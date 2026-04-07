// ---------------------------------------------------------------------------
// Execution Loop — autonomous multi-step plan executor
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import type { AIExecutionContext, AIExecutionResult } from "../types.js";
import { executeAI } from "../executor.js";
import {
  type TaskGraph,
  getReadySteps,
  markStepRunning,
  markStepCompleted,
  markStepFailed,
  resetStepForRetry,
  isGraphComplete,
  isGraphStuck,
  getGraphProgress,
} from "../planning/taskGraph.js";
import { generateExecutableStep, collectPreviousOutputs } from "../planning/stepGenerator.js";
import { observe, type Observation } from "./observationEngine.js";
import { replan } from "./replanner.js";
import { publishEvent } from "../../events/eventPublisher.js";
import { getAutonomyLimits } from "../governance/autonomyLimits.js";
import pino from "pino";

const logger = pino({ name: "execution-loop" });

export type LoopStatus = "running" | "completed" | "failed" | "cancelled" | "stuck";

export interface LoopResult {
  status: LoopStatus;
  graph: TaskGraph;
  iterations: number;
  observations: Observation[];
  error?: string;
}

export interface LoopOptions {
  maxIterations?: number;
  onStepComplete?: (stepId: string, observation: Observation) => Promise<void>;
  onGraphUpdate?: (graph: TaskGraph) => Promise<void>;
  shouldCancel?: () => boolean;
}

/**
 * Run the autonomous execution loop for a task graph.
 * Iterates through ready steps, executes them via the AI executor,
 * observes results, and replans on failure.
 */
export async function runExecutionLoop(
  graph: TaskGraph,
  baseContext: AIExecutionContext,
  db: Db,
  options: LoopOptions = {},
): Promise<LoopResult> {
  const globalMax = getAutonomyLimits().maxExecutionLoopIterations;
  const maxIterations = Math.min(options.maxIterations ?? globalMax, globalMax);
  let currentGraph = graph;
  let iterations = 0;
  const observations: Observation[] = [];

  logger.info(
    { goal: graph.metadata.goal, steps: graph.steps.length, maxIterations },
    "Starting execution loop",
  );

  await publishEvent("loop.cycle.started" as any, {
    runId: baseContext.runId,
    agentId: baseContext.agent.id,
    companyId: baseContext.agent.companyId,
    goal: graph.metadata.goal,
    totalSteps: graph.steps.length,
  });

  while (iterations < maxIterations) {
    // Check cancellation
    if (options.shouldCancel?.()) {
      logger.info({ iterations }, "Loop cancelled by caller");
      return { status: "cancelled", graph: currentGraph, iterations, observations };
    }

    // Check completion
    if (isGraphComplete(currentGraph)) {
      logger.info({ iterations }, "All steps completed");
      break;
    }

    // Check if stuck
    if (isGraphStuck(currentGraph)) {
      logger.warn({ iterations }, "Graph is stuck — no ready steps");
      return { status: "stuck", graph: currentGraph, iterations, observations };
    }

    // Get next ready steps
    const readySteps = getReadySteps(currentGraph);
    if (readySteps.length === 0) {
      // All steps are either running or blocked
      logger.warn("No ready steps available");
      return { status: "stuck", graph: currentGraph, iterations, observations };
    }

    // Execute the first ready step (sequential execution)
    const step = readySteps[0];
    iterations++;

    logger.info(
      { iteration: iterations, stepId: step.id, stepName: step.name },
      "Executing step",
    );

    // Mark as running
    currentGraph = markStepRunning(currentGraph, step.id);

    // Generate executable context
    const completedSteps = currentGraph.steps.filter((s) => s.status === "completed");
    const previousOutputs = collectPreviousOutputs(completedSteps);
    const executable = generateExecutableStep(step, baseContext, previousOutputs);

    // Execute with per-step timeout protection
    const STEP_TIMEOUT_MS = 120_000; // 2 minutes
    let result: AIExecutionResult;
    try {
      result = await Promise.race([
        executeAI(executable.context, db),
        new Promise<AIExecutionResult>((_, reject) =>
          setTimeout(() => reject(new Error(`Step timeout after ${STEP_TIMEOUT_MS / 1000}s`)), STEP_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Execution error";
      result = { status: "failed", error: message };
    }

    // Observe
    const observation = observe(step, result);
    observations.push(observation);

    // Handle observation verdict
    switch (observation.verdict) {
      case "success":
        currentGraph = markStepCompleted(currentGraph, step.id, result.output);
        await publishEvent("ai.execution.completed" as any, {
          runId: baseContext.runId,
          agentId: baseContext.agent.id,
          companyId: baseContext.agent.companyId,
          stepId: step.id,
          status: "completed",
        });
        break;

      case "retry":
        currentGraph = markStepFailed(currentGraph, step.id, observation.error ?? "");
        currentGraph = resetStepForRetry(currentGraph, step.id);
        break;

      case "replan": {
        currentGraph = markStepFailed(currentGraph, step.id, observation.error ?? "");
        const replanResult = await replan({
          graph: currentGraph,
          observation,
          context: baseContext,
        });
        if (replanResult.replanned) {
          currentGraph = replanResult.graph;
          logger.info({ reasoning: replanResult.reasoning }, "Graph replanned");
        } else {
          logger.warn("Replan failed, continuing with original graph");
        }
        break;
      }

      case "guarded":
        currentGraph = markStepFailed(currentGraph, step.id, "Action guarded");
        logger.info({ stepId: step.id }, "Step blocked by guard, skipping");
        break;

      case "abort":
        currentGraph = markStepFailed(currentGraph, step.id, observation.error ?? "");
        logger.error({ stepId: step.id, error: observation.error }, "Aborting plan");
        await publishEvent("ai.execution.completed" as any, {
          runId: baseContext.runId,
          agentId: baseContext.agent.id,
          companyId: baseContext.agent.companyId,
          stepId: step.id,
          status: "failed",
          error: observation.error,
        });
        return {
          status: "failed",
          graph: currentGraph,
          iterations,
          observations,
          error: observation.error,
        };
    }

    // Notify callbacks
    await options.onStepComplete?.(step.id, observation);
    await options.onGraphUpdate?.(currentGraph);
  }

  const iterationOverflow = iterations >= maxIterations && !isGraphComplete(currentGraph);
  const finalStatus: LoopStatus = isGraphComplete(currentGraph) ? "completed" : "failed";

  if (iterationOverflow) {
    logger.error(
      { agentId: baseContext.agent.id, companyId: baseContext.agent.companyId, iterations, maxIterations },
      "AGENT PAUSED: execution loop iteration limit exceeded — possible infinite loop",
    );
    await publishEvent("ai.agent.paused" as any, {
      agentId: baseContext.agent.id,
      companyId: baseContext.agent.companyId,
      reason: "execution_loop_iteration_limit",
      iterations,
      maxIterations,
    });
  }

  await publishEvent("loop.cycle.completed" as any, {
    runId: baseContext.runId,
    agentId: baseContext.agent.id,
    companyId: baseContext.agent.companyId,
    status: finalStatus,
    iterations,
    progress: getGraphProgress(currentGraph),
    iterationOverflow,
  });

  logger.info(
    { status: finalStatus, iterations, progress: getGraphProgress(currentGraph) },
    "Execution loop finished",
  );

  return {
    status: finalStatus,
    graph: currentGraph,
    iterations,
    observations,
    error: finalStatus === "failed" ? "Max iterations reached" : undefined,
  };
}
