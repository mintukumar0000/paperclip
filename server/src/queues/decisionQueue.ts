import { Queue } from "bullmq";
import { createHash } from "node:crypto";
import { createRedisConnection } from "../redis/index.js";
import { resolvePaperclipInstanceId } from "../home-paths.js";
import type { DecisionCycleInput } from "../ai/governance/decisionEngine.js";
import pino from "pino";

const logger = pino({ name: "decision-queue" });

export interface DecisionCycleJobPayload {
  companyId: string;
  source: DecisionCycleInput["source"];
  windowMinutes?: number;
  reason?: string;
}

const QUEUE_NAME = "decision-cycle";

function resolveDecisionQueuePrefix(): string {
  return `paperclip:${resolvePaperclipInstanceId()}`;
}

const DECISION_QUEUE_PREFIX = resolveDecisionQueuePrefix();

let _queue: Queue<DecisionCycleJobPayload> | null = null;

function normalizeJobId(jobId?: string): string | undefined {
  if (!jobId) return undefined;
  if (!jobId.includes(":")) return jobId;
  // BullMQ disallows ':' in custom job IDs.
  return `pc_${createHash("sha256").update(jobId).digest("hex")}`;
}

export function getDecisionQueue(): Queue<DecisionCycleJobPayload> {
  if (!_queue) {
    _queue = new Queue<DecisionCycleJobPayload>(QUEUE_NAME, {
      connection: createRedisConnection(),
      prefix: DECISION_QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
    logger.info("Decision-cycle queue initialized");
  }
  return _queue;
}

export async function enqueueDecisionCycleJob(
  payload: DecisionCycleJobPayload,
  opts?: { delay?: number; jobId?: string },
): Promise<string> {
  const queue = getDecisionQueue();
  const normalizedJobId = normalizeJobId(opts?.jobId);
  const job = await queue.add("decision-cycle", payload, {
    delay: opts?.delay ?? 0,
    jobId: normalizedJobId,
  });

  logger.info(
    {
      jobId: job.id,
      dedupeKey: opts?.jobId,
      companyId: payload.companyId,
      source: payload.source,
      reason: payload.reason,
    },
    "Decision-cycle job enqueued",
  );

  return String(job.id);
}

export { QUEUE_NAME as DECISION_QUEUE_NAME, DECISION_QUEUE_PREFIX };
