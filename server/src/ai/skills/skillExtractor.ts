import type { Db } from "@paperclipai/db";
import { activityLog, aiLearningRecords, and, eq, desc, gte } from "@paperclipai/db";
import pino from "pino";
import { routeLLMJSON } from "../llmRouter.js";
import { saveSkill, type SkillCategory, type SkillSource } from "./skillStore.js";
import { eventBus } from "../../events/eventBus.js";

const logger = pino({ name: "skill-extractor" });

export interface PerformanceInput {
  type: "content" | "landing" | "email" | "pricing";
  metrics: {
    impressions?: number;
    clicks?: number;
    signups?: number;
    payments?: number;
    revenue?: number;
  };
  context: {
    channel?: string;
    subreddit?: string;
    variant?: string;
    audience?: string;
    [key: string]: unknown;
  };
  content: string;
}

function isHighPerformer(input: PerformanceInput): boolean {
  const { impressions = 0, clicks = 0, signups = 0, payments = 0 } = input.metrics;
  const ctr = impressions > 0 ? clicks / impressions : 0;
  const signupRate = clicks > 0 ? signups / clicks : 0;
  const paymentRate = signups > 0 ? payments / signups : 0;

  return ctr > 0.05 || signupRate > 0.2 || paymentRate > 0.05;
}

function isLowPerformer(input: PerformanceInput): boolean {
  const { impressions = 0, clicks = 0, signups = 0 } = input.metrics;
  if (impressions < 30) return false;
  const ctr = impressions > 0 ? clicks / impressions : 0;
  return ctr < 0.01;
}

const TYPE_TO_CATEGORY: Record<string, SkillCategory> = {
  content: "traffic",
  landing: "conversion",
  email: "email",
  pricing: "pricing",
};

const TYPE_TO_SOURCE: Record<string, SkillSource> = {
  content: "content",
  landing: "landing",
  email: "email",
  pricing: "pricing",
};

export async function extractSkillFromPerformance(
  db: Db,
  companyId: string,
  input: PerformanceInput,
): Promise<void> {
  const isHigh = isHighPerformer(input);
  const isLow = isLowPerformer(input);

  if (!isHigh && !isLow) return;

  const category = TYPE_TO_CATEGORY[input.type] ?? "ops";
  const source = TYPE_TO_SOURCE[input.type] ?? "behavior";
  const sentiment = isHigh ? "high-performing" : "low-performing";

  const result = await routeLLMJSON<{
    name?: string;
    pattern?: string;
    conditions?: string[];
    expectedOutcome?: string;
  }>("reasoning", [
    {
      role: "system",
      content: `You are an expert growth analyst. Analyze a ${sentiment} data point and extract a reusable skill/pattern.

${isHigh ? "Extract the pattern that made this succeed so it can be reused." : "Extract what to AVOID so the system doesn't repeat this mistake."}

Return JSON:
{
  "name": "short_snake_case_name",
  "pattern": "The reusable insight in one sentence",
  "conditions": ["when to apply this"],
  "expectedOutcome": "What this should improve"
}`,
    },
    {
      role: "user",
      content: `Type: ${input.type}
Performance: ${sentiment}

Content:
${input.content.slice(0, 500)}

Metrics:
${JSON.stringify(input.metrics)}

Context:
${JSON.stringify(input.context)}`,
    },
  ]);

  if (!result?.name || !result?.pattern) return;

  const name = isLow ? `avoid_${result.name}` : result.name;
  const pattern = isLow ? `AVOID: ${result.pattern}` : result.pattern;

  await saveSkill(db, companyId, {
    name,
    category: category as SkillCategory,
    pattern,
    conditions: result.conditions ?? [],
    expectedOutcome: result.expectedOutcome,
    source: source as SkillSource,
    metadata: {
      ...input.context,
      metrics: input.metrics,
      isNegative: isLow,
      extractedFrom: sentiment,
    },
  });

  logger.info({ companyId, name, category, sentiment }, "Skill extracted from performance data");

  eventBus.publish("skill.extracted", {
    companyId,
    skillName: name,
    category,
    sentiment,
    timestamp: new Date().toISOString(),
  });
}

export async function extractSkillsFromRecentPerformance(
  db: Db,
  companyId: string,
): Promise<number> {
  let extracted = 0;

  const contentPerf = await db
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "distribution.reddit.post.success"),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(10);

  for (const row of contentPerf) {
    const d = (row.details ?? {}) as Record<string, unknown>;
    try {
      await extractSkillFromPerformance(db, companyId, {
        type: "content",
        metrics: { impressions: 100, clicks: Number(d.views ?? 10), signups: Number(d.signups ?? 0) },
        context: { channel: "reddit", subreddit: String(d.subreddit ?? "unknown") },
        content: String(d.title ?? ""),
      });
      extracted++;
    } catch { /* skip individual failures */ }
  }

  const landingPerf = await db
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "landing.variant.impression"),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(20);

  const variantCounts = new Map<string, { impressions: number; signups: number }>();
  for (const row of landingPerf) {
    const d = (row.details ?? {}) as Record<string, unknown>;
    const vid = String(d.variantId ?? "");
    if (!vid) continue;
    const existing = variantCounts.get(vid) ?? { impressions: 0, signups: 0 };
    existing.impressions++;
    variantCounts.set(vid, existing);
  }

  const signupRows = await db
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "landing.variant.signup"),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(20);

  for (const row of signupRows) {
    const d = (row.details ?? {}) as Record<string, unknown>;
    const vid = String(d.variantId ?? "");
    const existing = variantCounts.get(vid);
    if (existing) existing.signups++;
  }

  for (const [vid, counts] of variantCounts) {
    if (counts.impressions < 10) continue;
    try {
      await extractSkillFromPerformance(db, companyId, {
        type: "landing",
        metrics: { impressions: counts.impressions, signups: counts.signups },
        context: { variant: vid },
        content: `Landing variant ${vid}`,
      });
      extracted++;
    } catch { /* skip */ }
  }

  const emailPerf = await db
    .select({ summary: aiLearningRecords.summary, details: aiLearningRecords.details })
    .from(aiLearningRecords)
    .where(
      and(
        eq(aiLearningRecords.companyId, companyId),
        eq(aiLearningRecords.category, "email_performance"),
      ),
    )
    .orderBy(desc(aiLearningRecords.createdAt))
    .limit(10);

  for (const row of emailPerf) {
    const d = (row.details ?? {}) as Record<string, unknown>;
    try {
      await extractSkillFromPerformance(db, companyId, {
        type: "email",
        metrics: { impressions: Number(d.sent ?? 1), signups: Number(d.converted ?? 0) },
        context: { step: String(d.step ?? "unknown") },
        content: row.summary ?? "",
      });
      extracted++;
    } catch { /* skip */ }
  }

  logger.info({ companyId, extracted }, "Skill extraction cycle completed");
  return extracted;
}
