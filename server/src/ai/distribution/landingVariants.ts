import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { eq, and, desc } from "@paperclipai/db";
import pino from "pino";
import { routeLLMJSON } from "../llmRouter.js";

const logger = pino({ name: "landing-variants" });

export interface LandingVariant {
  id: string;
  headline: string;
  subheadline: string;
  cta: string;
  pricingFrame: string;
  angle: "urgency" | "social_proof" | "roi" | "curiosity";
}

interface VariantPerformance {
  variantId: string;
  impressions: number;
  signups: number;
  conversionRate: number;
}

const variantCache = new Map<string, { variants: LandingVariant[]; generatedAt: number }>();
const CACHE_TTL_MS = 6 * 60 * 60_000;

export async function generateLandingVariants(
  db: Db,
  companyId: string,
): Promise<LandingVariant[]> {
  const cached = variantCache.get(companyId);
  if (cached && Date.now() - cached.generatedAt < CACHE_TTL_MS) {
    return cached.variants;
  }

  const result = await routeLLMJSON<{ variants: Array<Record<string, string>> }>("decision", [
    {
      role: "system",
      content: `Generate 8 landing page variants for A/B testing. Each MUST use a different psychological angle.

Use these proven conversion patterns:
- Founder story: "I failed at X, then built Y" (builds trust)
- Pain-first: Name the exact problem, then solve it (triggers recognition)
- Outcome proof: Specific numbers — "47 calls in 30 days" (credibility)
- Scarcity anchor: Show original price crossed out, limited quantity (urgency)
- Contrarian: Challenge conventional wisdom (curiosity)
- Simple direct: No fluff, just what you get (clarity)
- Revenue proof: "40% open rates" — specific metrics (authority)
- Social proof: "50+ founders using this" (belonging)

Headlines must be specific, not generic. "Book 5 Calls This Week" beats "Improve Your Outreach".
CTAs must feel low-risk: "$5" or "Less than a coffee" removes price objection.
Subheadlines must include a specific number or proof point.

Return JSON:
{
  "variants": [
    {
      "id": "v1",
      "headline": "...",
      "subheadline": "...",
      "cta": "...",
      "pricing_frame": "...",
      "angle": "urgency|social_proof|roi|curiosity"
    }
  ]
}

Product: Cold email template pack for startup founders
Price: $5-$9
Audience: Indie hackers, solopreneurs, early-stage founders
Goal: 5-10% visitor → signup conversion`,
    },
    {
      role: "user",
      content: "Generate 8 high-converting landing page variants. Each must use a different psychological angle. Be specific with numbers and proof points.",
    },
  ]);

  if (!result?.variants) {
    return getDefaultVariants();
  }

  const variants: LandingVariant[] = result.variants.map((v, i) => ({
    id: v.id ?? `v${i + 1}`,
    headline: v.headline ?? "Launch Faster with Proven Email Templates",
    subheadline: v.subheadline ?? "Stop writing cold emails from scratch",
    cta: v.cta ?? "Get Templates Now",
    pricingFrame: v.pricing_frame ?? "Just $5 — less than a coffee",
    angle: (v.angle as LandingVariant["angle"]) ?? "roi",
  }));

  variantCache.set(companyId, { variants, generatedAt: Date.now() });

  logger.info({ companyId, variantCount: variants.length }, "Generated landing page variants");
  return variants;
}

