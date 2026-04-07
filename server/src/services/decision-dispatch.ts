import type { Db } from "@paperclipai/db";
import { enqueueDecisionCycleJob, type DecisionCycleJobPayload } from "../queues/decisionQueue.js";
import { getRecentSystemMetricsSnapshot } from "../ai/feedback/metricsEngine.js";
import { runAutonomousDecisionCycle } from "../ai/governance/decisionEngine.js";
import pino from "pino";

const logger = pino({ name: "decision-dispatch" });

export interface DispatchDecisionCycleInput {
  companyId: string;
  source?: DecisionCycleJobPayload["source"];
  windowMinutes?: number;
  reason?: string;
  dedupeKey?: string;
}

export async function runDecisionCycleForCompany(
  db: Db,
  input: DispatchDecisionCycleInput,
): Promise<void> {
  const source = input.source ?? "manual";
  const windowMinutes = input.windowMinutes ?? 180;
  const snapshot = await getRecentSystemMetricsSnapshot(db, input.companyId, windowMinutes);
  await runAutonomousDecisionCycle(db, {
    companyId: input.companyId,
    metrics: snapshot,
    source,
  });
}

export async function dispatchDecisionCycle(
  db: Db,
  input: DispatchDecisionCycleInput,
): Promise<{ mode: "queued" | "async_fallback"; jobId?: string }> {
  const source = input.source ?? "manual";
  const windowMinutes = input.windowMinutes ?? 180;

  try {
    const jobId = await enqueueDecisionCycleJob(
      {
        companyId: input.companyId,
        source,
        windowMinutes,
        reason: input.reason,
      },
      {
        jobId: input.dedupeKey,
      },
    );
    return { mode: "queued", jobId };
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId },
      "Decision queue unavailable, using async fallback",
    );

    setTimeout(() => {
      void runDecisionCycleForCompany(db, {
        companyId: input.companyId,
        source,
        windowMinutes,
        reason: input.reason,
      }).catch((fallbackErr) => {
        logger.error(
          { err: fallbackErr, companyId: input.companyId },
          "Async fallback decision-cycle failed",
        );
      });
    }, 0);

    return { mode: "async_fallback" };
  }
}
