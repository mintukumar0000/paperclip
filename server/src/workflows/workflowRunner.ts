import type { WorkflowDefinition, WorkflowStep, WorkflowStepResult } from "./dependencyGraph.js";
import { executeStep } from "./stepExecutor.js";
import { eventPublisher } from "../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "workflow-runner" });

interface RunContext {
  workflowRunId: string;
  companyId: string;
  agentMap: Map<string, string>;
  issueMap: Map<string, string>;
}

/**
 * Runs a single workflow: resolves DAG order, executes steps, tracks results.
 */
export async function runWorkflow(
  definition: WorkflowDefinition,
  context: RunContext,
): Promise<{ completed: WorkflowStepResult[]; failed: WorkflowStepResult[] }> {
  const executionOrder = resolveExecutionOrder(definition.steps);
  const completedSet = new Set<string>();
  const completed: WorkflowStepResult[] = [];
  const failed: WorkflowStepResult[] = [];

  logger.info(
    { name: definition.name, steps: executionOrder.map((s) => s.id) },
    "Starting workflow execution",
  );

  for (const step of executionOrder) {
    // Check all dependencies are met
    const depsOk = (step.dependsOn ?? []).every((dep) => completedSet.has(dep));
    if (!depsOk) {
      const result: WorkflowStepResult = {
        stepId: step.id,
        status: "skipped",
        error: "Dependency not met",
      };
      failed.push(result);
      logger.warn({ stepId: step.id }, "Step skipped — dependency not met");
      continue;
    }

    let result: WorkflowStepResult | null = null;
    const maxRetries = step.retryCount ?? 1;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      result = await executeStep(step, context);
      if (result.status === "completed") break;
      if (attempt < maxRetries) {
        logger.warn({ stepId: step.id, attempt }, "Retrying step");
      }
    }

    if (result!.status === "completed") {
      completedSet.add(step.id);
      completed.push(result!);
    } else {
      failed.push(result!);
      logger.error({ stepId: step.id }, "Step failed after retries");
    }
  }

  const status = failed.length === 0 ? "completed" : "failed";
  await eventPublisher.publish(
    status === "completed" ? "workflow.completed" : "workflow.failed",
    {
      workflowRunId: context.workflowRunId,
      companyId: context.companyId,
      completedSteps: completed.map((c) => c.stepId),
      failedSteps: failed.map((f) => f.stepId),
    },
  );

  return { completed, failed };
}

/** Topological sort of steps based on dependsOn edges */
function resolveExecutionOrder(steps: WorkflowStep[]): WorkflowStep[] {
  const stepMap = new Map(steps.map((s) => [s.id, s]));
  const visited = new Set<string>();
  const result: WorkflowStep[] = [];

  function visit(stepId: string) {
    if (visited.has(stepId)) return;
    visited.add(stepId);
    const step = stepMap.get(stepId);
    if (!step) return;
    for (const dep of step.dependsOn ?? []) {
      visit(dep);
    }
    result.push(step);
  }

  for (const step of steps) {
    visit(step.id);
  }

  return result;
}
