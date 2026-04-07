// ---------------------------------------------------------------------------
// Reflection Engine — the central intelligence of the self-improving AI layer
//
// Reads goal results, quality scores, and performance insights, then
// generates structured improvement recommendations.
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { aiLearningRecords } from "@paperclipai/db";
import { eq, and, desc } from "@paperclipai/db";
import type { OutcomeEvaluation } from "../evaluation/outcomeEvaluator.js";
import type { QualityScore } from "../evaluation/qualityScorer.js";
import type { PerformanceInsight, PerformanceReport } from "./performanceAnalyzer.js";
import { analyzePerformance } from "./performanceAnalyzer.js";
import { publishEvent } from "../../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "reflection-engine" });

export interface Reflection {
  id: string;
  companyId: string;
  goalId?: string;
  observation: string;
  hypothesis: string;
  recommendation: string;
  category: "prompt" | "workflow" | "strategy" | "routing" | "budget" | "general";
  confidence: number;  // 0-1
  priority: "low" | "medium" | "high" | "critical";
  evidence: Record<string, unknown>;
}

export interface ReflectionResult {
  companyId: string;
  reflections: Reflection[];
  sourceInsights: number;
  sourceEvaluations: number;
  generatedAt: Date;
}

/**
 * Run the full reflection process for a company.
 *
 * Pipeline:
 *   1. Load recent evaluations and quality scores
 *   2. Run performance analysis
 *   3. Generate reflections from patterns
 *   4. Persist reflections as learning records
 */
export async function reflect(
  db: Db,
  companyId: string,
): Promise<ReflectionResult> {
  // Load recent evaluation records
  const evaluations = await db
    .select()
    .from(aiLearningRecords)
    .where(
      and(
        eq(aiLearningRecords.companyId, companyId),
        eq(aiLearningRecords.recordType, "evaluation"),
      ),
    )
    .orderBy(desc(aiLearningRecords.createdAt))
    .limit(100);

  // Run performance analysis
  const report = await analyzePerformance(db, companyId);

  // Generate reflections from insights and evaluations
  const reflections: Reflection[] = [];

  // Reflect on performance insights
  for (const insight of report.insights) {
    const reflection = insightToReflection(companyId, insight);
    if (reflection) reflections.push(reflection);
  }

  // Reflect on low-scoring evaluations
  for (const record of evaluations) {
    const scores = record.scores as Record<string, number> | null;
    if (!scores) continue;

    if (record.category === "outcome" && scores.overallScore != null && scores.overallScore < 0.6) {
      reflections.push(createReflection(companyId, {
        goalId: record.goalId ?? undefined,
        observation: `Goal scored low (${scores.overallScore}) — below 0.6 threshold`,
        hypothesis: "Prompts or workflow steps may be insufficient for this goal type",
        recommendation: "Review and enhance prompts for similar goals; consider adding validation steps",
        category: "prompt",
        confidence: 0.7,
        priority: scores.overallScore < 0.4 ? "high" : "medium",
        evidence: { recordId: record.id, scores },
      }));
    }

    if (record.category === "quality" && scores.efficiency != null && scores.efficiency < 0.5) {
      reflections.push(createReflection(companyId, {
        goalId: record.goalId ?? undefined,
        observation: `Low efficiency score (${scores.efficiency}) — task took too long or cost too much`,
        hypothesis: "Workflow may have unnecessary steps or agent is not optimally matched",
        recommendation: "Optimize workflow by removing redundant steps or re-routing to more efficient agent",
        category: "workflow",
        confidence: 0.6,
        priority: "medium",
        evidence: { recordId: record.id, scores },
      }));
    }

    if (record.category === "quality" && scores.accuracy != null && scores.accuracy < 0.6) {
      reflections.push(createReflection(companyId, {
        goalId: record.goalId ?? undefined,
        observation: `Low accuracy (${scores.accuracy}) — many errors in execution`,
        hypothesis: "Agent may lack required capabilities or prompt is ambiguous",
        recommendation: "Improve prompt specificity and add error-handling steps",
        category: "prompt",
        confidence: 0.65,
        priority: "high",
        evidence: { recordId: record.id, scores },
      }));
    }
  }

  // Reflect on agent-level patterns
  for (const agent of report.agentPerformance) {
    if (agent.weaknesses.includes("high_error_rate") && agent.goalCount >= 3) {
      reflections.push(createReflection(companyId, {
        observation: `Agent ${agent.agentId} has persistent high error rate (avg ${agent.avgErrorRate})`,
        hypothesis: "Agent may be assigned tasks outside its competency or needs updated prompts",
        recommendation: "Consider re-routing tasks to alternative agents or updating the agent's prompt template",
        category: "routing",
        confidence: 0.75,
        priority: "high",
        evidence: { agentId: agent.agentId, avgErrorRate: agent.avgErrorRate, goalCount: agent.goalCount },
      }));
    }

    if (agent.totalCostCents > 2000 && agent.goalCount >= 3) {
      const avgCost = Math.round(agent.totalCostCents / agent.goalCount);
      reflections.push(createReflection(companyId, {
        observation: `Agent ${agent.agentId} has high average cost ($${(avgCost / 100).toFixed(2)}/goal)`,
        hypothesis: "Agent may be using verbose prompts or unnecessary tool calls",
        recommendation: "Optimize prompts for conciseness; review tool usage patterns",
        category: "budget",
        confidence: 0.6,
        priority: "medium",
        evidence: { agentId: agent.agentId, totalCostCents: agent.totalCostCents, avgCostPerGoal: avgCost },
      }));
    }
  }

  // Deduplicate similar reflections
  const deduped = deduplicateReflections(reflections);

  // Persist reflections
  for (const r of deduped) {
    await db.insert(aiLearningRecords).values({
      companyId,
      goalId: r.goalId,
      recordType: "insight",
      category: r.category,
      summary: r.recommendation,
      details: {
        observation: r.observation,
        hypothesis: r.hypothesis,
        confidence: r.confidence,
        priority: r.priority,
      },
      scores: { confidence: r.confidence },
      recommendedChange: r.recommendation,
    });
  }

  await publishEvent("ai.learning.reflection.completed", {
    companyId,
    reflectionCount: deduped.length,
    categories: [...new Set(deduped.map((r) => r.category))],
  });

  logger.info(
    { companyId, reflections: deduped.length, evaluations: evaluations.length, insights: report.insights.length },
    "Reflection complete",
  );

  return {
    companyId,
    reflections: deduped,
    sourceInsights: report.insights.length,
    sourceEvaluations: evaluations.length,
    generatedAt: new Date(),
  };
}

