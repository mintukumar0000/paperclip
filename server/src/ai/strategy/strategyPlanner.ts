import type { Db } from "@paperclipai/db";
import { activityLog, aiLearningRecords } from "@paperclipai/db";
import { and, eq, desc } from "@paperclipai/db";
import pino from "pino";
import { routeLLMJSON } from "../llmRouter.js";
import { buildMemoryContext } from "../../memory/embeddingMemory.js";
import type { SystemMetricSnapshot } from "../feedback/metricsEngine.js";

const logger = pino({ name: "strategy-planner" });

export interface StrategyWeek {
  week: number;
  focus: string;
  actions: string[];
  successMetric: string;
  targetValue: string;
}

export interface StrategyPlan {
  companyId: string;
  goal: string;
  currentRevenueCents: number;
  targetRevenueCents: number;
  weeks: StrategyWeek[];
  keyRisks: string[];
  reasoning: string;
  generatedAt: string;
}

export async function generateStrategyPlan(
  db: Db,
  companyId: string,
  metrics: SystemMetricSnapshot,
  goal: string = "Reach $100 revenue",
): Promise<StrategyPlan | null> {
  let memoryContext = "";
  try {
    memoryContext = await buildMemoryContext(db, companyId, "strategy actions conversion revenue what worked", 10);
  } catch { /* memory unavailable */ }

  const recentActions = await db
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "ai.decision.action.executed")))
    .orderBy(desc(activityLog.createdAt))
    .limit(20);

  const actionSummary = recentActions
    .map((r) => {
      const d = (r.details ?? {}) as Record<string, unknown>;
      return `- [${d.actionType}] ${d.key}: ${d.reason ?? ""} (success=${d.success})`;
    })
    .join("\n");

  const result = await routeLLMJSON<Record<string, unknown>>("strategy", [
    {
      role: "system",
      content: `You are a startup growth strategist. Create a concrete, week-by-week plan to achieve a specific revenue goal.

Return JSON:
{
  "goal": "the goal statement",
  "weeks": [
    {
      "week": 1,
      "focus": "Primary focus area",
      "actions": ["Specific action 1", "Specific action 2", "Specific action 3"],
      "success_metric": "What to measure",
      "target_value": "Specific number to hit"
    }
  ],
  "key_risks": ["Risk 1", "Risk 2"],
  "reasoning": "2-3 sentences explaining the strategic logic"
}

Be SPECIFIC. Not "increase traffic" but "Post 3 Reddit threads targeting r/SaaS and r/microsaas with ROI-focused angles". Not "improve conversion" but "A/B test 4 headline variants, measure signup rate, pick winner after 50 visits each".`,
    },
    {
      role: "user",
      content: `## Goal
${goal}

## Current Metrics
- Traffic: ${metrics.traffic} visits
- Conversions: ${metrics.conversions}
- Revenue: ${metrics.revenue} cents ($${(metrics.revenue / 100).toFixed(2)})
- Conversion Rate: ${metrics.conversion_rate.toFixed(2)}%
- Payment Conversion Rate: ${metrics.payment_conversion_rate.toFixed(2)}%
- Revenue per Visitor: ${metrics.revenue_per_visit.toFixed(2)} cents

## Recent Actions Taken
${actionSummary || "None recorded"}

${memoryContext ? `\n## Past Memories\n${memoryContext}` : ""}

## Channels Available
- Reddit (5 subreddits, auto-posting every 3h)
- Twitter/X (auto-posting)
- Email sequences (3-step drip)
- Pricing experiments (A/B testing $5/$7/$9)
- Landing page variants (4 angles)

Create a 4-week plan to reach the goal. Be realistic about what can be achieved each week.`,
    },
  ]);

  if (!result) return null;

  const weeks: StrategyWeek[] = [];
  const rawWeeks = result.weeks as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(rawWeeks)) {
    for (const w of rawWeeks) {
      weeks.push({
        week: Number(w.week ?? weeks.length + 1),
        focus: String(w.focus ?? ""),
        actions: Array.isArray(w.actions) ? w.actions.map(String) : [],
        successMetric: String(w.success_metric ?? ""),
        targetValue: String(w.target_value ?? ""),
      });
    }
  }

  const plan: StrategyPlan = {
    companyId,
    goal,
    currentRevenueCents: metrics.revenue,
    targetRevenueCents: 10_000,
    weeks,
    keyRisks: Array.isArray(result.key_risks) ? result.key_risks.map(String) : [],
    reasoning: String(result.reasoning ?? ""),
    generatedAt: new Date().toISOString(),
  };

  await db.insert(aiLearningRecords).values({
    companyId,
    recordType: "insight",
    category: "strategy",
    summary: `Strategy plan: ${goal} — ${weeks.length} weeks`,
    details: {
      source: "strategy_planner",
      plan: JSON.stringify(plan).slice(0, 4000),
    },
  });

  await db.insert(activityLog).values({
    companyId,
    actorType: "system",
    actorId: "strategy-planner",
    agentId: null,
    runId: null,
    action: "strategy.plan.generated",
    entityType: "company",
    entityId: companyId,
    details: {
      goal,
      weekCount: weeks.length,
      riskCount: plan.keyRisks.length,
      reasoning: plan.reasoning.slice(0, 200),
    },
  });

  logger.info({ companyId, goal, weeks: weeks.length }, "Strategy plan generated");
  return plan;
}

let plannerInterval: ReturnType<typeof setInterval> | null = null;

export function startStrategyPlanner(db: Db, intervalMs = 24 * 60 * 60_000): () => void {
  const enabled = (process.env.STRATEGY_PLANNER_ENABLED ?? "true").trim().toLowerCase();
  if (enabled === "false" || enabled === "0") {
    logger.info("Strategy planner disabled");
    return () => {};
  }

  logger.info({ intervalMs }, "Starting strategy planner");

  setTimeout(async () => {
    try {
      const { companies } = await import("@paperclipai/db");
      const { getRecentSystemMetricsSnapshot } = await import("../feedback/metricsEngine.js");
      const allCompanies = await db.select({ id: companies.id }).from(companies);

      for (const company of allCompanies.slice(0, 3)) {
        const metrics = await getRecentSystemMetricsSnapshot(db, company.id, 4320);
        if (metrics.sample_count < 3) continue;
        await generateStrategyPlan(db, company.id, metrics);
      }
    } catch (err) {
      logger.error({ err }, "Initial strategy plan generation failed");
    }
  }, 3 * 60_000);

  plannerInterval = setInterval(async () => {
    try {
      const { companies } = await import("@paperclipai/db");
      const { getRecentSystemMetricsSnapshot } = await import("../feedback/metricsEngine.js");
      const allCompanies = await db.select({ id: companies.id }).from(companies);

      for (const company of allCompanies.slice(0, 3)) {
        const metrics = await getRecentSystemMetricsSnapshot(db, company.id, 4320);
        if (metrics.sample_count < 3) continue;
        await generateStrategyPlan(db, company.id, metrics);
      }
    } catch (err) {
      logger.error({ err }, "Strategy plan generation failed");
    }
  }, intervalMs);

  return () => {
    if (plannerInterval) {
      clearInterval(plannerInterval);
      plannerInterval = null;
    }
  };
}
