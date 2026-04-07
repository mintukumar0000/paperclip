// ---------------------------------------------------------------------------
// Simulation Evaluator — Strategy Comparison & Selection
// ---------------------------------------------------------------------------
// After multiple simulations run, the evaluator compares results and
// selects the best strategy based on weighted criteria.
// ---------------------------------------------------------------------------

import type { ScenarioResult } from "./scenarioRunner.js";
import { rankStrategies, type EvaluationCriteria, DEFAULT_CRITERIA } from "./simulationMetrics.js";
import pino from "pino";

const logger = pino({ name: "sim-evaluator" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StrategyComparison {
  /** The selected winning strategy */
  winner: {
    strategyName: string;
    score: number;
    metrics: ScenarioResult["metrics"];
  };
  /** All strategies ranked from best to worst */
  rankings: Array<{
    rank: number;
    strategyName: string;
    score: number;
    profit: number;
    goalSuccessRate: number;
    failureRate: number;
  }>;
  /** Summary statistics */
  summary: {
    totalStrategiesTested: number;
    bestScore: number;
    worstScore: number;
    averageScore: number;
    marginOfVictory: number; // difference between #1 and #2
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate and compare multiple scenario results.
 * Returns the best strategy and full rankings.
 */
export function evaluateStrategies(
  results: ScenarioResult[],
  criteria: EvaluationCriteria[] = DEFAULT_CRITERIA,
): StrategyComparison {
  if (results.length === 0) {
    throw new Error("No simulation results to evaluate");
  }

  const ranked = rankStrategies(
    results.map((r) => ({
      strategyName: r.scenarioName,
      metrics: r.metrics,
    })),
    criteria,
  );

  const scores = ranked.map((r) => r.score);
  const bestScore = Math.max(...scores);
  const worstScore = Math.min(...scores);
  const avgScore = scores.reduce((s, v) => s + v, 0) / scores.length;
  const marginOfVictory = ranked.length >= 2 ? ranked[0].score - ranked[1].score : 0;

  const winner = ranked[0];
  const winnerResult = results.find((r) => r.scenarioName === winner.strategyName)!;

  logger.info(
    {
      winner: winner.strategyName,
      score: winner.score.toFixed(2),
      margin: marginOfVictory.toFixed(2),
      totalTested: results.length,
    },
    "Strategy evaluation complete",
  );

  return {
    winner: {
      strategyName: winner.strategyName,
      score: winner.score,
      metrics: winnerResult.metrics,
    },
    rankings: ranked.map((r, i) => {
      const result = results.find((res) => res.scenarioName === r.strategyName);
      return {
        rank: i + 1,
        strategyName: r.strategyName,
        score: r.score,
        profit: r.metrics.totalProfit,
        goalSuccessRate: r.metrics.goalSuccessRate,
        failureRate: r.metrics.failureRate,
      };
    }),
    summary: {
      totalStrategiesTested: results.length,
      bestScore,
      worstScore,
      averageScore: avgScore,
      marginOfVictory,
    },
  };
}

/**
 * Check if a strategy is "safe enough" to deploy.
 * Uses minimum score threshold and maximum failure rate.
 */
export function isStrategyDeployable(
  score: number,
  failureRate: number,
  options: { minScore?: number; maxFailureRate?: number } = {},
): { deployable: boolean; reason?: string } {
  const minScore = options.minScore ?? 40;
  const maxFailureRate = options.maxFailureRate ?? 0.3;

  if (score < minScore) {
    return { deployable: false, reason: `Score too low (${score.toFixed(1)} < ${minScore})` };
  }

  if (failureRate > maxFailureRate) {
    return { deployable: false, reason: `Failure rate too high (${(failureRate * 100).toFixed(1)}% > ${(maxFailureRate * 100).toFixed(1)}%)` };
  }

  return { deployable: true };
}
