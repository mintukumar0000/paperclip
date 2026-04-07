import type { WorkflowStep, WorkflowStepResult } from "./dependencyGraph.js";
import { dispatchAgentExecution } from "../services/agentDispatchService.js";
import { eventPublisher } from "../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "step-executor" });

/**
 * Executes a single workflow step by dispatching agent work.
 */
export async function executeStep(
  step: WorkflowStep,
  runContext: {
    workflowRunId: string;
    companyId: string;
    agentMap: Map<string, string>; // role → agentId
    issueMap: Map<string, string>; // stepId → issueId
  },
): Promise<WorkflowStepResult> {
  const agentId = runContext.agentMap.get(step.agent);
  if (!agentId) {
    logger.error({ step: step.id, role: step.agent }, "No agent found for role");
    return { stepId: step.id, status: "failed", error: `No agent with role "${step.agent}"` };
  }

  const issueId = runContext.issueMap.get(step.id);
  if (!issueId) {
    logger.error({ step: step.id }, "No issue mapped for workflow step");
    return { stepId: step.id, status: "failed", error: "No issue for step" };
  }

  try {
    const jobId = await dispatchAgentExecution(
      {
        agentId,
        issueId,
        companyId: runContext.companyId,
        wakeReason: "workflow_step",
        context: { workflowRunId: runContext.workflowRunId, stepId: step.id },
      },
      {
        workflowRunId: runContext.workflowRunId,
        stepId: step.id,
      },
    );

    logger.info({ stepId: step.id, jobId }, "Workflow step dispatched");

    await eventPublisher.publish("workflow.step.completed", {
      workflowRunId: runContext.workflowRunId,
      stepId: step.id,
      jobId,
      companyId: runContext.companyId,
    });

    return { stepId: step.id, status: "completed", result: { jobId } };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ stepId: step.id, err }, "Workflow step failed");

    await eventPublisher.publish("workflow.step.failed", {
      workflowRunId: runContext.workflowRunId,
      stepId: step.id,
      error: errorMsg,
      companyId: runContext.companyId,
    });

    return { stepId: step.id, status: "failed", error: errorMsg };
  }
}
