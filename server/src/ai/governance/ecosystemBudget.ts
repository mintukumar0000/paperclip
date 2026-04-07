// ---------------------------------------------------------------------------
// Ecosystem Budget — controls spending across all companies
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { sql } from "@paperclipai/db";
import { getAutonomyLimits } from "./autonomyLimits.js";
import pino from "pino";

const logger = pino({ name: "ecosystem-budget" });

export interface EcosystemLimits {
  maxCompanies: number;
  totalBudgetCents: number;
  perCompanyBudgetLimitCents: number;
  maxCompaniesPerDay: number;
}

export interface EcosystemStatus {
  companyCount: number;
  totalAllocatedBudgetCents: number;
  totalSpentCents: number;
  limits: EcosystemLimits;
  canCreateCompany: boolean;
  violations: string[];
}

/** Default ecosystem limits — synced from global autonomy limits */
function getDefaultEcosystemLimits(): EcosystemLimits {
  const global = getAutonomyLimits();
  return {
    maxCompanies: global.maxCompaniesInEcosystem,
    totalBudgetCents: 100_000, // $1,000
    perCompanyBudgetLimitCents: 15_000, // $150
    maxCompaniesPerDay: 3,
  };
}

/**
 * Get effective ecosystem limits.
 */
export function getEcosystemLimits(): EcosystemLimits {
  return getDefaultEcosystemLimits();
}

/**
 * Check current ecosystem status against limits.
 */
export async function checkEcosystemStatus(db: Db): Promise<EcosystemStatus> {
  const limits = getEcosystemLimits();

  // Count companies
  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(companies);
  const companyCount = countRows[0]?.count ?? 0;

  // Sum budgets
  const budgetRows = await db
    .select({
      allocated: sql<number>`coalesce(sum(budget_monthly_cents), 0)::int`,
      spent: sql<number>`coalesce(sum(spent_monthly_cents), 0)::int`,
    })
    .from(companies);
  const totalAllocatedBudgetCents = budgetRows[0]?.allocated ?? 0;
  const totalSpentCents = budgetRows[0]?.spent ?? 0;

  const violations: string[] = [];

  if (companyCount >= limits.maxCompanies) {
    violations.push(`Company limit reached (${companyCount}/${limits.maxCompanies})`);
  }
  if (totalAllocatedBudgetCents >= limits.totalBudgetCents) {
    violations.push(`Total budget limit reached ($${(totalAllocatedBudgetCents / 100).toFixed(2)}/$${(limits.totalBudgetCents / 100).toFixed(2)})`);
  }

  const canCreateCompany = violations.length === 0;

  if (!canCreateCompany) {
    logger.warn({ violations }, "Ecosystem expansion blocked");
  }

  return {
    companyCount,
    totalAllocatedBudgetCents,
    totalSpentCents,
    limits,
    canCreateCompany,
    violations,
  };
}

/**
 * Check if a specific company creation is within limits.
 */
export async function canCreateNewCompany(
  db: Db,
  budgetCents: number,
): Promise<{ allowed: boolean; reason?: string }> {
  const status = await checkEcosystemStatus(db);

  if (status.companyCount >= status.limits.maxCompanies) {
    return { allowed: false, reason: `Company limit reached (${status.companyCount}/${status.limits.maxCompanies})` };
  }

  if (budgetCents > status.limits.perCompanyBudgetLimitCents) {
    return {
      allowed: false,
      reason: `Per-company budget exceeds limit ($${(budgetCents / 100).toFixed(2)}/$${(status.limits.perCompanyBudgetLimitCents / 100).toFixed(2)})`,
    };
  }

  if (status.totalAllocatedBudgetCents + budgetCents > status.limits.totalBudgetCents) {
    return {
      allowed: false,
      reason: `Would exceed total ecosystem budget ($${((status.totalAllocatedBudgetCents + budgetCents) / 100).toFixed(2)}/$${(status.limits.totalBudgetCents / 100).toFixed(2)})`,
    };
  }

  return { allowed: true };
}
