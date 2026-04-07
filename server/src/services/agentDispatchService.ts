import { enqueueAgentJob } from "../queues/agentQueue.js";
import type { AgentJobPayload } from "../queues/agentQueue.js";
import { eventPublisher } from "../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "agent-dispatch" });

export interface DispatchOptions {
  priority?: number;
  delay?: number;
  workflowRunId?: string;
  stepId?: string;
}

/**
 * High-level dispatch: enqueues an agent execution job to the distributed queue.
 * This wraps the existing heartbeat execution inside a BullMQ job for distributed processing.
 */
export async function dispatchAgentExecution(
  params: {
    agentId: string;
    issueId: string;
    companyId: string;
    context?: Record<string, unknown>;
    wakeReason?: string;
  },
  opts?: DispatchOptions,
): Promise<string> {
  const payload: AgentJobPayload = {
    agentId: params.agentId,
    issueId: params.issueId,
    companyId: params.companyId,
    context: params.context ?? {},
    wakeReason: params.wakeReason,
    workflowRunId: opts?.workflowRunId,
    stepId: opts?.stepId,
  };

  const jobId = await enqueueAgentJob(payload, {
    priority: opts?.priority,
    delay: opts?.delay,
  });

  logger.info(
    { jobId, agentId: params.agentId, issueId: params.issueId },
    "Agent execution dispatched",
  );

  await eventPublisher.publish("agent.dispatched", {
    jobId,
    agentId: params.agentId,
    issueId: params.issueId,
    companyId: params.companyId,
  });

  return jobId;
}
