// ---------------------------------------------------------------------------
// Autonomy Limits — hard global constraints preventing unbounded expansion
// ---------------------------------------------------------------------------
// Reads from environment variables with sensible defaults.
// These are the absolute ceilings the system can NEVER exceed.
// ---------------------------------------------------------------------------

import pino from "pino";
import { eventBus } from "../../events/eventBus.js";

const logger = pino({ name: "autonomy-limits" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GlobalAutonomyLimits {
  // Organizational
  maxAgentsPerCompany: number;
  maxCompaniesInEcosystem: number;
  maxAgentCreationPerDay: number;
  maxDepartmentsPerCompany: number;

  // Execution
  maxWorkflowDepth: number;
  maxExecutionLoopIterations: number;
  maxActivePlansPerCompany: number;
  maxReplanCycles: number;
  maxConcurrentRunsPerAgent: number;

  // Economic
  maxDailyCostPerCompanyCents: number;
  maxIntercompanyContracts: number;
  maxServiceCallsPerDay: number;
  maxTransactionValueCents: number;
  maxIntercompanyDependencies: number;
  maxEcosystemDailySpendCents: number;

  // Goal Containment — prevents recursive goal amplification (RGA)
  maxGoalDepth: number;
  maxChildGoals: number;
  maxActiveGoalsPerCompany: number;
  maxTasksPerPlanCycle: number;
}

// ---------------------------------------------------------------------------
// Defaults — safe conservative values
// ---------------------------------------------------------------------------

const DEFAULT_LIMITS: GlobalAutonomyLimits = {
  // Organizational
  maxAgentsPerCompany: 20,
  maxCompaniesInEcosystem: 10,
  maxAgentCreationPerDay: 3,
  maxDepartmentsPerCompany: 8,

  // Execution
  maxWorkflowDepth: 20,
  maxExecutionLoopIterations: 100,
  maxActivePlansPerCompany: 20,
  maxReplanCycles: 3,
  maxConcurrentRunsPerAgent: 5,

  // Economic
  maxDailyCostPerCompanyCents: 5_000, // $50
  maxIntercompanyContracts: 50,
  maxServiceCallsPerDay: 200,
  maxTransactionValueCents: 1_000, // $10 per single transaction
  maxIntercompanyDependencies: 10,
  maxEcosystemDailySpendCents: 20_000, // $200

  // Goal Containment
  maxGoalDepth: 5,
  maxChildGoals: 5,
  maxActiveGoalsPerCompany: 50,
  maxTasksPerPlanCycle: 20,
};

// ---------------------------------------------------------------------------
// Runtime state — loaded once, overridable for testing
// ---------------------------------------------------------------------------

let currentLimits: GlobalAutonomyLimits | null = null;

function parseIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseDollarsToCents(key: string, fallbackCents: number): number {
  const raw = process.env[key];
  if (!raw) return fallbackCents;
  // Accept "$50" or "50" — strip $ sign
  const cleaned = raw.replace(/[$,]/g, "").trim();
  const dollars = parseFloat(cleaned);
  return Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : fallbackCents;
}

/**
 * Load global autonomy limits from environment variables.
 * Safe to call multiple times — caches after first load.
 */
export function getAutonomyLimits(): GlobalAutonomyLimits {
  if (currentLimits) return currentLimits;

  currentLimits = {
    maxAgentsPerCompany: parseIntEnv("MAX_AGENTS_PER_COMPANY", DEFAULT_LIMITS.maxAgentsPerCompany),
    maxCompaniesInEcosystem: parseIntEnv("MAX_COMPANIES_IN_ECOSYSTEM", DEFAULT_LIMITS.maxCompaniesInEcosystem),
    maxAgentCreationPerDay: parseIntEnv("MAX_AGENT_CREATION_PER_DAY", DEFAULT_LIMITS.maxAgentCreationPerDay),
    maxDepartmentsPerCompany: parseIntEnv("MAX_DEPARTMENTS_PER_COMPANY", DEFAULT_LIMITS.maxDepartmentsPerCompany),
    maxWorkflowDepth: parseIntEnv("MAX_WORKFLOW_DEPTH", DEFAULT_LIMITS.maxWorkflowDepth),
    maxExecutionLoopIterations: parseIntEnv("MAX_EXECUTION_LOOP_ITERATIONS", DEFAULT_LIMITS.maxExecutionLoopIterations),
    maxActivePlansPerCompany: parseIntEnv("MAX_ACTIVE_PLANS_PER_COMPANY", DEFAULT_LIMITS.maxActivePlansPerCompany),
    maxReplanCycles: parseIntEnv("MAX_REPLAN_CYCLES", DEFAULT_LIMITS.maxReplanCycles),
    maxConcurrentRunsPerAgent: parseIntEnv("MAX_CONCURRENT_RUNS_PER_AGENT", DEFAULT_LIMITS.maxConcurrentRunsPerAgent),
    maxDailyCostPerCompanyCents: parseDollarsToCents("MAX_DAILY_COST_PER_COMPANY", DEFAULT_LIMITS.maxDailyCostPerCompanyCents),
    maxIntercompanyContracts: parseIntEnv("MAX_INTERCOMPANY_CONTRACTS", DEFAULT_LIMITS.maxIntercompanyContracts),
    maxServiceCallsPerDay: parseIntEnv("MAX_SERVICE_CALLS_PER_DAY", DEFAULT_LIMITS.maxServiceCallsPerDay),
    maxTransactionValueCents: parseDollarsToCents("MAX_TRANSACTION_VALUE", DEFAULT_LIMITS.maxTransactionValueCents),
    maxIntercompanyDependencies: parseIntEnv("MAX_INTERCOMPANY_DEPENDENCIES", DEFAULT_LIMITS.maxIntercompanyDependencies),
    maxEcosystemDailySpendCents: parseDollarsToCents("MAX_ECOSYSTEM_DAILY_SPEND", DEFAULT_LIMITS.maxEcosystemDailySpendCents),

    // Goal Containment
    maxGoalDepth: parseIntEnv("MAX_GOAL_DEPTH", DEFAULT_LIMITS.maxGoalDepth),
    maxChildGoals: parseIntEnv("MAX_CHILD_GOALS", DEFAULT_LIMITS.maxChildGoals),
    maxActiveGoalsPerCompany: parseIntEnv("MAX_ACTIVE_GOALS_PER_COMPANY", DEFAULT_LIMITS.maxActiveGoalsPerCompany),
    maxTasksPerPlanCycle: parseIntEnv("MAX_TASKS_PER_PLAN_CYCLE", DEFAULT_LIMITS.maxTasksPerPlanCycle),
  };

  logger.info({ limits: currentLimits }, "Autonomy limits loaded");
  return currentLimits;
}

/**
 * Override limits at runtime (for testing or admin override).
 */
export function setAutonomyLimits(overrides: Partial<GlobalAutonomyLimits>): void {
  const base = getAutonomyLimits();
  currentLimits = { ...base, ...overrides };
  logger.info({ overrides }, "Autonomy limits overridden");
}

/**
 * Reset to reload from environment on next call.
 */
export function resetAutonomyLimits(): void {
  currentLimits = null;
}

// ---------------------------------------------------------------------------
// Limit enforcement helpers
// ---------------------------------------------------------------------------

export interface LimitCheckResult {
  allowed: boolean;
  limit: string;
  current: number;
  max: number;
  reason?: string;
}

/**
 * Check a specific limit against a current value.
 */
export function checkLimit(
  limitName: keyof GlobalAutonomyLimits,
  currentValue: number,
): LimitCheckResult {
  const limits = getAutonomyLimits();
  const max = limits[limitName];

  if (currentValue >= max) {
    const reason = `${limitName} limit reached (${currentValue}/${max})`;
    logger.warn({ limitName, current: currentValue, max }, reason);
    eventBus.publish("governance.action.blocked", {
      traceId: `limit_${limitName}_${Date.now()}`,
      action: limitName,
      companyId: "system",
      actorId: "system",
      blockedBy: "hard_limit",
      reason,
    });
    return { allowed: false, limit: limitName, current: currentValue, max, reason };
  }

  return { allowed: true, limit: limitName, current: currentValue, max };
}

/**
 * Get all limits as a read-only snapshot.
 */
export function getAutonomyLimitsSnapshot(): Readonly<GlobalAutonomyLimits> {
  return Object.freeze({ ...getAutonomyLimits() });
}
