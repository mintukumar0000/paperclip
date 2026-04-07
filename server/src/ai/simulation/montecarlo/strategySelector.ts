// ---------------------------------------------------------------------------
// Strategy Selector — Optimal Strategy Selection from Monte Carlo Analysis
// ---------------------------------------------------------------------------
// Takes statistical summaries from the probability analyzer and selects the
// best strategy using a risk-adjusted scoring approach (similar to Sharpe ratio).
// ---------------------------------------------------------------------------

import type { StrategyStatistics } from "./probabilityAnalyzer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StrategyRanking {
  strategyName: string;
  /** Combined risk-adjusted score (0-100) */
  score: number;
  /** Factors that contributed to the score */
  factors: {
    profitScore: number;
    riskPenalty: number;
    successBonus: number;
    efficiencyScore: number;
    confidenceMultiplier: number;
  };
  /** Whether this strategy is recommended for deployment */
  recommended: boolean;
  /** Reason for recommendation or rejection */
  reason: string;
}

export interface SelectionResult {
  winner: StrategyRanking | null;
  rankings: StrategyRanking[];
  /** Number of strategies that passed safety thresholds */
  viableCount: number;
  /** Summary text */
  summary: string;
}

export interface SelectionCriteria {
  /** Minimum success probability to be considered (default: 0.4) */
  minSuccessProbability: number;
  /** Maximum acceptable risk score (default: 80) */
  maxRiskScore: number;
  /** Minimum confidence level (default: 0.3) */
  minConfidence: number;
  /** Weight for profit in scoring (default: 0.40) */
  profitWeight: number;
  /** Weight for success probability (default: 0.25) */
  successWeight: number;
  /** Weight for efficiency (default: 0.20) */
  efficiencyWeight: number;
  /** Weight for risk (subtracted) (default: 0.15) */
  riskWeight: number;
}

export const DEFAULT_SELECTION_CRITERIA: SelectionCriteria = {
  minSuccessProbability: 0.4,
  maxRiskScore: 80,
  minConfidence: 0.3,
  profitWeight: 0.40,
  successWeight: 0.25,
  efficiencyWeight: 0.20,
  riskWeight: 0.15,
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreStrategy(
  stats: StrategyStatistics,
  criteria: SelectionCriteria,
): StrategyRanking {
  // Normalize profit to 0-100 scale (using median profit relative to range)
  const profitScore = stats.profit.median > 0
    ? Math.min(100, (stats.profit.median / (stats.profit.max || 1)) * 100)
    : Math.max(0, 50 + (stats.profit.median / (Math.abs(stats.profit.min) || 1)) * 50);

  // Success bonus: direct probability * 100
  const successBonus = stats.successProbability * 100;

  // Efficiency score: agent efficiency * 100
  const efficiencyScore = stats.agentEfficiency.mean * 100;

  // Risk penalty: invert risk score
  const riskPenalty = stats.riskScore;

  // Confidence multiplier: scales final score
  const confidenceMultiplier = Math.max(0.5, stats.confidenceLevel);

  // Weighted combination
  const rawScore =
    profitScore * criteria.profitWeight +
    successBonus * criteria.successWeight +
    efficiencyScore * criteria.efficiencyWeight -
    riskPenalty * criteria.riskWeight;

  const score = Math.max(0, Math.min(100, rawScore * confidenceMultiplier));

  // Determine recommendation
  const meetsThresholds =
    stats.successProbability >= criteria.minSuccessProbability &&
    stats.riskScore <= criteria.maxRiskScore &&
    stats.confidenceLevel >= criteria.minConfidence;

  let reason: string;
  if (!meetsThresholds) {
    const issues: string[] = [];
    if (stats.successProbability < criteria.minSuccessProbability)
      issues.push(`low success probability (${(stats.successProbability * 100).toFixed(0)}%)`);
    if (stats.riskScore > criteria.maxRiskScore)
      issues.push(`risk too high (${stats.riskScore.toFixed(0)})`);
    if (stats.confidenceLevel < criteria.minConfidence)
      issues.push(`insufficient confidence (${(stats.confidenceLevel * 100).toFixed(0)}%)`);
    reason = `Rejected: ${issues.join(", ")}`;
  } else if (score >= 60) {
    reason = "Strong performer across risk-adjusted metrics";
  } else if (score >= 40) {
    reason = "Moderate performer — acceptable with caution";
  } else {
    reason = "Below threshold despite meeting minimums";
  }

  return {
    strategyName: stats.strategyName,
    score,
    factors: {
      profitScore,
      riskPenalty,
      successBonus,
      efficiencyScore,
      confidenceMultiplier,
    },
    recommended: meetsThresholds && score >= 30,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Select the best strategy from Monte Carlo analysis results.
 */
export function selectStrategy(
  allStats: StrategyStatistics[],
  criteria: SelectionCriteria = DEFAULT_SELECTION_CRITERIA,
): SelectionResult {
  if (allStats.length === 0) {
    return {
      winner: null,
      rankings: [],
      viableCount: 0,
      summary: "No strategies to evaluate",
    };
  }

  const rankings = allStats
    .map((s) => scoreStrategy(s, criteria))
    .sort((a, b) => b.score - a.score);

  const viable = rankings.filter((r) => r.recommended);
  const winner = viable.length > 0 ? viable[0] : null;

  const summary = winner
    ? `Selected "${winner.strategyName}" (score: ${winner.score.toFixed(1)}) from ${viable.length} viable strategies out of ${rankings.length} total`
    : `No viable strategy found among ${rankings.length} candidates`;

  return { winner, rankings, viableCount: viable.length, summary };
}
