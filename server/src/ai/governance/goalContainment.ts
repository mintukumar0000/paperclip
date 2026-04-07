// ---------------------------------------------------------------------------
// Goal Containment — prevents Recursive Goal Amplification (RGA)
// ---------------------------------------------------------------------------
// Enforces three limits:
//   1. Goal Depth Limit   — max tree depth for derived goals
//   2. Goal Fan-Out Limit — max child goals per parent
//   3. Active Goal Budget — max active goals per company
//
// Also limits tasks generated per planning cycle.
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { goals } from "@paperclipai/db";
import { eq, and, inArray } from "@paperclipai/db";
import pino from "pino";
import { eventBus } from "../../events/eventBus.js";
import { getAutonomyLimits } from "./autonomyLimits.js";

const logger = pino({ name: "goal-containment" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoalContainmentCheck {
  allowed: boolean;
  reason?: string;
  currentDepth?: number;
  maxDepth?: number;
  currentChildren?: number;
  maxChildren?: number;
  activeGoals?: number;
  maxActiveGoals?: number;
}

// ---------------------------------------------------------------------------
// Core enforcement
// ---------------------------------------------------------------------------

/**
 * Check whether creating a new goal is allowed under containment rules.
 * Call this BEFORE inserting any goal into the database.
 */
export async function canCreateGoal(
  db: Db,
  companyId: string,
  parentId?: string | null,
): Promise<GoalContainmentCheck> {
  const limits = getAutonomyLimits();

  // 1. Active Goal Budget — max goals per company
  const companyGoals = await db
    .select({ id: goals.id, status: goals.status })
    .from(goals)
    .where(eq(goals.companyId, companyId));

  const activeGoals = companyGoals.filter(
    (g) => g.status !== "achieved" && g.status !== "cancelled",
  ).length;

  if (activeGoals >= limits.maxActiveGoalsPerCompany) {
    const reason = `Active goal budget exhausted (${activeGoals}/${limits.maxActiveGoalsPerCompany}). Finish existing goals before creating new ones.`;
    emitContainmentEvent(companyId, "active_goal_budget", {
      activeGoals,
      max: limits.maxActiveGoalsPerCompany,
    });
    emitGoalRejectedEvent(companyId, reason, { limitType: "active_goal_budget" });
    emitGoalLimitReachedEvent(companyId, "active_goal_budget", activeGoals, limits.maxActiveGoalsPerCompany);
    logger.warn({ companyId, activeGoals, max: limits.maxActiveGoalsPerCompany }, reason);
    return { allowed: false, reason, activeGoals, maxActiveGoals: limits.maxActiveGoalsPerCompany };
  }

  // 2. If no parent, this is a root goal — always allowed (depth = 1)
  if (!parentId) {
    return { allowed: true, currentDepth: 0, maxDepth: limits.maxGoalDepth, activeGoals, maxActiveGoals: limits.maxActiveGoalsPerCompany };
  }

  // 3. Goal Cycle Detection — ensure parentId doesn't create a cycle
  const hasCycle = await detectGoalCycle(db, parentId);
  if (hasCycle) {
    const reason = `Goal cycle detected: parent ${parentId} is part of a circular chain. Cannot create circular goal hierarchies.`;
    emitContainmentEvent(companyId, "cycle_detected", { parentId });
    emitGoalRejectedEvent(companyId, reason, { limitType: "cycle_detected", parentId });
    emitGoalLimitReachedEvent(companyId, "cycle_detected", 0, 0);
    eventBus.publish("goal.containment.cycle_detected", {
      companyId,
      parentId,
      timestamp: new Date().toISOString(),
    });
    logger.warn({ companyId, parentId }, reason);
    return { allowed: false, reason };
  }

  // 4. Goal Depth Limit — walk up the parent chain
  const depth = await getGoalDepth(db, parentId);
  const newDepth = depth + 1;

  if (newDepth >= limits.maxGoalDepth) {
    const reason = `Goal depth limit reached (depth ${newDepth}/${limits.maxGoalDepth}). Cannot derive deeper goals.`;
    emitContainmentEvent(companyId, "goal_depth", {
      currentDepth: newDepth,
      max: limits.maxGoalDepth,
      parentId,
    });
    emitGoalRejectedEvent(companyId, reason, { limitType: "goal_depth", parentId });
    emitGoalLimitReachedEvent(companyId, "goal_depth", newDepth, limits.maxGoalDepth);
    logger.warn({ companyId, parentId, depth: newDepth, max: limits.maxGoalDepth }, reason);
    return { allowed: false, reason, currentDepth: newDepth, maxDepth: limits.maxGoalDepth };
  }

  // 5. Goal Fan-Out Limit — count existing children of the parent
  const childCount = await countChildGoals(db, parentId);

  if (childCount >= limits.maxChildGoals) {
    const reason = `Goal fan-out limit reached (${childCount}/${limits.maxChildGoals} children for parent ${parentId}). Parent goal has too many sub-goals.`;
    emitContainmentEvent(companyId, "goal_fan_out", {
      parentId,
      childCount,
      max: limits.maxChildGoals,
    });
    emitGoalRejectedEvent(companyId, reason, { limitType: "goal_fan_out", parentId });
    emitGoalLimitReachedEvent(companyId, "goal_fan_out", childCount, limits.maxChildGoals);
    logger.warn({ companyId, parentId, childCount, max: limits.maxChildGoals }, reason);
    return { allowed: false, reason, currentChildren: childCount, maxChildren: limits.maxChildGoals };
  }

  return {
    allowed: true,
    currentDepth: newDepth,
    maxDepth: limits.maxGoalDepth,
    currentChildren: childCount,
    maxChildren: limits.maxChildGoals,
    activeGoals,
    maxActiveGoals: limits.maxActiveGoalsPerCompany,
  };
}

/**
 * Cap the number of tasks generated in a single planning cycle.
 * Returns the trimmed list if it exceeds the limit.
 */
export function capPlanningTasks<T>(tasks: T[], companyId?: string): T[] {
  const max = getAutonomyLimits().maxTasksPerPlanCycle;
  if (tasks.length <= max) return tasks;

  if (companyId) {
    emitContainmentEvent(companyId, "task_fan_out", {
      generated: tasks.length,
      max,
    });
    logger.warn(
      { companyId, generated: tasks.length, max },
      `Planning cycle task cap hit — trimming from ${tasks.length} to ${max}`,
    );
  }
  return tasks.slice(0, max);
}

/**
 * Get the current goal tree stats for a company (for dashboards).
 */
export async function getGoalContainmentStats(
  db: Db,
  companyId: string,
): Promise<{
  totalGoals: number;
  activeGoals: number;
  maxActiveGoals: number;
  maxDepth: number;
  maxChildGoals: number;
  maxTasksPerPlanCycle: number;
  deepestGoalDepth: number;
}> {
  const limits = getAutonomyLimits();
  const allGoals = await db
    .select({ id: goals.id, status: goals.status, parentId: goals.parentId })
    .from(goals)
    .where(eq(goals.companyId, companyId));

  const activeGoals = allGoals.filter(
    (g) => g.status !== "achieved" && g.status !== "cancelled",
  ).length;

  // Find deepest depth by traversing parent chains
  let deepest = 0;
  const rootGoals = allGoals.filter((g) => !g.parentId);
  const childMap = new Map<string, string[]>();
  for (const g of allGoals) {
    if (g.parentId) {
      const children = childMap.get(g.parentId) ?? [];
      children.push(g.id);
      childMap.set(g.parentId, children);
    }
  }

  function walkDepth(goalId: string, depth: number) {
    if (depth > deepest) deepest = depth;
    const children = childMap.get(goalId) ?? [];
    for (const childId of children) {
      walkDepth(childId, depth + 1);
    }
  }

  for (const root of rootGoals) {
    walkDepth(root.id, 1);
  }

  return {
    totalGoals: allGoals.length,
    activeGoals,
    maxActiveGoals: limits.maxActiveGoalsPerCompany,
    maxDepth: limits.maxGoalDepth,
    maxChildGoals: limits.maxChildGoals,
    maxTasksPerPlanCycle: limits.maxTasksPerPlanCycle,
    deepestGoalDepth: deepest,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect cycles in the goal parent chain.
 * Walks up from the given goalId and checks if it revisits any node.
 * Returns true if a cycle is detected (A→B→C→A).
 */
async function detectGoalCycle(db: Db, goalId: string): Promise<boolean> {
  const visited = new Set<string>();
  let currentId: string | null = goalId;
  const MAX_WALK = 100;
  let walked = 0;

  while (currentId && walked < MAX_WALK) {
    if (visited.has(currentId)) return true; // cycle found
    visited.add(currentId);
    walked++;

    const rows = await db
      .select({ parentId: goals.parentId })
      .from(goals)
      .where(eq(goals.id, currentId));
    const row = rows[0] ?? null;

    if (!row) break;
    currentId = row.parentId;
  }

  return false;
}

/** Walk up the parent chain to determine goal depth (1-based: root = 1) */
async function getGoalDepth(db: Db, goalId: string): Promise<number> {
  let depth = 0;
  let currentId: string | null = goalId;

  // Safety: hard cap at 100 iterations to prevent infinite loops if data is corrupt
  const MAX_WALK = 100;
  let walked = 0;

  while (currentId && walked < MAX_WALK) {
    walked++;
    const rows = await db
      .select({ parentId: goals.parentId })
      .from(goals)
      .where(eq(goals.id, currentId));
    const row = rows[0] ?? null;

    if (!row) break; // goal not found — stop
    depth++;
    currentId = row.parentId;
  }

  return depth;
}

/** Count how many direct child goals a parent has */
async function countChildGoals(db: Db, parentId: string): Promise<number> {
  const children = await db
    .select({ id: goals.id })
    .from(goals)
    .where(eq(goals.parentId, parentId));

  return children.length;
}

/** Emit goal containment event for telemetry */
function emitContainmentEvent(
  companyId: string,
  limitType: string,
  metadata: Record<string, unknown>,
) {
  eventBus.publish("goal.limit.hit", {
    companyId,
    limitType,
    ...metadata,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Emit a telemetry event when a goal is successfully created under containment.
 * Useful for tracking headroom usage.
 */
export function emitGoalCreatedEvent(
  companyId: string,
  goalId: string,
  depth: number,
  parentId?: string | null,
) {
  eventBus.publish("goal.containment.created", {
    companyId,
    goalId,
    depth,
    parentId: parentId ?? null,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Emit event when a planning cycle is capped.
 * Tracks how often the system is hitting the planning cap.
 */
export function emitPlanningCapEvent(
  companyId: string,
  requestedTasks: number,
  allowedTasks: number,
) {
  eventBus.publish("goal.containment.planning_capped", {
    companyId,
    requestedTasks,
    allowedTasks,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Emit event when a goal creation is rejected by containment checks.
 * Tracks how often the system blocks goal creation.
 */
export function emitGoalRejectedEvent(
  companyId: string,
  reason: string,
  metadata: Record<string, unknown> = {},
) {
  eventBus.publish("goal.containment.rejected", {
    companyId,
    reason,
    ...metadata,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Emit event when a specific containment limit is reached (cap hit).
 * Tracks which limits are being hit most frequently.
 */
export function emitGoalLimitReachedEvent(
  companyId: string,
  limitType: "active_goal_budget" | "goal_depth" | "goal_fan_out" | "cycle_detected",
  current: number,
  max: number,
) {
  eventBus.publish("goal.containment.limit_reached", {
    companyId,
    limitType,
    current,
    max,
    timestamp: new Date().toISOString(),
  });
}
