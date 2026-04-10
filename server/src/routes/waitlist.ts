import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { waitlistSignups, aiLearningRecords, activityLog, and, desc, eq, sql } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { createDodoCheckoutSession } from "../ai/tools/externalTools.js";
import { assignPriceVariant, recordPricingImpression, getPricingExperimentResults } from "../core/pricingOptimizer.js";
import { resolvePublicBaseUrl as resolveSharedPublicBaseUrl } from "../public-base-url.js";

type SignupPayload = {
  name?: unknown;
  email?: unknown;
  source?: unknown;
  variantId?: unknown;
  pageVersion?: unknown;
  companyId?: unknown;
  metadata?: unknown;
};

type SupabaseSyncResult = {
  synced: boolean;
  reason?: string;
};

type ResendResult = {
  sent: boolean;
  reason?: string;
};

type OfferTier = "entry" | "upsell" | "premium";

type OfferLearningIntelligence = {
  subjectPattern: "urgency_24h" | "direct_roi" | "social_proof";
  preferredTier: OfferTier;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TRANSPARENT_GIF = Buffer.from("R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64");
let offerDispatchInFlight = false;
let resolvingOfferProductIds: Promise<Record<OfferTier, string | null>> | null = null;

const OFFER_TIER_CONFIG: Record<OfferTier, { defaultPriceCents: number; defaultName: string }> = {
  entry: {
    defaultPriceCents: 500,
    defaultName: "Founder Cold Email Template Pack",
  },
  upsell: {
    defaultPriceCents: 1500,
    defaultName: "Founder Outbound Pro Pack",
  },
  premium: {
    defaultPriceCents: 4900,
    defaultName: "Founder Revenue System Premium",
  },
};

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeEmailQueryString(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  // Query parsing turns '+' into spaces; restore plus-addressing aliases.
  if (normalized.includes(" ") && normalized.includes("@")) {
    return normalized.replace(/\s+/g, "+");
  }
  return normalized;
}

function normalizeNumericString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.round(value));
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return String(Math.round(parsed));
}

function firstString(root: unknown, keys: string[]): string | null {
  if (!root || typeof root !== "object") return null;
  const record = root as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function resolveOfferTier(raw: string | null): OfferTier {
  if (raw === "upsell" || raw === "premium") return raw;
  return "entry";
}

function offerPriceFromEnv(tier: OfferTier): number {
  const keyByTier: Record<OfferTier, string[]> = {
    entry: ["WAITLIST_OFFER_PRICE_CENTS", "WAITLIST_OFFER_ENTRY_PRICE_CENTS"],
    upsell: ["WAITLIST_OFFER_UPSELL_PRICE_CENTS"],
    premium: ["WAITLIST_OFFER_PREMIUM_PRICE_CENTS"],
  };

  for (const envKey of keyByTier[tier]) {
    const parsed = normalizeNumericString(process.env[envKey]);
    if (parsed) return Number(parsed) || OFFER_TIER_CONFIG[tier].defaultPriceCents;
  }
  return OFFER_TIER_CONFIG[tier].defaultPriceCents;
}

function offerProductNameFromEnv(tier: OfferTier): string {
  const keyByTier: Record<OfferTier, string[]> = {
    entry: ["WAITLIST_OFFER_PRODUCT_NAME", "WAITLIST_OFFER_ENTRY_PRODUCT_NAME"],
    upsell: ["WAITLIST_OFFER_UPSELL_PRODUCT_NAME"],
    premium: ["WAITLIST_OFFER_PREMIUM_PRODUCT_NAME"],
  };

  for (const envKey of keyByTier[tier]) {
    const value = normalizeOptionalString(process.env[envKey]);
    if (value) return value;
  }
  return OFFER_TIER_CONFIG[tier].defaultName;
}

async function createDodoOfferProductForTier(tier: OfferTier): Promise<string | null> {
  const apiKey = (process.env.DODO_PAYMENTS_API_KEY ?? process.env.DODO_API_KEY ?? "").trim();
  if (!apiKey) return null;

  const dodoEnvironment = (process.env.DODO_PAYMENTS_ENVIRONMENT ?? "").trim().toLowerCase();
  const defaultBaseUrl = dodoEnvironment === "test_mode"
    ? "https://test.dodopayments.com"
    : "https://live.dodopayments.com";
  const baseUrl = (process.env.DODO_PAYMENTS_BASE_URL ?? defaultBaseUrl).trim().replace(/\/$/, "");
  const endpoint = `${baseUrl}/products`;
  const priceCents = offerPriceFromEnv(tier);
  const currency = (process.env.WAITLIST_OFFER_CURRENCY ?? "usd").trim().toLowerCase() || "usd";
  const name = offerProductNameFromEnv(tier);
  const description = (process.env.WAITLIST_OFFER_PRODUCT_DESCRIPTION ?? "High-converting outbound playbooks and templates.").trim();

  const payloadCandidates: Array<Record<string, unknown>> = [
    {
      name,
      description,
      price: priceCents,
      currency,
      metadata: { source: "waitlist_offer_auto_product", tier },
    },
    {
      name,
      description,
      price_cents: priceCents,
      currency,
      metadata: { source: "waitlist_offer_auto_product", tier },
    },
    {
      name,
      description,
      pricing: {
        amount_cents: priceCents,
        currency,
      },
      metadata: { source: "waitlist_offer_auto_product", tier },
    },
  ];

  for (const payload of payloadCandidates) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    }).catch(() => null);

    if (!response?.ok) continue;

    const body = await response.json().catch(() => ({}));
    const objectBody = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data = objectBody.data && typeof objectBody.data === "object"
      ? objectBody.data as Record<string, unknown>
      : null;

    const productId =
      firstString(objectBody, ["id", "product_id", "productId"])
      ?? firstString(data, ["id", "product_id", "productId"]);

    if (productId) return productId;
  }

  return null;
}

