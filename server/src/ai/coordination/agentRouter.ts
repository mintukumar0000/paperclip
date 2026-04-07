// ---------------------------------------------------------------------------
// Agent Router — route tasks to the best available agent by type/capability
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { loadCompanyProfiles, type AgentProfile } from "../agents/agentProfiles.js";
import { getAgentWorkloads } from "./taskDelegator.js";
import pino from "pino";

const logger = pino({ name: "agent-router" });

export interface RouteRequest {
  companyId: string;
  taskType: string;
  requiredCapabilities?: string[];
  excludeAgentIds?: string[];
}

export interface RouteResult {
  matched: boolean;
  agent?: AgentProfile;
  alternates: AgentProfile[];
  reason: string;
}

/**
 * Route a task to the best available agent based on task type and capabilities.
 *
 * Scoring:
 *   +100 — task type matches agent's role task types
 *   +20 per matching required capability
 *   +50 — budget headroom (1 - spend ratio) * 50
 *   -priority — higher-priority roles get slight preference
 *   -15 per active task — workload balancing
 */
export async function routeTask(
  db: Db,
  request: RouteRequest,
): Promise<RouteResult> {
  const { companyId, taskType, requiredCapabilities = [], excludeAgentIds = [] } = request;

  const profiles = await loadCompanyProfiles(db, companyId);
  const available = profiles.filter(
    (p) => !excludeAgentIds.includes(p.id),
  );

  if (available.length === 0) {
    return { matched: false, alternates: [], reason: "No active agents in company" };
  }

  // Load workload info for balancing
  const workloads = await getAgentWorkloads(db, companyId);

  const scored = available.map((p) => {
    let score = 0;

    // Task type match
    if (p.taskTypes.includes(taskType)) score += 100;

    // Capability match
    for (const cap of requiredCapabilities) {
      if (p.capabilities.includes(cap)) score += 20;
    }

    // Budget headroom
    if (p.budgetMonthlyCents > 0) {
      const ratio = p.spentMonthlyCents / p.budgetMonthlyCents;
      score += Math.round((1 - Math.min(ratio, 1)) * 50);
    } else {
      score += 25;
    }

    // Priority bonus (lower priority = more senior)
    score -= p.roleDefinition.priority;

    // Workload balancing: penalize agents with many active tasks
    const wl = workloads.get(p.id);
    score -= (wl?.activeTaskCount ?? 0) * 15;

    return { profile: p, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best.score <= 0) {
    return {
      matched: false,
      alternates: scored.map((s) => s.profile),
      reason: `No agent scored positively for task type "${taskType}"`,
    };
  }

  logger.info(
    { companyId, taskType, agentId: best.profile.id, agentName: best.profile.name, score: best.score },
    "Task routed to agent",
  );

  return {
    matched: true,
    agent: best.profile,
    alternates: scored.slice(1).map((s) => s.profile),
    reason: `Routed to ${best.profile.name} (${best.profile.role}) with score ${best.score}`,
  };
}

/**
 * Route a task type to all capable agents (for parallel execution).
 */
export async function routeToAll(
  db: Db,
  companyId: string,
  taskType: string,
): Promise<AgentProfile[]> {
  const profiles = await loadCompanyProfiles(db, companyId);
  return profiles.filter((p) => p.taskTypes.includes(taskType));
}

/**
 * Get the organizational hierarchy for a company.
 * Returns agents sorted by priority (CEO first).
 */
export async function getHierarchy(
  db: Db,
  companyId: string,
): Promise<AgentProfile[]> {
  const profiles = await loadCompanyProfiles(db, companyId);
  return profiles.sort((a, b) => a.roleDefinition.priority - b.roleDefinition.priority);
}
