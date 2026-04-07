// ---------------------------------------------------------------------------
// Agent Budget — per-agent spending controls and enforcement
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "@paperclipai/db";
import { publishEvent } from "../../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "agent-budget" });

export interface BudgetStatus {
  agentId: string;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  remainingCents: number;
  utilizationPercent: number;
  isOverBudget: boolean;
  isNearLimit: boolean; // >80%
}

/** Threshold at which we warn about budget usage */
const BUDGET_WARNING_THRESHOLD = 0.8;

/**
 * Check an agent's budget status.
 */
export async function checkBudget(
  db: Db,
  agentId: string,
): Promise<BudgetStatus> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }

  const budget = agent.budgetMonthlyCents;
  const spent = agent.spentMonthlyCents;
  const remaining = Math.max(0, budget - spent);
  const utilization = budget > 0 ? spent / budget : 0;

  return {
    agentId,
    budgetMonthlyCents: budget,
    spentMonthlyCents: spent,
    remainingCents: remaining,
    utilizationPercent: Math.round(utilization * 100),
    isOverBudget: budget > 0 && spent >= budget,
    isNearLimit: budget > 0 && utilization >= BUDGET_WARNING_THRESHOLD,
  };
}

/**
 * Record spending for an agent and enforce budget limits.
 * Returns false if the agent is over budget (hard stop).
 */
export async function recordSpending(
  db: Db,
  agentId: string,
  costCents: number,
): Promise<{ allowed: boolean; newSpent: number; reason?: string }> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) {
    return { allowed: false, newSpent: 0, reason: "Agent not found" };
  }

  const newSpent = agent.spentMonthlyCents + costCents;

  // Budget hard-stop: if budget is set and would be exceeded, block
  if (agent.budgetMonthlyCents > 0 && newSpent > agent.budgetMonthlyCents) {
    logger.warn(
      { agentId, budget: agent.budgetMonthlyCents, spent: newSpent, costCents },
      "Agent budget exceeded — hard stop",
    );

    // Pause the agent
    await db
      .update(agents)
      .set({ status: "paused", updatedAt: new Date() })
      .where(eq(agents.id, agentId));

    await publishEvent("agent.paused", {
      agentId,
      companyId: agent.companyId,
      reason: "budget_exceeded",
      budget: agent.budgetMonthlyCents,
      spent: newSpent,
    });

    return {
      allowed: false,
      newSpent: agent.spentMonthlyCents,
      reason: `Budget exceeded: ${newSpent} > ${agent.budgetMonthlyCents} cents`,
    };
  }

  // Update spending
  await db
    .update(agents)
    .set({
      spentMonthlyCents: newSpent,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, agentId));

  // Warn if approaching limit
  if (agent.budgetMonthlyCents > 0) {
    const utilization = newSpent / agent.budgetMonthlyCents;
    if (utilization >= BUDGET_WARNING_THRESHOLD) {
      logger.info(
        { agentId, utilization: Math.round(utilization * 100), budget: agent.budgetMonthlyCents },
        "Agent approaching budget limit",
      );
    }
  }

  return { allowed: true, newSpent };
}

/**
 * Get budget summary for all agents in a company.
 */
export async function getCompanyBudgetSummary(
  db: Db,
  companyId: string,
): Promise<{
  agents: BudgetStatus[];
  totalBudgetCents: number;
  totalSpentCents: number;
  overBudgetCount: number;
}> {
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.companyId, companyId));

  const statuses: BudgetStatus[] = rows.map((a) => {
    const budget = a.budgetMonthlyCents;
    const spent = a.spentMonthlyCents;
    const remaining = Math.max(0, budget - spent);
    const utilization = budget > 0 ? spent / budget : 0;
    return {
      agentId: a.id,
      budgetMonthlyCents: budget,
      spentMonthlyCents: spent,
      remainingCents: remaining,
      utilizationPercent: Math.round(utilization * 100),
      isOverBudget: budget > 0 && spent >= budget,
      isNearLimit: budget > 0 && utilization >= BUDGET_WARNING_THRESHOLD,
    };
  });

  return {
    agents: statuses,
    totalBudgetCents: statuses.reduce((sum, s) => sum + s.budgetMonthlyCents, 0),
    totalSpentCents: statuses.reduce((sum, s) => sum + s.spentMonthlyCents, 0),
    overBudgetCount: statuses.filter((s) => s.isOverBudget).length,
  };
}

/**
 * Check if an agent can afford a given cost.
 */
export async function canAfford(
  db: Db,
  agentId: string,
  costCents: number,
): Promise<boolean> {
  const status = await checkBudget(db, agentId);
  if (status.budgetMonthlyCents === 0) return true; // no budget constraint
  return status.remainingCents >= costCents;
}