async function ensureOfferProductIds(): Promise<Record<OfferTier, string | null>> {
  const explicitEntry = (process.env.DODO_PRODUCT_ID_ENTRY ?? process.env.DODO_PRODUCT_ID ?? "").trim() || null;
  const explicitUpsell = (process.env.DODO_PRODUCT_ID_UPSELL ?? "").trim() || null;
  const explicitPremium = (process.env.DODO_PRODUCT_ID_PREMIUM ?? "").trim() || null;

  if (explicitEntry && explicitUpsell && explicitPremium) {
    return { entry: explicitEntry, upsell: explicitUpsell, premium: explicitPremium };
  }

  if (!resolvingOfferProductIds) {
    resolvingOfferProductIds = (async () => {
      const [entryCreated, upsellCreated, premiumCreated] = await Promise.all([
        explicitEntry ? Promise.resolve(explicitEntry) : createDodoOfferProductForTier("entry"),
        explicitUpsell ? Promise.resolve(explicitUpsell) : createDodoOfferProductForTier("upsell"),
        explicitPremium ? Promise.resolve(explicitPremium) : createDodoOfferProductForTier("premium"),
      ]);

      return {
        entry: explicitEntry ?? entryCreated,
        upsell: explicitUpsell ?? upsellCreated,
        premium: explicitPremium ?? premiumCreated,
      };
    })().finally(() => {
      resolvingOfferProductIds = null;
    });
  }

  return resolvingOfferProductIds;
}

