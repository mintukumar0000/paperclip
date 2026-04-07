import { Worker, Job } from "bullmq";
import { createRedisConnection } from "../redis/index.js";
import {
  DECISION_QUEUE_NAME,
  DECISION_QUEUE_PREFIX,
  type DecisionCycleJobPayload,
} from "../queues/decisionQueue.js";
import pino from "pino";

const logger = pino({ name: "decision-worker" });

export interface DecisionWorkerDeps {
  runDecisionCycle: (payload: DecisionCycleJobPayload) => Promise<void>;
}

export function createDecisionWorker(deps: DecisionWorkerDeps): Worker<DecisionCycleJobPayload> {
  const worker = new Worker<DecisionCycleJobPayload>(
    DECISION_QUEUE_NAME,
    async (job: Job<DecisionCycleJobPayload>) => {
      const { companyId, source, reason, windowMinutes } = job.data;

      logger.info(
        { jobId: job.id, companyId, source, reason, windowMinutes },
        "Worker processing decision-cycle job",
      );

      await deps.runDecisionCycle(job.data);

      logger.info({ jobId: job.id, companyId }, "Decision-cycle job completed");
    },
    {
      connection: createRedisConnection(),
      prefix: DECISION_QUEUE_PREFIX,
      concurrency: Number(process.env.DECISION_WORKER_CONCURRENCY ?? 4),
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "Decision-cycle job failed");
  });

  worker.on("error", (err) => {
    logger.error({ err }, "Decision worker error");
  });

  logger.info("Decision worker started");
  return worker;
}
