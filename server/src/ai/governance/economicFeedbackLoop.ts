// ---------------------------------------------------------------------------
// Economic Feedback Loop — ROI measurement with auto-shutdown
// ---------------------------------------------------------------------------
// Agents and companies must measure ROI. If a company loses money for too
// long, the system automatically shuts it down. This keeps the ecosystem
// healthy and prevents zombie companies from burning budget.
//
// Key metrics tracked:
//   - Cost per task
//   - Revenue per company
//   - Agent productivity (tasks completed / budget spent)
//   - Company health over time (rolling window)
//
// Auto-actions:
//   - Warning when company health degrades
//   - Auto-pause agents in unprofitable companies
//   - Auto-shutdown companies losing money for sustained period
// ---------------------------------------------------------------------------

import pino from "pino";
import { eventBus } from "../../events/eventBus.js";
import type { EventName } from "../../events/eventTypes.js";
import {
  getCompanyRevenue,
  getCompanySpending,
  listContractsByCompany,
} from "../economy/contractManager.js";
import { findServicesByCompany } from "../economy/serviceRegistry.js";

const logger = pino({ name: "economic-feedback-loop" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompanyHealthTrend = "improving" | "stable" | "declining" | "critical";

export interface CompanyROI {
  companyId: string;
  revenueCents: number;
  spendingCents: number;
  profitCents: number;
  roi: number; // ratio: profit / spending (or 0 if no spending)
  tasksCompleted: number;
  costPerTaskCents: number;
  activeContracts: number;
  activeServices: number;
  healthTrend: CompanyHealthTrend;
  /** Number of consecutive negative-ROI evaluation periods */
  consecutiveLossPeriods: number;
  evaluatedAt: string;
}

export interface AgentProductivity {
  agentId: string;
  companyId: string;
  tasksCompleted: number;
  totalCostCents: number;
  costPerTaskCents: number;
  productivityScore: number; // 0-100
  evaluatedAt: string;
}

export interface FeedbackAction {
  type:
    | "warning"
    | "pause_agents"
    | "shutdown_company"
    | "reduce_budget"
    | "improve_landing_page"
    | "increase_content_output"
    | "update_strategy"
    | "trigger_expansion"
    | "none";
  companyId: string;
  reason: string;
  triggeredAt: string;
}

export interface BehaviorMetrics {
  traffic: number;
  conversions: number;
  revenueCents: number;
  taskSuccessRate: number; // 0..1
  costPerActionCents: number;
  conversionRatePercent: number;
  bounceRatePercent: number;
  sampleCount: number;
}

export interface EcosystemHealth {
  totalCompanies: number;
  healthyCompanies: number;
  atRiskCompanies: number;
  criticalCompanies: number;
  totalRevenueCents: number;
  totalSpendingCents: number;
  ecosystemROI: number;
  companyROIs: CompanyROI[];
  pendingActions: FeedbackAction[];
  evaluatedAt: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface FeedbackLoopConfig {
  /** Consecutive loss periods before warning */
  warningThreshold: number;
  /** Consecutive loss periods before pausing agents */
  pauseThreshold: number;
  /** Consecutive loss periods before shutdown */
  shutdownThreshold: number;
  /** Minimum spending (cents) before evaluating ROI. Companies below this are exempt. */
  minSpendingForEvaluation: number;
  /** Minimum ROI before company is considered "at risk" */
  minHealthyROI: number;
  /** Conversion rate threshold (%) below which funnel optimization is triggered */
  minConversionRatePercent: number;
  /** Maximum acceptable bounce rate (%) above which funnel optimization is triggered */
  maxBounceRatePercent: number;
  /** Traffic threshold below which growth actions are triggered */
  minTrafficThreshold: number;
  /** Minimum sample count required before behavior actions are emitted */
  minBehaviorSampleCount: number;
  /** Minimum acceptable task success rate (0..1) */
  minTaskSuccessRate: number;
  /** Revenue threshold at which expansion can be triggered */
  expansionRevenueThresholdCents: number;
}

const DEFAULT_CONFIG: FeedbackLoopConfig = {
  warningThreshold: 3,
  pauseThreshold: 5,
  shutdownThreshold: 8,
  minSpendingForEvaluation: 500, // $5 minimum spend before we evaluate
  minHealthyROI: -0.2, // ROI below -20% is "at risk"
  minConversionRatePercent: 2,
  maxBounceRatePercent: 65,
  minTrafficThreshold: 25,
  minBehaviorSampleCount: 5,
  minTaskSuccessRate: 0.65,
  expansionRevenueThresholdCents: 5_000,
};

let config: FeedbackLoopConfig = { ...DEFAULT_CONFIG };

export function getFeedbackConfig(): FeedbackLoopConfig {
  return { ...config };
}

export function setFeedbackConfig(newConfig: Partial<FeedbackLoopConfig>): void {
  config = { ...config, ...newConfig };
  logger.info({ config }, "Feedback loop config updated");
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Track company evaluation history */
const companyHistory = new Map<string, CompanyROI[]>();

/** Track agent productivity */
const agentProductivity = new Map<string, AgentProductivity[]>();

/** Pending actions from the feedback loop */
const pendingActions: FeedbackAction[] = [];

/** Task completions per company (agent reports in) */
const taskCompletions = new Map<string, number>();

/** Task completions per agent */
const agentTaskCompletions = new Map<string, number>();

/** Agent cost tracking */
const agentCosts = new Map<string, number>();

// ---------------------------------------------------------------------------
// Task and Cost Recording
// ---------------------------------------------------------------------------

/**
 * Record a task completion for a company/agent.
 */
export function recordTaskCompletion(
  companyId: string,
  agentId: string,
  costCents: number,
): void {
  taskCompletions.set(companyId, (taskCompletions.get(companyId) ?? 0) + 1);
  agentTaskCompletions.set(agentId, (agentTaskCompletions.get(agentId) ?? 0) + 1);
  agentCosts.set(agentId, (agentCosts.get(agentId) ?? 0) + costCents);
}

// ---------------------------------------------------------------------------
// ROI Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate ROI for a single company.
 */
export function evaluateCompanyROI(companyId: string): CompanyROI {
  const revenueCents = getCompanyRevenue(companyId);
  const spendingCents = getCompanySpending(companyId);
  const profitCents = revenueCents - spendingCents;
  const roi = spendingCents > 0 ? profitCents / spendingCents : 0;
  const tasksCompleted = taskCompletions.get(companyId) ?? 0;
  const costPerTaskCents = tasksCompleted > 0 ? Math.round(spendingCents / tasksCompleted) : 0;
  const activeContracts = listContractsByCompany(companyId).length;
  const activeServices = findServicesByCompany(companyId).length;

  // Get history to determine trend
  const history = companyHistory.get(companyId) ?? [];
  const healthTrend = calculateHealthTrend(history, roi);
  const consecutiveLossPeriods = countConsecutiveLosses(history);

  const evaluation: CompanyROI = {
    companyId,
    revenueCents,
    spendingCents,
    profitCents,
    roi,
    tasksCompleted,
    costPerTaskCents,
    activeContracts,
    activeServices,
    healthTrend,
    consecutiveLossPeriods: profitCents < 0 ? consecutiveLossPeriods + 1 : 0,
    evaluatedAt: new Date().toISOString(),
  };

  // Store in history
  if (!companyHistory.has(companyId)) {
    companyHistory.set(companyId, []);
  }
  const hist = companyHistory.get(companyId)!;
  hist.push(evaluation);
  // Keep bounded history (last 50 evaluations)
  if (hist.length > 50) {
    hist.splice(0, hist.length - 50);
  }

  return evaluation;
}

/**
 * Evaluate agent productivity.
 */
export function evaluateAgentProductivity(
  agentId: string,
  companyId: string,
): AgentProductivity {
  const tasksCompleted = agentTaskCompletions.get(agentId) ?? 0;
  const totalCostCents = agentCosts.get(agentId) ?? 0;
  const costPerTaskCents = tasksCompleted > 0 ? Math.round(totalCostCents / tasksCompleted) : 0;

  // Productivity score: higher tasks/cost = better (normalized 0-100)
  let productivityScore = 50; // baseline
  if (tasksCompleted > 0 && totalCostCents > 0) {
    const efficiency = tasksCompleted / (totalCostCents / 100); // tasks per dollar
    productivityScore = Math.min(100, Math.round(efficiency * 20));
  } else if (tasksCompleted > 0 && totalCostCents === 0) {
    productivityScore = 100; // free work
  }

  const result: AgentProductivity = {
    agentId,
    companyId,
    tasksCompleted,
    totalCostCents,
    costPerTaskCents,
    productivityScore,
    evaluatedAt: new Date().toISOString(),
  };

  if (!agentProductivity.has(agentId)) {
    agentProductivity.set(agentId, []);
  }
  const hist = agentProductivity.get(agentId)!;
  hist.push(result);
  if (hist.length > 50) {
    hist.splice(0, hist.length - 50);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Feedback Actions
// ---------------------------------------------------------------------------

/**
 * Run the feedback loop for a company — evaluates ROI and determines actions.
 */
export function runCompanyFeedback(companyId: string): FeedbackAction {
  const roi = evaluateCompanyROI(companyId);
  const action = determineFeedbackAction(roi);

  if (action.type !== "none") {
    pendingActions.push(action);

    eventBus.publish("governance.feedback.action", {
      actionType: action.type,
      companyId,
      reason: action.reason,
      roi: roi.roi,
      consecutiveLossPeriods: roi.consecutiveLossPeriods,
    });
  }

  return action;
}

/**
 * Run behavior-level feedback checks from runtime metrics.
 * This is the "decision + feedback intelligence" path.
 */
export function runBehaviorFeedback(
  companyId: string,
  metrics: BehaviorMetrics,
): FeedbackAction[] {
  const actions = determineBehaviorActions(companyId, metrics);
  for (const action of actions) {
    if (action.type === "none") continue;
    pendingActions.push(action);
    eventBus.publish("governance.feedback.action", {
      actionType: action.type,
      companyId,
      reason: action.reason,
      conversionRate: metrics.conversionRatePercent,
      bounceRatePercent: metrics.bounceRatePercent,
      traffic: metrics.traffic,
      taskSuccessRate: metrics.taskSuccessRate,
      revenueCents: metrics.revenueCents,
      sampleCount: metrics.sampleCount,
      source: "behavior",
    });
  }
  return actions;
}

/**
 * Run feedback loop for the entire ecosystem.
 */
export function evaluateEcosystemHealth(companyIds: string[]): EcosystemHealth {
  const companyROIs: CompanyROI[] = [];
  const actions: FeedbackAction[] = [];

  let totalRevenueCents = 0;
  let totalSpendingCents = 0;
  let healthyCompanies = 0;
  let atRiskCompanies = 0;
  let criticalCompanies = 0;

  for (const companyId of companyIds) {
    const roi = evaluateCompanyROI(companyId);
    companyROIs.push(roi);
    totalRevenueCents += roi.revenueCents;
    totalSpendingCents += roi.spendingCents;

    // Classify and take action
    if (roi.healthTrend === "critical") {
      criticalCompanies++;
    } else if (roi.healthTrend === "declining") {
      atRiskCompanies++;
    } else {
      healthyCompanies++;
    }

    // Only evaluate feedback for companies with meaningful spending
    if (roi.spendingCents >= config.minSpendingForEvaluation) {
      const action = determineFeedbackAction(roi);
      if (action.type !== "none") {
        actions.push(action);
        pendingActions.push(action);
      }
    }
  }

  const ecosystemROI = totalSpendingCents > 0
    ? (totalRevenueCents - totalSpendingCents) / totalSpendingCents
    : 0;

  const health: EcosystemHealth = {
    totalCompanies: companyIds.length,
    healthyCompanies,
    atRiskCompanies,
    criticalCompanies,
    totalRevenueCents,
    totalSpendingCents,
    ecosystemROI,
    companyROIs,
    pendingActions: actions,
    evaluatedAt: new Date().toISOString(),
  };

  eventBus.publish("governance.feedback.ecosystem_evaluated", {
    totalCompanies: health.totalCompanies,
    healthyCompanies,
    atRiskCompanies,
    criticalCompanies,
    ecosystemROI,
  });

  return health;
}

/**
 * Get pending feedback actions.
 */
export function getPendingFeedbackActions(companyId?: string): FeedbackAction[] {
  if (companyId) {
    return pendingActions.filter((a) => a.companyId === companyId);
  }
  return [...pendingActions];
}

/**
 * Get historical evaluations for a company.
 */
export function getCompanyROIHistory(companyId: string): CompanyROI[] {
  return companyHistory.get(companyId) ?? [];
}

/**
 * Get agent productivity history.
 */
export function getAgentProductivityHistory(agentId: string): AgentProductivity[] {
  return agentProductivity.get(agentId) ?? [];
}

/**
 * Clear all feedback loop data (for testing).
 */
export function clearFeedbackData(): void {
  companyHistory.clear();
  agentProductivity.clear();
  pendingActions.length = 0;
  taskCompletions.clear();
  agentTaskCompletions.clear();
  agentCosts.clear();
  config = { ...DEFAULT_CONFIG };
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

function determineFeedbackAction(roi: CompanyROI): FeedbackAction {
  const now = new Date().toISOString();

  // Skip evaluation for companies with minimal spending
  if (roi.spendingCents < config.minSpendingForEvaluation) {
    return { type: "none", companyId: roi.companyId, reason: "Below minimum spend threshold", triggeredAt: now };
  }

  // Auto-shutdown: too many consecutive losses
  if (roi.consecutiveLossPeriods >= config.shutdownThreshold) {
    logger.error(
      { companyId: roi.companyId, consecutiveLossPeriods: roi.consecutiveLossPeriods },
      "CRITICAL: Company recommended for shutdown due to sustained losses",
    );
    return {
      type: "shutdown_company",
      companyId: roi.companyId,
      reason: `Company has had ${roi.consecutiveLossPeriods} consecutive loss periods (threshold: ${config.shutdownThreshold}). ROI: ${(roi.roi * 100).toFixed(1)}%`,
      triggeredAt: now,
    };
  }

  // Auto-pause agents: escalating losses
  if (roi.consecutiveLossPeriods >= config.pauseThreshold) {
    logger.warn(
      { companyId: roi.companyId, consecutiveLossPeriods: roi.consecutiveLossPeriods },
      "Company agents should be paused due to ongoing losses",
    );
    return {
      type: "pause_agents",
      companyId: roi.companyId,
      reason: `Company has had ${roi.consecutiveLossPeriods} consecutive loss periods (threshold: ${config.pauseThreshold}). Pausing agents to stop budget burn.`,
      triggeredAt: now,
    };
  }

  // Warning: initial losses
  if (roi.consecutiveLossPeriods >= config.warningThreshold) {
    logger.warn(
      { companyId: roi.companyId, consecutiveLossPeriods: roi.consecutiveLossPeriods },
      "Company showing sustained losses — warning issued",
    );
    return {
      type: "warning",
      companyId: roi.companyId,
      reason: `Company has had ${roi.consecutiveLossPeriods} consecutive loss periods (threshold: ${config.warningThreshold}). ROI: ${(roi.roi * 100).toFixed(1)}%`,
      triggeredAt: now,
    };
  }

  // Budget reduction recommendation for declining companies
  if (roi.healthTrend === "declining" && roi.roi < config.minHealthyROI) {
    return {
      type: "reduce_budget",
      companyId: roi.companyId,
      reason: `Company ROI (${(roi.roi * 100).toFixed(1)}%) below minimum healthy threshold (${(config.minHealthyROI * 100).toFixed(1)}%)`,
      triggeredAt: now,
    };
  }

  return { type: "none", companyId: roi.companyId, reason: "Company within healthy parameters", triggeredAt: now };
}

function determineBehaviorActions(companyId: string, metrics: BehaviorMetrics): FeedbackAction[] {
  const now = new Date().toISOString();
  const actions: FeedbackAction[] = [];

  if (metrics.sampleCount < config.minBehaviorSampleCount) {
    return actions;
  }

  if (metrics.conversionRatePercent < config.minConversionRatePercent) {
    actions.push({
      type: "improve_landing_page",
      companyId,
      reason: `Conversion rate ${metrics.conversionRatePercent.toFixed(2)}% is below ${config.minConversionRatePercent}%`,
      triggeredAt: now,
    });
  }

  if (metrics.bounceRatePercent > config.maxBounceRatePercent) {
    actions.push({
      type: "improve_landing_page",
      companyId,
      reason: `Bounce rate ${metrics.bounceRatePercent.toFixed(2)}% is above ${config.maxBounceRatePercent}%`,
      triggeredAt: now,
    });
  }

  if (metrics.traffic < config.minTrafficThreshold) {
    actions.push({
      type: "increase_content_output",
      companyId,
      reason: `Traffic ${metrics.traffic} is below threshold ${config.minTrafficThreshold}`,
      triggeredAt: now,
    });
  }

  if (metrics.taskSuccessRate < config.minTaskSuccessRate) {
    actions.push({
      type: "update_strategy",
      companyId,
      reason: `Task success rate ${(metrics.taskSuccessRate * 100).toFixed(1)}% is below ${(config.minTaskSuccessRate * 100).toFixed(1)}%`,
      triggeredAt: now,
    });
  }

  if (
    metrics.revenueCents >= config.expansionRevenueThresholdCents &&
    metrics.taskSuccessRate >= config.minTaskSuccessRate &&
    metrics.conversionRatePercent >= config.minConversionRatePercent
  ) {
    actions.push({
      type: "trigger_expansion",
      companyId,
      reason: `Revenue and execution quality exceeded expansion thresholds (revenue=${metrics.revenueCents}, conversion=${metrics.conversionRatePercent.toFixed(2)}%)`,
      triggeredAt: now,
    });
  }

  return actions;
}

function calculateHealthTrend(history: CompanyROI[], currentROI: number): CompanyHealthTrend {
  if (history.length < 2) {
    return currentROI >= 0 ? "stable" : "declining";
  }

  // Look at last 3 evaluations
  const recent = history.slice(-3);
  const avgRecentROI = recent.reduce((sum, h) => sum + h.roi, 0) / recent.length;

  if (currentROI > avgRecentROI && currentROI > 0) return "improving";
  if (currentROI >= avgRecentROI * 0.9) return "stable";
  if (currentROI > -0.5) return "declining";
  return "critical";
}

function countConsecutiveLosses(history: CompanyROI[]): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.profitCents < 0) {
      count++;
    } else {
      break;
    }
  }
  return count;
}