async function resolveOfferLearningIntelligence(db: Db, companyId: string): Promise<OfferLearningIntelligence> {
  const fallback: OfferLearningIntelligence = {
    subjectPattern: "urgency_24h",
    preferredTier: "entry",
  };

  const [dispatchInsight, paymentInsight] = await Promise.all([
    db
      .select()
      .from(aiLearningRecords)
      .where(
        and(
          eq(aiLearningRecords.companyId, companyId),
          eq(aiLearningRecords.recordType, "insight"),
          eq(aiLearningRecords.category, "strategy"),
          sql`${aiLearningRecords.details} ->> 'source' = 'waitlist_offer'`,
        ),
      )
      .orderBy(desc(aiLearningRecords.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select()
      .from(aiLearningRecords)
      .where(
        and(
          eq(aiLearningRecords.companyId, companyId),
          eq(aiLearningRecords.recordType, "evaluation"),
          eq(aiLearningRecords.category, "outcome"),
          sql`${aiLearningRecords.details} ->> 'eventType' = 'payment_completed'`,
          sql`${aiLearningRecords.details} ->> 'source' = 'waitlist_offer'`,
        ),
      )
      .orderBy(desc(aiLearningRecords.createdAt))
      .limit(25),
  ]);

  let subjectPattern: OfferLearningIntelligence["subjectPattern"] = fallback.subjectPattern;
  if (dispatchInsight?.scores && typeof dispatchInsight.scores === "object") {
    const scores = dispatchInsight.scores as Record<string, unknown>;
    const deliveryRate = typeof scores.deliveryRate === "number" ? scores.deliveryRate : null;
    if (deliveryRate != null && deliveryRate >= 0.75) subjectPattern = "direct_roi";
    if (deliveryRate != null && deliveryRate < 0.45) subjectPattern = "social_proof";
  }

  const tierRevenue = { entry: 0, upsell: 0, premium: 0 };
  for (const record of paymentInsight) {
    const details = record.details && typeof record.details === "object"
      ? record.details as Record<string, unknown>
      : {};
    const metadata = details.metadata && typeof details.metadata === "object"
      ? details.metadata as Record<string, unknown>
      : {};
    const tierValue = resolveOfferTier(normalizeOptionalString(metadata.tier));
    const amount = typeof details.amountCents === "number" ? details.amountCents : 0;
    tierRevenue[tierValue] += Math.max(0, amount);
  }

  let preferredTier: OfferTier = "entry";
  if (tierRevenue.premium > tierRevenue.upsell && tierRevenue.premium > tierRevenue.entry) preferredTier = "premium";
  else if (tierRevenue.upsell > tierRevenue.entry) preferredTier = "upsell";

  return { subjectPattern, preferredTier };
}

function renderOfferSubject(name: string, pattern: OfferLearningIntelligence["subjectPattern"], tier: OfferTier): string {
  const safeName = name || "Founder";
  const priceCents = offerPriceFromEnv(tier);
  const priceUsd = (priceCents / 100).toFixed(0);
  if (pattern === "direct_roi") return `${safeName}, turn $${priceUsd} into faster outbound replies this week`;
  if (pattern === "social_proof") return `${safeName}, founders are using this $${priceUsd} pack to close more calls`;
  return `${safeName}, your $${priceUsd} founder offer closes in 24h`;
}

function selectTierForSignup(
  signup: { source: string | null; metadata: Record<string, unknown> | null },
  intelligence: OfferLearningIntelligence | null,
): OfferTier {
  const source = (signup.source ?? "").toLowerCase();
  if (source.includes("enterprise") || source.includes("agency")) return "premium";
  if (source.includes("referral") || source.includes("community")) return "upsell";
  if (intelligence) return intelligence.preferredTier;
  return "entry";
}

function isUuid(value: string | null): boolean {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin?.trim() || "*",
    "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

async function syncToSupabase(args: {
  name: string | null;
  email: string;
  source: string | null;
  variantId: string | null;
  pageVersion: string | null;
  companyId: string | null;
  createdAt: string;
}): Promise<SupabaseSyncResult> {
  const projectId = (process.env.SUPABASE_PROJECT_ID ?? "").trim();
  const explicitUrl = (process.env.SUPABASE_URL ?? "").trim();
  const serviceKey =
    (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? "").trim();

  const baseUrl = explicitUrl || (projectId ? `https://${projectId}.supabase.co` : "");
  if (!baseUrl || !serviceKey) {
    return { synced: false, reason: "supabase_not_configured" };
  }

  const table = (process.env.SUPABASE_WAITLIST_TABLE ?? "waitlist").trim() || "waitlist";
  const endpoint = `${baseUrl.replace(/\/$/, "")}/rest/v1/${encodeURIComponent(table)}?on_conflict=email`;
  const fullPayload = {
    name: args.name,
    email: args.email,
    source: args.source,
    variant_id: args.variantId,
    page_version: args.pageVersion,
    company_id: args.companyId,
    monetization_sent: false,
    created_at: args.createdAt,
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(fullPayload),
  });

  if (response.ok) {
    return { synced: true };
  }

  const responseText = await response.text().catch(() => "");
  if (response.status >= 400 && response.status < 500) {
    const fallback = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        email: args.email,
        created_at: args.createdAt,
      }),
    });
    if (fallback.ok) {
      return { synced: true, reason: "supabase_fallback_minimal_payload" };
    }
    const fallbackText = await fallback.text().catch(() => "");
    return {
      synced: false,
      reason: `supabase_${fallback.status}:${fallbackText.slice(0, 140)}`,
    };
  }

  return { synced: false, reason: `supabase_${response.status}:${responseText.slice(0, 140)}` };
}

