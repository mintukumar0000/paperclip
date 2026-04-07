import { Queue } from "bullmq";
import { createRedisConnection } from "../redis/index.js";
import pino from "pino";

const logger = pino({ name: "agent-queue" });

export interface AgentJobPayload {
  agentId: string;
  issueId: string;
  companyId: string;
  context: Record<string, unknown>;
  wakeReason?: string;
  workflowRunId?: string;
  stepId?: string;
}

const QUEUE_NAME = "agent-execution";

let _queue: Queue<AgentJobPayload> | null = null;

export function getAgentQueue(): Queue<AgentJobPayload> {
  if (!_queue) {
    _queue = new Queue<AgentJobPayload>(QUEUE_NAME, {
      connection: createRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
    logger.info("Agent execution queue initialized");
  }
  return _queue;
}

export async function enqueueAgentJob(
  payload: AgentJobPayload,
  opts?: { priority?: number; delay?: number },
): Promise<string> {
  const queue = getAgentQueue();
  const job = await queue.add("execute-agent", payload, {
    priority: opts?.priority ?? 0,
    delay: opts?.delay ?? 0,
  });
  logger.info(
    { jobId: job.id, agentId: payload.agentId, issueId: payload.issueId },
    "Agent job enqueued",
  );
  return job.id!;
}

export { QUEUE_NAME };
