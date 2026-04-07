import type { Db } from "@paperclipai/db";
import { aiLearningRecords, activityLog, waitlistSignups } from "@paperclipai/db";
import { and, eq, desc, sql } from "@paperclipai/db";
import pino from "pino";

const logger = pino({ name: "pricing-optimizer" });

export interface PriceVariant {
  id: string;
  priceCents: number;
  label: string;
}

export interface PricingExperiment {
  experimentId: string;
  tier: string;
  variants: PriceVariant[];
  startedAt: string;
}

export interface VariantPerformance {
  variantId: string;
  priceCents: number;
  impressions: number;
  conversions: number;
  revenueCents: number;
  conversionRate: number;
  revenuePerImpression: number;
}

const PRICING_VARIANTS: Record<string, PriceVariant[]> = {
  entry: [
    { id: "entry_a", priceCents: 500, label: "$5" },
    { id: "entry_b", priceCents: 900, label: "$9" },
    { id: "entry_c", priceCents: 700, label: "$7" },
  ],
  upsell: [
    { id: "upsell_a", priceCents: 1500, label: "$15" },
    { id: "upsell_b", priceCents: 1900, label: "$19" },
    { id: "upsell_c", priceCents: 2900, label: "$29" },
  ],
  premium: [
    { id: "premium_a", priceCents: 4900, label: "$49" },
    { id: "premium_b", priceCents: 3900, label: "$39" },
    { id: "premium_c", priceCents: 6900, label: "$69" },
  ],
};

const experimentState = new Map<string, {
  variant: PriceVariant;
  assignedAt: number;
}>();

export function assignPriceVariant(email: string, tier: string): PriceVariant {
  const enabled = (process.env.PRICING_EXPERIMENT_ENABLED ?? "true").trim().toLowerCase();
  if (enabled === "false" || enabled === "0") {
    const defaults: Record<string, number> = { entry: 500, upsell: 1500, premium: 4900 };
    return { id: `${tier}_default`, priceCents: defaults[tier] ?? 500, label: `$${((defaults[tier] ?? 500) / 100).toFixed(0)}` };
  }

  const cacheKey = `${email.toLowerCase()}:${tier}`;
  const cached = experimentState.get(cacheKey);
  if (cached && Date.now() - cached.assignedAt < 24 * 60 * 60_000) {
    return cached.variant;
  }

  const variants = PRICING_VARIANTS[tier] ?? PRICING_VARIANTS.entry!;

  // Weighted random: favor variants with less data for exploration
  const variant = variants[Math.floor(Math.random() * variants.length)]!;

  experimentState.set(cacheKey, { variant, assignedAt: Date.now() });

  logger.info({
    email: email.slice(0, 3) + "***",
    tier,
    variantId: variant.id,
    priceCents: variant.priceCents,
  }, "Price variant assigned");

  return variant;
}

export async function recordPricingImpression(
  db: Db,
  companyId: string,
  email: string,
  variant: PriceVariant,
  tier: string,
): Promise<void> {
  await db.insert(activityLog).values({
    companyId,
    actorType: "system",
    actorId: "pricing-optimizer",
    agentId: null,
    runId: null,
    action: "pricing.experiment.impression",
    entityType: "company",
    entityId: companyId,
    details: {
      email,
      tier,
      variantId: variant.id,
      priceCents: variant.priceCents,
      label: variant.label,
    },
  });
}

export async function recordPricingConversion(
  db: Db,
  companyId: string,
  email: string,
  amountCents: number,
  tier: string,
): Promise<void> {
  const cacheKey = `${email.toLowerCase()}:${tier}`;
  const assignment = experimentState.get(cacheKey);

  await db.insert(activityLog).values({
    companyId,
    actorType: "system",
    actorId: "pricing-optimizer",
    agentId: null,
    runId: null,
    action: "pricing.experiment.conversion",
    entityType: "company",
    entityId: companyId,
    details: {
      email,
      tier,
      variantId: assignment?.variant.id ?? "unknown",
      assignedPriceCents: assignment?.variant.priceCents ?? null,
      actualAmountCents: amountCents,
    },
  });
}

export async function getPricingExperimentResults(
  db: Db,
  companyId: string,
): Promise<{
  variants: VariantPerformance[];
  winner: VariantPerformance | null;
  sampleSize: number;
  recommendation: string;
}> {
  const impressions = await db
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "pricing.experiment.impression"),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(500);

  const conversions = await db
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "pricing.experiment.conversion"),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(500);

  const variantMap = new Map<string, VariantPerformance>();

  for (const row of impressions) {
    const d = (row.details ?? {}) as Record<string, unknown>;
    const vid = String(d.variantId ?? "unknown");
    const existing = variantMap.get(vid) ?? {
      variantId: vid,
      priceCents: Number(d.priceCents ?? 0),
      impressions: 0,
      conversions: 0,
      revenueCents: 0,
      conversionRate: 0,
      revenuePerImpression: 0,
    };
    existing.impressions++;
    variantMap.set(vid, existing);
  }

  for (const row of conversions) {
    const d = (row.details ?? {}) as Record<string, unknown>;
    const vid = String(d.variantId ?? "unknown");
    const existing = variantMap.get(vid);
    if (existing) {
      existing.conversions++;
      existing.revenueCents += Number(d.actualAmountCents ?? 0);
    }
  }

  const variants: VariantPerformance[] = [];
  for (const v of variantMap.values()) {
    v.conversionRate = v.impressions > 0 ? (v.conversions / v.impressions) * 100 : 0;
    v.revenuePerImpression = v.impressions > 0 ? v.revenueCents / v.impressions : 0;
    variants.push(v);
  }

  variants.sort((a, b) => b.revenuePerImpression - a.revenuePerImpression);

  const totalSamples = variants.reduce((sum, v) => sum + v.impressions, 0);
  const winner = totalSamples >= 10 ? variants[0] ?? null : null;

  let recommendation = "Insufficient data — need at least 10 impressions per variant to determine winner.";
  if (winner && totalSamples >= 30) {
    recommendation = `Variant ${winner.variantId} ($${(winner.priceCents / 100).toFixed(0)}) has the best revenue/impression at ${winner.revenuePerImpression.toFixed(1)} cents. Consider making this the default price.`;
  } else if (winner) {
    recommendation = `Early signal: ${winner.variantId} ($${(winner.priceCents / 100).toFixed(0)}) is leading, but more data needed for confidence.`;
  }

  return { variants, winner, sampleSize: totalSamples, recommendation };
}

export function getAvailableVariants(): typeof PRICING_VARIANTS {
  return PRICING_VARIANTS;
}
