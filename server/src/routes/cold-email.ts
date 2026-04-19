import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { activityLog, and, companies, desc, eq, sql, waitlistSignups } from "@paperclipai/db";
import { createDodoCheckoutSession } from "../ai/tools/externalTools.js";
import { recordSystemMetric } from "../ai/feedback/metricsEngine.js";
import {
  assignVariant,
  generateLandingVariants,
  getDefaultLandingVariants,
  trackImpression,
  type LandingVariant,
} from "../ai/distribution/landingVariants.js";
import { getSystemControls } from "../services/system-controls.js";
import { resolvePublicBaseUrl as resolveSharedPublicBaseUrl } from "../public-base-url.js";
import { logger } from "../middleware/logger.js";
import {
  COLD_EMAIL_FEATURE_KEY,
  hasEntitlement,
  setEntitlement,
} from "../lib/entitlements.js";

type JsonRecord = Record<string, unknown>;
type AttributionContext = {
  utmSource: string | null;
  utmCampaign: string | null;
  referrer: string | null;
  sessionId: string | null;
};

type OfferTier = "entry" | "upsell" | "premium";

type ColdEmailRuntimeControls = {
  freeLimit: number;
  pricingVariant: string;
  pricingTier: OfferTier;
  pricingVariantPriceCents: number;
  dodoProductId: string | null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEMPLATE_PLACEHOLDER_RE = /\[[^\]\n]{1,80}\]|\{\{[^}\n]{1,80}\}\}|<[^>\n]{1,80}>/g;
const TEMPLATE_PLACEHOLDER_TEST_RE = /\[[^\]\n]{1,80}\]|\{\{[^}\n]{1,80}\}\}|<[^>\n]{1,80}>/;
const scheduledFollowUps = new Set<string>();
const LOCKED_PREVIEW_LINES = 4;
const LANDING_VISITOR_COOKIE = "paperclip_landing_visitor_id";
const LANDING_EXPERIMENT_ID = "cold_email_landing_ab_v1";

const EMPTY_ATTRIBUTION: AttributionContext = {
  utmSource: null,
  utmCampaign: null,
  referrer: null,
  sessionId: null,
};

function compactJsonRecord(record: JsonRecord): JsonRecord {
  const next: JsonRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (value == null) continue;
    next[key] = value;
  }
  return next;
}