async function sendWaitlistConfirmationEmail(args: {
  name: string | null;
  email: string;
  source: string | null;
}): Promise<ResendResult> {
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  const from = (process.env.RESEND_FROM_EMAIL ?? "").trim();
  if (!apiKey || !from) {
    return { sent: false, reason: "resend_not_configured" };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: [args.email],
      subject: "You're on the waitlist",
      html: `<p>Thanks for joining the waitlist${args.name ? `, ${args.name}` : ""}.</p><p>We will send early access details soon.</p>`
        + (args.source ? `<p>Source: ${args.source}</p>` : ""),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { sent: false, reason: `resend_${response.status}:${body.slice(0, 140)}` };
  }

  return { sent: true };
}

function renderMonetizationOfferEmail(args: { name: string; paymentLink: string; tier: OfferTier }): string {
  const safeName = args.name || "there";
  const paymentLink = args.paymentLink;
  const entryPrice = (offerPriceFromEnv("entry") / 100).toFixed(0);
  const upsellPrice = (offerPriceFromEnv("upsell") / 100).toFixed(0);
  const premiumPrice = (offerPriceFromEnv("premium") / 100).toFixed(0);
  const selectedPrice = (offerPriceFromEnv(args.tier) / 100).toFixed(0);
  return `
<p>Hi ${safeName},</p>
<p>Thanks for joining the waitlist.</p>
<p>I opened limited founder spots for the outbound conversion system today.</p>
<p><strong>Your current offer tier is $${selectedPrice} for the next 24 hours</strong>.</p>
<p>Inside the pack:</p>
<p>
  - High-converting outreach templates by use case<br>
  - Follow-up sequences to recover silent leads<br>
  - Subject-line patterns with better open rates
</p>
<p>Offer ladder available after checkout:</p>
<p>
  - Entry: $${entryPrice}<br>
  - Upsell: $${upsellPrice}<br>
  - Premium: $${premiumPrice}
</p>
<p><strong>Claim your access now:</strong></p>
<p>👉 <a href="${paymentLink}">Unlock Founder Access</a></p>
<p>${paymentLink}</p>
<p>If this helps your outbound, this should be the fastest ROI purchase you make this week.</p>
<p>– Mintu</p>
`.trim();
}

