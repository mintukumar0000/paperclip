import { Worker, Job } from "bullmq";
import { createRedisConnection } from "../redis/index.js";
import { QUEUE_NAME } from "../queues/agentQueue.js";
import type { AgentJobPayload } from "../queues/agentQueue.js";
import { eventPublisher } from "../events/eventPublisher.js";
import { agentJobDuration, agentJobsTotal, agentJobsActive } from "../observability/metrics.js";
import pino from "pino";

const logger = pino({ name: "agent-worker" });

export interface WorkerDeps {
  /** The existing heartbeat service invoke/wakeup function */
  invokeHeartbeat: (params: {
    agentId: string;
    companyId: string;
    issueId?: string;
    wakeReason?: string;
    context?: Record<string, unknown>;
  }) => Promise<{ runId: string }>;
  markIssueCompleted?: (params: {
    issueId: string;
    agentId: string;
    runId: string;
  }) => Promise<void>;
  markIssueFailed?: (params: {
    issueId: string;
    agentId: string;
    reason: string;
  }) => Promise<void>;
  executeRealAction?: (params: {
    issueId: string;
    agentId: string;
    companyId: string;
    runId: string;
  }) => Promise<{ performed: boolean; artifactPath: string | null; reason: string | null }>;
}

export function createAgentWorker(deps: WorkerDeps): Worker<AgentJobPayload> {
  const worker = new Worker<AgentJobPayload>(
    QUEUE_NAME,
    async (job: Job<AgentJobPayload>) => {
      const { agentId, issueId, companyId, context, wakeReason } = job.data;

      logger.info(
        { jobId: job.id, agentId, issueId, companyId, attempt: job.attemptsMade + 1 },
        "Worker processing agent job",
      );

      agentJobsActive.inc();
      const jobStartTime = performance.now();

      try {
        const result = await deps.invokeHeartbeat({
          agentId,
          companyId,
          issueId,
          wakeReason: wakeReason ?? "worker_dispatch",
          context,
        });

        if (issueId && deps.executeRealAction) {
          try {
            const realAction = await deps.executeRealAction({
              issueId,
              agentId,
              companyId,
              runId: result.runId,
            });
            if (realAction.performed) {
              logger.info(
                {
                  jobId: job.id,
                  issueId,
                  agentId,
                  artifactPath: realAction.artifactPath,
                  reason: realAction.reason,
                },
                "Real action side effect completed",
              );
            }
          } catch (realActionErr) {
            logger.warn(
              { jobId: job.id, issueId, agentId, err: realActionErr },
              "Real action side effect failed",
            );
          }
        }

        if (issueId && deps.markIssueCompleted) {
          try {
            await deps.markIssueCompleted({ issueId, agentId, runId: result.runId });
          } catch (markDoneErr) {
            logger.warn(
              { jobId: job.id, issueId, agentId, err: markDoneErr },
              "Failed to mark issue as done after successful run",
            );
          }
        }

        logger.info(
          { jobId: job.id, runId: result.runId, agentId },
          "Agent job completed",
        );

        await eventPublisher.publish("agent.run.completed", {
          agentId,
          issueId,
          companyId,
          runId: result.runId,
          jobId: job.id!,
        });

        agentJobsActive.dec();
        agentJobDuration.observe({ agent_id: agentId, status: "completed" }, (performance.now() - jobStartTime) / 1000);
        agentJobsTotal.inc({ status: "completed" });

        return result;
      } catch (err) {
        if (issueId && deps.markIssueFailed) {
          try {
            await deps.markIssueFailed({
              issueId,
              agentId,
              reason: err instanceof Error ? err.message : String(err),
            });
          } catch (markFailedErr) {
            logger.warn(
              { jobId: job.id, issueId, agentId, err: markFailedErr },
              "Failed to mark issue after run failure",
            );
          }
        }

        logger.error(
          { jobId: job.id, agentId, issueId, err },
          "Agent job failed",
        );

        await eventPublisher.publish("agent.failed", {
          agentId,
          issueId,
          companyId,
          error: err instanceof Error ? err.message : String(err),
          jobId: job.id!,
          attempt: job.attemptsMade + 1,
        });

        agentJobsActive.dec();
        agentJobDuration.observe({ agent_id: agentId, status: "failed" }, (performance.now() - jobStartTime) / 1000);
        agentJobsTotal.inc({ status: "failed" });

        throw err; // BullMQ will retry based on job options
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),
      limiter: {
        max: 10,
        duration: 60_000, // max 10 jobs per minute per worker
      },
    },
  );

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "Job completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "Job failed");
  });

  worker.on("error", (err) => {
    logger.error({ err }, "Worker error");
  });

  logger.info("Agent worker started");
  return worker;
}
