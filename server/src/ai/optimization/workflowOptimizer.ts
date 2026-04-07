// ---------------------------------------------------------------------------
// Workflow Optimizer — improves execution workflows based on past performance
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { aiLearningRecords } from "@paperclipai/db";
import { eq, and, desc } from "@paperclipai/db";
import { publishEvent } from "../../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "workflow-optimizer" });

export interface WorkflowStep {
  id: string;
  name: string;
  taskType: string;
  agentRole?: string;
  dependsOn: string[];
}

export interface WorkflowOptimization {
  companyId: string;
  originalSteps: WorkflowStep[];
  optimizedSteps: WorkflowStep[];
  additions: WorkflowStep[];
  removals: string[];          // step IDs removed
  reorderings: { stepId: string; reason: string }[];
  reason: string;
  expectedImpact: "low" | "medium" | "high";
}

/** Common workflow improvement patterns */
const WORKFLOW_PATTERNS: {
  condition: (steps: WorkflowStep[], scores: Record<string, number>) => boolean;
  apply: (steps: WorkflowStep[]) => { additions: WorkflowStep[]; reason: string };
}[] = [
  {
    // If there's a deploy step but no test step, add testing before deploy
    condition: (steps) =>
      steps.some((s) => s.taskType === "deployment") &&
      !steps.some((s) => s.taskType === "testing"),
    apply: (steps) => {
      const deployStep = steps.find((s) => s.taskType === "deployment")!;
      return {
        additions: [{
          id: crypto.randomUUID(),
          name: "Automated testing (auto-added)",
          taskType: "testing",
          agentRole: "qa",
          dependsOn: deployStep.dependsOn, // same deps as deploy
        }],
        reason: "Added testing step before deployment for quality assurance",
      };
    },
  },
  {
    // If there's a marketing step but no research step, add market research first
    condition: (steps) =>
      steps.some((s) => s.taskType === "marketing") &&
      !steps.some((s) => s.taskType === "research"),
    apply: () => ({
      additions: [{
        id: crypto.randomUUID(),
        name: "Market research (auto-added)",
        taskType: "research",
        agentRole: "researcher",
        dependsOn: [],
      }],
      reason: "Added market research step before marketing for better targeting",
    }),
  },
  {
    // If error rate is high and no validation step exists, add one
    condition: (_steps, scores) =>
      (scores.errorRate ?? 0) > 0.3 &&
      !_steps.some((s) => s.name.toLowerCase().includes("validat")),
    apply: (steps) => ({
      additions: [{
        id: crypto.randomUUID(),
        name: "Output validation (auto-added)",
        taskType: "testing",
        agentRole: "qa",
        dependsOn: steps.filter((s) => s.dependsOn.length === 0).map((s) => s.id),
      }],
      reason: "Added validation step to reduce error rate",
    }),
  },
];

/**
 * Optimize a workflow based on historical performance patterns.
 */
export async function optimizeWorkflow(
  db: Db,
  companyId: string,
  steps: WorkflowStep[],
): Promise<WorkflowOptimization> {
  // Load recent performance scores
  const records = await db
    .select()
    .from(aiLearningRecords)
    .where(
      and(
        eq(aiLearningRecords.companyId, companyId),
        eq(aiLearningRecords.recordType, "evaluation"),
        eq(aiLearningRecords.category, "outcome"),
      ),
    )
    .orderBy(desc(aiLearningRecords.createdAt))
    .limit(20);

  // Aggregate scores
  const avgScores: Record<string, number> = {};
  const scoreKeys = ["completionRate", "errorRate", "overallScore", "costEfficiency", "timeEfficiency"];
  for (const key of scoreKeys) {
    const vals = records
      .map((r) => (r.scores as Record<string, number> | null)?.[key])
      .filter((v): v is number => v != null);
    avgScores[key] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }

  const allAdditions: WorkflowStep[] = [];
  const reasons: string[] = [];

  // Apply workflow patterns
  for (const pattern of WORKFLOW_PATTERNS) {
    if (pattern.condition(steps, avgScores)) {
      const result = pattern.apply(steps);
      allAdditions.push(...result.additions);
      reasons.push(result.reason);
    }
  }

  // Build optimized step list
  const optimizedSteps = [...steps];

  // Insert additions at appropriate positions
  for (const addition of allAdditions) {
    // Find the position to insert: before the step that depends on it, or at end
    const insertIdx = optimizedSteps.findIndex((s) =>
      addition.taskType === "testing" && s.taskType === "deployment",
    );
    if (insertIdx >= 0) {
      // Update deploy step to depend on the new test step
      optimizedSteps[insertIdx] = {
        ...optimizedSteps[insertIdx],
        dependsOn: [...optimizedSteps[insertIdx].dependsOn, addition.id],
      };
      optimizedSteps.splice(insertIdx, 0, addition);
    } else {
      optimizedSteps.push(addition);
    }
  }

  const optimization: WorkflowOptimization = {
    companyId,
    originalSteps: steps,
    optimizedSteps,
    additions: allAdditions,
    removals: [],
    reorderings: [],
    reason: reasons.join("; ") || "No workflow optimizations needed",
    expectedImpact: allAdditions.length > 0 ? "medium" : "low",
  };

  // Persist
  if (allAdditions.length > 0) {
    await db.insert(aiLearningRecords).values({
      companyId,
      recordType: "optimization",
      category: "workflow",
      summary: `Workflow optimization: ${allAdditions.length} steps added`,
      details: {
        originalStepCount: steps.length,
        optimizedStepCount: optimizedSteps.length,
        additions: allAdditions.map((a) => ({ id: a.id, name: a.name, taskType: a.taskType })),
        reasons,
        avgScores,
      },
      recommendedChange: reasons.join("; "),
    });

    await publishEvent("ai.learning.workflow.optimized", {
      companyId,
      additionsCount: allAdditions.length,
      originalSteps: steps.length,
      optimizedSteps: optimizedSteps.length,
    });
  }

  logger.info(
    { companyId, originalSteps: steps.length, optimizedSteps: optimizedSteps.length, additions: allAdditions.length },
    "Workflow optimization computed",
  );

  return optimization;
}

/**
 * Get workflow optimization history for a company.
 */
export async function getWorkflowOptimizationHistory(
  db: Db,
  companyId: string,
): Promise<Array<{ id: string; summary: string; additions: number; createdAt: Date }>> {
  const records = await db
    .select()
    .from(aiLearningRecords)
    .where(
      and(
        eq(aiLearningRecords.companyId, companyId),
        eq(aiLearningRecords.recordType, "optimization"),
        eq(aiLearningRecords.category, "workflow"),
      ),
    )
    .orderBy(desc(aiLearningRecords.createdAt))
    .limit(20);

  return records.map((r) => {
    const d = r.details as Record<string, unknown>;
    return {
      id: r.id,
      summary: r.summary,
      additions: (d.additions as unknown[])?.length ?? 0,
      createdAt: r.createdAt,
    };
  });
}
