// ---------------------------------------------------------------------------
// Strategy Optimizer — improves high-level execution strategies
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { aiLearningRecords } from "@paperclipai/db";
import { eq, and, desc } from "@paperclipai/db";
import { publishEvent } from "../../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "strategy-optimizer" });

export interface StrategyStep {
  phase: string;
  description: string;
  importance: "critical" | "important" | "optional";
}

export interface StrategyOptimization {
  companyId: string;
  goalType: string;
  originalStrategy: StrategyStep[];
  optimizedStrategy: StrategyStep[];
  additions: StrategyStep[];
  reorderings: string[];
  reason: string;
  confidence: number;
}

/** Strategy patterns — common improvements based on goal types */
const STRATEGY_PATTERNS: Record<string, {
  check: (steps: StrategyStep[]) => boolean;
  additions: StrategyStep[];
  reason: string;
}[]> = {
  product_launch: [
    {
      check: (steps) => !steps.some((s) => s.phase.toLowerCase().includes("validat")),
      additions: [
        { phase: "Market validation", description: "Validate market demand before building", importance: "critical" },
      ],
      reason: "Added market validation phase before building",
    },
    {
      check: (steps) => !steps.some((s) => s.phase.toLowerCase().includes("feedback")),
      additions: [
        { phase: "Feedback collection", description: "Collect user feedback after MVP", importance: "important" },
      ],
      reason: "Added feedback collection after MVP for iterative improvement",
    },
  ],
  marketing_campaign: [
    {
      check: (steps) => !steps.some((s) => s.description.toLowerCase().includes("seo") || s.description.toLowerCase().includes("keyword")),
      additions: [
        { phase: "SEO keyword research", description: "Research and integrate target keywords for SEO optimization", importance: "important" },
      ],
      reason: "Added SEO keyword research for better campaign performance",
    },
    {
      check: (steps) => !steps.some((s) => s.phase.toLowerCase().includes("a/b") || s.description.toLowerCase().includes("test")),
      additions: [
        { phase: "A/B testing", description: "Test campaign variations before full rollout", importance: "optional" },
      ],
      reason: "Added A/B testing phase for optimization",
    },
  ],
  engineering: [
    {
      check: (steps) => !steps.some((s) => s.phase.toLowerCase().includes("test")),
      additions: [
        { phase: "Testing", description: "Run automated tests before deployment", importance: "critical" },
      ],
      reason: "Added testing phase",
    },
    {
      check: (steps) => !steps.some((s) => s.phase.toLowerCase().includes("review")),
      additions: [
        { phase: "Code review", description: "Review code changes for quality and security", importance: "important" },
      ],
      reason: "Added code review phase",
    },
  ],
  default: [
    {
      check: (steps) => !steps.some((s) => s.phase.toLowerCase().includes("plan")),
      additions: [
        { phase: "Planning", description: "Define clear objectives and success criteria", importance: "important" },
      ],
      reason: "Added planning phase for clarity",
    },
  ],
};

/**
 * Optimize a strategy for a given goal type.
 */
export async function optimizeStrategy(
  db: Db,
  companyId: string,
  goalType: string,
  currentStrategy: StrategyStep[],
): Promise<StrategyOptimization> {
  const patterns = STRATEGY_PATTERNS[goalType] ?? STRATEGY_PATTERNS.default;

  const additions: StrategyStep[] = [];
  const reasons: string[] = [];

  // Also check learnings from past executions
  const pastInsights = await db
    .select()
    .from(aiLearningRecords)
    .where(
      and(
        eq(aiLearningRecords.companyId, companyId),
        eq(aiLearningRecords.recordType, "insight"),
        eq(aiLearningRecords.category, "strategy"),
      ),
    )
    .orderBy(desc(aiLearningRecords.createdAt))
    .limit(10);

  // Apply pattern-based improvements
  for (const pattern of patterns) {
    if (pattern.check(currentStrategy)) {
      additions.push(...pattern.additions);
      reasons.push(pattern.reason);
    }
  }

  // Apply insights from past reflections
  for (const insight of pastInsights) {
    if (insight.recommendedChange && !insight.applied) {
      reasons.push(`Past insight: ${insight.recommendedChange}`);
    }
  }

  // Build optimized strategy
  const optimizedStrategy = [...currentStrategy];

  // Insert additions at logical positions
  for (const addition of additions) {
    if (addition.importance === "critical") {
      // Critical steps go at the beginning
      optimizedStrategy.unshift(addition);
    } else if (addition.importance === "optional") {
      // Optional steps go at the end
      optimizedStrategy.push(addition);
    } else {
      // Important steps go in the middle
      const midpoint = Math.floor(optimizedStrategy.length / 2);
      optimizedStrategy.splice(midpoint, 0, addition);
    }
  }

  const confidence = additions.length > 0
    ? Math.min(0.9, 0.5 + (pastInsights.length * 0.05))
    : 0.3;

  const optimization: StrategyOptimization = {
    companyId,
    goalType,
    originalStrategy: currentStrategy,
    optimizedStrategy,
    additions,
    reorderings: [],
    reason: reasons.join("; ") || "No strategy optimizations needed",
    confidence: Math.round(confidence * 100) / 100,
  };

  // Persist
  if (additions.length > 0) {
    await db.insert(aiLearningRecords).values({
      companyId,
      recordType: "optimization",
      category: "strategy",
      summary: `Strategy optimization for ${goalType}: ${additions.length} phases added`,
      details: {
        goalType,
        originalPhaseCount: currentStrategy.length,
        optimizedPhaseCount: optimizedStrategy.length,
        additions: additions.map((a) => a.phase),
        reasons,
        confidence,
      },
      scores: { confidence },
      recommendedChange: reasons.join("; "),
    });

    await publishEvent("ai.learning.strategy.optimized", {
      companyId,
      goalType,
      additionsCount: additions.length,
      confidence,
    });
  }

  logger.info(
    { companyId, goalType, additions: additions.length, confidence },
    "Strategy optimization computed",
  );

  return optimization;
}

/**
 * Classify a goal string into a strategy type.
 */
export function classifyGoalType(goal: string): string {
  const lower = goal.toLowerCase();
  if (lower.includes("launch") || lower.includes("product") || lower.includes("saas") || lower.includes("mvp")) {
    return "product_launch";
  }
  if (lower.includes("marketing") || lower.includes("campaign") || lower.includes("brand")) {
    return "marketing_campaign";
  }
  if (lower.includes("build") || lower.includes("code") || lower.includes("develop") || lower.includes("engineer")) {
    return "engineering";
  }
  return "default";
}

/**
 * Get strategy optimization history.
 */
export async function getStrategyHistory(
  db: Db,
  companyId: string,
): Promise<Array<{ id: string; goalType: string; additions: number; confidence: number; createdAt: Date }>> {
  const records = await db
    .select()
    .from(aiLearningRecords)
    .where(
      and(
        eq(aiLearningRecords.companyId, companyId),
        eq(aiLearningRecords.recordType, "optimization"),
        eq(aiLearningRecords.category, "strategy"),
      ),
    )
    .orderBy(desc(aiLearningRecords.createdAt))
    .limit(20);

  return records.map((r) => {
    const d = r.details as Record<string, unknown>;
    return {
      id: r.id,
      goalType: d.goalType as string ?? "unknown",
      additions: (d.additions as unknown[])?.length ?? 0,
      confidence: (r.scores as Record<string, number> | null)?.confidence ?? 0,
      createdAt: r.createdAt,
    };
  });
}
