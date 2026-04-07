// ---------------------------------------------------------------------------
// Collaboration Planner — builds multi-agent execution plans from goals
// ---------------------------------------------------------------------------
//
// Given a high-level goal, this planner:
//   1. Analyzes the goal to identify required task types
//   2. Maps task types to agent roles via the Agent Router
//   3. Creates a multi-agent TaskGraph with agent assignments
//   4. Resolves cross-agent dependencies
//
// The resulting plan feeds into the existing company execution loop.
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import { createTaskGraph, addStep, type TaskGraph } from "../planning/taskGraph.js";
import { routeTask } from "../coordination/agentRouter.js";
import { findDelegator, loadCompanyProfiles, type AgentProfile } from "../agents/agentProfiles.js";
import { sendAgentMessage } from "../coordination/agentMessenger.js";
import { publishEvent } from "../../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "collaboration-planner" });

/** A single task in the collaboration plan before it's added to the graph */
export interface CollaborationTask {
  name: string;
  description: string;
  taskType: string;
  requiredCapabilities?: string[];
  dependsOn?: string[];
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}

export interface CollaborationPlanRequest {
  companyId: string;
  goal: string;
  tasks: CollaborationTask[];
  issueId?: string;
  initiatorAgentId?: string;
}

export interface CollaborationPlanResult {
  graph: TaskGraph;
  assignments: TaskAssignment[];
  unassigned: string[];
}

export interface TaskAssignment {
  stepId: string;
  taskName: string;
  taskType: string;
  agentId: string;
  agentName: string;
  agentRole: string;
}

/**
 * Build a multi-agent collaboration plan.
 *
 * For each task:
 *   - Route to the best agent via the Agent Router
 *   - Annotate the TaskGraph step with the agent assignment
 *   - Notify the assigned agent via the Agent Messenger
 */
export async function buildCollaborationPlan(
  db: Db,
  request: CollaborationPlanRequest,
): Promise<CollaborationPlanResult> {
  const { companyId, goal, tasks, initiatorAgentId } = request;

  let graph = createTaskGraph(goal);
  const assignments: TaskAssignment[] = [];
  const unassigned: string[] = [];

  // Step ID mapping for dependsOn resolution
  const nameToStepId = new Map<string, string>();

  for (const task of tasks) {
    const stepId = `step-${randomUUID().slice(0, 8)}`;
    nameToStepId.set(task.name, stepId);

    // Route to the best agent
    const routeResult = await routeTask(db, {
      companyId,
      taskType: task.taskType,
      requiredCapabilities: task.requiredCapabilities,
    });

    // Resolve dependsOn names to step IDs
    const resolvedDeps = (task.dependsOn ?? [])
      .map((depName) => nameToStepId.get(depName))
      .filter((id): id is string => id != null);

    graph = addStep(graph, {
      id: stepId,
      name: task.name,
      description: task.description,
      dependsOn: resolvedDeps,
      toolName: task.toolName,
      toolArgs: {
        ...task.toolArgs,
        // Annotate with agent assignment
        __assignedAgentId: routeResult.agent?.id,
        __assignedAgentName: routeResult.agent?.name,
        __assignedAgentRole: routeResult.agent?.role,
        __taskType: task.taskType,
      },
      maxRetries: 2,
    });

    if (routeResult.matched && routeResult.agent) {
      assignments.push({
        stepId,
        taskName: task.name,
        taskType: task.taskType,
        agentId: routeResult.agent.id,
        agentName: routeResult.agent.name,
        agentRole: routeResult.agent.role,
      });

      // Notify assigned agent
      if (initiatorAgentId && initiatorAgentId !== routeResult.agent.id) {
        await sendAgentMessage(db, {
          companyId,
          fromAgentId: initiatorAgentId,
          toAgentId: routeResult.agent.id,
          message: `Assigned task "${task.name}": ${task.description}`,
          messageType: "task_assignment",
        });
      }
    } else {
      unassigned.push(task.name);
    }
  }

  await publishEvent("ai.goal.created", {
    companyId,
    goal,
    totalSteps: graph.steps.length,
    assignments: assignments.length,
    unassigned: unassigned.length,
  });

  logger.info(
    {
      companyId,
      goal,
      totalTasks: tasks.length,
      assigned: assignments.length,
      unassigned: unassigned.length,
    },
    "Collaboration plan built",
  );

  return { graph, assignments, unassigned };
}

/**
 * Classify a goal into constituent task types (deterministic heuristic).
 * This is a simple keyword-based classifier. LLM-driven classification
 * can be layered on top via the goal planner.
 */
export function classifyGoalTasks(goal: string): string[] {
  const lower = goal.toLowerCase();
  const types: string[] = [];

  const keywords: Record<string, string[]> = {
    engineering:   ["build", "implement", "code", "develop", "fix", "debug", "feature", "api", "endpoint"],
    design:        ["design", "ui", "ux", "wireframe", "prototype", "visual", "layout"],
    testing:       ["test", "qa", "quality", "validate", "verify", "coverage"],
    deployment:    ["deploy", "release", "ci/cd", "pipeline", "infrastructure", "server"],
    marketing:     ["marketing", "campaign", "content", "social", "brand", "promotion", "seo"],
    research:      ["research", "analyze", "investigate", "study", "explore", "evaluate"],
    planning:      ["plan", "strategy", "roadmap", "prioritize", "schedule", "milestone"],
    finance:       ["budget", "cost", "revenue", "financial", "expense", "invoice"],
  };

  for (const [taskType, kws] of Object.entries(keywords)) {
    if (kws.some((kw) => lower.includes(kw))) {
      types.push(taskType);
    }
  }

  return types.length > 0 ? types : ["general"];
}

/**
 * Auto-generate a collaboration plan from a goal string.
 * Uses keyword classification + agent routing.
 */
export async function autoCollaborationPlan(
  db: Db,
  companyId: string,
  goal: string,
  issueId?: string,
): Promise<CollaborationPlanResult> {
  const taskTypes = classifyGoalTasks(goal);

  // Find the delegator (CEO)
  const delegator = await findDelegator(db, companyId);

  const tasks: CollaborationTask[] = taskTypes.map((taskType, i) => ({
    name: `${taskType}_task_${i + 1}`,
    description: `Handle the ${taskType} aspect of: ${goal}`,
    taskType,
    dependsOn: i > 0 && needsDependency(taskTypes[i - 1], taskType)
      ? [taskTypes[i - 1] + `_task_${i}`]
      : [],
  }));

  return buildCollaborationPlan(db, {
    companyId,
    goal,
    tasks,
    issueId,
    initiatorAgentId: delegator?.id,
  });
}

/** Determine if task B depends on task A */
function needsDependency(taskTypeA: string, taskTypeB: string): boolean {
  const deps: Record<string, string[]> = {
    testing:    ["engineering", "implementation"],
    deployment: ["engineering", "testing"],
    marketing:  ["planning"],
  };
  return deps[taskTypeB]?.includes(taskTypeA) ?? false;
}