function normalizeOptionalString(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string") continue;
      const trimmedEntry = entry.trim();
      if (trimmedEntry.length > 0) return trimmedEntry;
    }
    return null;
  }

  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readCookieValue(req: Request, cookieName: string): string | null {
  const raw = req.header("cookie");
  if (!raw) return null;
  const pairs = raw.split(";");
  for (const pair of pairs) {
    const [namePart, ...valueParts] = pair.split("=");
    if (!namePart || valueParts.length === 0) continue;
    if (namePart.trim() !== cookieName) continue;
    const value = valueParts.join("=").trim();
    if (!value) return null;
    try {
      const decoded = decodeURIComponent(value);
      return decoded.length > 0 ? decoded : null;
    } catch {
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function stableHash(input: string): string {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function resolveLandingVisitorId(req: Request, attribution: AttributionContext): {
  visitorId: string;
  fromCookie: boolean;
} {
  const cookieId = normalizeOptionalString(readCookieValue(req, LANDING_VISITOR_COOKIE));
  if (cookieId) {
    return { visitorId: cookieId, fromCookie: true };
  }

  const sessionId = normalizeOptionalString(attribution.sessionId);
  if (sessionId) {
    return { visitorId: `sess_${stableHash(sessionId)}`, fromCookie: false };
  }

  const fingerprint = `${req.ip ?? "unknown"}|${req.header("user-agent") ?? "unknown"}`;
  return { visitorId: `anon_${stableHash(fingerprint)}`, fromCookie: false };
}

function normalizeAttributionValue(value: unknown, maxLength: number): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  const cleaned = normalized.slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : null;
}

function readAttributionFromUnknown(input: unknown): AttributionContext {
  const record = asMetadata(input);
  return {
    utmSource: normalizeAttributionValue(record.utm_source ?? record.utmSource, 80),
    utmCampaign: normalizeAttributionValue(record.utm_campaign ?? record.utmCampaign, 120),
    referrer: normalizeAttributionValue(record.referrer ?? record.referer, 1000),
    sessionId: normalizeAttributionValue(record.session_id ?? record.sessionId, 120),
  };
}

function attributionToMetadata(attribution: AttributionContext): JsonRecord {
  return compactJsonRecord({
    utm_source: attribution.utmSource,
    utm_campaign: attribution.utmCampaign,
    referrer: attribution.referrer,
    session_id: attribution.sessionId,
  });
}

function mergeAttribution(primary: AttributionContext, fallback: AttributionContext): AttributionContext {
  return {
    utmSource: primary.utmSource ?? fallback.utmSource,
    utmCampaign: primary.utmCampaign ?? fallback.utmCampaign,
    referrer: primary.referrer ?? fallback.referrer,
    sessionId: primary.sessionId ?? fallback.sessionId,
  };
}

function readAttributionFromRequest(req: Request): AttributionContext {
  const fromBody = readAttributionFromUnknown(req.body);
  const fromQuery = readAttributionFromUnknown(req.query);
  const headerReferrer = normalizeAttributionValue(req.header("referer"), 1000);
  const headerSessionId = normalizeAttributionValue(req.header("x-paperclip-session-id"), 120);

  return mergeAttribution(
    {
      utmSource: fromBody.utmSource ?? fromQuery.utmSource,
      utmCampaign: fromBody.utmCampaign ?? fromQuery.utmCampaign,
      referrer: fromBody.referrer ?? fromQuery.referrer ?? headerReferrer,
      sessionId: fromBody.sessionId ?? fromQuery.sessionId ?? headerSessionId,
    },
    EMPTY_ATTRIBUTION,
  );
}

function normalizeEmail(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  return EMAIL_RE.test(lower) ? lower : null;
}

function isUuid(value: string | null): boolean {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function readDefaultFreeLimit(): number {
  const raw = Number(process.env.COLD_EMAIL_FREE_LIMIT ?? "3");
  if (!Number.isFinite(raw)) return 3;
  return Math.max(1, Math.round(raw));
}

function normalizePricingVariant(raw: string | null | undefined): string {
  const normalized = normalizeOptionalString(raw)?.toLowerCase() ?? "entry_9";
  if (normalized === "entry" || normalized === "entry_9") return "entry_9";
  if (normalized === "entry_19" || normalized === "upsell" || normalized === "upsell_19") return "entry_19";
  if (normalized === "entry_29" || normalized === "premium" || normalized === "premium_29") return "entry_29";
  return normalized;
}

function pricingTierFromVariant(variant: string): OfferTier {
  if (variant.includes("29") || variant.includes("premium")) return "premium";
  if (variant.includes("19") || variant.includes("upsell")) return "upsell";
  return "entry";
}

function pricingVariantToCents(variant: string): number {
  const numericMatch = variant.match(/(\d{1,4})/);
  if (numericMatch) {
    const dollars = Number(numericMatch[1]);
    if (Number.isFinite(dollars) && dollars > 0) return Math.round(dollars * 100);
  }

  const tier = pricingTierFromVariant(variant);
  if (tier === "premium") return 2900;
  if (tier === "upsell") return 1900;
  return 900;
}

function productIdForTier(tier: OfferTier): string | null {
  if (tier === "premium") {
    return normalizeOptionalString(process.env.DODO_PRODUCT_ID_PREMIUM)
      ?? normalizeOptionalString(process.env.DODO_PRODUCT_ID_ENTRY)
      ?? normalizeOptionalString(process.env.DODO_PRODUCT_ID)
      ?? null;
  }
  if (tier === "upsell") {
    return normalizeOptionalString(process.env.DODO_PRODUCT_ID_UPSELL)
      ?? normalizeOptionalString(process.env.DODO_PRODUCT_ID_ENTRY)
      ?? normalizeOptionalString(process.env.DODO_PRODUCT_ID)
      ?? null;
  }
  return normalizeOptionalString(process.env.DODO_PRODUCT_ID_ENTRY)
    ?? normalizeOptionalString(process.env.DODO_PRODUCT_ID)
    ?? null;
}

async function resolveColdEmailRuntimeControls(
  db: Db,
  companyId: string | null,
): Promise<ColdEmailRuntimeControls> {
  const defaultsVariant = normalizePricingVariant(null);
  const defaultsTier = pricingTierFromVariant(defaultsVariant);

  if (!companyId) {
    return {
      freeLimit: readDefaultFreeLimit(),
      pricingVariant: defaultsVariant,
      pricingTier: defaultsTier,
      pricingVariantPriceCents: pricingVariantToCents(defaultsVariant),
      dodoProductId: productIdForTier(defaultsTier),
    };
  }

  const controls = await getSystemControls(db, companyId).catch(() => null);
  const pricingVariant = normalizePricingVariant(controls?.pricingVariant ?? null);
  const pricingTier = pricingTierFromVariant(pricingVariant);
  const controlsFreeLimitRaw = Number(controls?.paywallTriggerCount ?? Number.NaN);
  const freeLimit = Number.isFinite(controlsFreeLimitRaw)
    ? Math.max(1, Math.round(controlsFreeLimitRaw))
    : readDefaultFreeLimit();

  return {
    freeLimit,
    pricingVariant,
    pricingTier,
    pricingVariantPriceCents: pricingVariantToCents(pricingVariant),
    dodoProductId: productIdForTier(pricingTier),
  };
}

function getSoftTriggerGenerationCount(freeLimit: number): number {
  const fallback = Math.max(1, freeLimit - 1);
  const raw = Number(process.env.COLD_EMAIL_SOFT_TRIGGER_GENERATION_COUNT ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  const normalized = Math.max(1, Math.round(raw));
  return Math.min(freeLimit, normalized);
}

function shouldLockOutputPreview(generationCount: number, freeLimit: number): boolean {
  const triggerAt = getSoftTriggerGenerationCount(freeLimit);
  return generationCount >= triggerAt && generationCount < freeLimit;
}

function buildLockedPreview(emailCopy: string): string {
  const lines = emailCopy
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [
      "Subject: [Visible after generation]",
      "",
      "Body:",
      "[Unlock unlimited to reveal the full personalized email output.]",
    ].join("\n");
  }

  const subjectLine = lines.find((line) => /^subject\s*:/i.test(line)) ?? `Subject: ${lines[0]}`;
  const bodyLines = lines.filter((line) => line !== subjectLine);
  const visibleBody = bodyLines.slice(0, LOCKED_PREVIEW_LINES).join("\n");

  return [
    subjectLine,
    "",
    "Body preview:",
    visibleBody,
    "",
    "[...locked... unlock unlimited to reveal the full email and higher-quality personalization.]",
  ].join("\n");
}

function softUpsellMessage(): {
  title: string;
  detail: string;
  valueStack: string[];
} {
  return {
    title: "You are one step away from a perfect cold email.",
    detail: "Unlock unlimited generations and higher-quality personalization.",
    valueStack: [
      "Unlimited cold emails",
      "Higher personalization depth",
      "Stronger conversion angles",
      "Priority model quality",
      "Intro pricing expires soon",
      "Agencies charge about $50/email - you pay less than $1",
    ],
  };
}

function getFollowUpDelayMs(step: "day1" | "day2"): number {
  const fallback = step === "day1" ? 24 * 60 * 60_000 : 48 * 60 * 60_000;
  const key = step === "day1" ? "COLD_EMAIL_FOLLOWUP_DAY1_DELAY_MS" : "COLD_EMAIL_FOLLOWUP_DAY2_DELAY_MS";
  const raw = Number(process.env[key] ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(5_000, Math.round(raw));
}

function resolveTelemetryCompanyId(): string | null {
  const active = normalizeOptionalString(process.env.ACTIVE_COMPANY_ID);
  if (isUuid(active)) return active;
  const fallback = normalizeOptionalString(process.env.BILLING_WEBHOOK_COMPANY_ID);
  if (isUuid(fallback)) return fallback;
  return null;
}

async function resolveTelemetryCompanyIdForDb(db: Db): Promise<string | null> {
  const companyId = resolveTelemetryCompanyId();
  if (!companyId) return null;

  let company: { id: string } | null = null;
  try {
    company = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1)
      .then((rows) => rows[0] ?? null)
      .catch((error) => {
        logger.warn({ err: error }, "Failed to validate telemetry company id for cold email route");
        return null;
      });
  } catch (error) {
    logger.warn({ err: error }, "Cold email telemetry company lookup failed with non-standard DB adapter");
    return null;
  }

  return company?.id ?? null;
}

function describeColdEmailGenerateFailure(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();

  if (
    lowered.includes("waitlist_signups")
    && (
      lowered.includes("does not exist")
      || lowered.includes("column")
      || lowered.includes("relation")
    )
  ) {
    return "Database schema for waitlist_signups is out of date. Apply DB migrations on the active DATABASE_URL.";
  }

  if (lowered.includes("waitlist_signups_company_id") && lowered.includes("foreign key")) {
    return "Configured ACTIVE_COMPANY_ID/BILLING_WEBHOOK_COMPANY_ID is not present in the active database.";
  }

  return null;
}

function resolvePublicBaseUrl(args: {
  reqOrigin?: string;
  host?: string;
  forwardedHost?: string;
  forwardedProto?: string;
}): string {
  const resolved = resolveSharedPublicBaseUrl({
    requestOrigin: args.reqOrigin,
    host: args.host,
    forwardedHost: args.forwardedHost,
    forwardedProto: args.forwardedProto,
  });
  return resolved ?? "http://localhost:3100";
}

function asMetadata(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function isColdEmailPaid(metadata: JsonRecord): boolean {
  return hasEntitlement(metadata, COLD_EMAIL_FEATURE_KEY);
}

function withColdEmailEntitlement(metadata: JsonRecord, paid: boolean): JsonRecord {
  return setEntitlement(metadata, COLD_EMAIL_FEATURE_KEY, paid);
}

function buildColdEmailCancelUrl(
  baseUrl: string,
  email: string,
): string {
  const params = new URLSearchParams({ email, payment: "cancel" });
  return `${baseUrl}/api/cold-email?${params.toString()}`;
}

function buildColdEmailSuccessUrl(baseUrl: string, email: string): string {
  const params = new URLSearchParams({ email });
  return `${baseUrl}/api/cold-email/success?${params.toString()}`;
}

function renderTrackedPixel(baseUrl: string, email: string, step: string, companyId: string | null): string {
  const companyPart = companyId ? `&companyId=${encodeURIComponent(companyId)}` : "";
  return `${baseUrl}/api/email/open?email=${encodeURIComponent(email)}&step=${encodeURIComponent(step)}${companyPart}`;
}

function renderTrackedClick(baseUrl: string, email: string, step: string, companyId: string | null, targetUrl: string): string {
  const companyPart = companyId ? `&companyId=${encodeURIComponent(companyId)}` : "";
  return `${baseUrl}/api/email/click?email=${encodeURIComponent(email)}&step=${encodeURIComponent(step)}${companyPart}&url=${encodeURIComponent(targetUrl)}`;
}

async function capturePosthogEvent(event: string, properties: Record<string, unknown>): Promise<void> {
  const key = (process.env.POSTHOG_API_KEY ?? process.env.VITE_POSTHOG_KEY ?? "").trim();
  if (!key) return;
  const host = (process.env.POSTHOG_HOST ?? process.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com").trim();
  const distinctId = String(properties.email ?? properties.distinctId ?? `cold_email_${Date.now()}`);

  await fetch(`${host.replace(/\/$/, "")}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      event,
      distinct_id: distinctId,
      properties,
    }),
  }).catch(() => undefined);
}

async function sendResendEmail(args: {
  to: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  const from = (process.env.RESEND_FROM_EMAIL ?? "").trim();
  if (!apiKey || !from) return false;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: [args.to],
      subject: args.subject,
      html: args.html,
    }),
  }).catch(() => null);

  return Boolean(response?.ok);
}

function llmConfig(): {
  baseUrl: string;
  model: string;
  headers: Record<string, string>;
} | null {
  const openRouterKey = (process.env.OPENROUTER_API_KEY ?? "").trim();
  if (openRouterKey) {
    const baseUrl = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").trim();
    const model = (
      process.env.OPENROUTER_MODEL
      ?? process.env.LOW_COST_GPT_MODEL
      ?? "openai/gpt-4o-mini"
    ).trim();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openRouterKey}`,
    };
    const siteUrl = (process.env.OPENROUTER_SITE_URL ?? "").trim();
    const appName = (process.env.OPENROUTER_APP_NAME ?? "paperclip").trim();
    if (siteUrl) headers["HTTP-Referer"] = siteUrl;
    if (appName) headers["X-Title"] = appName;
    return { baseUrl, model, headers };
  }

  const openAiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!openAiKey) return null;
  return {
    baseUrl: (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim(),
    model: (process.env.OPENAI_MODEL ?? "gpt-4o-mini").trim(),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openAiKey}`,
    },
  };
}

function fallbackColdEmail(args: { product: string; targetAudience: string; keyBenefit: string }): string {
  return [
    `Subject: Helping ${args.targetAudience} with ${args.keyBenefit}`,
    "",
    "Hi there,",
    "",
    `I work on ${args.product}, and it helps ${args.targetAudience.toLowerCase()} get ${args.keyBenefit.toLowerCase()} without adding process overhead.`,
    "",
    "If this is relevant, I can share a short walkthrough with examples from similar teams.",
    "",
    "Would a quick 10-minute walkthrough be useful this week?",
    "",
    "- Alex from Paperclip",
  ].join("\n");
}

function containsTemplatePlaceholders(content: string): boolean {
  if (!content) return false;
  return TEMPLATE_PLACEHOLDER_TEST_RE.test(content);
}

function stripTemplatePlaceholders(content: string): string {
  if (!content) return content;
  return content
    .replace(TEMPLATE_PLACEHOLDER_RE, "there")
    .replace(/there\s+there/g, "there")
    .trim();
}

async function generateChatCompletion(
  cfg: { baseUrl: string; model: string; headers: Record<string, string> },
  messages: Array<{ role: "system" | "user"; content: string }>,
): Promise<string | null> {
  const response = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: cfg.headers,
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.7,
      max_tokens: 500,
      messages,
    }),
  }).catch(() => null);

  if (!response?.ok) return null;

  const body = await response.json().catch(() => ({})) as JsonRecord;
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? (choices[0] as JsonRecord) : null;
  const message = first && typeof first.message === "object" ? (first.message as JsonRecord) : null;
  const content = typeof message?.content === "string" ? message.content.trim() : "";

  return content.length > 0 ? content : null;
}

async function generateColdEmail(args: {
  product: string;
  targetAudience: string;
  keyBenefit: string;
}): Promise<string> {
  const cfg = llmConfig();
  if (!cfg) return fallbackColdEmail(args);

  const systemPrompt = [
    "You write concise, high-conversion B2B cold emails.",
    "Return plain text only.",
    "Never output placeholders like [Name], [Company], {{first_name}}, or <name>.",
    "Generate realistic, ready-to-send copy with concrete language.",
    "Use this structure: Subject line, opener, value proposition, low-friction CTA.",
    "Avoid hype and generic AI buzzwords.",
  ].join("\n");

  const userPrompt = [
    "Write a highly personalized cold email.",
    `Product: ${args.product}`,
    `Target audience: ${args.targetAudience}`,
    `Key benefit: ${args.keyBenefit}`,
    "Rules:",
    "- DO NOT use placeholders like [Name], [Company], {{first_name}}, or <name>",
    "- Generate realistic personalization using a believable sender persona",
    "- Output must be ready-to-send",
    "Return only the email.",
  ].join("\n");

  const content = await generateChatCompletion(cfg, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);

  if (!content) return fallbackColdEmail(args);
  if (!containsTemplatePlaceholders(content)) {
    const cleaned = stripTemplatePlaceholders(content);
    return containsTemplatePlaceholders(cleaned) ? fallbackColdEmail(args) : cleaned;
  }

  const rewritePrompt = [
    "Rewrite this cold email so it is ready-to-send and has zero template placeholders.",
    "Replace any bracket/brace placeholders with natural language.",
    "Return plain text only.",
    "Original email:",
    content,
  ].join("\n");

  const rewritten = await generateChatCompletion(cfg, [
    { role: "system", content: systemPrompt },
    { role: "user", content: rewritePrompt },
  ]);

  if (rewritten && !containsTemplatePlaceholders(rewritten)) {
    const cleaned = stripTemplatePlaceholders(rewritten);
    return containsTemplatePlaceholders(cleaned) ? fallbackColdEmail(args) : cleaned;
  }

  const sanitized = stripTemplatePlaceholders(rewritten ?? content);
  if (sanitized && !containsTemplatePlaceholders(sanitized)) return sanitized;

  return fallbackColdEmail(args);
}

async function resolveCheckoutUrl(
  email: string,
  companyId: string | null,
  baseUrl?: string,
  attribution: AttributionContext = EMPTY_ATTRIBUTION,
  runtimeControls?: ColdEmailRuntimeControls | null,
): Promise<string | null> {
  const productId = runtimeControls?.dodoProductId ?? normalizeOptionalString(process.env.DODO_PRODUCT_ID);
  const hosted = (process.env.DODO_PAYMENTS_CHECKOUT_URL ?? process.env.WAITLIST_OFFER_PAYMENT_LINK ?? "").trim();
  const hostedConfigured = hosted.length > 0;

  if (!productId && !hosted) {
    logger.warn("Cold-email checkout unavailable: DODO_PRODUCT_ID and DODO_PAYMENTS_CHECKOUT_URL are both missing");
    return null;
  }

  const metadata: JsonRecord = {
    source: "cold_email_tool",
    email,
    featureKey: COLD_EMAIL_FEATURE_KEY,
    feature: "cold_email_unlimited",
    pricingVariantId: runtimeControls?.pricingVariant ?? null,
    pricingVariantPriceCents: runtimeControls?.pricingVariantPriceCents ?? null,
    pricingCheckoutTier: runtimeControls?.pricingTier ?? null,
    ...attributionToMetadata(attribution),
  };
  if (companyId) metadata.companyId = companyId;

  const successUrl = baseUrl ? buildColdEmailSuccessUrl(baseUrl, email) : null;
  const cancelUrl = baseUrl ? buildColdEmailCancelUrl(baseUrl, email) : null;

  try {
    const result = await createDodoCheckoutSession(
      { integrationEnv: {} },
      {
        payload: {
          product_id: productId || undefined,
          metadata,
          ...(successUrl ? { success_url: successUrl, successUrl } : {}),
          ...(cancelUrl ? { cancel_url: cancelUrl, cancelUrl } : {}),
          ...(successUrl ? { return_url: successUrl, returnUrl: successUrl } : {}),
        },
        hostedCheckoutUrl: hosted || undefined,
        fallbackToHostedCheckoutUrl: true,
      },
    ) as JsonRecord;

    const keys = ["url", "checkout_url", "checkoutUrl"];
    for (const key of keys) {
      const value = result[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }

    logger.warn(
      {
        hasProductId: !!productId,
        hasHostedCheckoutUrl: hostedConfigured,
        resultKeys: Object.keys(result),
      },
      "Dodo checkout response missing checkout URL",
    );
    return hostedConfigured ? hosted : null;
  } catch (error) {
    logger.warn(
      {
        err: error,
        hasProductId: !!productId,
        hasHostedCheckoutUrl: hostedConfigured,
      },
      "Failed to resolve Dodo checkout URL",
    );
    return hostedConfigured ? hosted : null;
  }
}

function renderSuccessPage(email: string): string {
  const escapedEmail = email.replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Payment Confirmation</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: "Avenir Next", "Segoe UI", sans-serif;
      background: linear-gradient(180deg, #f7f4ef 0%, #ebe5d8 100%);
      color: #1f1b17;
      padding: 16px;
    }
    .card {
      width: min(620px, 100%);
      border-radius: 18px;
      background: #fffdf8;
      border: 1px solid #d8cfc0;
      box-shadow: 0 10px 26px rgba(24, 19, 13, 0.08);
      padding: 22px;
    }
    h1 { margin: 0 0 10px; font-size: 1.5rem; }
    p { margin: 0 0 10px; line-height: 1.45; }
    .muted { color: #6d6257; }
    .ok { color: #0f766e; font-weight: 700; }
    .warn { color: #9a5800; font-weight: 700; }
    .btn {
      display: inline-block;
      margin-top: 12px;
      border-radius: 10px;
      background: #0f766e;
      color: #fff;
      text-decoration: none;
      padding: 10px 14px;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Payment received</h1>
    <p class="muted">Email: ${escapedEmail}</p>
    <p id="status" class="warn">Payment processing. Confirming access...</p>
    <a id="cta" class="btn" href="/api/cold-email?email=${encodeURIComponent(email)}" style="display:none;">Continue to generator</a>
  </main>
  <script>
    (function () {
      var email = ${JSON.stringify(email)};
      var attempts = 0;
      var maxAttempts = 20;
      var statusNode = document.getElementById("status");
      var ctaNode = document.getElementById("cta");

      async function pollAccess() {
        attempts += 1;
        try {
          var response = await fetch("/api/cold-email/access?email=" + encodeURIComponent(email));
          var data = await response.json().catch(function () { return {}; });
          if (response.ok && data && data.success && data.paid) {
            if (statusNode) {
              statusNode.className = "ok";
              statusNode.textContent = "Payment successful. Unlimited access is now active.";
            }
            if (ctaNode) ctaNode.style.display = "inline-block";
            return;
          }
        } catch (_err) {
          // Ignore transient polling failures.
        }

        if (attempts >= maxAttempts) {
          if (statusNode) {
            statusNode.className = "warn";
            statusNode.textContent = "Payment processing is taking longer than expected. Please continue and retry in a few seconds.";
          }
          if (ctaNode) ctaNode.style.display = "inline-block";
          return;
        }

        setTimeout(pollAccess, 3000);
      }

      pollAccess();
    })();
  </script>
</body>
</html>`;
}

async function scheduleFollowUps(args: {
  db: Db;
  signupId: string;
  email: string;
  companyId: string | null;
  baseUrl: string;
  checkoutUrl: string | null;
}): Promise<void> {
  const checkoutTarget = args.checkoutUrl ?? `${args.baseUrl}/api/cold-email`;
  const steps: Array<{ step: "day1" | "day2"; subject: string; html: string }> = [
    {
      step: "day1",
      subject: "Most cold emails fail because of this...",
      html: [
        "<p>Most outbound emails fail because they sound generic.</p>",
        "<p>Use this quick structure instead:</p>",
        "<p>1) Name one specific pain in their ICP.</p>",
        "<p>2) Give one measurable outcome.</p>",
        "<p>3) Ask for one tiny next step.</p>",
        `<p><a href=\"${renderTrackedClick(args.baseUrl, args.email, "cold_email_day1", args.companyId, checkoutTarget)}\">Generate another personalized email</a></p>`,
        `<img src=\"${renderTrackedPixel(args.baseUrl, args.email, "cold_email_day1", args.companyId)}\" alt=\"\" width=\"1\" height=\"1\"/>`,
      ].join(""),
    },
    {
      step: "day2",
      subject: "Here's how to fix your outreach instantly",
      html: [
        "<p>Fast fix: stop writing from scratch and ship tested structures every day.</p>",
        "<p>Unlock unlimited emails + better quality outputs.</p>",
        `<p><a href=\"${renderTrackedClick(args.baseUrl, args.email, "cold_email_day2", args.companyId, checkoutTarget)}\">Upgrade now</a></p>`,
        `<img src=\"${renderTrackedPixel(args.baseUrl, args.email, "cold_email_day2", args.companyId)}\" alt=\"\" width=\"1\" height=\"1\"/>`,
      ].join(""),
    },
  ];

  for (const step of steps) {
    const followUpKey = `${args.email}:${step.step}`;
    if (scheduledFollowUps.has(followUpKey)) continue;
    scheduledFollowUps.add(followUpKey);

    setTimeout(() => {
      void (async () => {
        const sent = await sendResendEmail({
          to: args.email,
          subject: step.subject,
          html: step.html,
        });

        const sequenceState = step.step === "day2" ? "completed" : "active_unpaid";
        const signup = await args.db
          .select({ metadata: waitlistSignups.metadata })
          .from(waitlistSignups)
          .where(eq(waitlistSignups.id, args.signupId))
          .limit(1)
          .then((rows) => rows[0] ?? null)
          .catch(() => null);

        if (signup) {
          const nextMetadata: JsonRecord = {
            ...asMetadata(signup.metadata),
            coldEmailSequenceState: sequenceState,
            coldEmailSequenceLastStep: step.step,
            coldEmailSequenceLastSentAt: new Date().toISOString(),
            coldEmailSequenceLastStatus: sent ? "sent" : "failed",
          };
          await args.db
            .update(waitlistSignups)
            .set({ metadata: nextMetadata })
            .where(eq(waitlistSignups.id, args.signupId))
            .catch(() => undefined);
        }

        if (args.companyId) {
          await args.db.insert(activityLog).values({
            companyId: args.companyId,
            actorType: "system",
            actorId: "cold-email-sequence",
            agentId: null,
            runId: null,
            action: sent ? `cold_email.sequence.${step.step}.sent` : `cold_email.sequence.${step.step}.failed`,
            entityType: "company",
            entityId: args.companyId,
            details: {
              email: args.email,
              step: step.step,
              subject: step.subject,
            },
          }).catch(() => undefined);
        }
      })();
    }, getFollowUpDelayMs(step.step));
  }
}

function renderLandingPage(
  baseUrl: string,
  freeLimit: number,
  opts?: {
    initialEmail?: string | null;
    paymentState?: "success" | "cancel" | null;
    variant?: LandingVariant | null;
    experimentId?: string | null;
  },
): string {
  const selectedVariant = opts?.variant ?? null;
  const headline = selectedVariant?.headline ?? "Write high-converting cold emails in 10 seconds";
  const subheadline = selectedVariant?.subheadline ?? "Paste your product and get a ready-to-send email.";
  const ctaLabel = selectedVariant?.cta ?? "Generate your first email (free)";
  const pricingFrame = selectedVariant?.pricingFrame ?? `Intro pricing active - limited free usage: ${freeLimit} generations`;
  const variantId = selectedVariant?.id ?? "control";
  const experimentId = opts?.experimentId ?? null;

  const demoOutput = [
    "Subject: quick win for SDR teams this week",
    "",
    "Hi Sarah,",
    "",
    "Saw your team is scaling outbound at Acme. I built a personalization helper that turns one product benefit into prospect-specific cold emails in seconds.",
    "",
    "For teams targeting SaaS founders, it improved first-reply speed and made follow-ups easier to ship.",
    "",
    "If useful, I can send 3 variants tailored to your ICP.",
    "",
    "- Mintu",
  ].join("\\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cold Email Conversion Generator</title>
  <style>
    :root {
      --bg: #f6f3ee;
      --surface: #fffdf8;
      --ink: #1f1b17;
      --muted: #6d6257;
      --accent: #0f766e;
      --accent-ink: #ffffff;
      --ring: #dfd2c4;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Avenir Next", "Segoe UI", sans-serif;
      background: radial-gradient(circle at 20% 10%, #fff5d9 0%, var(--bg) 45%, #efe9df 100%);
      color: var(--ink);
      min-height: 100vh;
    }
    .wrap {
      max-width: 1080px;
      margin: 0 auto;
      padding: 36px 18px 80px;
    }
    .hero {
      display: grid;
      grid-template-columns: 1.15fr 1fr;
      gap: 22px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--ring);
      border-radius: 18px;
      padding: 20px;
      box-shadow: 0 8px 24px rgba(24, 19, 13, 0.08);
    }
    h1 {
      margin: 0 0 10px;
      font-size: clamp(1.8rem, 3vw, 2.8rem);
      line-height: 1.1;
      letter-spacing: -0.02em;
    }
    .sub { color: var(--muted); font-size: 1rem; margin: 0 0 14px; }
    .urgency {
      display: inline-block;
      border: 1px solid #f59e0b;
      background: #fff7e7;
      color: #9a5800;
      border-radius: 999px;
      font-weight: 700;
      font-size: 12px;
      padding: 6px 10px;
      margin-bottom: 14px;
    }
    label { display: block; font-size: 13px; font-weight: 700; margin: 12px 0 6px; }
    input, textarea {
      width: 100%;
      border: 1px solid var(--ring);
      border-radius: 10px;
      padding: 11px 12px;
      font: inherit;
      background: #fff;
      color: var(--ink);
    }
    textarea { min-height: 220px; white-space: pre-wrap; }
    .btn {
      margin-top: 14px;
      width: 100%;
      border: 0;
      border-radius: 12px;
      background: var(--accent);
      color: var(--accent-ink);
      font-size: 16px;
      font-weight: 800;
      padding: 13px 14px;
      cursor: pointer;
    }
    .hint { color: var(--muted); font-size: 12px; margin-top: 8px; }
    .status { margin-top: 10px; font-size: 13px; color: var(--muted); }
    .example {
      white-space: pre-wrap;
      background: #fff;
      border: 1px dashed var(--ring);
      border-radius: 12px;
      padding: 14px;
      font-size: 14px;
      line-height: 1.45;
      min-height: 260px;
    }
    .topline { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
    @media (max-width: 920px) {
      .hero { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <section class="card">
        <span id="usage-pill" class="urgency">${escapeHtml(pricingFrame)}</span>
        <h1>${escapeHtml(headline)}</h1>
        <p class="sub">${escapeHtml(subheadline)}</p>
        <p class="sub">No templates. No copywriting skills needed.</p>

        <label for="email">Work Email (required before full output)</label>
        <input id="email" type="email" placeholder="you@company.com" />

        <label for="product">Your Product</label>
        <input id="product" placeholder="AI SDR assistant for B2B SaaS" />

        <label for="audience">Target Audience</label>
        <input id="audience" placeholder="SaaS founders running outbound" />

        <label for="benefit">Key Benefit</label>
        <input id="benefit" placeholder="Get qualified replies faster" />

        <button id="generate" type="button" class="btn">${escapeHtml(ctaLabel)}</button>
        <div class="hint">By generating, you agree to receive your result and 2 tactical follow-ups.</div>
        <div class="hint">Used by 1,000+ founders.</div>
        <div class="hint">Agencies often charge $50/email. Here you can generate at less than $1 per output when upgraded.</div>
        <div id="status" class="status"></div>
        <div id="landing-variant-meta" data-variant-id="${escapeHtml(variantId)}" data-experiment-id="${escapeHtml(experimentId ?? "")}" style="display:none"></div>
      </section>

      <section class="card">
        <div class="topline">Real Example Output</div>
        <h2 style="margin: 8px 0 12px; font-size: 1.1rem;">High-converting cold email preview</h2>
        <div id="output" class="example">${demoOutput}</div>
      </section>
    </div>
  </div>

  <script>
    (function () {
      var statusNode = document.getElementById("status");
      var outputNode = document.getElementById("output");
      var button = document.getElementById("generate");
      var emailNode = document.getElementById("email");
      var usagePill = document.getElementById("usage-pill");
      var initialEmail = ${JSON.stringify(opts?.initialEmail ?? "")};
      var paymentState = ${JSON.stringify(opts?.paymentState ?? "")};
      var assignedVariantId = ${JSON.stringify(variantId)};
      var experimentId = ${JSON.stringify(experimentId)};
      var SESSION_STORAGE_KEY = "paperclip_cold_email_session_id";

      if (!statusNode || !outputNode || !button || !emailNode) {
        return;
      }

      function showPaywallStatus(checkoutUrl) {
        statusNode.textContent = "Free limit reached. Unlock unlimited emails + better quality outputs. ";
        if (!checkoutUrl) {
          statusNode.textContent = "Free limit reached. Checkout is not configured yet.";
          return;
        }

        var link = document.createElement("a");
        link.href = String(checkoutUrl);
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "Upgrade for unlimited access";
        statusNode.appendChild(link);
        statusNode.appendChild(document.createTextNode("."));
      }

      function showSoftLockStatus(data) {
        var title = (data && data.softPromptTitle) ? String(data.softPromptTitle) : "Unlock unlimited emails + better quality outputs";
        var detail = (data && data.softPromptDetail) ? String(data.softPromptDetail) : "Your best-performing version is ready after unlock.";
        statusNode.textContent = title + " " + detail + " ";
        if (!data || !data.checkoutUrl) return;
        var link = document.createElement("a");
        link.href = String(data.checkoutUrl);
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "Unlock full output";
        statusNode.appendChild(link);
        statusNode.appendChild(document.createTextNode("."));
      }

      function showCheckoutError(message) {
        var msg = (message && String(message).trim()) || "Checkout is not configured yet.";
        statusNode.textContent = "Free limit reached. " + msg;
      }

      function normalizeAttribution(value, maxLength) {
        if (typeof value !== "string") return null;
        var trimmed = value.trim();
        if (!trimmed) return null;
        return trimmed.slice(0, maxLength);
      }

      function getOrCreateSessionId() {
        var fromWindow = normalizeAttribution(window.name, 120);
        if (fromWindow) return fromWindow;
        try {
          var existing = normalizeAttribution(localStorage.getItem(SESSION_STORAGE_KEY), 120);
          if (existing) {
            window.name = existing;
            return existing;
          }
          var created = "ce_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
          localStorage.setItem(SESSION_STORAGE_KEY, created);
          window.name = created;
          return created;
        } catch (_err) {
          return "ce_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
        }
      }

      function readAttribution() {
        var params = new URLSearchParams(window.location.search || "");
        return {
          utm_source: normalizeAttribution(params.get("utm_source") || params.get("utmSource"), 80),
          utm_campaign: normalizeAttribution(params.get("utm_campaign") || params.get("utmCampaign"), 120),
          referrer: normalizeAttribution(document.referrer, 1000),
          session_id: getOrCreateSessionId(),
        };
      }

      var attribution = readAttribution();

      async function requestCheckoutUrl(emailValue) {
        var response = await fetch("/api/cold-email/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: emailValue,
            utm_source: attribution.utm_source,
            utm_campaign: attribution.utm_campaign,
            referrer: attribution.referrer,
            session_id: attribution.session_id,
          }),
        });
        var data = await response.json().catch(function () { return {}; });
        if (!response.ok || !data || !data.checkoutUrl) {
          var err = (data && data.error) ? String(data.error) : "checkout_failed";
          var hint = (data && data.hint) ? String(data.hint) : "";
          throw new Error(hint ? (err + ": " + hint) : err);
        }
        return String(data.checkoutUrl);
      }

      function text(id) {
        var node = document.getElementById(id);
        return (node && node.value ? node.value : "").trim();
      }

      function setPaidStatusUi() {
        if (usagePill) {
          usagePill.textContent = "Paid monthly: unlimited generations";
        }
      }

      function setFreeStatusUi(limit) {
        if (usagePill && typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
          usagePill.textContent = "Limited free usage: " + String(limit) + " generations";
        }
      }

      async function refreshAccessStatus(emailValue) {
        if (!emailValue) return;
        try {
          var response = await fetch("/api/cold-email/access?email=" + encodeURIComponent(emailValue));
          var data = await response.json().catch(function () { return {}; });
          if (!response.ok || !data || !data.success) {
            return;
          }
          if (data.paid) {
            setPaidStatusUi();
            statusNode.textContent = "Paid monthly active. Unlimited generations enabled.";
          } else {
            setFreeStatusUi(data.freeLimit);
          }
        } catch (_err) {
          // Ignore background status refresh errors.
        }
      }

      fetch("/api/cold-email/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "landing_view",
          variant_id: assignedVariantId,
          experiment_id: experimentId,
          utm_source: attribution.utm_source,
          utm_campaign: attribution.utm_campaign,
          referrer: attribution.referrer,
          session_id: attribution.session_id,
        }),
      }).catch(function () {});

      if (initialEmail) {
        emailNode.value = String(initialEmail);
        void refreshAccessStatus(String(initialEmail));
      }

      if (paymentState === "success") {
        statusNode.textContent = "Payment confirmed. Verifying paid access...";
        if (initialEmail) {
          var attempts = 0;
          var maxAttempts = 20;
          var pollAfterSuccess = function () {
            attempts += 1;
            void refreshAccessStatus(String(initialEmail));
            if (attempts < maxAttempts) {
              setTimeout(pollAfterSuccess, 3000);
            }
          };
          setTimeout(pollAfterSuccess, 500);
        }
      } else if (paymentState === "cancel") {
        statusNode.textContent = "Checkout canceled. Free access is still available.";
      }

      async function handleColdEmailGenerate() {
        var payload = {
          email: text("email"),
          product: text("product"),
          targetAudience: text("audience"),
          keyBenefit: text("benefit"),
          utm_source: attribution.utm_source,
          utm_campaign: attribution.utm_campaign,
          referrer: attribution.referrer,
          session_id: attribution.session_id,
        };

        if (!payload.email || !payload.product || !payload.targetAudience || !payload.keyBenefit) {
          statusNode.textContent = "Please complete all fields.";
          return;
        }

        button.disabled = true;
        statusNode.textContent = "Generating personalized email...";

        try {
          var response = await fetch("/api/cold-email/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          var data = await response.json().catch(function () { return {}; });

          if (!response.ok || !data.success) {
            if (data && data.paywall) {
              statusNode.textContent = "Free limit reached. Preparing checkout...";
              try {
                var checkoutFromBackend = await requestCheckoutUrl(payload.email);
                window.location.href = checkoutFromBackend;
                return;
              } catch (_checkoutErr) {
                if (_checkoutErr && _checkoutErr.message) {
                  showCheckoutError(_checkoutErr.message);
                  return;
                }
                showPaywallStatus(data.checkoutUrl);
              }
              return;
            }
            var hint = (data && data.hint) ? String(data.hint) : "";
            statusNode.textContent = (data && data.error)
              ? (hint ? (String(data.error) + " " + hint) : String(data.error))
              : "Generation failed. Try again.";
            return;
          }

          outputNode.textContent = data.emailCopy || "No output returned.";
          if (data.previewLocked) {
            outputNode.textContent = data.emailPreview || outputNode.textContent;
            showSoftLockStatus(data);
            return;
          }
          if (data.paid) {
            setPaidStatusUi();
            statusNode.textContent = "Generated and emailed. Paid monthly active with unlimited access.";
            return;
          }
          var remaining = typeof data.remainingFree === "number" ? data.remainingFree : 0;
          statusNode.textContent = "Generated and emailed. Free generations left: " + remaining;
        } catch (_err) {
          statusNode.textContent = "Generation request failed. Try again.";
        } finally {
          button.disabled = false;
        }
      }

      emailNode.addEventListener("blur", function () {
        var emailValue = text("email");
        if (!emailValue) return;
        void refreshAccessStatus(emailValue);
      });

      button.addEventListener("click", function () {
        void handleColdEmailGenerate();
      });
    })();
  </script>
</body>
</html>`;
}

async function createCheckoutForEmail(args: {
  db: Db;
  email: string;
  baseUrl: string;
  attribution?: AttributionContext;
}): Promise<{ checkoutUrl: string | null; companyId: string | null; controls: ColdEmailRuntimeControls }> {
  const telemetryCompanyId = await resolveTelemetryCompanyIdForDb(args.db);
  const signup = await args.db
    .select({
      id: waitlistSignups.id,
      companyId: waitlistSignups.companyId,
      metadata: waitlistSignups.metadata,
    })
    .from(waitlistSignups)
    .where(eq(waitlistSignups.email, args.email))
    .orderBy(desc(waitlistSignups.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null)
    .catch(() => null);

  const mergedAttribution = mergeAttribution(
    args.attribution ?? EMPTY_ATTRIBUTION,
    readAttributionFromUnknown(signup?.metadata),
  );

  if (signup) {
    const nextMetadata = {
      ...asMetadata(signup.metadata),
      ...attributionToMetadata(mergedAttribution),
    };

    await args.db
      .update(waitlistSignups)
      .set({ metadata: nextMetadata })
      .where(eq(waitlistSignups.id, signup.id))
      .catch(() => undefined);
  }

  const companyId = telemetryCompanyId ?? signup?.companyId ?? null;
  const controls = await resolveColdEmailRuntimeControls(args.db, companyId);

  const checkoutUrl = await resolveCheckoutUrl(args.email, companyId, args.baseUrl, mergedAttribution, controls);
  return { checkoutUrl, companyId, controls };
}

export function coldEmailRoutes(db: Db) {
  const router = Router();

  router.get("/cold-email", async (req, res) => {
    const baseUrl = resolvePublicBaseUrl({
      reqOrigin: req.header("origin"),
      host: req.header("host"),
      forwardedHost: req.header("x-forwarded-host"),
      forwardedProto: req.header("x-forwarded-proto"),
    });

    const companyId = await resolveTelemetryCompanyIdForDb(db);
    const attribution = readAttributionFromRequest(req);
    const visitor = resolveLandingVisitorId(req, attribution);
    const visitorId = visitor.visitorId;
    let selectedVariant: LandingVariant | null = null;

    if (companyId) {
      const generatedVariants = await generateLandingVariants(db, companyId).catch(() => getDefaultLandingVariants());
      const activeVariants = generatedVariants.length > 0 ? generatedVariants : getDefaultLandingVariants();
      selectedVariant = assignVariant(visitorId, activeVariants);
      await trackImpression(db, companyId, {
        visitorId,
        experimentId: LANDING_EXPERIMENT_ID,
        variantId: selectedVariant.id,
        timestamp: Date.now(),
      }).catch(() => undefined);
    } else {
      selectedVariant = assignVariant(visitorId, getDefaultLandingVariants());
    }

    if (!visitor.fromCookie) {
      const secure = (req.header("x-forwarded-proto") ?? "").toLowerCase() === "https";
      const cookieValue = `${LANDING_VISITOR_COOKIE}=${encodeURIComponent(visitorId)}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
      res.append("Set-Cookie", cookieValue);
    }

    if (companyId) {
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "cold-email-landing",
        agentId: null,
        runId: null,
        action: "cold_email.landing.viewed",
        entityType: "company",
        entityId: companyId,
        details: compactJsonRecord({
          source: "public_landing",
          host: req.header("host") ?? null,
          visitorId,
          experimentId: LANDING_EXPERIMENT_ID,
          variantId: selectedVariant?.id ?? null,
          ...attributionToMetadata(attribution),
        }),
      }).catch(() => undefined);
    }

    await capturePosthogEvent("cold_email_landing_viewed", {
      source: "public_landing",
      host: req.header("host") ?? null,
      distinctId: req.ip,
      visitor_id: visitorId,
      experiment_id: LANDING_EXPERIMENT_ID,
      variant_id: selectedVariant?.id ?? null,
      ...attributionToMetadata(attribution),
    });

    if (companyId) {
      await recordSystemMetric(db, {
        companyId,
        sourceType: "tool_action",
        sourceId: `cold_email:landing:${Date.now()}`,
        traffic: 1,
        conversions: 0,
        revenueCents: 0,
        metadata: {
          source: "cold_email_landing",
          host: req.header("host") ?? null,
          visitorId,
          experimentId: LANDING_EXPERIMENT_ID,
          variantId: selectedVariant?.id ?? null,
          ...attributionToMetadata(attribution),
        },
      }).catch(() => undefined);
    }

    const initialEmail = normalizeEmail(req.query.email);
    const paymentStateRaw = normalizeOptionalString(req.query.payment);
    const paymentState = paymentStateRaw === "success" || paymentStateRaw === "cancel"
      ? paymentStateRaw
      : null;
    const controls = await resolveColdEmailRuntimeControls(db, companyId);

    res
      .status(200)
      .set({ "Content-Type": "text/html; charset=utf-8" })
      .send(renderLandingPage(baseUrl, controls.freeLimit, {
        initialEmail,
        paymentState,
        variant: selectedVariant,
        experimentId: LANDING_EXPERIMENT_ID,
      }));
  });

  router.get("/cold-email/access", async (req, res) => {
    const email = normalizeEmail(req.query.email);
    if (!email) {
      res.status(422).json({ success: false, error: "Valid email is required" });
      return;
    }

    const signup = await db
      .select({
        metadata: waitlistSignups.metadata,
        createdAt: waitlistSignups.createdAt,
      })
      .from(waitlistSignups)
      .where(eq(waitlistSignups.email, email))
      .orderBy(desc(waitlistSignups.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const metadata = asMetadata(signup?.metadata);
    const generationCount = Math.max(0, Number(metadata.coldEmailGenerationCount ?? 0));
    const paid = isColdEmailPaid(metadata);
    const metadataCompanyId = normalizeOptionalString(metadata.companyId);
    const companyId = isUuid(metadataCompanyId) ? metadataCompanyId : await resolveTelemetryCompanyIdForDb(db);
    const controls = await resolveColdEmailRuntimeControls(db, companyId);
    const freeLimit = controls.freeLimit;

    res.json({
      success: true,
      email,
      paid,
      generationCount,
      freeLimit,
      remainingFree: paid ? Number.MAX_SAFE_INTEGER : Math.max(0, freeLimit - generationCount),
      plan: paid ? "paid_monthly" : "free",
      createdAt: signup?.createdAt?.toISOString() ?? null,
    });
  });

  router.get("/cold-email/success", async (req, res) => {
    const email = normalizeEmail(req.query.email);
    if (!email) {
      res.status(422).send("Valid email is required");
      return;
    }

    res
      .status(200)
      .set({ "Content-Type": "text/html; charset=utf-8" })
      .send(renderSuccessPage(email));
  });

  router.post("/cold-email/track", async (req, res) => {
    const event = normalizeOptionalString(req.body?.event) ?? "unknown";
    const attribution = readAttributionFromRequest(req);
    const companyId = await resolveTelemetryCompanyIdForDb(db);

    if (companyId) {
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "cold-email-track",
        agentId: null,
        runId: null,
        action: "cold_email.landing.tracked",
        entityType: "company",
        entityId: companyId,
        details: compactJsonRecord({
          source: "landing_client",
          event,
          ...attributionToMetadata(attribution),
        }),
      }).catch(() => undefined);
    }

    await capturePosthogEvent(`cold_email_${event}`, {
      source: "landing_client",
      distinctId: req.ip,
      ...attributionToMetadata(attribution),
    });
    res.json({ success: true });
  });

  router.post("/cold-email/checkout", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) {
      res.status(422).json({ success: false, error: "Valid email is required" });
      return;
    }

    const baseUrl = resolvePublicBaseUrl({
      reqOrigin: req.header("origin"),
      host: req.header("host"),
      forwardedHost: req.header("x-forwarded-host"),
      forwardedProto: req.header("x-forwarded-proto"),
    });
    const attribution = readAttributionFromRequest(req);

    const { checkoutUrl, companyId } = await createCheckoutForEmail({
      db,
      email,
      baseUrl,
      attribution,
    });
    if (!checkoutUrl) {
      res.status(500).json({
        success: false,
        error: "checkout_failed",
        hint: "Verify DODO_PRODUCT_ID, DODO_PAYMENTS_API_KEY, DODO_PAYMENTS_BASE_URL, and DODO checkout API reachability.",
      });
      return;
    }

    await capturePosthogEvent("payment_started", {
      source: "cold_email_tool",
      email,
      companyId,
      checkout: checkoutUrl,
      entry_point: "cold_email_checkout",
      ...attributionToMetadata(attribution),
    });

    if (companyId) {
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "cold-email-checkout",
        agentId: null,
        runId: null,
        action: "cold_email.checkout.started",
        entityType: "company",
        entityId: companyId,
        details: compactJsonRecord({
          email,
          checkoutUrl,
          ...attributionToMetadata(attribution),
        }),
      }).catch(() => undefined);
    }

    res.json({ success: true, checkoutUrl });
  });

  router.get("/cold-email/checkout", async (req, res) => {
    const email = normalizeEmail(req.query.email);
    if (!email) {
      res.status(422).json({ success: false, error: "Valid email is required" });
      return;
    }

    const baseUrl = resolvePublicBaseUrl({
      reqOrigin: req.header("origin"),
      host: req.header("host"),
      forwardedHost: req.header("x-forwarded-host"),
      forwardedProto: req.header("x-forwarded-proto"),
    });
    const attribution = readAttributionFromRequest(req);

    const { checkoutUrl } = await createCheckoutForEmail({
      db,
      email,
      baseUrl,
      attribution,
    });

    if (!checkoutUrl) {
      res.status(500).json({
        success: false,
        error: "checkout_failed",
        hint: "Check DODO config",
      });
      return;
    }

    res.json({ checkoutUrl });
  });

  router.get("/cold-email/generate", (_req, res) => {
    res.redirect(302, "/api/cold-email");
  });

  router.post("/cold-email/generate", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const product = normalizeOptionalString(req.body?.product);
    const targetAudience = normalizeOptionalString(req.body?.targetAudience);
    const keyBenefit = normalizeOptionalString(req.body?.keyBenefit);

    if (!email || !product || !targetAudience || !keyBenefit) {
      res.status(422).json({
        success: false,
        error: "email, product, targetAudience, and keyBenefit are required",
      });
      return;
    }

    try {
      const baseUrl = resolvePublicBaseUrl({
        reqOrigin: req.header("origin"),
        host: req.header("host"),
        forwardedHost: req.header("x-forwarded-host"),
        forwardedProto: req.header("x-forwarded-proto"),
      });
      const companyId = await resolveTelemetryCompanyIdForDb(db);
      const runtimeControls = await resolveColdEmailRuntimeControls(db, companyId);
      const source = "cold_email_tool";
      const now = new Date();
      const requestAttribution = readAttributionFromRequest(req);

      await db
        .insert(waitlistSignups)
        .values({
          email,
          companyId,
          source,
          metadata: compactJsonRecord({
            coldEmailGenerationCount: 0,
            ...attributionToMetadata(requestAttribution),
            ...withColdEmailEntitlement({}, false),
          }),
          createdAt: now,
        })
        .onConflictDoNothing({ target: waitlistSignups.email });

      const signup = await db
        .select()
        .from(waitlistSignups)
        .where(eq(waitlistSignups.email, email))
        .orderBy(desc(waitlistSignups.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (!signup) {
        res.status(500).json({ success: false, error: "Failed to load signup profile" });
        return;
      }

      const metadata = asMetadata(signup.metadata);
      const attribution = mergeAttribution(requestAttribution, readAttributionFromUnknown(metadata));
      const freeLimit = runtimeControls.freeLimit;
      const generationCount = Math.max(0, Number(metadata.coldEmailGenerationCount ?? 0));
      const paid = isColdEmailPaid(metadata);

      if (!paid && generationCount >= freeLimit) {
          const checkoutUrl = await resolveCheckoutUrl(email, companyId, baseUrl, attribution, runtimeControls);

        await capturePosthogEvent("cold_email_paywall_hit", {
          source,
          email,
          companyId,
          generationCount,
          ...attributionToMetadata(attribution),
        });

        if (companyId) {
          await db.insert(activityLog).values({
            companyId,
            actorType: "system",
            actorId: "cold-email-generator",
            agentId: null,
            runId: null,
            action: "cold_email.paywall.hit",
            entityType: "company",
            entityId: companyId,
            details: {
              email,
              generationCount,
              freeLimit,
              pricingVariant: runtimeControls.pricingVariant,
              pricingVariantPriceCents: runtimeControls.pricingVariantPriceCents,
              checkoutUrl,
              ...attributionToMetadata(attribution),
            },
          }).catch(() => undefined);
        }

        res.status(402).json({
          success: false,
          paywall: true,
          error: "Free limit reached",
          checkoutUrl,
          checkoutHint: checkoutUrl
            ? null
            : "Checkout URL unavailable. Verify Dodo checkout configuration and API connectivity.",
        });
        return;
      }

      const generated = await generateColdEmail({ product, targetAudience, keyBenefit });
      const updatedGenerationCount = generationCount + 1;
      const previewLocked = !paid && shouldLockOutputPreview(updatedGenerationCount, freeLimit);
      const nextMetadata: JsonRecord = {
        ...withColdEmailEntitlement(metadata, paid),
        source,
        ...attributionToMetadata(attribution),
        coldEmailGenerationCount: updatedGenerationCount,
        coldEmailLastGeneratedAt: now.toISOString(),
        coldEmailPreviewLockedAt: previewLocked ? now.toISOString() : null,
        coldEmailSequenceState: paid ? "paused_paid" : "queued",
        coldEmailSequenceQueuedAt: paid ? (metadata.coldEmailSequenceQueuedAt ?? null) : (metadata.coldEmailSequenceQueuedAt ?? now.toISOString()),
        coldEmailLastInput: {
          product,
          targetAudience,
          keyBenefit,
        },
        coldEmailLastOutput: generated,
      };

      await db
        .update(waitlistSignups)
        .set({
          companyId: signup.companyId ?? companyId,
          source,
          metadata: nextMetadata,
          monetizationSent: paid ? signup.monetizationSent : true,
          monetizationSentAt: paid ? signup.monetizationSentAt : (signup.monetizationSentAt ?? now),
        })
        .where(eq(waitlistSignups.id, signup.id));

      const checkoutUrl = await resolveCheckoutUrl(email, companyId, baseUrl, attribution);
      const upgradeTarget = checkoutUrl ?? `${baseUrl}/api/cold-email`;
      const upsell = softUpsellMessage();
      const lockedPreview = previewLocked ? buildLockedPreview(generated) : null;

      const sentResultEmail = await sendResendEmail({
        to: email,
        subject: previewLocked ? "Your email preview is ready - unlock full output" : "Your personalized cold email is ready",
        html: previewLocked
          ? [
              `<p>${upsell.title}</p>`,
              `<p>${upsell.detail}</p>`,
              `<pre style=\"white-space:pre-wrap;border:1px solid #e5e7eb;padding:12px;border-radius:8px;\">${(lockedPreview ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`,
              `<p><a href=\"${renderTrackedClick(baseUrl, email, "cold_email_soft_unlock", companyId, upgradeTarget)}\">Unlock full output</a></p>`,
              `<img src=\"${renderTrackedPixel(baseUrl, email, "cold_email_soft_unlock", companyId)}\" alt=\"\" width=\"1\" height=\"1\"/>`,
            ].join("")
          : [
              "<p>Your personalized cold email:</p>",
              `<pre style=\"white-space:pre-wrap;border:1px solid #e5e7eb;padding:12px;border-radius:8px;\">${generated.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`,
              `<p><a href=\"${renderTrackedClick(baseUrl, email, "cold_email_result", companyId, upgradeTarget)}\">${paid ? "Generate another" : "Upgrade to unlimited"}</a></p>`,
              `<img src=\"${renderTrackedPixel(baseUrl, email, "cold_email_result", companyId)}\" alt=\"\" width=\"1\" height=\"1\"/>`,
            ].join(""),
      });

      if (!paid) {
        const sequenceMetadata: JsonRecord = {
          ...nextMetadata,
          coldEmailSequenceState: "active_unpaid",
          coldEmailSequenceLastStep: "day0",
          coldEmailSequenceLastSentAt: now.toISOString(),
          coldEmailSequenceLastStatus: sentResultEmail ? "sent" : "failed",
        };
        await db
          .update(waitlistSignups)
          .set({ metadata: sequenceMetadata })
          .where(eq(waitlistSignups.id, signup.id))
          .catch(() => undefined);
      }

      await scheduleFollowUps({
        db,
        signupId: signup.id,
        email,
        companyId,
        baseUrl,
        checkoutUrl,
      });

      if (!paid && companyId) {
        await db.insert(activityLog).values({
          companyId,
          actorType: "system",
          actorId: "cold-email-sequence",
          agentId: null,
          runId: null,
          action: "cold_email.sequence.queued",
          entityType: "company",
          entityId: companyId,
          details: {
            email,
            steps: ["day0", "day1", "day2"],
          },
        }).catch(() => undefined);
      }

      await capturePosthogEvent("cold_email_generated", {
        source,
        email,
        companyId,
        generationCount: updatedGenerationCount,
        paid,
        previewLocked,
        resultEmailSent: sentResultEmail,
        ...attributionToMetadata(attribution),
      });

      if (previewLocked && companyId) {
        await db.insert(activityLog).values({
          companyId,
          actorType: "system",
          actorId: "cold-email-generator",
          agentId: null,
          runId: null,
          action: "cold_email.soft_paywall.shown",
          entityType: "company",
          entityId: companyId,
          details: {
            email,
            generationCount: updatedGenerationCount,
            freeLimit,
            checkoutUrl,
            softPromptTitle: upsell.title,
            ...attributionToMetadata(attribution),
          },
        }).catch(() => undefined);
      }

      if (companyId) {
        await db.insert(activityLog).values({
          companyId,
          actorType: "system",
          actorId: "cold-email-generator",
          agentId: null,
          runId: null,
          action: "cold_email.generated",
          entityType: "company",
          entityId: companyId,
          details: {
            email,
            product,
            targetAudience,
            keyBenefit,
            paid,
            generationCount: updatedGenerationCount,
            resultEmailSent: sentResultEmail,
            ...attributionToMetadata(attribution),
          },
        }).catch(() => undefined);

        const conversionIncrement = generationCount === 0 ? 1 : 0;
        if (conversionIncrement > 0) {
          await recordSystemMetric(db, {
            companyId,
            sourceType: "tool_action",
            sourceId: `cold_email:first_generation:${email}`,
            traffic: 0,
            conversions: conversionIncrement,
            revenueCents: 0,
            metadata: {
              source: "cold_email_generation",
              email,
              paid,
              ...attributionToMetadata(attribution),
            },
          }).catch(() => undefined);
        }
      }

      res.json({
        success: true,
        emailCopy: previewLocked ? null : generated,
        emailPreview: lockedPreview,
        previewLocked,
        softPromptTitle: previewLocked ? upsell.title : null,
        softPromptDetail: previewLocked ? upsell.detail : null,
        softPromptValueStack: previewLocked ? upsell.valueStack : null,
        paid,
        generationCount: updatedGenerationCount,
        remainingFree: paid ? Number.MAX_SAFE_INTEGER : Math.max(0, freeLimit - updatedGenerationCount),
        freeLimit,
        pricingVariant: runtimeControls.pricingVariant,
        pricingVariantPriceCents: runtimeControls.pricingVariantPriceCents,
        checkoutUrl,
        resultEmailSent: sentResultEmail,
      });
    } catch (error) {
      const hint = describeColdEmailGenerateFailure(error);
      logger.error(
        {
          err: error,
          route: "POST /api/cold-email/generate",
          email,
        },
        "Cold email generation failed",
      );

      res.status(500).json({
        success: false,
        error: "Internal server error",
        ...(hint ? { hint } : {}),
      });
    }
  });

  router.get("/cold-email/stats", async (_req, res) => {
    const companyId = await resolveTelemetryCompanyIdForDb(db);
    if (!companyId) {
      res.json({
        success: true,
        companyId: null,
        visitors: 0,
        generated: 0,
        paywallHits: 0,
        paidUsers: 0,
      });
      return;
    }

    const [activity] = await db
      .select({
        visitors: sql<number>`count(*) filter (where ${activityLog.action} = 'cold_email.landing.viewed')::int`,
        generated: sql<number>`count(*) filter (where ${activityLog.action} = 'cold_email.generated')::int`,
        paywallHits: sql<number>`count(*) filter (where ${activityLog.action} = 'cold_email.paywall.hit')::int`,
      })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));

    const [paidUsers] = await db
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(waitlistSignups)
      .where(
        and(
          eq(waitlistSignups.companyId, companyId),
          sql`coalesce(((${waitlistSignups.metadata} -> 'entitlements' ->> 'cold_email')::boolean), false) = true`,
        ),
      );

    res.json({
      success: true,
      companyId,
      visitors: Number(activity?.visitors ?? 0),
      generated: Number(activity?.generated ?? 0),
      paywallHits: Number(activity?.paywallHits ?? 0),
      paidUsers: Number(paidUsers?.count ?? 0),
      freeLimit: (await resolveColdEmailRuntimeControls(db, companyId)).freeLimit,
    });
  });

  return router;
}