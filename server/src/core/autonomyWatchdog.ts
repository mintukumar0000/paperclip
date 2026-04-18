import type { Db } from "@paperclipai/db";
import { and, eq } from "@paperclipai/db";
import { companies, cycleState } from "@paperclipai/db";
import type { CycleMode } from "@paperclipai/shared";
import pino from "pino";
import { getSystemControls } from "../services/system-controls.js";
import { runCompanyCycleOrchestrator } from "../routes/cycle-orchestrator.js";
import { logActivity } from "../services/activity-log.js";

const logger = pino({ name: "autonomy-watchdog" });

const DEFAULT_WATCHDOG_TICK_MS = 15_000;
const MAX_INTERVAL_MS = 15 * 60_000;
const MIN_INTERVAL_MS = 30_000;

const runningCompanies = new Set<string>();

function toCycleMode(value: string): CycleMode {
  if (value === "launch" || value === "improve" || value === "scale" || value === "dominate") {
    return value;
  }
  return "launch";
}

function resolveCompanyIntervalMs(raw: number): number {
  if (!Number.isFinite(raw)) return 60_000;
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.trunc(raw)));
}

async function shouldRunCompanyCycle(db: Db, companyId: string, intervalMs: number): Promise<boolean> {
  const row = await db
    .select()
    .from(cycleState)
    .where(and(eq(cycleState.companyId, companyId), eq(cycleState.loopKey, "cycle_orchestrator")))
    .then((rows) => rows[0] ?? null)
    .catch(() => null);

  if (!row) return true;

  const now = Date.now();
  const startedAt = row.lastRunStartedAt ? new Date(row.lastRunStartedAt).getTime() : 0;
  const completedAt = row.lastRunCompletedAt ? new Date(row.lastRunCompletedAt).getTime() : 0;
  const latest = Math.max(startedAt, completedAt);

  if (row.status === "running") {
    const runtime = startedAt > 0 ? now - startedAt : 0;
    return runtime > intervalMs * 2;
  }

  if (latest <= 0) return true;
  return now - latest >= intervalMs;
}

export function startAutonomyWatchdog(db: Db, tickMs = DEFAULT_WATCHDOG_TICK_MS): () => void {
  logger.info({ tickMs }, "Starting autonomy watchdog loop");

  const timer = setInterval(() => {
    void (async () => {
      const activeCompanies = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.status, "active"))
        .catch(() => []);

      for (const company of activeCompanies) {
        if (runningCompanies.has(company.id)) continue;

        const controls = await getSystemControls(db, company.id).catch(() => null);
        if (!controls || controls.trafficEnabled === false) {
          continue;
        }

        const intervalMs = resolveCompanyIntervalMs(controls.trafficPostIntervalMs);
        const shouldRun = await shouldRunCompanyCycle(db, company.id, intervalMs);
        if (!shouldRun) continue;

        runningCompanies.add(company.id);
        const cycleMode = toCycleMode(controls.cycleMode);

        void runCompanyCycleOrchestrator({
          db,
          companyId: company.id,
          cycleType: cycleMode,
          reason: "autonomy_watchdog_interval",
          actor: {
            actorType: "system",
            actorId: "autonomy-watchdog",
            agentId: null,
            runId: null,
          },
        }).then(async (result) => {
          await logActivity(db, {
            companyId: company.id,
            actorType: "system",
            actorId: "autonomy-watchdog",
            action: "autonomy.watchdog.triggered",
            entityType: "company",
            entityId: company.id,
            details: {
              status: result.status,
              cycleType: result.cycleType,
              durationMs: result.durationMs,
              intervalMs,
            },
          }).catch(() => undefined);
        }).catch(async (err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err, companyId: company.id }, "Autonomy watchdog cycle failed");
          await logActivity(db, {
            companyId: company.id,
            actorType: "system",
            actorId: "autonomy-watchdog",
            action: "autonomy.watchdog.failed",
            entityType: "company",
            entityId: company.id,
            details: {
              error: message,
              intervalMs,
            },
          }).catch(() => undefined);
        }).finally(() => {
          runningCompanies.delete(company.id);
        });
      }
    })();
  }, Math.max(5_000, tickMs));

  return () => {
    clearInterval(timer);
    logger.info("Autonomy watchdog loop stopped");
  };
}
