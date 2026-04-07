// ---------------------------------------------------------------------------
// Probability Analyzer — Statistical Analysis of Monte Carlo Results
// ---------------------------------------------------------------------------
// After all universes complete, the analyzer computes:
//   - Mean, median, variance, standard deviation
//   - Success/failure probability
//   - Confidence intervals
//   - Risk scores
// ---------------------------------------------------------------------------

import type { UniverseResult } from "./universeGenerator.js";
import type { SimMetrics } from "../simulationEnvironment.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StatisticalSummary {
  sampleSize: number;
  mean: number;
  median: number;
  variance: number;
  standardDeviation: number;
  min: number;
  max: number;
  p5: number;   // 5th percentile
  p25: number;  // 25th percentile
  p75: number;  // 75th percentile
  p95: number;  // 95th percentile
}

export interface StrategyStatistics {
  strategyName: string;
  profit: StatisticalSummary;
  revenue: StatisticalSummary;
  cost: StatisticalSummary;
  goalSuccessRate: StatisticalSummary;
  agentEfficiency: StatisticalSummary;
  taskCompletion: StatisticalSummary;
  failureRate: StatisticalSummary;
  /** Probability of achieving positive profit */
  successProbability: number;
  /** Risk score: higher = more volatile */
  riskScore: number;
  /** Confidence level based on sample size */
  confidenceLevel: number;
  /** Number of universes that completed successfully */
  validSamples: number;
}

// ---------------------------------------------------------------------------
// Statistical Functions
// ---------------------------------------------------------------------------

function computeStats(values: number[]): StatisticalSummary {
  if (values.length === 0) {
    return {
      sampleSize: 0, mean: 0, median: 0, variance: 0, standardDeviation: 0,
      min: 0, max: 0, p5: 0, p25: 0, p75: 0, p95: 0,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((s, v) => s + v, 0);
  const mean = sum / n;

  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const standardDeviation = Math.sqrt(variance);

  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];

  const percentile = (p: number) => {
    const idx = (p / 100) * (n - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
  };

  return {
    sampleSize: n,
    mean,
    median,
    variance,
    standardDeviation,
    min: sorted[0],
    max: sorted[n - 1],
    p5: percentile(5),
    p25: percentile(25),
    p75: percentile(75),
    p95: percentile(95),
  };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Analyze Monte Carlo universe results for a single strategy.
 * Produces comprehensive statistics across all metric dimensions.
 */
export function analyzeStrategy(
  strategyName: string,
  results: UniverseResult[],
): StrategyStatistics {
  const valid = results.filter((r) => r.succeeded);

  if (valid.length === 0) {
    return {
      strategyName,
      profit: computeStats([]),
      revenue: computeStats([]),
      cost: computeStats([]),
      goalSuccessRate: computeStats([]),
      agentEfficiency: computeStats([]),
      taskCompletion: computeStats([]),
      failureRate: computeStats([]),
      successProbability: 0,
      riskScore: 100,
      confidenceLevel: 0,
      validSamples: 0,
    };
  }

  const profits = valid.map((r) => r.metrics.totalProfit);
  const revenues = valid.map((r) => r.metrics.totalRevenue);
  const costs = valid.map((r) => r.metrics.totalCost);
  const goalRates = valid.map((r) => r.metrics.goalSuccessRate);
  const efficiencies = valid.map((r) => r.metrics.agentEfficiency);
  const completions = valid.map((r) => r.metrics.taskCompletion);
  const failRates = valid.map((r) => r.metrics.failureRate);

  const profitStats = computeStats(profits);
  const successProbability = profits.filter((p) => p > 0).length / valid.length;

  // Risk score: combination of failure probability and profit volatility
  const coefficientOfVariation = profitStats.mean !== 0
    ? Math.abs(profitStats.standardDeviation / profitStats.mean)
    : 1;
  const riskScore = Math.min(100, (1 - successProbability) * 50 + coefficientOfVariation * 50);

  // Confidence level based on sample size (approaches 1 as N increases)
  const confidenceLevel = 1 - 1 / Math.sqrt(valid.length);

  return {
    strategyName,
    profit: profitStats,
    revenue: computeStats(revenues),
    cost: computeStats(costs),
    goalSuccessRate: computeStats(goalRates),
    agentEfficiency: computeStats(efficiencies),
    taskCompletion: computeStats(completions),
    failureRate: computeStats(failRates),
    successProbability,
    riskScore,
    confidenceLevel,
    validSamples: valid.length,
  };
}

/**
 * Analyze multiple strategies and return all statistical summaries.
 */
export function analyzeAllStrategies(
  strategiesWithResults: Array<{
    strategyName: string;
    results: UniverseResult[];
  }>,
): StrategyStatistics[] {
  return strategiesWithResults.map((s) =>
    analyzeStrategy(s.strategyName, s.results),
  );
}