function getDefaultVariants(): LandingVariant[] {
  return [
    {
      id: "founder_story",
      headline: "I Failed at Cold Emails for 6 Months. Then I Built This.",
      subheadline: "12 templates tested on 500+ real outreach campaigns. Average reply rate: 17%.",
      cta: "Get the Templates — $5",
      pricingFrame: "One-time $5. No subscription. No upsell.",
      angle: "social_proof",
    },
    {
      id: "pain_first",
      headline: "Your Cold Emails Aren't Working. Here's Exactly Why.",
      subheadline: "90% of founders use the same 3 broken patterns. These 12 templates fix all of them.",
      cta: "Fix My Outbound Now",
      pricingFrame: "Less than a coffee. More than a consultant.",
      angle: "roi",
    },
    {
      id: "outcome_proof",
      headline: "Book Your First 5 Calls This Week",
      subheadline: "Copy-paste these templates. Send 30 emails. Watch replies come in. Real founders, real results.",
      cta: "Send Better Emails Today — $5",
      pricingFrame: "$5 now → goes to $19 after 100 sales",
      angle: "urgency",
    },
    {
      id: "curiosity_hook",
      headline: "The Outbound Sequence That Booked 47 Calls in 30 Days",
      subheadline: "A solo founder reverse-engineered what top SDRs do. Now it's a $5 template pack.",
      cta: "See the Exact Sequence",
      pricingFrame: "47 calls. 30 days. $5 investment.",
      angle: "curiosity",
    },
    {
      id: "revenue_proof",
      headline: "How Founders Are Getting 40% Open Rates on Cold Emails",
      subheadline: "Not theory. Not AI-generated fluff. Battle-tested subject lines and follow-up sequences.",
      cta: "Steal These Templates",
      pricingFrame: "12 templates. 3 sequences. $5 total.",
      angle: "social_proof",
    },
    {
      id: "scarcity_anchor",
      headline: "Cold Email Template Pack — Founder Edition",
      subheadline: "12 proven templates + 3 follow-up sequences + subject line formulas. Usually $29.",
      cta: "Get It for $5 (87 Left)",
      pricingFrame: "$29 → $5 for early founders. Price increases at 100 sales.",
      angle: "urgency",
    },
    {
      id: "simple_direct",
      headline: "Cold Emails That Actually Get Replies",
      subheadline: "12 templates. Copy. Paste. Send. That's it.",
      cta: "Get Templates — $5",
      pricingFrame: "$5. One time. Done.",
      angle: "roi",
    },
    {
      id: "contrarian",
      headline: "Stop Personalizing Your Cold Emails. Do This Instead.",
      subheadline: "The counterintuitive framework that out-performs 'personalized' outreach by 3x.",
      cta: "Learn the Framework — $5",
      pricingFrame: "One idea. 12 templates. Infinite ROI.",
      angle: "curiosity",
    },
  ];
}

export function assignVariantToVisitor(variants: LandingVariant[], visitorId: string): LandingVariant {
  const hash = visitorId.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return variants[hash % variants.length]!;
}

export async function recordVariantImpression(
  db: Db,
  companyId: string,
  variantId: string,
): Promise<void> {
  await db.insert(activityLog).values({
    companyId,
    actorType: "system",
    actorId: "landing-variants",
    agentId: null,
    runId: null,
    action: "landing.variant.impression",
    entityType: "company",
    entityId: companyId,
    details: { variantId },
  });
}

export async function getVariantResults(
  db: Db,
  companyId: string,
): Promise<{ variants: VariantPerformance[]; winner: string | null }> {
  const impressions = await db
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "landing.variant.impression")))
    .orderBy(desc(activityLog.createdAt))
    .limit(1000);

  const signups = await db
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "landing.variant.signup")))
    .orderBy(desc(activityLog.createdAt))
    .limit(1000);

  const map = new Map<string, VariantPerformance>();

  for (const row of impressions) {
    const d = (row.details ?? {}) as Record<string, unknown>;
    const vid = String(d.variantId ?? "unknown");
    const existing = map.get(vid) ?? { variantId: vid, impressions: 0, signups: 0, conversionRate: 0 };
    existing.impressions++;
    map.set(vid, existing);
  }

  for (const row of signups) {
    const d = (row.details ?? {}) as Record<string, unknown>;
    const vid = String(d.variantId ?? "unknown");
    const existing = map.get(vid);
    if (existing) existing.signups++;
  }

  const results: VariantPerformance[] = [];
  for (const v of map.values()) {
    v.conversionRate = v.impressions > 0 ? (v.signups / v.impressions) * 100 : 0;
    results.push(v);
  }

  results.sort((a, b) => b.conversionRate - a.conversionRate);
  const winner = results.length > 0 && results[0]!.impressions >= 20 ? results[0]!.variantId : null;

  return { variants: results, winner };
}
