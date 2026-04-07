// ---------------------------------------------------------------------------
// Goal Planner — LLM-driven plan generation from high-level goals
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { AIExecutionContext, LLMAdapter } from "../types.js";
import { getLLMAdapter } from "../router/llmRouter.js";
import { createTaskGraph, addStep, type TaskGraph, type TaskStep } from "./taskGraph.js";
import { getAutonomyLimits } from "../governance/autonomyLimits.js";
import pino from "pino";

const logger = pino({ name: "goal-planner" });

export interface PlanRequest {
  goal: string;
  context: AIExecutionContext;
  maxSteps?: number;
}

export interface PlanResult {
  graph: TaskGraph;
  reasoning: string;
}

const PLANNING_SYSTEM_PROMPT = `You are an autonomous AI planning engine. Given a goal and context, produce a step-by-step execution plan.

Rules:
1. Each step must be a concrete, executable action (tool call or sub-task).
2. Steps can depend on previous steps (specify by step ID).
3. Keep plans minimal — no more than the requested max steps.
4. Each step should have: id, name, description, dependsOn (array of step IDs), toolName (optional), toolArgs (optional).

Available tools: create_issue, update_issue, send_message, store_memory

Respond with a JSON object:
{
  "reasoning": "Brief explanation of the plan",
  "steps": [
    {
      "id": "step-1",
      "name": "Step name",
      "description": "What this step does",
      "dependsOn": [],
      "toolName": "tool_name_or_null",
      "toolArgs": {}
    }
  ]
}

Respond ONLY with valid JSON, no markdown fencing.`;

/** Generate an execution plan from a goal using LLM reasoning */
export async function generatePlan(request: PlanRequest): Promise<PlanResult> {
  const { goal, context, maxSteps = 10 } = request;
  // Hard-enforce max steps from global limits — LLM cannot exceed this
  const globalMax = getAutonomyLimits().maxTasksPerPlanCycle;
  const effectiveMax = Math.min(maxSteps, globalMax);
  const adapter = getLLMAdapter(context.agent.runtime ?? "openai");

  const prompt = buildPlanningPrompt(goal, context, effectiveMax);

  logger.info({ goal, agentId: context.agent.id, maxSteps: effectiveMax }, "Generating plan");

  const response = await adapter.generate({
    prompt,
    systemPrompt: PLANNING_SYSTEM_PROMPT,
    temperature: 0.3,
    maxTokens: 2000,
  });

  const parsed = parsePlanResponse(response.text ?? "{}");
  // Hard-truncate steps even if LLM ignored the limit
  const truncatedSteps = parsed.steps.slice(0, effectiveMax);
  const graph = buildGraphFromSteps(goal, truncatedSteps);

  logger.info(
    { goal, stepCount: graph.steps.length, reasoning: parsed.reasoning, truncated: parsed.steps.length > effectiveMax },
    "Plan generated",
  );

  return { graph, reasoning: parsed.reasoning };
}

/** Build a plan without LLM — for deterministic / rule-based planning */
export function generateDeterministicPlan(
  goal: string,
  steps: Array<{
    name: string;
    description: string;
    dependsOn?: string[];
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    maxRetries?: number;
  }>,
): TaskGraph {
  let graph = createTaskGraph(goal);
  for (const step of steps) {
    graph = addStep(graph, {
      id: `step-${randomUUID().slice(0, 8)}`,
      name: step.name,
      description: step.description,
      dependsOn: step.dependsOn ?? [],
      toolName: step.toolName,
      toolArgs: step.toolArgs,
      maxRetries: step.maxRetries ?? 2,
    });
  }
  return graph;
}

function buildPlanningPrompt(goal: string, context: AIExecutionContext, maxSteps: number): string {
  const parts: string[] = [
    `Goal: ${goal}`,
    `Agent: ${context.agent.name} (${context.agent.role ?? "general"})`,
    `Issue: ${context.issue.title} [${context.issue.status ?? "open"}]`,
  ];

  if (context.issue.description) {
    parts.push(`Issue Description: ${context.issue.description}`);
  }
  if (context.memoryContext) {
    parts.push(`Memory Context:\n${context.memoryContext}`);
  }

  parts.push(`\nMax steps allowed: ${maxSteps}`);
  parts.push("Generate the execution plan:");

  return parts.join("\n");
}

function parsePlanResponse(text: string): { reasoning: string; steps: RawStep[] } {
  try {
    const parsed = JSON.parse(text);
    return {
      reasoning: parsed.reasoning ?? "",
      steps: Array.isArray(parsed.steps) ? parsed.steps : [],
    };
  } catch {
    logger.warn({ text: text.slice(0, 200) }, "Failed to parse plan response, returning empty");
    return { reasoning: "Failed to parse LLM response", steps: [] };
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

function buildGraphFromSteps(goal: string, rawSteps: RawStep[]): TaskGraph {
  let graph = createTaskGraph(goal);

  for (let i = 0; i < rawSteps.length; i++) {
    const raw = rawSteps[i];
    graph = addStep(graph, {
      id: raw.id ?? `step-${i + 1}`,
      name: raw.name ?? `Step ${i + 1}`,
      description: raw.description ?? "",
      dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn : [],
      toolName: raw.toolName ?? undefined,
      toolArgs: raw.toolArgs ?? undefined,
      maxRetries: 2,
    });
  }

  return graph;
}
