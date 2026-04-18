import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  runCompanyCycleSchema,
  runCompanyCycleByIntentSchema,
  type CycleMode,
  type RunCompanyCycle,
  type RunCompanyCycleByIntent,
  type SystemCycleRunResult,
  type SystemCycleStepKey,
  type SystemCycleStepResult,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { setCycleState } from "../services/cycle-state.js";
import { logActivity } from "../services/activity-log.js";
import { executionLoop } from "../core/executionLoop.js";
import { runTrafficCycleWithDecision } from "../core/trafficLoop.js";
import { withActiveCompanyScope } from "../core/companyScope.js";
import { getRecentSystemMetricsSnapshot } from "../ai/feedback/metricsEngine.js";
import { runAutonomousDecisionCycle } from "../ai/governance/decisionEngine.js";
import { runEmailSequenceCycle } from "../ai/distribution/emailSequence.js";
import { getSystemControls } from "../services/system-controls.js";

const CYCLE_STEP_ORDER: Record<CycleMode, SystemCycleStepKey[]> = {
  launch: ["execution", "traffic", "decision", "email"],
  improve: ["decision", "execution", "traffic", "email"],
  scale: ["decision", "traffic", "execution", "email"],
  dominate: ["decision", "traffic", "email", "execution"],
};

function resolvePublicBaseUrl(): string {
  const raw = (
    process.env.PUBLIC_API_BASE
    ?? process.env.WAITLIST_PUBLIC_BASE_URL
    ?? process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL
    ?? "http://localhost:3100"
  ).trim();
  return raw.length > 0 ? raw : "http://localhost:3100";
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function mapIntentToCycle(intent: string, fallback: CycleMode): CycleMode {
  const normalized = intent.toLowerCase();
  if (/launch|start|new\s+company|boot|kickoff|go\s+live/.test(normalized)) return "launch";
  if (/improve|optimi[sz]e|conversion|bounce|funnel|retention/.test(normalized)) return "improve";
  if (/scale|grow|traffic|acquisition|expand|distribution/.test(normalized)) return "scale";
  if (/dominate|maximi[sz]e|pricing|revenue|email\s+sequence|monetiz/.test(normalized)) return "dominate";
  return fallback;
}

export async function runCompanyCycleOrchestrator(input: {
  db: Db;
  companyId: string;
  cycleType: CycleMode;
  reason?: string | null;
  actor: {
    actorType: "user" | "agent" | "system";
    actorId: string;
    agentId?: string | null;
    runId?: string | null;
  };
}): Promise<SystemCycleRunResult> {
  const { db, companyId, cycleType, reason, actor } = input;
  const execution = executionLoop(db);
  const stepOrder = CYCLE_STEP_ORDER[cycleType];
  const cycleStartedAt = Date.now();
  const traceId = `cycle_orchestrator:${companyId}:${cycleStartedAt}`;
  const startedAt = new Date(cycleStartedAt).toISOString();
  const steps: SystemCycleStepResult[] = [];

  await setCycleState(db, companyId, "cycle_orchestrator", {
    status: "running",
    stage: "planning",
    currentAction: cycleType,
    lastError: null,
    lastRunStartedAt: new Date(cycleStartedAt),
    details: {
      traceId,
      cycleType,
      reason: reason ?? null,
      stepOrder,
    },
  }).catch(() => undefined);

  await logActivity(db, {
    companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    action: "cycle.execution.plan",
    entityType: "company",
    entityId: companyId,
    details: {
      status: "pending",
      traceId,
      cycleType,
      reason: reason ?? null,
      stepOrder,
    },
  }).catch(() => undefined);

  for (const step of stepOrder) {
    const stepStartedAt = Date.now();
    const stepStarted = new Date(stepStartedAt).toISOString();

    await setCycleState(db, companyId, "cycle_orchestrator", {
      status: "running",
      stage: "executing",
      currentAction: step,
      details: {
        cycleType,
        step,
        stepOrder,
      },
    }).catch(() => undefined);

    try {
      let stepDetails: Record<string, unknown> = {};

      if (step === "execution") {
        const result = await execution.runCycle(companyId);
        stepDetails = {
          goalsAnalyzed: result.goalsAnalyzed,
          tasksDispatched: result.tasksDispatched,
          agentsActivated: result.agentsActivated,
          cycleStarted: result.cycleStarted,
          cycleCompleted: result.cycleCompleted,
        };
      } else if (step === "traffic") {
        const result = await withActiveCompanyScope(companyId, async () =>
          runTrafficCycleWithDecision({ db, baseUrl: resolvePublicBaseUrl() }, { traceId }),
        );
        if (result.error) {
          throw new Error(result.error);
        }
        stepDetails = {
          successCount: result.successCount,
          failCount: result.failCount,
          resultCount: result.results.length,
        };
      } else if (step === "decision") {
        const metrics = await getRecentSystemMetricsSnapshot(db, companyId, 180);
        const result = await runAutonomousDecisionCycle(db, {
          companyId,
          metrics,
          source: "manual",
        });
        stepDetails = {
          feedbackCount: result.feedback.length,
          actionCount: result.actions.length,
          executedCount: result.executed.filter((entry) => entry.success).length,
          pendingCount: result.executed.filter((entry) => !entry.success).length,
        };
      } else {
        const emailResult = await withActiveCompanyScope(companyId, async () =>
          runEmailSequenceCycle(db, { companyId }),
        );
        if (emailResult.status === "failed") {
          throw new Error(emailResult.error ?? "email sequence cycle failed");
        }
        stepDetails = {
          sent: emailResult.sent,
          attempted: emailResult.attempted,
        };
      }

      steps.push({
        step,
        status: "success",
        startedAt: stepStarted,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - stepStartedAt,
        details: stepDetails,
      });
    } catch (err) {
      const message = toErrorMessage(err);
      steps.push({
        step,
        status: "failed",
        startedAt: stepStarted,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - stepStartedAt,
        error: message,
      });

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "cycle.execution.step.failed",
        entityType: "company",
        entityId: companyId,
        details: {
          status: "failed",
          traceId,
          cycleType,
          step,
          error: message,
        },
      }).catch(() => undefined);
    }
  }

  const failedSteps = steps.filter((step) => step.status === "failed").length;
  const status: SystemCycleRunResult["status"] = failedSteps === 0
    ? "success"
    : failedSteps === steps.length
      ? "failed"
      : "partial_failed";

  const result: SystemCycleRunResult = {
    companyId,
    cycleType,
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - cycleStartedAt,
    steps,
  };

  await setCycleState(db, companyId, "cycle_orchestrator", {
    status: status === "success" ? "completed" : "failed",
    stage: "idle",
    currentAction: null,
    lastError: status === "success"
      ? null
      : steps.filter((step) => step.status === "failed").map((step) => step.error).filter(Boolean).join(" | "),
    lastRunCompletedAt: new Date(),
    lastRunDurationMs: result.durationMs,
    details: {
      traceId,
      cycleType,
      status,
      stepOrder,
    },
  }).catch(() => undefined);

  await logActivity(db, {
    companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    action: "cycle.execution.result",
    entityType: "company",
    entityId: companyId,
    details: {
      status,
      traceId,
      cycleType,
      reason: reason ?? null,
      durationMs: result.durationMs,
      steps: steps.map((step) => ({
        step: step.step,
        status: step.status,
        durationMs: step.durationMs,
        error: step.error ?? null,
      })),
    },
  }).catch(() => undefined);

  return result;
}

export function cycleOrchestratorRoutes(db: Db) {
  const router = Router();

  router.post("/cycle/run", validate(runCompanyCycleSchema), async (req, res) => {
    const { companyId, cycleType, reason } = req.body as RunCompanyCycle;
    assertCompanyAccess(req, companyId);

    const actor = getActorInfo(req);
    const result = await runCompanyCycleOrchestrator({
      db,
      companyId,
      cycleType,
      reason,
      actor,
    });

    res.json(result);
  });

  router.post("/cycle/run-from-intent", validate(runCompanyCycleByIntentSchema), async (req, res) => {
    const { companyId, intent, reason } = req.body as RunCompanyCycleByIntent;
    assertCompanyAccess(req, companyId);

    const actor = getActorInfo(req);
    const controls = await getSystemControls(db, companyId).catch(() => null);
    const fallbackCycle = (controls?.cycleMode ?? "launch") as CycleMode;
    const cycleType = mapIntentToCycle(intent, fallbackCycle);

    const result = await runCompanyCycleOrchestrator({
      db,
      companyId,
      cycleType,
      reason: reason ?? intent,
      actor,
    });

    res.json({
      intent,
      mappedCycleType: cycleType,
      result,
    });
  });

  return router;
}
