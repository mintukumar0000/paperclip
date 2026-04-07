// ---------------------------------------------------------------------------
// Observation Engine — evaluates step results and decides next action
// ---------------------------------------------------------------------------

import type { AIExecutionResult } from "../types.js";
import type { TaskStep } from "../planning/taskGraph.js";
import pino from "pino";

const logger = pino({ name: "observation-engine" });

export type ObservationVerdict =
  | "success"        // step completed successfully
  | "retry"          // step failed but can be retried
  | "replan"         // step failed in a way that needs replanning
  | "abort"          // unrecoverable failure, abort the plan
  | "guarded";       // action was blocked by guard, needs approval

export interface Observation {
  stepId: string;
  verdict: ObservationVerdict;
  reason: string;
  output?: string;
  error?: string;
}

/** Evaluate the result of a step execution and produce an observation */
export function observe(step: TaskStep, result: AIExecutionResult): Observation {
  const base = { stepId: step.id, output: result.output, error: result.error };

  if (result.status === "completed" || result.status === "tool_executed") {
    logger.debug({ stepId: step.id, status: result.status }, "Step succeeded");
    return { ...base, verdict: "success", reason: "Step completed successfully" };
  }

  if (result.status === "guarded") {
    logger.info({ stepId: step.id }, "Step blocked by guard");
    return {
      ...base,
      verdict: "guarded",
      reason: result.error ?? "Action requires approval",
    };
  }

  // Failed — decide if retryable
  if (result.status === "failed") {
    const canRetry = step.retries < step.maxRetries;
    const isTransient = isTransientError(result.error ?? "");

    if (canRetry && isTransient) {
      logger.info({ stepId: step.id, retries: step.retries }, "Step failed, will retry");
      return { ...base, verdict: "retry", reason: "Transient failure, retrying" };
    }

    if (canRetry) {
      logger.info({ stepId: step.id }, "Step failed, requesting replan");
      return { ...base, verdict: "replan", reason: result.error ?? "Step failed, replanning" };
    }

    logger.warn({ stepId: step.id, error: result.error }, "Step failed, aborting");
    return { ...base, verdict: "abort", reason: result.error ?? "Max retries exceeded" };
  }

  return { ...base, verdict: "abort", reason: "Unknown result status" };
}

function isTransientError(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes("timeout") ||
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("503") ||
    lower.includes("econnreset") ||
    lower.includes("temporary")
  );
}
