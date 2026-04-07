// ---------------------------------------------------------------------------
// Task Delegator — CEO/manager agents delegate tasks to specialized agents
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { agentPlans, agents, issues } from "@paperclipai/db";
import { eq, and, sql } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import type { AgentProfile } from "../agents/agentProfiles.js";
import { loadCompanyProfiles, loadAgentProfile } from "../agents/agentProfiles.js";
import { publishEvent } from "../../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "task-delegator" });

export interface DelegationRequest {
  companyId: string;
  fromAgentId: string;
  taskType: string;
  goal: string;
  issueId?: string;
  preferredAgentId?: string;
  context?: string;
}

export interface DelegationResult {
  delegated: boolean;
  toAgentId?: string;
  toAgentName?: string;
  toAgentRole?: string;
  reason: string;
}

/**
 * Delegate a task from a manager agent to the best available specialist.
 * 
 * Selection logic:
 *   1. If preferredAgentId is set and available, use it
 *   2. Find agents whose role matches the task type
 *   3. Score with task match, budget headroom, priority, workload, and execution time
 *   4. Fall back to general agents
 *   5. On failure, attempt fallback to alternate agent
 */
export async function delegateTask(
  db: Db,
  request: DelegationRequest,
): Promise<DelegationResult> {
  const { companyId, fromAgentId, taskType, goal, preferredAgentId } = request;

  // Verify the delegator has delegation authority
  const from = await loadAgentProfile(db, fromAgentId);
  if (!from) {
    return { delegated: false, reason: "Delegating agent not found" };
  }
  if (!from.canDelegate) {
    return { delegated: false, reason: `Agent "${from.name}" (${from.role}) cannot delegate tasks` };
  }

  // Load available agents and their workload
  const profiles = await loadCompanyProfiles(db, companyId);
  const workloads = await getAgentWorkloads(db, companyId);
  const candidates = selectCandidates(profiles, taskType, fromAgentId, workloads, preferredAgentId);

  if (candidates.length === 0) {
    logger.warn({ companyId, taskType, fromAgentId }, "No candidate agents for delegation");
    return { delegated: false, reason: `No available agent can handle task type "${taskType}"` };
  }

  const selected = candidates[0];

  // Mark the delegatee as running
  await db
    .update(agents)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(agents.id, selected.id));

  await publishEvent("agent.dispatched", {
    companyId,
    fromAgentId,
    toAgentId: selected.id,
    toAgentName: selected.name,
    taskType,
    goal,
  });

  logger.info(
    { companyId, from: from.name, to: selected.name, taskType, goal },
    "Task delegated",
  );

  return {
    delegated: true,
    toAgentId: selected.id,
    toAgentName: selected.name,
    toAgentRole: selected.role,
    reason: `Delegated to ${selected.name} (${selected.role})`,
  };
}

/** Agent workload info from active issue counts */
export interface AgentWorkload {
  agentId: string;
  activeTaskCount: number;
}

/** Get active task (issue) counts per agent in a company */
export async function getAgentWorkloads(
  db: Db,
  companyId: string,
): Promise<Map<string, AgentWorkload>> {
  const rows = await db
    .select({
      agentId: issues.assigneeAgentId,
      count: sql<number>`count(*)::int`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        sql`${issues.status} IN ('in_progress', 'todo')`,
      ),
    )
    .groupBy(issues.assigneeAgentId);

  const map = new Map<string, AgentWorkload>();
  for (const r of rows) {
    if (r.agentId) {
      map.set(r.agentId, { agentId: r.agentId, activeTaskCount: Number(r.count) });
    }
  }
  return map;
}

