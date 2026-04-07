// ---------------------------------------------------------------------------
// Replanner — adjusts the task graph when steps fail or conditions change
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { AIExecutionContext, LLMAdapter } from "../types.js";
import { getLLMAdapter } from "../router/llmRouter.js";
import type { TaskGraph, TaskStep } from "../planning/taskGraph.js";
import { replaceSteps, getGraphProgress } from "../planning/taskGraph.js";
import type { Observation } from "./observationEngine.js";
import { getAutonomyLimits } from "../governance/autonomyLimits.js";
import pino from "pino";

const logger = pino({ name: "replanner" });

const REPLAN_SYSTEM_PROMPT = `You are an AI replanner. A step in the execution plan has failed. Review the situation and produce a revised set of remaining steps.

Rules:
1. Keep completed steps — do not redo them.
2. Address the failure by adjusting the approach.
3. Minimize changes — only modify what's necessary.

Respond with a JSON object:
{
  "reasoning": "Why this replan was chosen",
  "steps": [
    {
      "id": "step-id",
      "name": "Step name",
      "description": "What this step does",
      "dependsOn": [],
      "toolName": "optional_tool",
      "toolArgs": {}
    }
  ]
}

Respond ONLY with valid JSON, no markdown fencing.`;

export interface ReplanRequest {
  graph: TaskGraph;
  observation: Observation;
  context: AIExecutionContext;
}

export interface ReplanResult {
  graph: TaskGraph;
  reasoning: string;
  replanned: boolean;
}

const MAX_REPLAN_CYCLES = getAutonomyLimits().maxReplanCycles;

/** Attempt to replan the task graph after a failure */
export async function replan(request: ReplanRequest): Promise<ReplanResult> {
  const { graph, observation, context } = request;

  // Enforce max replan depth to prevent infinite expansion
  const currentReplanCount = graph.metadata.replanCount ?? 0;
  if (currentReplanCount >= MAX_REPLAN_CYCLES) {
    logger.warn(
      { goal: graph.metadata.goal, replanCount: currentReplanCount },
      "Max replan cycles exceeded, refusing to replan further",
    );
    return { graph, reasoning: `Max replan cycles (${MAX_REPLAN_CYCLES}) exceeded`, replanned: false };
  }

  const adapter = getLLMAdapter(context.agent.runtime ?? "openai");
  const progress = getGraphProgress(graph);

  const prompt = buildReplanPrompt(graph, observation, progress);

  logger.info(
    { goal: graph.metadata.goal, failedStep: observation.stepId, progress },
    "Replanning",
  );

  try {
    const response = await adapter.generate({
      prompt,
      systemPrompt: REPLAN_SYSTEM_PROMPT,
      temperature: 0.3,
      maxTokens: 2000,
    });

    const parsed = parseReplanResponse(response.text ?? "{}");

    if (parsed.steps.length === 0) {
      logger.warn("Replan produced no steps, keeping original graph");
      return { graph, reasoning: "Replan failed to produce steps", replanned: false };
    }

    const newGraph = replaceSteps(
      graph,
      parsed.steps.map((s, i) => ({
        id: s.id ?? `replan-${randomUUID().slice(0, 8)}`,
        name: s.name ?? `Replan step ${i + 1}`,
        description: s.description ?? "",
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
        toolName: s.toolName,
        toolArgs: s.toolArgs,
        maxRetries: 2,
      })),
      true, // keep completed steps
    );

    // Track replan count
    newGraph.metadata.replanCount = currentReplanCount + 1;

    logger.info(
      { newStepCount: newGraph.steps.length, reasoning: parsed.reasoning },
      "Replan complete",
    );

    return { graph: newGraph, reasoning: parsed.reasoning, replanned: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Replan failed";
    logger.error({ err }, "Replan LLM call failed");
    return { graph, reasoning: message, replanned: false };
  }
}

function buildReplanPrompt(
  graph: TaskGraph,
  observation: Observation,
  progress: ReturnType<typeof getGraphProgress>,
): string {
  const completedSteps = graph.steps
    .filter((s) => s.status === "completed")
    .map((s) => `  - ${s.id}: ${s.name} ✓ ${s.output ?? ""}`)
    .join("\n");

  const failedStep = graph.steps.find((s) => s.id === observation.stepId);
  const pendingSteps = graph.steps
    .filter((s) => s.status === "pending")
    .map((s) => `  - ${s.id}: ${s.name} (depends on: ${s.dependsOn.join(", ") || "none"})`)
    .join("\n");

  return [
    `Goal: ${graph.metadata.goal}`,
    `Progress: ${progress.completed}/${progress.total} steps completed`,
    `\nCompleted steps:\n${completedSteps || "  (none)"}`,
    `\nFailed step:\n  - ${failedStep?.id}: ${failedStep?.name}\n  Error: ${observation.error ?? observation.reason}`,
    `\nRemaining pending steps:\n${pendingSteps || "  (none)"}`,
    `\nProduce a revised plan for the remaining work:`,
  ].join("\n");
}

function parseReplanResponse(text: string): { reasoning: string; steps: RawStep[] } {
  try {
    const parsed = JSON.parse(text);
    return {
      reasoning: parsed.reasoning ?? "",
      steps: Array.isArray(parsed.steps) ? parsed.steps : [],
    };
  } catch {
    logger.warn({ text: text.slice(0, 200) }, "Failed to parse replan response");
    return { reasoning: "Failed to parse LLM replan response", steps: [] };
  }
}

interface RawStep {
  id?: string;
  name?: string;
  description?: string;
  dependsOn?: string[];
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}
