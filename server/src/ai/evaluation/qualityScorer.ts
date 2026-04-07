// ---------------------------------------------------------------------------
// Quality Scorer — scores the quality of agent outputs across dimensions
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { aiLearningRecords } from "@paperclipai/db";
import pino from "pino";

const logger = pino({ name: "quality-scorer" });

export interface QualityInput {
  goalId: string;
  companyId: string;
  agentId: string;
  taskType: string;
  output: string;
  expectedOutcome?: string;
  stepCount: number;
  completedSteps: number;
  failedSteps: number;
  executionTimeMs: number;
  costCents: number;
}

export interface QualityScore {
  goalId: string;
  agentId: string;
  accuracy: number;       // 0-1: how well output matches expectations
  completeness: number;   // 0-1: portion of expected work done
  efficiency: number;     // 0-1: resource usage vs baseline
  goalAlignment: number;  // 0-1: how well output serves the goal
  composite: number;      // 0-1: weighted aggregate
}

/** Scoring weights */
const QUALITY_WEIGHTS = {
  accuracy: 0.30,
  completeness: 0.30,
  efficiency: 0.20,
  goalAlignment: 0.20,
};

/**
 * Score the quality of an agent's output for a goal/task.
 *
 * Heuristic scoring based on execution metrics:
 *   - accuracy: inverse of error rate
 *   - completeness: step completion ratio
 *   - efficiency: time and cost relative to baselines
 *   - goalAlignment: success + completion + low error composite
 */
export async function scoreQuality(
  db: Db,
  input: QualityInput,
): Promise<QualityScore> {
  const {
    goalId, companyId, agentId, taskType,
    stepCount, completedSteps, failedSteps,
    executionTimeMs, costCents,
  } = input;

  // Accuracy: based on error rate (fewer errors = higher accuracy)
  const errorRate = stepCount > 0 ? failedSteps / stepCount : 0;
  const accuracy = Math.round((1 - errorRate) * 100) / 100;

  // Completeness: step completion ratio
  const completeness = stepCount > 0
    ? Math.round((completedSteps / stepCount) * 100) / 100
    : 0;

  // Efficiency: time-based (60s per step baseline) + cost-based ($0.50/step baseline)
  const expectedTimeMs = stepCount * 60_000;
  const timeScore = expectedTimeMs > 0
    ? Math.min(1, expectedTimeMs / Math.max(executionTimeMs, 1))
    : 0.5;
  const expectedCostCents = stepCount * 50;
  const costScore = expectedCostCents > 0
    ? Math.min(1, expectedCostCents / Math.max(costCents, 1))
    : 0.5;
  const efficiency = Math.round(((timeScore + costScore) / 2) * 100) / 100;

  // Goal alignment: composite of completion, low errors, and overall success signal
  const goalAlignment = Math.round(
    (completeness * 0.5 + accuracy * 0.3 + efficiency * 0.2) * 100,
  ) / 100;

  // Composite score
  const composite = Math.round((
    QUALITY_WEIGHTS.accuracy * accuracy +
    QUALITY_WEIGHTS.completeness * completeness +
    QUALITY_WEIGHTS.efficiency * efficiency +
    QUALITY_WEIGHTS.goalAlignment * goalAlignment
  ) * 100) / 100;

  const score: QualityScore = {
    goalId,
    agentId,
    accuracy,
    completeness,
    efficiency,
    goalAlignment,
    composite,
  };

  // Persist the quality score as a learning record
  await db.insert(aiLearningRecords).values({
    companyId,
    goalId,
    agentId,
    recordType: "evaluation",
    category: "quality",
    summary: `Agent ${agentId} quality for ${taskType}: ${composite}`,
    details: { ...score, taskType } as unknown as Record<string, unknown>,
    scores: {
      accuracy,
      completeness,
      efficiency,
      goalAlignment,
      composite,
    },
  });

  logger.info(
    { goalId, agentId, taskType, composite },
    "Quality scored",
  );

  return score;
}

/**
 * Score quality for multiple agents on the same goal.
 */
export async function scoreGoalQuality(
  db: Db,
  inputs: QualityInput[],
): Promise<QualityScore[]> {
  const scores: QualityScore[] = [];
  for (const input of inputs) {
    scores.push(await scoreQuality(db, input));
  }
  return scores;
}

/**
 * Get an aggregate quality summary for an agent across goals.
 */
export function aggregateQualityScores(scores: QualityScore[]): {
  avgAccuracy: number;
  avgCompleteness: number;
  avgEfficiency: number;
  avgGoalAlignment: number;
  avgComposite: number;
  count: number;
} {
  if (scores.length === 0) {
    return { avgAccuracy: 0, avgCompleteness: 0, avgEfficiency: 0, avgGoalAlignment: 0, avgComposite: 0, count: 0 };
  }
  const sum = (key: keyof QualityScore) =>
    scores.reduce((acc, s) => acc + (typeof s[key] === "number" ? s[key] : 0), 0);
  const n = scores.length;
  return {
    avgAccuracy: Math.round((sum("accuracy") / n) * 100) / 100,
    avgCompleteness: Math.round((sum("completeness") / n) * 100) / 100,
    avgEfficiency: Math.round((sum("efficiency") / n) * 100) / 100,
    avgGoalAlignment: Math.round((sum("goalAlignment") / n) * 100) / 100,
    avgComposite: Math.round((sum("composite") / n) * 100) / 100,
    count: n,
  };
}
