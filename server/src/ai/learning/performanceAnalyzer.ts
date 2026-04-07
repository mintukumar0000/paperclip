// ---------------------------------------------------------------------------
// Performance Analyzer — analyzes historical executions for patterns/insights
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { aiLearningRecords } from "@paperclipai/db";
import { eq, and, desc } from "@paperclipai/db";
import pino from "pino";

const logger = pino({ name: "performance-analyzer" });

export interface PerformanceInsight {
  type: "agent_strength" | "agent_weakness" | "bottleneck" | "cost_anomaly" | "failure_pattern";
  agentId?: string;
  taskType?: string;
  description: string;
  severity: "low" | "medium" | "high";
  evidence: Record<string, unknown>;
  recommendation: string;
}

export interface PerformanceReport {
  companyId: string;
  analyzedRecords: number;
  insights: PerformanceInsight[];
  agentPerformance: AgentPerformanceSummary[];
  overallScore: number;
  generatedAt: Date;
}

export interface AgentPerformanceSummary {
  agentId: string;
  goalCount: number;
  avgScore: number;
  avgCompletionRate: number;
  avgErrorRate: number;
  totalCostCents: number;
  strengths: string[];
  weaknesses: string[];
}

/**
 * Analyze company-wide performance from historical learning records.
 */
export async function analyzePerformance(
  db: Db,
  companyId: string,
): Promise<PerformanceReport> {
  // Load evaluations
  const records = await db
    .select()
    .from(aiLearningRecords)
    .where(
      and(
        eq(aiLearningRecords.companyId, companyId),
        eq(aiLearningRecords.recordType, "evaluation"),
      ),
    )
    .orderBy(desc(aiLearningRecords.createdAt))
    .limit(200);

  const insights: PerformanceInsight[] = [];
  const agentMap = new Map<string, {
    scores: number[];
    completionRates: number[];
    errorRates: number[];
    costCents: number[];
    taskTypes: string[];
  }>();

  for (const record of records) {
    const details = record.details as Record<string, unknown>;
    const scores = record.scores as Record<string, number> | null;
    const agentId = record.agentId ?? (details.agentId as string | undefined);

    if (agentId) {
      if (!agentMap.has(agentId)) {
        agentMap.set(agentId, { scores: [], completionRates: [], errorRates: [], costCents: [], taskTypes: [] });
      }
      const entry = agentMap.get(agentId)!;
      if (scores?.composite != null) entry.scores.push(scores.composite);
      if (scores?.completionRate != null) entry.completionRates.push(scores.completionRate);
      if (scores?.errorRate != null) entry.errorRates.push(scores.errorRate);
      if (details.costCents != null) entry.costCents.push(details.costCents as number);
      if (details.taskType) entry.taskTypes.push(details.taskType as string);
    }

    // Detect failure patterns
    if (scores?.errorRate != null && scores.errorRate > 0.5) {
      insights.push({
        type: "failure_pattern",
        agentId: agentId ?? undefined,
        taskType: details.taskType as string | undefined,
        description: `High error rate (${Math.round(scores.errorRate * 100)}%) detected`,
        severity: scores.errorRate > 0.75 ? "high" : "medium",
        evidence: { recordId: record.id, errorRate: scores.errorRate, goalId: record.goalId },
        recommendation: `Review task assignment for ${details.taskType ?? "tasks"} — consider reassigning or improving prompts`,
      });
    }

    // Detect cost anomalies
    if (details.costCents != null && (details.costCents as number) > 500) {
      insights.push({
        type: "cost_anomaly",
        agentId: agentId ?? undefined,
        description: `High cost ($${((details.costCents as number) / 100).toFixed(2)}) for single goal`,
        severity: (details.costCents as number) > 1000 ? "high" : "medium",
        evidence: { recordId: record.id, costCents: details.costCents, goalId: record.goalId },
        recommendation: "Consider optimizing prompts or reducing step count for cost efficiency",
      });
    }
  }

  // Build per-agent summaries
  const agentPerformance: AgentPerformanceSummary[] = [];
  for (const [agentId, data] of agentMap) {
    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const avgScore = Math.round(avg(data.scores) * 100) / 100;
    const avgCompletion = Math.round(avg(data.completionRates) * 100) / 100;
    const avgError = Math.round(avg(data.errorRates) * 100) / 100;
    const totalCost = data.costCents.reduce((a, b) => a + b, 0);

    const strengths: string[] = [];
    const weaknesses: string[] = [];

    if (avgScore >= 0.8) strengths.push("high_overall_quality");
    if (avgCompletion >= 0.9) strengths.push("high_completion_rate");
    if (avgError <= 0.1) strengths.push("low_error_rate");

    if (avgScore < 0.5) weaknesses.push("low_overall_quality");
    if (avgCompletion < 0.7) weaknesses.push("low_completion_rate");
    if (avgError > 0.3) weaknesses.push("high_error_rate");

    // Detect agent strengths/weaknesses as insights
    if (avgScore >= 0.8 && data.scores.length >= 3) {
      const topTypes = [...new Set(data.taskTypes)].slice(0, 3);
      insights.push({
        type: "agent_strength",
        agentId,
        description: `Agent consistently performs well (avg score ${avgScore})`,
        severity: "low",
        evidence: { avgScore, goalCount: data.scores.length, topTaskTypes: topTypes },
        recommendation: `Route more ${topTypes.join(", ")} tasks to this agent`,
      });
    }

    if (avgScore < 0.5 && data.scores.length >= 3) {
      insights.push({
        type: "agent_weakness",
        agentId,
        description: `Agent consistently underperforms (avg score ${avgScore})`,
        severity: "high",
        evidence: { avgScore, goalCount: data.scores.length, avgError },
        recommendation: "Review agent prompts, role assignment, or consider retraining",
      });
    }

    agentPerformance.push({
      agentId,
      goalCount: data.scores.length,
      avgScore,
      avgCompletionRate: avgCompletion,
      avgErrorRate: avgError,
      totalCostCents: totalCost,
      strengths,
      weaknesses,
    });
  }

  // Sort by performance (worst first for attention)
  agentPerformance.sort((a, b) => a.avgScore - b.avgScore);

  // Overall company score
  const allScores = agentPerformance.map((a) => a.avgScore).filter((s) => s > 0);
  const overallScore = allScores.length > 0
    ? Math.round((allScores.reduce((a, b) => a + b, 0) / allScores.length) * 100) / 100
    : 0;

  const report: PerformanceReport = {
    companyId,
    analyzedRecords: records.length,
    insights,
    agentPerformance,
    overallScore,
    generatedAt: new Date(),
  };

  // Persist the analysis as a learning record
  if (insights.length > 0) {
    await db.insert(aiLearningRecords).values({
      companyId,
      recordType: "insight",
      category: "performance",
      summary: `Performance analysis: ${insights.length} insights, overall score ${overallScore}`,
      details: {
        insightCount: insights.length,
        agentCount: agentPerformance.length,
        overallScore,
        topInsightTypes: [...new Set(insights.map((i) => i.type))],
      },
    });
  }

  logger.info(
    { companyId, records: records.length, insights: insights.length, overallScore },
    "Performance analysis complete",
  );

  return report;
}

/**
 * Get performance insights for a specific agent.
 */
export async function analyzeAgentPerformance(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<AgentPerformanceSummary | null> {
  const report = await analyzePerformance(db, companyId);
  return report.agentPerformance.find((a) => a.agentId === agentId) ?? null;
}
