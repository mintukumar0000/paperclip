// ---------------------------------------------------------------------------
// Step Generator — converts abstract plan steps into executable AI actions
// ---------------------------------------------------------------------------

import type { AIExecutionContext } from "../types.js";
import type { TaskStep } from "./taskGraph.js";
import pino from "pino";

const logger = pino({ name: "step-generator" });

export interface ExecutableStep {
  step: TaskStep;
  context: AIExecutionContext;
  tools: string[];
}

/**
 * Convert a task graph step into an executable AI context.
 * Enriches the base context with step-specific tool permissions and memory.
 */
export function generateExecutableStep(
  step: TaskStep,
  baseContext: AIExecutionContext,
  previousOutputs: Map<string, string>,
): ExecutableStep {
  // Build step-specific prompt enrichment from dependency outputs
  const depContext = step.dependsOn
    .map((depId) => {
      const output = previousOutputs.get(depId);
      return output ? `[Result of ${depId}]: ${output}` : null;
    })
    .filter(Boolean)
    .join("\n");

  const enrichedMemory = [
    baseContext.memoryContext ?? "",
    depContext ? `\nPrevious step results:\n${depContext}` : "",
    `\nCurrent step: ${step.name}\nDescription: ${step.description}`,
  ]
    .filter(Boolean)
    .join("\n");

  // Determine which tools this step needs
  const tools = step.toolName ? [step.toolName] : baseContext.tools ?? [];

  const context: AIExecutionContext = {
    ...baseContext,
    runId: `${baseContext.runId}-${step.id}`,
    memoryContext: enrichedMemory,
    tools,
    forcedToolCall: step.toolName
      ? {
          tool: step.toolName,
          args: step.toolArgs ?? {},
        }
      : undefined,
  };

  logger.debug(
    { stepId: step.id, stepName: step.name, tools },
    "Generated executable step",
  );

  return { step, context, tools };
}

/**
 * Collect outputs from completed steps into a lookup map.
 */
export function collectPreviousOutputs(
  completedSteps: TaskStep[],
): Map<string, string> {
  const outputs = new Map<string, string>();
  for (const step of completedSteps) {
    if (step.output) {
      outputs.set(step.id, step.output);
    }
  }
  return outputs;
}