async function capturePosthogEvent(event: string, properties: Record<string, unknown>): Promise<void> {
  const key = (process.env.POSTHOG_API_KEY ?? process.env.VITE_POSTHOG_KEY ?? "").trim();
  const debug = /^(1|true|yes)$/i.test((process.env.POSTHOG_CAPTURE_DEBUG ?? "").trim());
  if (!key) {
    if (debug) {
      console.info("[waitlist.posthog.capture] skipped: missing key", { event });
    }
    return;
  }
  const host = (process.env.POSTHOG_HOST ?? process.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com").trim();
  const distinctId = String(properties.distinctId ?? properties.email ?? `waitlist_${Date.now()}`);

  try {
    const response = await fetch(`${host.replace(/\/$/, "")}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        event,
        distinct_id: distinctId,
        properties,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn("[waitlist.posthog.capture] non-2xx response", {
        event,
        status: response.status,
        body: body.slice(0, 300),
      });
    } else if (debug) {
      console.info("[waitlist.posthog.capture] accepted", {
        event,
        host,
        distinctId,
      });
    }
  } catch (error) {
    console.warn("[waitlist.posthog.capture] request failed", {
      event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resolveOfferCheckoutUrl(
  email: string,
  name: string | null,
  companyId: string | null,
  tier: OfferTier,
): Promise<string | null> {
  const hostedCheckout = (process.env.WAITLIST_OFFER_PAYMENT_LINK ?? process.env.DODO_PAYMENTS_CHECKOUT_URL ?? "").trim();
  const productIds = await ensureOfferProductIds();
  const productId = productIds[tier] ?? productIds.entry;

  if (!productId) return hostedCheckout || null;

  try {
    const created = await createDodoCheckoutSession(
      { integrationEnv: {} },
      {
        payload: {
          product_id: productId,
          metadata: {
            source: "waitlist_offer",
            email,
            name,
            companyId,
            tier,
          },
        },
        hostedCheckoutUrl: hostedCheckout || undefined,
        fallbackToHostedCheckoutUrl: true,
      },
    ) as Record<string, unknown>;

    const urlKeys = ["url", "checkout_url", "checkoutUrl"] as const;
    for (const key of urlKeys) {
      const value = created[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    return hostedCheckout || null;
  } catch {
    return hostedCheckout || null;
  }
}

async function resolveCompanyIdForEmail(db: Db, email: string | null): Promise<string | null> {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;

  const row = await db
    .select({ companyId: waitlistSignups.companyId })
    .from(waitlistSignups)
    .where(eq(waitlistSignups.email, normalized))
    .orderBy(desc(waitlistSignups.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return row?.companyId ?? null;
}

function resolvePublicBaseUrl(args: {
  reqOrigin?: string;
  host?: string;
  forwardedHost?: string;
  forwardedProto?: string;
}): string | null {
  return resolveSharedPublicBaseUrl({
    requestOrigin: args.reqOrigin,
    host: args.host,
    forwardedHost: args.forwardedHost,
    forwardedProto: args.forwardedProto,
  });
}

function hasWaitlistAutomationAccess(req: { header(name: string): string | undefined }): boolean {
  const expected = (process.env.WAITLIST_AUTOMATION_SECRET ?? "").trim();
  if (!expected) return false;

  const headerSecret = (req.header("x-waitlist-secret") ?? "").trim();
  if (headerSecret && headerSecret === expected) return true;

  const auth = (req.header("authorization") ?? "").trim();
  if (!auth) return false;
  const bearerPrefix = "Bearer ";
  if (!auth.startsWith(bearerPrefix)) return false;
  return auth.slice(bearerPrefix.length).trim() === expected;
}

export async function sendOfferEmailsToRecentSignups(
  db: Db,
  opts: {
    triggerReason: string;
    origin?: string;
    host?: string;
    forwardedHost?: string;
    forwardedProto?: string;
  },
) {
  if (offerDispatchInFlight) {
    return { sent: 0, skipped: 0, reason: "dispatch_in_flight" };
  }

  offerDispatchInFlight = true;
  try {
    const minSignups = Math.max(1, Number(process.env.WAITLIST_MONETIZATION_MIN_SIGNUPS ?? "10") || 10);
    const batchLimit = Math.max(1, Number(process.env.WAITLIST_MONETIZATION_BATCH_LIMIT ?? "100") || 100);
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(waitlistSignups);
    const totalSignups = Number(countRow?.count ?? 0);
    if (totalSignups < minSignups) {
      return { sent: 0, skipped: 0, reason: "below_threshold", totalSignups, minSignups };
    }

    const pending = await db
      .select()
      .from(waitlistSignups)
      .where(eq(waitlistSignups.monetizationSent, false))
      .orderBy(desc(waitlistSignups.createdAt))
      .limit(batchLimit);

    let sent = 0;
    let skipped = 0;
    const companyDispatchStats = new Map<string, { attempted: number; sent: number; skipped: number }>();
    const companyIntelligence = new Map<string, OfferLearningIntelligence>();
    const baseUrl = resolvePublicBaseUrl({
      reqOrigin: opts.origin,
      host: opts.host,
      forwardedHost: opts.forwardedHost,
      forwardedProto: opts.forwardedProto,
    });
    if (!baseUrl) {
      return { sent: 0, skipped: pending.length, totalSignups, minSignups, reason: "public_base_url_not_configured" };
    }

    for (const user of pending) {
      if (user.companyId) {
        const companyStats = companyDispatchStats.get(user.companyId) ?? { attempted: 0, sent: 0, skipped: 0 };
        companyStats.attempted += 1;
        companyDispatchStats.set(user.companyId, companyStats);
      }

      const displayName = (user.name ?? "").trim() || "there";
      const userMetadata = user.metadata && typeof user.metadata === "object" && !Array.isArray(user.metadata)
        ? user.metadata as Record<string, unknown>
        : null;

      let intelligence: OfferLearningIntelligence | null = null;
      if (user.companyId) {
        if (!companyIntelligence.has(user.companyId)) {
          companyIntelligence.set(user.companyId, await resolveOfferLearningIntelligence(db, user.companyId));
        }
        intelligence = companyIntelligence.get(user.companyId) ?? null;
      }

      const tier = selectTierForSignup({ source: user.source, metadata: userMetadata }, intelligence);
      const subjectPattern = intelligence?.subjectPattern ?? "urgency_24h";
      const trackedLink = `${baseUrl}/api/waitlist/offer-click?email=${encodeURIComponent(user.email)}&tier=${encodeURIComponent(tier)}${user.companyId ? `&companyId=${encodeURIComponent(user.companyId)}` : ""}`;

      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${(process.env.RESEND_API_KEY ?? "").trim()}`,
        },
        body: JSON.stringify({
          from: (process.env.RESEND_FROM_EMAIL ?? "").trim(),
          to: [user.email],
          subject: renderOfferSubject(displayName, subjectPattern, tier),
          html: renderMonetizationOfferEmail({ name: displayName, paymentLink: trackedLink, tier }),
        }),
      });

      if (!response.ok) {
        if (user.companyId) {
          const companyStats = companyDispatchStats.get(user.companyId);
          if (companyStats) companyStats.skipped += 1;
        }
        skipped += 1;
        continue;
      }

      await db
        .update(waitlistSignups)
        .set({ monetizationSent: true, monetizationSentAt: new Date() })
        .where(eq(waitlistSignups.id, user.id));

      await capturePosthogEvent("offer_email_sent", {
        email: user.email,
        source: user.source ?? "waitlist",
        triggerReason: opts.triggerReason,
        tier,
        subjectPattern,
      });
      if (user.companyId) {
        const companyStats = companyDispatchStats.get(user.companyId);
        if (companyStats) companyStats.sent += 1;
      }
      sent += 1;
    }

    for (const [companyId, stats] of companyDispatchStats.entries()) {
      if (stats.attempted <= 0) continue;
      const deliveryRate = stats.sent / stats.attempted;
      await db.insert(aiLearningRecords).values({
        companyId,
        recordType: "insight",
        category: "strategy",
        summary: `Waitlist offer dispatch: ${stats.sent}/${stats.attempted} delivered`,
        details: {
          source: "waitlist_offer",
          triggerReason: opts.triggerReason,
          attempted: stats.attempted,
          sent: stats.sent,
          skipped: stats.skipped,
          minSignups,
          totalSignups,
          preferredTier: companyIntelligence.get(companyId)?.preferredTier ?? "entry",
          subjectPattern: companyIntelligence.get(companyId)?.subjectPattern ?? "urgency_24h",
        },
        scores: {
          deliveryRate: Number(deliveryRate.toFixed(4)),
        },
        recommendedChange: deliveryRate < 0.5
          ? "Deliverability low; test sender domain quality and subject-line clarity."
          : "Keep current offer cadence and increase qualified waitlist traffic.",
        applied: true,
        appliedAt: new Date(),
      });
    }

    return { sent, skipped, totalSignups, minSignups, reason: "completed" };
  } finally {
    offerDispatchInFlight = false;
  }
}

