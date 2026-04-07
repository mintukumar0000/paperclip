// ---------------------------------------------------------------------------
// Prompt Optimizer — automatically improves agent prompts based on performance
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { aiLearningRecords } from "@paperclipai/db";
import { eq, and, desc } from "@paperclipai/db";
import { publishEvent } from "../../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "prompt-optimizer" });

export interface PromptVersion {
  id: string;
  agentId: string;
  companyId: string;
  taskType: string;
  originalPrompt: string;
  optimizedPrompt: string;
  improvementReason: string;
  version: number;
  performanceBeforeScore: number;
  performanceAfterScore?: number;
  status: "proposed" | "active" | "rolled_back";
  createdAt: Date;
}

export interface PromptOptimizationResult {
  agentId: string;
  taskType: string;
  original: string;
  optimized: string;
  changes: string[];
  expectedImprovement: string;
}

/** Common prompt enhancement patterns based on performance signals */
const ENHANCEMENT_PATTERNS: {
  condition: (scores: Record<string, number>) => boolean;
  enhancement: string;
  description: string;
}[] = [
  {
    condition: (s) => (s.accuracy ?? 1) < 0.6,
    enhancement: "Be precise and verify each step before proceeding. Double-check outputs against requirements.",
    description: "Added accuracy verification instructions",
  },
  {
    condition: (s) => (s.completeness ?? 1) < 0.7,
    enhancement: "Ensure ALL required deliverables are completed. Check the full requirements list before finishing.",
    description: "Added completeness checklist",
  },
  {
    condition: (s) => (s.efficiency ?? 1) < 0.5,
    enhancement: "Optimize for efficiency: use concise approaches, avoid unnecessary steps, and prefer proven patterns.",
    description: "Added efficiency guidance",
  },
  {
    condition: (s) => (s.goalAlignment ?? 1) < 0.6,
    enhancement: "Stay focused on the primary goal. Before each action, verify it directly serves the objective.",
    description: "Added goal-alignment reminder",
  },
];

/**
 * Optimize a prompt based on historical performance data.
 */
export async function optimizePrompt(
  db: Db,
  companyId: string,
  agentId: string,
  taskType: string,
  currentPrompt: string,
): Promise<PromptOptimizationResult> {
  // Load quality scores for this agent
  const records = await db
    .select()
    .from(aiLearningRecords)
    .where(
      and(
        eq(aiLearningRecords.companyId, companyId),
        eq(aiLearningRecords.recordType, "evaluation"),
        eq(aiLearningRecords.category, "quality"),
      ),
    )
    .orderBy(desc(aiLearningRecords.createdAt))
    .limit(20);

  // Filter for this agent's records
  const agentRecords = records.filter((r) => {
    const d = r.details as Record<string, unknown>;
    return d.agentId === agentId;
  });

  // Aggregate scores
  const avgScores: Record<string, number> = {};
  const scoreKeys = ["accuracy", "completeness", "efficiency", "goalAlignment", "composite"];
  for (const key of scoreKeys) {
    const vals = agentRecords
      .map((r) => (r.scores as Record<string, number> | null)?.[key])
      .filter((v): v is number => v != null);
    avgScores[key] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0.75;
  }

  // Apply enhancement patterns
  const changes: string[] = [];
  const enhancements: string[] = [];

  for (const pattern of ENHANCEMENT_PATTERNS) {
    if (pattern.condition(avgScores)) {
      enhancements.push(pattern.enhancement);
      changes.push(pattern.description);
    }
  }

  // Build optimized prompt
  let optimized = currentPrompt;
  if (enhancements.length > 0) {
    const enhancementBlock = "\n\nIMPORTANT GUIDELINES:\n" + enhancements.map((e, i) => `${i + 1}. ${e}`).join("\n");
    optimized = currentPrompt + enhancementBlock;
  }

  // Persist the optimization
  const version: PromptVersion = {
    id: crypto.randomUUID(),
    agentId,
    companyId,
    taskType,
    originalPrompt: currentPrompt,
    optimizedPrompt: optimized,
    improvementReason: changes.join("; ") || "No changes needed",
    version: agentRecords.length + 1,
    performanceBeforeScore: avgScores.composite ?? 0,
    status: changes.length > 0 ? "proposed" : "active",
    createdAt: new Date(),
  };

  await db.insert(aiLearningRecords).values({
    companyId,
    agentId,
    recordType: "optimization",
    category: "prompt",
    summary: `Prompt optimization for ${taskType}: ${changes.length} changes`,
    details: {
      versionId: version.id,
      taskType,
      originalLength: currentPrompt.length,
      optimizedLength: optimized.length,
      changesApplied: changes,
      avgScores,
    },
    scores: avgScores,
    recommendedChange: changes.join("; "),
  });

  if (changes.length > 0) {
    await publishEvent("ai.learning.prompt.optimized", {
      companyId,
      agentId,
      taskType,
      changeCount: changes.length,
    });
  }

  logger.info(
    { agentId, taskType, changes: changes.length },
    "Prompt optimization computed",
  );

  return {
    agentId,
    taskType,
    original: currentPrompt,
    optimized,
    changes,
    expectedImprovement: changes.length > 0
      ? `Expected improvement in: ${changes.map((c) => c.replace("Added ", "").replace(" instructions", "").replace(" checklist", "").replace(" guidance", "").replace(" reminder", "")).join(", ")}`
      : "No improvements needed — performance is good",
  };
}

/**
 * Get prompt optimization history for an agent.
 */
export async function getPromptHistory(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<Array<{ id: string; taskType: string; changes: string[]; createdAt: Date }>> {
  const records = await db
    .select()
    .from(aiLearningRecords)
    .where(
      and(
        eq(aiLearningRecords.companyId, companyId),
        eq(aiLearningRecords.recordType, "optimization"),
        eq(aiLearningRecords.category, "prompt"),
      ),
    )
    .orderBy(desc(aiLearningRecords.createdAt))
    .limit(20);

  return records
    .filter((r) => r.agentId === agentId)
    .map((r) => {
      const d = r.details as Record<string, unknown>;
      return {
        id: r.id,
        taskType: d.taskType as string ?? "unknown",
        changes: (d.changesApplied as string[]) ?? [],
        createdAt: r.createdAt,
      };
    });
}