/**
 * Reflect on a single goal's outcome (post-execution review).
 */
export async function reflectOnGoal(
  db: Db,
  companyId: string,
  goalId: string,
  evaluation: OutcomeEvaluation,
  qualityScores: QualityScore[],
): Promise<Reflection[]> {
  const reflections: Reflection[] = [];

  if (!evaluation.success) {
    reflections.push(createReflection(companyId, {
      goalId,
      observation: `Goal ${goalId} failed with completion rate ${evaluation.completionRate}`,
      hypothesis: "Planning or execution may have hit an unrecoverable error",
      recommendation: "Add retry logic for failed steps and improve error handling in prompts",
      category: "workflow",
      confidence: 0.8,
      priority: "high",
      evidence: { evaluation },
    }));
  }

  for (const qs of qualityScores) {
    if (qs.composite < 0.5) {
      reflections.push(createReflection(companyId, {
        goalId,
        observation: `Agent ${qs.agentId} scored ${qs.composite} on goal ${goalId}`,
        hypothesis: `Agent may need better prompts or different task assignments (accuracy=${qs.accuracy}, completeness=${qs.completeness})`,
        recommendation: `Review and improve prompts for agent ${qs.agentId}; consider task re-routing`,
        category: "prompt",
        confidence: 0.7,
        priority: "medium",
        evidence: { qualityScore: qs },
      }));
    }
  }

  // Persist
  for (const r of reflections) {
    await db.insert(aiLearningRecords).values({
      companyId,
      goalId: r.goalId,
      recordType: "insight",
      category: r.category,
      summary: r.recommendation,
      details: {
        observation: r.observation,
        hypothesis: r.hypothesis,
        confidence: r.confidence,
        priority: r.priority,
      },
      scores: { confidence: r.confidence },
      recommendedChange: r.recommendation,
    });
  }

  return reflections;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createReflection(
  companyId: string,
  params: Omit<Reflection, "id" | "companyId">,
): Reflection {
  return {
    id: crypto.randomUUID(),
    companyId,
    ...params,
  };
}

function insightToReflection(companyId: string, insight: PerformanceInsight): Reflection | null {
  const categoryMap: Record<string, Reflection["category"]> = {
    agent_strength: "routing",
    agent_weakness: "prompt",
    bottleneck: "workflow",
    cost_anomaly: "budget",
    failure_pattern: "prompt",
  };

  return createReflection(companyId, {
    observation: insight.description,
    hypothesis: deriveHypothesis(insight),
    recommendation: insight.recommendation,
    category: categoryMap[insight.type] ?? "general",
    confidence: insight.severity === "high" ? 0.8 : insight.severity === "medium" ? 0.6 : 0.4,
    priority: insight.severity,
    evidence: insight.evidence,
  });
}

function deriveHypothesis(insight: PerformanceInsight): string {
  switch (insight.type) {
    case "agent_strength":
      return "This agent is well-suited for its assigned task types";
    case "agent_weakness":
      return "Agent may need prompt improvements or task reassignment";
    case "bottleneck":
      return "A step in the workflow is creating delays";
    case "cost_anomaly":
      return "Resource usage exceeds expected baselines";
    case "failure_pattern":
      return "Repeated failures suggest a systematic issue";
    default:
      return "Pattern detected that may warrant investigation";
  }
}

function deduplicateReflections(reflections: Reflection[]): Reflection[] {
  const seen = new Set<string>();
  return reflections.filter((r) => {
    const key = `${r.category}:${r.observation.slice(0, 50)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
