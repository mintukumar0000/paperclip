// ---------------------------------------------------------------------------
// Simulation Metrics — Collection and Scoring
// ---------------------------------------------------------------------------
// Provides metric aggregation and scoring for simulation results.
// Used by both single-scenario and Monte Carlo evaluation flows.
// ---------------------------------------------------------------------------

import type { SimMetrics } from "./simulationEnvironment.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvaluationCriteria {
  metric: string;
  weight: number;
  direction: "maximize" | "minimize";
}

export interface ScoredResult {
  strategyName: string;
  score: number;
  metrics: SimMetrics;
  breakdown: Array<{
    metric: string;
    rawValue: number;
    normalizedValue: number;
    weight: number;
    contribution: number;
  }>;
}

// ---------------------------------------------------------------------------
// Default evaluation criteria
// ---------------------------------------------------------------------------

export const DEFAULT_CRITERIA: EvaluationCriteria[] = [
  { metric: "totalProfit", weight: 0.30, direction: "maximize" },
  { metric: "goalSuccessRate", weight: 0.20, direction: "maximize" },
  { metric: "agentEfficiency", weight: 0.15, direction: "maximize" },
  { metric: "taskCompletion", weight: 0.15, direction: "maximize" },
  { metric: "failureRate", weight: 0.10, direction: "minimize" },
  { metric: "totalCost", weight: 0.10, direction: "minimize" },
];

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score a single simulation result against evaluation criteria.
 * Returns a 0-100 score where 100 is the best possible outcome.
 */
export function scoreMetrics(
  metrics: SimMetrics,
  criteria: EvaluationCriteria[] = DEFAULT_CRITERIA,
): ScoredResult {
  const breakdown: ScoredResult["breakdown"] = [];
  let totalScore = 0;

  for (const criterion of criteria) {
    const rawValue = getMetricValue(metrics, criterion.metric);
    const normalizedValue = normalizeMetric(rawValue, criterion);
    const contribution = normalizedValue * criterion.weight * 100;

    breakdown.push({
      metric: criterion.metric,
      rawValue,
      normalizedValue,
      weight: criterion.weight,
      contribution,
    });

    totalScore += contribution;
  }

  return {
    strategyName: "",
    score: Math.max(0, Math.min(100, totalScore)),
    metrics,
    breakdown,
  };
}

/**
 * Compare multiple strategy results and rank them.
 */
export function rankStrategies(
  results: Array<{ strategyName: string; metrics: SimMetrics }>,
  criteria: EvaluationCriteria[] = DEFAULT_CRITERIA,
): ScoredResult[] {
  const scored = results.map((r) => {
    const result = scoreMetrics(r.metrics, criteria);
    result.strategyName = r.strategyName;
    return result;
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMetricValue(metrics: SimMetrics, metricName: string): number {
  const val = (metrics as unknown as Record<string, unknown>)[metricName];
  return typeof val === "number" ? val : 0;
}

/**
 * Normalize a metric value to 0-1 range based on direction.
 * For "maximize": higher values → closer to 1
 * For "minimize": lower values → closer to 1
 */
function normalizeMetric(value: number, criterion: EvaluationCriteria): number {
  if (criterion.direction === "maximize") {
    // For profit-like metrics, use a sigmoid-like scaling
    if (criterion.metric === "totalProfit") {
      // Scale around typical range: -100k to +500k cents
      return Math.max(0, Math.min(1, (value + 100000) / 600000));
    }
    if (criterion.metric === "totalRevenue") {
      return Math.max(0, Math.min(1, value / 500000));
    }
    // For 0-1 ratio metrics (completion rates, efficiency, etc.)
    return Math.max(0, Math.min(1, value));
  }

  // Minimize direction
  if (criterion.metric === "totalCost") {
    // Lower cost is better — invert the scale
    return Math.max(0, Math.min(1, 1 - value / 500000));
  }
  // For 0-1 ratio metrics like failureRate
  return Math.max(0, Math.min(1, 1 - value));
}