/** Select and rank candidate agents for a task with workload balancing */
function selectCandidates(
  profiles: AgentProfile[],
  taskType: string,
  excludeAgentId: string,
  workloads: Map<string, AgentWorkload>,
  preferredAgentId?: string,
): AgentProfile[] {
  // Filter to active, non-delegator agents (or the preferred one)
  const available = profiles.filter(
    (p) => p.id !== excludeAgentId && p.status === "active",
  );

  // If a preferred agent is specified, try it first
  if (preferredAgentId) {
    const preferred = available.find((p) => p.id === preferredAgentId);
    if (preferred && preferred.taskTypes.includes(taskType)) {
      return [preferred, ...available.filter((p) => p.id !== preferredAgentId)];
    }
  }

  // Score candidates: task match + budget headroom + priority + workload balance
  const scored = available.map((p) => {
    let score = 0;

    // Task type match (+100)
    if (p.taskTypes.includes(taskType)) score += 100;

    // Budget utilization: prefer agents with more budget remaining (+0 to +50)
    if (p.budgetMonthlyCents > 0) {
      const utilizationRatio = p.spentMonthlyCents / p.budgetMonthlyCents;
      score += Math.round((1 - utilizationRatio) * 50);
    } else {
      score += 25; // no budget constraint = medium score
    }

    // Workload balancing: penalize agents with many active tasks (-15 per task)
    const workload = workloads.get(p.id);
    const taskCount = workload?.activeTaskCount ?? 0;
    score -= taskCount * 15;

    // Priority: lower priority number = more senior
    score -= p.roleDefinition.priority;

    return { profile: p, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .map((s) => s.profile);
}

/**
 * Delegate with automatic fallback on failure.
 *
 * If the primary agent fails (status = "error"), the task is re-delegated
 * to the next best candidate, excluding the failed agent.
 */
export async function delegateWithFallback(
  db: Db,
  request: DelegationRequest,
  failedAgentIds: string[] = [],
): Promise<DelegationResult> {
  const { companyId, fromAgentId, taskType, goal, preferredAgentId } = request;

  const from = await loadAgentProfile(db, fromAgentId);
  if (!from) {
    return { delegated: false, reason: "Delegating agent not found" };
  }
  if (!from.canDelegate) {
    return { delegated: false, reason: `Agent "${from.name}" (${from.role}) cannot delegate tasks` };
  }

  const profiles = await loadCompanyProfiles(db, companyId);
  const workloads = await getAgentWorkloads(db, companyId);

  // Exclude previously failed agents
  const eligible = profiles.filter((p) => !failedAgentIds.includes(p.id));
  const candidates = selectCandidates(eligible, taskType, fromAgentId, workloads, preferredAgentId);

  if (candidates.length === 0) {
    logger.warn(
      { companyId, taskType, failedAgentIds },
      "No fallback agents available after failures",
    );
    return {
      delegated: false,
      reason: `No fallback agent available for "${taskType}" (${failedAgentIds.length} agent(s) already failed)`,
    };
  }

  const selected = candidates[0];

  await db
    .update(agents)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(agents.id, selected.id));

  await publishEvent("collaboration.task.delegated", {
    companyId,
    fromAgentId,
    toAgentId: selected.id,
    toAgentName: selected.name,
    taskType,
    goal,
    isFallback: failedAgentIds.length > 0,
    failedAgentIds,
  });

  logger.info(
    { companyId, from: from.name, to: selected.name, taskType, failedCount: failedAgentIds.length },
    "Task delegated (with fallback support)",
  );

  return {
    delegated: true,
    toAgentId: selected.id,
    toAgentName: selected.name,
    toAgentRole: selected.role,
    reason: failedAgentIds.length > 0
      ? `Fallback delegation to ${selected.name} (${selected.role}) after ${failedAgentIds.length} failure(s)`
      : `Delegated to ${selected.name} (${selected.role})`,
  };
}

/** Check if any agent in the company can handle a task type */
export async function canDelegateTaskType(
  db: Db,
  companyId: string,
  taskType: string,
): Promise<boolean> {
  const profiles = await loadCompanyProfiles(db, companyId);
  return profiles.some((p) => p.taskTypes.includes(taskType));
}
