// ---------------------------------------------------------------------------
// Ecosystem Stability Controller
// ---------------------------------------------------------------------------
// Prevents the Recursive Empire Collapse Problem by monitoring ecosystem
// health and throttling growth when instability is detected.
//
// Five structural stabilizers:
//   1. Resource Budget Governor — strict per-company and per-ecosystem limits
//   2. Expansion Approval System — governance review before new entities
//   3. Economic Equilibrium Monitor — tracks growth rates and balance
//   4. Simulation Isolation — ensures sim results pass evaluation first
//   5. Ecosystem Health Metrics — global stability scoring
//
// The controller follows the Empire Collapse Curve model:
//   Formation → Expansion → Hypergrowth → Instability → Collapse
// and intervenes to prevent Stage 4 (Instability) from ever occurring.
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import {
  eq, and, sql, desc, gt,
  companies, agents, goals, issues,
  ecosystemMetrics, ecosystemLimits, stabilityEvents,
} from "@paperclipai/db";
import pino from "pino";
import { eventBus } from "../../events/eventBus.js";

const logger = pino({ name: "stability-controller" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The five stages of the Empire Collapse Curve */
export type EcosystemStage =
  | "formation"      // small, stable
  | "expansion"      // rapid growth
  | "hypergrowth"    // complexity skyrockets
  | "instability"    // resource imbalance
  | "collapse";      // system fails

/** Actions the controller can take */
export type StabilityAction =
  | "allow"          // normal operation
  | "warn"           // approaching limits
  | "throttle"       // slow down growth
  | "freeze"         // halt all expansion
  | "emergency_stop"; // immediate shutdown of autonomous actions

/** A stability assessment result */
export interface StabilityAssessment {
  stage: EcosystemStage;
  stabilityScore: number;     // 0-100 (100 = perfectly stable)
  expansionPressure: number;  // 0-100 (100 = maximum growth pressure)
  action: StabilityAction;
  indicators: StabilityIndicators;
  warnings: string[];
  recommendations: string[];
}

/** Raw indicator values used for stability calculation */
export interface StabilityIndicators {
  companyCount: number;
  agentCount: number;
  totalGoals: number;
  activeGoals: number;
  taskBacklog: number;
  agentUtilization: number;
  goalGrowthRate: number;
  companyGrowthRate: number;
  resourceBalance: number;   // ratio of productive output to resource usage
}

// ---------------------------------------------------------------------------
// Configuration thresholds
// ---------------------------------------------------------------------------

interface StabilityThresholds {
  maxCompanies: number;
  maxTotalAgents: number;
  maxActiveGoals: number;
  maxTaskBacklog: number;
  minAgentUtilization: number;     // below this → overstaffed
  maxGoalGrowthRate: number;       // goals/day threshold
  maxCompanyGrowthRate: number;    // companies/day threshold
  warnStabilityScore: number;      // below this → warn
  throttleStabilityScore: number;  // below this → throttle
  freezeStabilityScore: number;    // below this → freeze
  emergencyStabilityScore: number; // below this → emergency stop
}

const DEFAULT_THRESHOLDS: StabilityThresholds = {
  maxCompanies: 20,
  maxTotalAgents: 200,
  maxActiveGoals: 500,
  maxTaskBacklog: 1000,
  minAgentUtilization: 40,         // if <40% utilization → stop hiring
  maxGoalGrowthRate: 50,           // max 50 new goals/day
  maxCompanyGrowthRate: 3,         // max 3 new companies/day
  warnStabilityScore: 70,
  throttleStabilityScore: 50,
  freezeStabilityScore: 30,
  emergencyStabilityScore: 15,
};

let currentThresholds = { ...DEFAULT_THRESHOLDS };

export function getStabilityThresholds(): StabilityThresholds {
  return { ...currentThresholds };
}

export function setStabilityThresholds(
  overrides: Partial<StabilityThresholds>,
): StabilityThresholds {
  currentThresholds = { ...currentThresholds, ...overrides };
  return { ...currentThresholds };
}

export function resetStabilityThresholds(): StabilityThresholds {
  currentThresholds = { ...DEFAULT_THRESHOLDS };
  return { ...currentThresholds };
}

// ---------------------------------------------------------------------------
// Core Stability Assessment
// ---------------------------------------------------------------------------

/**
 * Assess ecosystem stability. This is the main entry point.
 * Call before any expansion action to determine whether it should proceed.
 */
export async function assessStability(db: Db): Promise<StabilityAssessment> {
  const thresholds = getStabilityThresholds();
  const indicators = await gatherIndicators(db);
  const stabilityScore = calculateStabilityScore(indicators, thresholds);
  const expansionPressure = calculateExpansionPressure(indicators, thresholds);
  const stage = determineStage(stabilityScore);
  const action = determineAction(stabilityScore, thresholds);
  const warnings = generateWarnings(indicators, thresholds);
  const recommendations = generateRecommendations(indicators, thresholds, action);

  // Persist the metric snapshot
  await recordMetricSnapshot(db, indicators, stabilityScore, expansionPressure);

  // Log a stability event if action is not "allow"
  if (action !== "allow") {
    await recordStabilityEvent(db, null, action, stabilityScore, warnings);
    eventBus.publish("stability.assessed", {
      stage,
      stabilityScore,
      action,
      warnings,
      timestamp: new Date().toISOString(),
    });
  }

  return {
    stage,
    stabilityScore,
    expansionPressure,
    action,
    indicators,
    warnings,
    recommendations,
  };
}

/**
 * Quick check: can the ecosystem expand right now?
 * Returns false if in freeze/emergency mode.
 */
export async function canExpand(db: Db): Promise<{ allowed: boolean; reason?: string; action: StabilityAction }> {
  const assessment = await assessStability(db);

  if (assessment.action === "freeze" || assessment.action === "emergency_stop") {
    return {
      allowed: false,
      reason: `Ecosystem expansion frozen (stability score: ${assessment.stabilityScore.toFixed(1)}, stage: ${assessment.stage})`,
      action: assessment.action,
    };
  }

  return { allowed: true, action: assessment.action };
}

/**
 * Company-scoped stability check — should this company be allowed to grow?
 */
export async function canCompanyExpand(
  db: Db,
  companyId: string,
): Promise<{ allowed: boolean; reason?: string; stabilityScore: number }> {
  const assessment = await assessStability(db);

  if (assessment.action === "freeze" || assessment.action === "emergency_stop") {
    return {
      allowed: false,
      reason: `Ecosystem-wide expansion freeze (score: ${assessment.stabilityScore.toFixed(1)})`,
      stabilityScore: assessment.stabilityScore,
    };
  }

  // Company-specific checks
  const companyAgents = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const agentCount = companyAgents[0]?.count ?? 0;

  if (assessment.action === "throttle" && agentCount > 10) {
    return {
      allowed: false,
      reason: `Throttling: company already has ${agentCount} agents during throttle mode`,
      stabilityScore: assessment.stabilityScore,
    };
  }

  return { allowed: true, stabilityScore: assessment.stabilityScore };
}

// ---------------------------------------------------------------------------
// Indicator Gathering
// ---------------------------------------------------------------------------

async function gatherIndicators(db: Db): Promise<StabilityIndicators> {
  // Company count
  const companyRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(companies);

  // Agent count
  const agentRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agents);

  // Goal counts
  const goalRows = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where status not in ('achieved','cancelled'))::int`,
    })
    .from(goals);

  // Task backlog (non-done, non-cancelled issues)
  const taskRows = await db
    .select({
      backlog: sql<number>`count(*) filter (where status not in ('done','cancelled'))::int`,
    })
    .from(issues);

  const companyCount = companyRows[0]?.count ?? 0;
  const agentCount = agentRows[0]?.count ?? 0;
  const totalGoals = goalRows[0]?.total ?? 0;
  const activeGoals = goalRows[0]?.active ?? 0;
  const taskBacklog = taskRows[0]?.backlog ?? 0;

  // Agent utilization: ratio of agents with active tasks
  const busyAgents = await db
    .select({ count: sql<number>`count(distinct assignee_agent_id) filter (where assignee_agent_id is not null and status in ('in_progress','in_review'))::int` })
    .from(issues);
  const busyCount = busyAgents[0]?.count ?? 0;
  const agentUtilization = agentCount > 0 ? (busyCount / agentCount) * 100 : 0;

  // Growth rates — compare to previous snapshot
  const prevSnapshot = await db
    .select()
    .from(ecosystemMetrics)
    .orderBy(desc(ecosystemMetrics.snapshotAt))
    .limit(1);

  let goalGrowthRate = 0;
  let companyGrowthRate = 0;
  if (prevSnapshot[0]) {
    const hoursSince = Math.max(
      1,
      (Date.now() - new Date(prevSnapshot[0].snapshotAt).getTime()) / 3600000,
    );
    goalGrowthRate = ((totalGoals - (prevSnapshot[0].goalCount ?? 0)) / hoursSince) * 24;
    companyGrowthRate = ((companyCount - (prevSnapshot[0].companyCount ?? 0)) / hoursSince) * 24;
  }

  // Resource balance: productivity vs consumption
  const resourceBalance = agentCount > 0
    ? Math.min(100, ((totalGoals > 0 ? activeGoals / totalGoals : 1) * agentUtilization))
    : 100;

  return {
    companyCount,
    agentCount,
    totalGoals,
    activeGoals,
    taskBacklog,
    agentUtilization,
    goalGrowthRate,
    companyGrowthRate,
    resourceBalance,
  };
}

// ---------------------------------------------------------------------------
// Stability Scoring
// ---------------------------------------------------------------------------

function calculateStabilityScore(
  ind: StabilityIndicators,
  t: StabilityThresholds,
): number {
  let score = 100;

  // Company overgrowth penalty
  if (ind.companyCount > t.maxCompanies * 0.8) {
    score -= Math.min(30, ((ind.companyCount - t.maxCompanies * 0.8) / (t.maxCompanies * 0.2)) * 30);
  }

  // Agent overgrowth penalty
  if (ind.agentCount > t.maxTotalAgents * 0.7) {
    score -= Math.min(20, ((ind.agentCount - t.maxTotalAgents * 0.7) / (t.maxTotalAgents * 0.3)) * 20);
  }

  // Goal explosion penalty
  if (ind.activeGoals > t.maxActiveGoals * 0.6) {
    score -= Math.min(15, ((ind.activeGoals - t.maxActiveGoals * 0.6) / (t.maxActiveGoals * 0.4)) * 15);
  }

  // Task backlog penalty
  if (ind.taskBacklog > t.maxTaskBacklog * 0.5) {
    score -= Math.min(15, ((ind.taskBacklog - t.maxTaskBacklog * 0.5) / (t.maxTaskBacklog * 0.5)) * 15);
  }

  // Low utilization penalty → means agents aren't productive
  if (ind.agentUtilization < t.minAgentUtilization && ind.agentCount > 5) {
    score -= Math.min(10, ((t.minAgentUtilization - ind.agentUtilization) / t.minAgentUtilization) * 10);
  }

  // Goal growth rate penalty
  if (ind.goalGrowthRate > t.maxGoalGrowthRate * 0.7) {
    score -= Math.min(10, ((ind.goalGrowthRate - t.maxGoalGrowthRate * 0.7) / (t.maxGoalGrowthRate * 0.3)) * 10);
  }

  return Math.max(0, Math.min(100, score));
}

function calculateExpansionPressure(
  ind: StabilityIndicators,
  t: StabilityThresholds,
): number {
  let pressure = 0;

  pressure += (ind.companyCount / t.maxCompanies) * 25;
  pressure += (ind.agentCount / t.maxTotalAgents) * 25;
  pressure += (ind.activeGoals / t.maxActiveGoals) * 25;
  pressure += (ind.goalGrowthRate / Math.max(1, t.maxGoalGrowthRate)) * 25;

  return Math.max(0, Math.min(100, pressure));
}

function determineStage(score: number): EcosystemStage {
  if (score >= 85) return "formation";
  if (score >= 65) return "expansion";
  if (score >= 45) return "hypergrowth";
  if (score >= 20) return "instability";
  return "collapse";
}

function determineAction(score: number, t: StabilityThresholds): StabilityAction {
  if (score <= t.emergencyStabilityScore) return "emergency_stop";
  if (score <= t.freezeStabilityScore) return "freeze";
  if (score <= t.throttleStabilityScore) return "throttle";
  if (score <= t.warnStabilityScore) return "warn";
  return "allow";
}

// ---------------------------------------------------------------------------
// Warning & Recommendation Generation
// ---------------------------------------------------------------------------

function generateWarnings(ind: StabilityIndicators, t: StabilityThresholds): string[] {
  const warnings: string[] = [];

  if (ind.companyCount >= t.maxCompanies) {
    warnings.push(`Company limit reached (${ind.companyCount}/${t.maxCompanies})`);
  }
  if (ind.agentCount >= t.maxTotalAgents) {
    warnings.push(`Agent limit reached (${ind.agentCount}/${t.maxTotalAgents})`);
  }
  if (ind.activeGoals >= t.maxActiveGoals) {
    warnings.push(`Active goals at capacity (${ind.activeGoals}/${t.maxActiveGoals})`);
  }
  if (ind.taskBacklog >= t.maxTaskBacklog) {
    warnings.push(`Task backlog critical (${ind.taskBacklog}/${t.maxTaskBacklog})`);
  }
  if (ind.agentUtilization < t.minAgentUtilization && ind.agentCount > 5) {
    warnings.push(`Agent utilization low (${ind.agentUtilization.toFixed(1)}% < ${t.minAgentUtilization}%)`);
  }
  if (ind.goalGrowthRate > t.maxGoalGrowthRate) {
    warnings.push(`Goal creation rate too high (${ind.goalGrowthRate.toFixed(1)}/day > ${t.maxGoalGrowthRate}/day)`);
  }
  if (ind.companyGrowthRate > t.maxCompanyGrowthRate) {
    warnings.push(`Company creation rate too high (${ind.companyGrowthRate.toFixed(1)}/day > ${t.maxCompanyGrowthRate}/day)`);
  }

  return warnings;
}

function generateRecommendations(
  ind: StabilityIndicators,
  t: StabilityThresholds,
  action: StabilityAction,
): string[] {
  const recs: string[] = [];

  if (action === "emergency_stop") {
    recs.push("EMERGENCY: Halt all autonomous operations immediately");
    recs.push("Review and cancel unnecessary goals and tasks");
    recs.push("Reduce active companies to sustainable levels");
  } else if (action === "freeze") {
    recs.push("Freeze all new company creation");
    recs.push("Stop new agent hiring across the ecosystem");
    recs.push("Focus on completing existing goals before creating new ones");
  } else if (action === "throttle") {
    recs.push("Slow new company creation — one per week maximum");
    if (ind.agentUtilization < t.minAgentUtilization) {
      recs.push("Stop hiring — current agents are underutilized");
    }
    if (ind.taskBacklog > t.maxTaskBacklog * 0.7) {
      recs.push("Clear task backlog before generating new tasks");
    }
  } else if (action === "warn") {
    if (ind.goalGrowthRate > t.maxGoalGrowthRate * 0.7) {
      recs.push("Goal creation trending high — monitor closely");
    }
    if (ind.companyCount > t.maxCompanies * 0.8) {
      recs.push("Approaching company limit — consider consolidation");
    }
  }

  return recs;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function recordMetricSnapshot(
  db: Db,
  ind: StabilityIndicators,
  stabilityScore: number,
  expansionPressure: number,
): Promise<void> {
  // Use the first company as context or create a system-level record
  const firstCompany = await db
    .select({ id: companies.id })
    .from(companies)
    .limit(1);

  if (firstCompany.length === 0) return;

  await db.insert(ecosystemMetrics).values({
    companyId: firstCompany[0].id,
    companyCount: ind.companyCount,
    agentCount: ind.agentCount,
    goalCount: ind.totalGoals,
    activeGoalCount: ind.activeGoals,
    taskBacklog: ind.taskBacklog,
    agentUtilization: ind.agentUtilization,
    goalGrowthRate: ind.goalGrowthRate,
    systemLoad: ind.resourceBalance,
    stabilityScore,
    expansionPressure,
  });
}

async function recordStabilityEvent(
  db: Db,
  companyId: string | null,
  action: StabilityAction,
  score: number,
  warnings: string[],
): Promise<void> {
  const severityMap: Record<StabilityAction, string> = {
    allow: "info",
    warn: "warning",
    throttle: "warning",
    freeze: "critical",
    emergency_stop: "emergency",
  };

  await db.insert(stabilityEvents).values({
    companyId,
    eventType: action === "emergency_stop" ? "collapse_detected" : action,
    severity: severityMap[action],
    stabilityScore: score,
    trigger: warnings.join("; ") || "stability assessment",
    action: `Action: ${action}`,
    details: { warnings },
  });
}

// ---------------------------------------------------------------------------
// Stability History
// ---------------------------------------------------------------------------

/**
 * Get recent stability metrics for dashboard display.
 */
export async function getStabilityHistory(
  db: Db,
  limit = 50,
): Promise<Array<typeof ecosystemMetrics.$inferSelect>> {
  return db
    .select()
    .from(ecosystemMetrics)
    .orderBy(desc(ecosystemMetrics.snapshotAt))
    .limit(limit);
}

/**
 * Get recent stability events.
 */
export async function getStabilityEvents(
  db: Db,
  limit = 50,
): Promise<Array<typeof stabilityEvents.$inferSelect>> {
  return db
    .select()
    .from(stabilityEvents)
    .orderBy(desc(stabilityEvents.createdAt))
    .limit(limit);
}

/**
 * Get ecosystem limits from the database (or return defaults).
 */
export async function getEcosystemLimitsFromDb(
  db: Db,
): Promise<Array<typeof ecosystemLimits.$inferSelect>> {
  return db.select().from(ecosystemLimits);
}
