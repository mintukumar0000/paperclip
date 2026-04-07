// ---------------------------------------------------------------------------
// Workforce Limits — prevents uncontrolled organizational growth
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { agents, departments } from "@paperclipai/db";
import { eq, and, sql } from "@paperclipai/db";
import { getAutonomyLimits } from "./autonomyLimits.js";
import pino from "pino";

const logger = pino({ name: "workforce-limits" });

export interface WorkforceLimits {
  maxAgentsPerCompany: number;
  maxDepartments: number;
  maxMonthlyBudgetCents: number;
  maxAgentsPerDepartment: number;
  maxExpansionsPerDay: number;
}

export interface WorkforceStatus {
  companyId: string;
  agentCount: number;
  departmentCount: number;
  totalMonthlyBudgetCents: number;
  limits: WorkforceLimits;
  canExpand: boolean;
  violations: string[];
}

/** Default limits — synced from global autonomy limits, can be overridden per company */
function getDefaultLimits(): WorkforceLimits {
  const global = getAutonomyLimits();
  return {
    maxAgentsPerCompany: global.maxAgentsPerCompany,
    maxDepartments: global.maxDepartmentsPerCompany,
    maxMonthlyBudgetCents: 20_000, // $200
    maxAgentsPerDepartment: 8,
    maxExpansionsPerDay: global.maxAgentCreationPerDay,
  };
}

/**
 * Get effective limits for a company (defaults for now, extensible).
 */
export function getWorkforceLimits(_companyId?: string): WorkforceLimits {
  return getDefaultLimits();
}

/**
 * Check the current workforce status against limits.
 */
export async function checkWorkforceStatus(
  db: Db,
  companyId: string,
): Promise<WorkforceStatus> {
  const limits = getWorkforceLimits(companyId);

  // Count active agents
  const agentRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const agentCount = agentRows[0]?.count ?? 0;

  // Count departments
  const deptRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(departments)
    .where(eq(departments.companyId, companyId));
  const departmentCount = deptRows[0]?.count ?? 0;

  // Sum monthly budgets
  const budgetRows = await db
    .select({ total: sql<number>`coalesce(sum(budget_monthly_cents), 0)::int` })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const totalMonthlyBudgetCents = budgetRows[0]?.total ?? 0;

  const violations: string[] = [];

  if (agentCount >= limits.maxAgentsPerCompany) {
    violations.push(`Agent limit reached (${agentCount}/${limits.maxAgentsPerCompany})`);
  }
  if (departmentCount >= limits.maxDepartments) {
    violations.push(`Department limit reached (${departmentCount}/${limits.maxDepartments})`);
  }
  if (totalMonthlyBudgetCents >= limits.maxMonthlyBudgetCents) {
    violations.push(`Budget limit reached ($${(totalMonthlyBudgetCents / 100).toFixed(2)}/$${(limits.maxMonthlyBudgetCents / 100).toFixed(2)})`);
  }

  const canExpand = violations.length === 0;

  if (!canExpand) {
    logger.warn({ companyId, violations }, "Workforce expansion blocked");
  }

  return {
    companyId,
    agentCount,
    departmentCount,
    totalMonthlyBudgetCents,
    limits,
    canExpand,
    violations,
  };
}

/**
 * Check if a specific expansion would be within limits.
 */
export async function canCreateAgent(
  db: Db,
  companyId: string,
  budgetCents: number,
): Promise<{ allowed: boolean; reason?: string }> {
  const status = await checkWorkforceStatus(db, companyId);

  if (status.agentCount >= status.limits.maxAgentsPerCompany) {
    return { allowed: false, reason: `Agent limit reached (${status.agentCount}/${status.limits.maxAgentsPerCompany})` };
  }

  if (status.totalMonthlyBudgetCents + budgetCents > status.limits.maxMonthlyBudgetCents) {
    return {
      allowed: false,
      reason: `Would exceed budget limit ($${((status.totalMonthlyBudgetCents + budgetCents) / 100).toFixed(2)}/$${(status.limits.maxMonthlyBudgetCents / 100).toFixed(2)})`,
    };
  }

  return { allowed: true };
}

/**
 * Check if a new department can be created.
 */
export async function canCreateDepartment(
  db: Db,
  companyId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const status = await checkWorkforceStatus(db, companyId);

  if (status.departmentCount >= status.limits.maxDepartments) {
    return { allowed: false, reason: `Department limit reached (${status.departmentCount}/${status.limits.maxDepartments})` };
  }

  return { allowed: true };
}