export function waitlistRoutes(db: Db) {
  const router = Router();

  router.get("/email/open", async (req, res) => {
    const email = normalizeEmailQueryString(req.query.email);
    const step = normalizeOptionalString(req.query.step) ?? "unknown";
    const requestedCompanyId = normalizeOptionalString(req.query.companyId);
    const companyId = requestedCompanyId ?? await resolveCompanyIdForEmail(db, email);

    if (companyId && email) {
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "email-tracker",
        agentId: null,
        runId: null,
        action: "email.sequence.opened",
        entityType: "company",
        entityId: companyId,
        details: {
          email,
          step,
          source: "tracking_pixel",
        },
      }).catch(() => undefined);
    }

    res
      .status(200)
      .set({
        "Content-Type": "image/gif",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      })
      .send(TRANSPARENT_GIF);
  });

  router.get("/email/click", async (req, res) => {
    const email = normalizeEmailQueryString(req.query.email);
    const step = normalizeOptionalString(req.query.step) ?? "unknown";
    const requestedCompanyId = normalizeOptionalString(req.query.companyId);
    const companyId = requestedCompanyId ?? await resolveCompanyIdForEmail(db, email);
    const rawTarget = normalizeOptionalString(req.query.url);

    const fallbackBase = resolvePublicBaseUrl({
      reqOrigin: req.header("origin"),
      host: req.header("host"),
      forwardedHost: req.header("x-forwarded-host"),
      forwardedProto: req.header("x-forwarded-proto"),
    }) ?? "http://localhost:3100";
    let redirectUrl = fallbackBase;
    if (rawTarget) {
      try {
        const parsed = new URL(rawTarget);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          redirectUrl = parsed.toString();
        }
      } catch {
        // Keep safe fallback URL if target is invalid.
      }
    }

    if (companyId && email) {
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "email-tracker",
        agentId: null,
        runId: null,
        action: "email.sequence.clicked",
        entityType: "company",
        entityId: companyId,
        details: {
          email,
          step,
          targetUrl: redirectUrl,
          source: "tracked_link",
        },
      }).catch(() => undefined);
    }

    res.redirect(302, redirectUrl);
  });

  router.options("/waitlist/signup", (req, res) => {
    res.set(corsHeaders(req.header("origin"))).status(204).end();
  });

  router.post("/waitlist/signup", async (req, res) => {
    res.set(corsHeaders(req.header("origin")));

    const body = (req.body ?? {}) as SignupPayload;
    const name = normalizeOptionalString(body.name);
    const rawEmail = normalizeOptionalString(body.email);
    if (!rawEmail) {
      res.status(400).json({ error: "Email required" });
      return;
    }

    const normalizedEmail = rawEmail.toLowerCase();
    if (!EMAIL_RE.test(normalizedEmail)) {
      res.status(422).json({ error: "Invalid email" });
      return;
    }

    const source = normalizeOptionalString(body.source);
    const variantId = normalizeOptionalString(body.variantId);
    const pageVersion = normalizeOptionalString(body.pageVersion);
    const companyId = normalizeOptionalString(body.companyId);
    if (companyId && !isUuid(companyId)) {
      res.status(422).json({ error: "Invalid companyId" });
      return;
    }

    const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? (body.metadata as Record<string, unknown>)
      : null;

    const createdAt = new Date();
    const inserted = await db
      .insert(waitlistSignups)
      .values({
        name,
        email: normalizedEmail,
        companyId: companyId ?? null,
        source,
        variantId,
        pageVersion,
        monetizationSent: false,
        metadata,
        createdAt,
      })
      .onConflictDoNothing({ target: waitlistSignups.email })
      .returning({ id: waitlistSignups.id });

    const duplicate = inserted.length === 0;

    const supabase = await syncToSupabase({
      name,
      email: normalizedEmail,
      source,
      variantId,
      pageVersion,
      companyId: companyId ?? null,
      createdAt: createdAt.toISOString(),
    });

    const resend = await sendWaitlistConfirmationEmail({
      name,
      email: normalizedEmail,
      source,
    });

    const monetization = await sendOfferEmailsToRecentSignups(db, {
      triggerReason: duplicate ? "duplicate_signup" : "new_signup",
      origin: req.header("origin"),
      host: req.header("host"),
      forwardedHost: req.header("x-forwarded-host"),
      forwardedProto: req.header("x-forwarded-proto"),
    });

    res.status(200).json({
      success: true,
      duplicate,
      stored: true,
      supabaseSynced: supabase.synced,
      resendSent: resend.sent,
      monetization,
      warnings: [supabase.reason, resend.reason].filter((value): value is string => Boolean(value)),
    });
  });

  router.get("/waitlist/offer-click", async (req, res) => {
    const email = normalizeEmailQueryString(req.query.email);
    const checkoutFromQuery = normalizeOptionalString(req.query.checkout);
    const tier = resolveOfferTier(normalizeOptionalString(req.query.tier));
    const requestedCompanyId = normalizeOptionalString(req.query.companyId);
    const companyId = requestedCompanyId ?? await resolveCompanyIdForEmail(db, email);

    // Pricing experiment: assign variant for this user
    const priceVariant = email ? assignPriceVariant(email, tier) : null;
    if (priceVariant && companyId) {
      await recordPricingImpression(db, companyId, email ?? "unknown", priceVariant, tier).catch(() => {});
    }

    let checkout: string | null = null;

    if (email) {
      checkout = await resolveOfferCheckoutUrl(email, null, companyId, tier);
    }

    if (!checkout && checkoutFromQuery) {
      console.log("[waitlist.offer-click] Using legacy checkout URL from query param");
      checkout = checkoutFromQuery;
    }

    if (!checkout) {
      res.status(500).json({
        error: "Checkout session creation failed",
        hint: "Check Dodo API DNS/connectivity and API key configuration",
      });
      return;
    }

    const checkoutMode = checkoutFromQuery && checkout === checkoutFromQuery ? "legacy_query_param" : "dynamic_session";

    const publicBaseForOfferClick = resolvePublicBaseUrl({
      reqOrigin: req.header("origin"),
      host: req.header("host"),
      forwardedHost: req.header("x-forwarded-host"),
      forwardedProto: req.header("x-forwarded-proto"),
    });

    await capturePosthogEvent("payment_started", {
      email: email ?? "unknown",
      source: "waitlist_offer",
      checkout,
      tier,
      companyId,
      checkout_mode: checkoutMode,
      entry_point: "email_click",
      url: req.headers.referer || "email",
      $current_url: req.headers.referer || (publicBaseForOfferClick ? `${publicBaseForOfferClick}/api/waitlist/offer-click` : "email"),
      screen: "offer_click_redirect",
      pricing_variant_id: priceVariant?.id ?? null,
      pricing_variant_cents: priceVariant?.priceCents ?? null,
    });

    console.log("[waitlist.offer-click] payment_started event fired", {
      email: email ?? "unknown",
      tier,
      companyId,
      checkoutMode,
      pricingVariant: priceVariant?.id ?? "default",
      checkout: checkout?.slice(0, 80),
    });

    res.redirect(302, checkout);
  });

  router.post("/waitlist/offers/send", async (req, res) => {
    if (!hasWaitlistAutomationAccess(req)) {
      assertBoard(req);
    }
    const report = await sendOfferEmailsToRecentSignups(db, {
      triggerReason: "manual",
      origin: req.header("origin"),
      host: req.header("host"),
      forwardedHost: req.header("x-forwarded-host"),
      forwardedProto: req.header("x-forwarded-proto"),
    });
    res.json({ success: true, report });
  });

  router.get("/waitlist/pricing-experiment", async (req, res) => {
    const companyId = normalizeOptionalString(req.query.companyId);
    if (!companyId) {
      res.status(400).json({ error: "companyId query parameter required" });
      return;
    }
    const results = await getPricingExperimentResults(db, companyId);
    res.json(results);
  });

  router.get("/waitlist/stats", async (_req, res) => {
    const [totals] = await db.select({
      totalSignups: sql<number>`count(*)::int`,
      totalOffersSent: sql<number>`count(*) filter (where monetization_sent = true)::int`,
    }).from(waitlistSignups);
    res.json({
      totalSignups: Number(totals?.totalSignups ?? 0),
      totalOffersSent: Number(totals?.totalOffersSent ?? 0),
      offerThreshold: Math.max(1, Number(process.env.WAITLIST_MONETIZATION_MIN_SIGNUPS ?? "10") || 10),
    });
  });

  router.get("/companies/:companyId/waitlist/signups", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const rows = await db
      .select()
      .from(waitlistSignups)
      .where(eq(waitlistSignups.companyId, companyId))
      .orderBy(desc(waitlistSignups.createdAt))
      .limit(500);

    res.json(rows);
  });

  return router;
}