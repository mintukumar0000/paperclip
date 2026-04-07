// ---------------------------------------------------------------------------
// Outcome Evaluator — evaluates goal execution results quantitatively
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { aiLearningRecords } from "@paperclipai/db";
import { publishEvent } from "../../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "outcome-evaluator" });

export interface GoalOutcome {
  goalId: string;
  companyId: string;
  success: boolean;
  startedAt: Date;
  completedAt: Date;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  totalCostCents: number;
  agentIds: string[];
  errors: string[];
}

export interface OutcomeEvaluation {
  goalId: string;
  success: boolean;
  completionRate: number;       // 0-1
  executionTimeMs: number;
  costCents: number;
  errorRate: number;            // 0-1
  agentCount: number;
  overallScore: number;         // 0-1 composite
}

/** Weight configuration for composite scoring */
const WEIGHTS = {
  completionRate: 0.35,
  successBonus: 0.25,
  costEfficiency: 0.15,
  errorPenalty: 0.15,
  timeEfficiency: 0.10,
};

/** Expected execution time per step (ms) for time efficiency scoring */
const EXPECTED_TIME_PER_STEP_MS = 60_000; // 1 minute per step baseline

/**
 * Evaluate a completed goal's outcome and persist the evaluation.
 */
export async function evaluateOutcome(
  db: Db,
  outcome: GoalOutcome,
): Promise<OutcomeEvaluation> {
  const { goalId, companyId, success, startedAt, completedAt, totalSteps, completedSteps, failedSteps, totalCostCents, agentIds, errors } = outcome;

  const executionTimeMs = completedAt.getTime() - startedAt.getTime();
  const completionRate = totalSteps > 0 ? completedSteps / totalSteps : 0;
  const errorRate = totalSteps > 0 ? failedSteps / totalSteps : 0;

  // Time efficiency: ratio of expected vs actual time (capped at 1)
  const expectedTimeMs = totalSteps * EXPECTED_TIME_PER_STEP_MS;
  const timeEfficiency = expectedTimeMs > 0
    ? Math.min(1, expectedTimeMs / Math.max(executionTimeMs, 1))
    : 0.5;

  // Cost efficiency: lower is better, normalized to 0-1
  // Assume $0.50 per step is the baseline
  const expectedCostCents = totalSteps * 50;
  const costEfficiency = expectedCostCents > 0
    ? Math.min(1, expectedCostCents / Math.max(totalCostCents, 1))
    : 0.5;

  // Composite score
  const overallScore = Math.min(1, Math.max(0,
    WEIGHTS.completionRate * completionRate +
    WEIGHTS.successBonus * (success ? 1.0 : 0.0) +
    WEIGHTS.costEfficiency * costEfficiency +
    WEIGHTS.errorPenalty * (1 - errorRate) +
    WEIGHTS.timeEfficiency * timeEfficiency,
  ));

  const evaluation: OutcomeEvaluation = {
    goalId,
    success,
    completionRate: Math.round(completionRate * 100) / 100,
    executionTimeMs,
    costCents: totalCostCents,
    errorRate: Math.round(errorRate * 100) / 100,
    agentCount: agentIds.length,
    overallScore: Math.round(overallScore * 100) / 100,
  };

  // Persist as a learning record
  await db.insert(aiLearningRecords).values({
    companyId,
    goalId,
    recordType: "evaluation",
    category: "outcome",
    summary: `Goal ${goalId}: ${success ? "succeeded" : "failed"} — score ${evaluation.overallScore}`,
    details: evaluation as unknown as Record<string, unknown>,
    scores: {
      completionRate: evaluation.completionRate,
      errorRate: evaluation.errorRate,
      overallScore: evaluation.overallScore,
      costEfficiency: Math.round(costEfficiency * 100) / 100,
      timeEfficiency: Math.round(timeEfficiency * 100) / 100,
    },
  });

  await publishEvent("ai.learning.evaluation.created", {
    companyId,
    goalId,
    success,
    overallScore: evaluation.overallScore,
  });

  logger.info(
    { goalId, success, score: evaluation.overallScore, timeMs: executionTimeMs },
    "Goal outcome evaluated",
  );

  return evaluation;
}

/**
 * Evaluate a batch of goal outcomes (for historical analysis).
 */
export async function evaluateOutcomes(
  db: Db,
  outcomes: GoalOutcome[],
): Promise<OutcomeEvaluation[]> {
  const results: OutcomeEvaluation[] = [];
  for (const outcome of outcomes) {
    results.push(await evaluateOutcome(db, outcome));
  }
  return results;
}
