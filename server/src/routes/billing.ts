import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { activityLog, aiLearningRecords, and, companies, eq, sql, type Db, waitlistSignups } from "@paperclipai/db";
import {
  createDodoCheckoutSession,
  createStripeCheckoutSession,
} from "../ai/tools/externalTools.js";
import {
  getRecentSystemMetricsSnapshot,
  recordSystemMetric,
} from "../ai/feedback/metricsEngine.js";
import {
  creditCompanyFinanceForPayment,
  dispatchDecisionCycle,
  getCompanyFinanceSnapshot,
  logActivity,
} from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

type JsonRecord = Record<string, unknown>;
type BillingProvider = "stripe" | "dodo";
type RevenueTrend = "increasing" | "flat" | "down";
type RevenueDecision = "scale" | "improve" | "kill";

const RECENT_TRANSACTION_CACHE_TTL_MS = 30 * 60 * 1000;
const recentTransactionCache = new Map<string, number>();

function asRecord(value: unknown): JsonRecord {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return {};
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function persistPaymentLearningRecord(
  db: Db,
  args: {
    companyId: string;
    provider: string;
    amountCents: number;
    currency: string;
    sessionId: string | null;
    source: string;
    goalId: string | null;
    issueId: string | null;
    metadata: JsonRecord;
  },
): Promise<void> {
  await db.insert(aiLearningRecords).values({
    companyId: args.companyId,
    goalId: args.goalId,
    recordType: "evaluation",
    category: "outcome",
    summary: `Payment conversion recorded (${args.provider} ${args.amountCents} ${args.currency})`,
    details: {
      source: args.source,
      provider: args.provider,
      amountCents: args.amountCents,
      currency: args.currency,
      sessionId: args.sessionId,
      issueId: args.issueId,
      metadata: args.metadata,
      eventType: "payment_completed",
    },
    scores: {
      paymentAmountCents: args.amountCents,
      converted: 1,
    },
    recommendedChange: args.amountCents < 500
      ? "Test higher-value packaging or add post-purchase upsell to raise revenue per conversion."
      : "Replicate acquisition and offer path that produced this conversion.",
    applied: true,
    appliedAt: new Date(),
  });
}

function getPath(root: unknown, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return null;
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as JsonRecord)[segment];
  }
  return current;
}

function firstString(root: unknown, paths: string[]): string | null {
  for (const path of paths) {
    const value = readString(getPath(root, path));
    if (value) return value;
  }
  return null;
}

function firstNumber(root: unknown, paths: string[]): number | null {
  for (const path of paths) {
    const value = readNumber(getPath(root, path));
    if (value != null) return value;
  }
  return null;
}

function extractCheckoutUrl(payload: JsonRecord): string | null {
  return firstString(payload, [
    "url",
    "checkout_url",
    "checkoutUrl",
    "session.url",
    "data.url",
    "data.checkout_url",
  ]);
}

function extractSessionId(payload: JsonRecord): string | null {
  return firstString(payload, [
    "id",
    "session_id",
    "sessionId",
    "data.id",
    "data.object.id",
  ]);
}

async function capturePosthogEvent(event: string, properties: Record<string, unknown>): Promise<void> {
  const key = (process.env.POSTHOG_API_KEY ?? process.env.VITE_POSTHOG_KEY ?? "").trim();
  const debug = /^(1|true|yes)$/i.test((process.env.POSTHOG_CAPTURE_DEBUG ?? "").trim());
  if (!key) {
    if (debug) {
      console.info("[billing.posthog.capture] skipped: missing key", { event });
    }
    return;
  }
  const host = (process.env.POSTHOG_HOST ?? process.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com").trim();
  const distinctId = String(
    properties.email ?? properties.companyId ?? properties.sessionId ?? `billing_${Date.now()}`,
  );

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
      console.warn("[billing.posthog.capture] non-2xx response", {
        event,
        status: response.status,
        body: body.slice(0, 300),
      });
    } else if (debug) {
      console.info("[billing.posthog.capture] accepted", {
        event,
        host,
        distinctId,
      });
    }
  } catch (error) {
    console.warn("[billing.posthog.capture] request failed", {
      event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function secureCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

async function markColdEmailUserPaid(
  db: Db,
  args: {
    companyId: string;
    metadata: JsonRecord;
    payload: JsonRecord;
    amountCents: number;
    currency: string;
    sessionId: string | null;
  },
): Promise<void> {
  const email = (
    readString(args.metadata.email)
    ?? firstString(args.payload, [
      "metadata.email",
      "data.metadata.email",
      "data.object.metadata.email",
      "data.customer_details.email",
      "data.object.customer_details.email",
      "data.customer.email",
      "data.object.customer_email",
      "data.object.customer.email",
      "data.email",
      "customer.email",
      "customer_email",
      "email",
      "billing_email",
    ])
  )?.toLowerCase();
  if (!email) return;

  const row = await db
    .select({ id: waitlistSignups.id, metadata: waitlistSignups.metadata })
    .from(waitlistSignups)
    .where(eq(waitlistSignups.email, email))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  const source = readString(args.metadata.source)?.toLowerCase();
  const feature = readString(args.metadata.feature)?.toLowerCase();
  const expectedProductId = readString(process.env.DODO_PRODUCT_ID);
  const productId = firstString(args.payload, [
    "data.product_id",
    "data.object.product_id",
    "data.object.product.id",
    "data.product_cart.0.product_id",
    "data.object.product_cart.0.product_id",
    "product_cart.0.product_id",
    "line_items.0.product_id",
    "data.line_items.0.product_id",
    "product_id",
    "product.id",
  ]);

  const existingSource = row
    ? readString(asRecord(row.metadata).source)?.toLowerCase()
    : null;

  const isColdEmailPayment = source === "cold_email_tool"
    || feature === "cold_email_unlimited"
    || (expectedProductId != null && productId != null && expectedProductId === productId)
    || existingSource === "cold_email_tool";

  if (!isColdEmailPayment) return;

  if (!row) {
    await db
      .insert(waitlistSignups)
      .values({
        email,
        companyId: args.companyId,
        source: "cold_email_tool",
        metadata: {
          source: "cold_email_tool",
          coldEmailGenerationCount: 0,
          coldEmailPaid: true,
          coldEmailPlan: "paid_monthly",
          coldEmailUnlimited: true,
          coldEmailPaidAt: new Date().toISOString(),
          coldEmailLastPaymentCents: args.amountCents,
          coldEmailLastPaymentCurrency: args.currency,
          coldEmailLastPaymentSessionId: args.sessionId,
          coldEmailLastPaymentProductId: productId,
        },
      })
      .onConflictDoUpdate({
        target: waitlistSignups.email,
        set: {
          companyId: args.companyId,
          source: "cold_email_tool",
          metadata: {
            source: "cold_email_tool",
            coldEmailGenerationCount: 0,
            coldEmailPaid: true,
            coldEmailPlan: "paid_monthly",
            coldEmailUnlimited: true,
            coldEmailPaidAt: new Date().toISOString(),
            coldEmailLastPaymentCents: args.amountCents,
            coldEmailLastPaymentCurrency: args.currency,
            coldEmailLastPaymentSessionId: args.sessionId,
            coldEmailLastPaymentProductId: productId,
          },
        },
      });
  }

  const currentMetadata = row?.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata as JsonRecord
    : {};

  if (row) {
    await db
      .update(waitlistSignups)
      .set({
        companyId: args.companyId,
        metadata: {
          ...currentMetadata,
          source: "cold_email_tool",
          coldEmailPaid: true,
          coldEmailPlan: "paid_monthly",
          coldEmailUnlimited: true,
          coldEmailPaidAt: new Date().toISOString(),
          coldEmailLastPaymentCents: args.amountCents,
          coldEmailLastPaymentCurrency: args.currency,
          coldEmailLastPaymentSessionId: args.sessionId,
          coldEmailLastPaymentProductId: productId,
        },
      })
      .where(eq(waitlistSignups.id, row.id));
  }

  await logActivity(db, {
    companyId: args.companyId,
    actorType: "system",
    actorId: "billing-webhook",
    agentId: null,
    runId: null,
    action: "cold_email.payment.unlimited_unlocked",
    entityType: "company",
    entityId: args.companyId,
    details: {
      email,
      amountCents: args.amountCents,
      currency: args.currency,
      sessionId: args.sessionId,
      productId,
      source,
      feature,
    },
  });
}

function classifyRpvDecision(previousRpv: number, currentRpv: number): {
  trend: RevenueTrend;
  decision: RevenueDecision;
} {
  const previous = Math.max(0, previousRpv);
  const current = Math.max(0, currentRpv);
  const delta = current - previous;

  const trend: RevenueTrend =
    previous <= 0
      ? current > 0
        ? "increasing"
        : "flat"
      : delta > previous * 0.05
        ? "increasing"
        : delta < -previous * 0.05
          ? "down"
          : "flat";

  const decision: RevenueDecision = trend === "increasing"
    ? "scale"
    : trend === "down"
      ? "kill"
      : "improve";

  return { trend, decision };
}

function decodeWebhookSecret(secret: string): string | Buffer {
  if (!secret.startsWith("whsec_")) return secret;
  const raw = secret.slice("whsec_".length).trim();
  if (!raw) return secret;
  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 0) return secret;
    const normalizedRaw = raw.replace(/=+$/, "");
    const normalizedRoundTrip = decoded.toString("base64").replace(/=+$/, "");
    if (normalizedRaw === normalizedRoundTrip) return decoded;
  } catch {
    return secret;
  }
  return secret;
}

function parseSignatureList(headerValue: string): { timestamp: string | null; signatures: string[] } {
  const parts = headerValue
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  let timestamp: string | null = null;
  const signatures: string[] = [];

  for (const part of parts) {
    const [key, rawValue] = part.split("=", 2);
    if (!key || !rawValue) continue;
    const value = rawValue.trim();
    if (!value) continue;
    const normalizedKey = key.trim().toLowerCase();
    if (normalizedKey === "t") {
      timestamp = value;
      continue;
    }
    if (normalizedKey === "v1" || normalizedKey === "signature") {
      signatures.push(value);
    }
  }

  if (signatures.length === 0) {
    signatures.push(...parts.filter((part) => !part.includes("=") && part.length > 0));
  }

  return { timestamp, signatures };
}

function hasFreshTimestamp(timestamp: string | null, toleranceSeconds: number): boolean {
  if (!timestamp) return false;
  const parsed = Number(timestamp);
  if (!Number.isFinite(parsed) || parsed <= 0) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return Math.abs(nowSeconds - parsed) <= toleranceSeconds;
}

function hmacHex(secret: string, value: string): string {
  return createHmac("sha256", decodeWebhookSecret(secret)).update(value).digest("hex");
}

function hmacBase64(secret: string, value: string): string {
  return createHmac("sha256", decodeWebhookSecret(secret)).update(value).digest("base64");
}

function parseSvixSignatureValues(headerValue: string): string[] {
  const matches = [...headerValue.matchAll(/v\d,([^\s,]+)/g)];
  return matches.map((match) => match[1]?.trim()).filter((value): value is string => !!value);
}

function compactJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, val]) => val != null));
}

function readWebhookMetadata(payload: JsonRecord): JsonRecord {
  return asRecord(
    getPath(payload, "metadata") ??
    getPath(payload, "data.metadata") ??
    getPath(payload, "data.object.metadata") ??
    getPath(payload, "data.customer.metadata") ??
    getPath(payload, "data.object.customer.metadata"),
  );
}

function extractCompanyIdFromPayload(payload: JsonRecord, metadata: JsonRecord): string | null {
  return (
    firstString(payload, [
      "companyId",
      "company_id",
      "metadata.companyId",
      "metadata.company_id",
      "data.metadata.companyId",
      "data.metadata.company_id",
      "data.object.metadata.companyId",
      "data.object.metadata.company_id",
      "data.customer.metadata.companyId",
      "data.customer.metadata.company_id",
      "data.object.customer.metadata.companyId",
      "data.object.customer.metadata.company_id",
    ]) ??
    readString(metadata.companyId) ??
    readString(metadata.company_id)
  );
}

async function resolveCompanyIdFromCheckoutHistory(
  db: Db,
  payload: JsonRecord,
): Promise<string | null> {
  const checkoutUrl = firstString(payload, [
    "data.payment_link",
    "payment_link",
    "data.checkout_url",
    "checkout_url",
    "checkoutUrl",
    "url",
  ]);
  const checkoutSessionId = firstString(payload, [
    "data.checkout_session_id",
    "checkout_session_id",
    "checkoutSessionId",
    "data.checkout_session.id",
    "session_id",
    "sessionId",
  ]);

  if (!checkoutUrl && !checkoutSessionId) return null;

  if (checkoutUrl && checkoutSessionId) {
    const row = await db
      .select({ companyId: activityLog.companyId })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.action, "billing.checkout.created"),
          eq(activityLog.entityType, "company"),
          sql`${activityLog.details} ->> 'provider' = 'dodo'`,
          sql`(${activityLog.details} ->> 'checkoutUrl' = ${checkoutUrl} OR ${activityLog.details} ->> 'sessionId' = ${checkoutSessionId})`,
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row?.companyId ?? null;
  }

  if (checkoutUrl) {
    const row = await db
      .select({ companyId: activityLog.companyId })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.action, "billing.checkout.created"),
          eq(activityLog.entityType, "company"),
          sql`${activityLog.details} ->> 'provider' = 'dodo'`,
          sql`${activityLog.details} ->> 'checkoutUrl' = ${checkoutUrl}`,
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row?.companyId ?? null;
  }

  const row = await db
    .select({ companyId: activityLog.companyId })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.action, "billing.checkout.created"),
        eq(activityLog.entityType, "company"),
        sql`${activityLog.details} ->> 'provider' = 'dodo'`,
        sql`${activityLog.details} ->> 'sessionId' = ${checkoutSessionId}`,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row?.companyId ?? null;
}

async function companyExists(db: Db, companyId: string): Promise<boolean> {
  const row = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return !!row;
}

async function resolveWebhookCompanyId(
  db: Db,
  payload: JsonRecord,
  metadata: JsonRecord,
): Promise<string | null> {
  const configuredFallbackCompanyId =
    readString(process.env.BILLING_WEBHOOK_COMPANY_ID) ??
    readString(process.env.BILLING_DEFAULT_COMPANY_ID) ??
    readString(process.env.DODO_WEBHOOK_COMPANY_ID);

  console.log("[billing.webhook.resolve] Configured fallback:", configuredFallbackCompanyId);

  if (configuredFallbackCompanyId && isUuid(configuredFallbackCompanyId)) {
    const exists = await companyExists(db, configuredFallbackCompanyId);
    console.log("[billing.webhook.resolve] Fallback company exists:", exists);
    if (exists) return configuredFallbackCompanyId;
  }

  const directCompanyId = extractCompanyIdFromPayload(payload, metadata);
  console.log("[billing.webhook.resolve] Direct from payload:", directCompanyId);
  if (directCompanyId && isUuid(directCompanyId) && await companyExists(db, directCompanyId)) return directCompanyId;

  const fromCheckoutHistory = await resolveCompanyIdFromCheckoutHistory(db, payload);
  console.log("[billing.webhook.resolve] From checkout history:", fromCheckoutHistory);
  if (fromCheckoutHistory && await companyExists(db, fromCheckoutHistory)) return fromCheckoutHistory;

  const activeCompanies = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.status, "active"))
    .limit(5);
  console.log("[billing.webhook.resolve] Active companies:", activeCompanies.map((c) => c.id));
  if (activeCompanies.length === 1) return activeCompanies[0]!.id;

  const allCompanies = await db
    .select({ id: companies.id })
    .from(companies)
    .limit(5);
  console.log("[billing.webhook.resolve] All companies:", allCompanies.map((c) => c.id));
  if (allCompanies.length === 1) return allCompanies[0]!.id;

  if (activeCompanies.length > 0) {
    console.log("[billing.webhook.resolve] Falling back to first active company");
    return activeCompanies[0]!.id;
  }

  if (allCompanies.length > 0) {
    console.log("[billing.webhook.resolve] Falling back to first company");
    return allCompanies[0]!.id;
  }

  return null;
}

function resolvePaymentEventIdentity(
  provider: BillingProvider,
  payload: JsonRecord,
  rawBody: string,
): { externalEventId: string; transactionKey: string } {
  const eventId = firstString(payload, [
    "eventId",
    "event_id",
    "id",
    "payment_id",
    "invoice_id",
    "data.id",
    "data.payment_id",
    "data.invoice_id",
    "data.subscription_id",
    "data.object.id",
    "data.object.payment_intent",
  ]);
  const sessionId = firstString(payload, [
    "sessionId",
    "session_id",
    "payment_id",
    "data.id",
    "data.payment_id",
    "data.checkout_session_id",
    "data.object.id",
    "id",
  ]);
  const fallbackHash = createHash("sha256").update(rawBody).digest("hex");
  const externalEventId = eventId ?? sessionId ?? fallbackHash;
  const transactionKey = `billing:${provider}:${externalEventId}`;
  return { externalEventId, transactionKey };
}

function rememberRecentTransaction(transactionKey: string): void {
  const now = Date.now();
  for (const [key, ts] of recentTransactionCache.entries()) {
    if (now - ts > RECENT_TRANSACTION_CACHE_TTL_MS) {
      recentTransactionCache.delete(key);
    }
  }
  recentTransactionCache.set(transactionKey, now);
}

function hasRecentTransaction(transactionKey: string): boolean {
  const ts = recentTransactionCache.get(transactionKey);
  if (!ts) return false;
  if (Date.now() - ts > RECENT_TRANSACTION_CACHE_TTL_MS) {
    recentTransactionCache.delete(transactionKey);
    return false;
  }
  return true;
}

async function hasRecordedTransaction(
  db: Db,
  companyId: string,
  transactionKey: string,
): Promise<boolean> {
  const existing = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "payment_transaction"),
        eq(activityLog.entityId, transactionKey),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return !!existing;
}

function verifyStripeSignature(rawBody: string, headerValue: string, secret: string): boolean {
  const parsed = parseSignatureList(headerValue);
  if (!hasFreshTimestamp(parsed.timestamp, 300)) return false;
  if (!parsed.timestamp || parsed.signatures.length === 0) return false;

  const signedPayload = `${parsed.timestamp}.${rawBody}`;
  const expectedHex = hmacHex(secret, signedPayload);
  return parsed.signatures.some((candidate) => secureCompare(candidate, expectedHex));
}

function verifyDodoSignature(
  rawBody: string,
  headerValue: string,
  secret: string,
  timestampOverride?: string | null,
  webhookIdOverride?: string | null,
): boolean {
  const parsed = parseSignatureList(headerValue);
  const candidates = new Set<string>(parsed.signatures);
  for (const svixValue of parseSvixSignatureValues(headerValue)) {
    candidates.add(svixValue);
  }

  if (candidates.size === 0 && headerValue.trim().length > 0) {
    candidates.add(headerValue.trim());
  }

  const expectedValues = new Set<string>([
    hmacHex(secret, rawBody),
    hmacBase64(secret, rawBody),
  ]);

  const timestamp = timestampOverride ?? parsed.timestamp;
  if (timestamp) {
    const signedPayload = `${timestamp}.${rawBody}`;
    expectedValues.add(hmacHex(secret, signedPayload));
    expectedValues.add(hmacBase64(secret, signedPayload));

    // Svix canonical payload format used by some Dodo webhook deliveries.
    const webhookId = readString(webhookIdOverride);
    if (webhookId) {
      const svixSignedPayload = `${webhookId}.${timestamp}.${rawBody}`;
      expectedValues.add(hmacHex(secret, svixSignedPayload));
      expectedValues.add(hmacBase64(secret, svixSignedPayload));
    }
  }

  for (const candidate of candidates) {
    for (const expected of expectedValues) {
      if (secureCompare(candidate, expected)) return true;
    }
  }

  return false;
}

function readDodoSignatureHeader(req: Request): string | null {
  return (
    readString(req.header("svix-signature")) ??
    readString(req.header("webhook-signature")) ??
    readString(req.header("x-dodo-signature")) ??
    readString(req.header("dodo-signature")) ??
    readString(req.header("x-dodo-payments-signature"))
  );
}

function readDodoTimestampHeader(req: Request): string | null {
  return readString(req.header("svix-timestamp")) ?? readString(req.header("webhook-timestamp"));
}

function readDodoWebhookIdHeader(req: Request): string | null {
  return readString(req.header("svix-id")) ?? readString(req.header("webhook-id"));
}

function readRawBody(req: Request): string {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (raw && raw.length > 0) return raw.toString("utf8");
  return JSON.stringify(req.body ?? {});
}

function detectWebhookProvider(req: Request, payload: JsonRecord): BillingProvider {
  if (readString(req.header("stripe-signature"))) return "stripe";
  if (
    readDodoSignatureHeader(req)
  ) {
    return "dodo";
  }

  return readString(payload.provider) === "dodo" ? "dodo" : "stripe";
}

export const __billingInternals = {
  parseSignatureList,
  verifyStripeSignature,
  verifyDodoSignature,
};

export function billingRoutes(db: Db) {
  const router = Router();

  router.post("/payments/dodo/checkout", async (req, res) => {
    const body = asRecord(req.body);
    const companyId = readString(body.companyId);
    if (companyId) {
      assertCompanyAccess(req, companyId);
    }

    const productId =
      readString(body.productId) ??
      readString(body.product_id) ??
      readString(process.env.DODO_PRODUCT_ID);
    if (!productId) {
      res.status(400).json({ error: "productId is required" });
      return;
    }

    const successUrl =
      readString(body.successUrl) ??
      readString(body.success_url) ??
      readString(process.env.BILLING_SUCCESS_URL) ??
      "http://localhost:3100/payment-success";
    const cancelUrl =
      readString(body.cancelUrl) ??
      readString(body.cancel_url) ??
      readString(process.env.BILLING_CANCEL_URL) ??
      "http://localhost:3100/payment-cancel";

    const goalId = readString(body.goalId) ?? readString(body.goal_id);
    const issueId = readString(body.issueId) ?? readString(body.issue_id);
    const payload = asRecord(body.payload);
    const payloadMetadata = asRecord(payload.metadata);
    const mergedMetadata = compactJsonRecord({
      ...payloadMetadata,
      companyId: readString(payloadMetadata.companyId) ?? companyId,
      goalId: readString(payloadMetadata.goalId) ?? goalId,
      issueId: readString(payloadMetadata.issueId) ?? issueId,
      source: readString(payloadMetadata.source) ?? "paperclip.payments.dodo.checkout",
    });
    const dodoPayload =
      Object.keys(payload).length > 0
        ? { ...payload, metadata: mergedMetadata }
        : {
            product_id: productId,
            success_url: successUrl,
            cancel_url: cancelUrl,
            metadata: mergedMetadata,
          };

    const created = asRecord(
      await createDodoCheckoutSession(
        { integrationEnv: {} },
        {
          payload: dodoPayload,
          hostedCheckoutUrl:
            readString(body.hostedCheckoutUrl) ??
            readString(process.env.DODO_PAYMENTS_CHECKOUT_URL),
          fallbackToHostedCheckoutUrl: true,
        },
      ),
    );

    const checkoutUrl = extractCheckoutUrl(created);
    const sessionId = extractSessionId(created) ?? randomUUID();

    if (!checkoutUrl) {
      res.status(502).json({ error: "Dodo checkout URL not returned", raw: created });
      return;
    }

    if (companyId) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "billing.checkout.created",
        entityType: "company",
        entityId: companyId,
        details: {
          provider: "dodo",
          sessionId,
          checkoutUrl,
          productId,
          goalId,
          issueId,
          metadata: mergedMetadata,
        },
      });
    }

    res.status(201).json({
      provider: "dodo",
      sessionId,
      checkoutUrl,
      raw: created,
    });
  });

  const handleDodoWebhook = async (req: Request, res: Response) => {
    const payload = asRecord(req.body);
    const rawBody = readRawBody(req);

    console.log("[billing.webhook] ====== DODO WEBHOOK RECEIVED ======");
    console.log("[billing.webhook] Path:", req.path);
    console.log("[billing.webhook] Headers:", JSON.stringify({
      "content-type": req.header("content-type"),
      "svix-id": req.header("svix-id"),
      "svix-timestamp": req.header("svix-timestamp"),
      "svix-signature": req.header("svix-signature"),
      "webhook-id": req.header("webhook-id"),
      "webhook-timestamp": req.header("webhook-timestamp"),
      "webhook-signature": req.header("webhook-signature"),
      "x-dodo-signature": req.header("x-dodo-signature"),
      "dodo-signature": req.header("dodo-signature"),
    }));
    console.log("[billing.webhook] Body:", JSON.stringify(payload).slice(0, 2000));
    console.log("[billing.webhook] Raw body length:", rawBody.length);

    const dodoSecret =
      readString(process.env.DODO_WEBHOOK_SECRET) ??
      readString(process.env.DODO_PAYMENTS_WEBHOOK_SECRET) ??
      readString(process.env.DODO_PAYMENTS_SIGNING_SECRET);

    const debugMode = /^(1|true|yes)$/i.test((process.env.BILLING_WEBHOOK_DEBUG ?? "").trim());

    if (!dodoSecret) {
      console.warn("[billing.webhook] No DODO_WEBHOOK_SECRET configured — rejecting");
      res.status(401).json({ error: "Missing configured dodo webhook secret" });
      return;
    }

    const signatureHeader = readDodoSignatureHeader(req);
    const timestampHeader = readDodoTimestampHeader(req);
    const webhookIdHeader = readDodoWebhookIdHeader(req);

    console.log("[billing.webhook] Signature verification:", {
      signatureHeader: signatureHeader?.slice(0, 40),
      timestampHeader,
      webhookIdHeader,
      secretPrefix: dodoSecret.slice(0, 10) + "...",
    });

    const signatureValid = signatureHeader
      ? verifyDodoSignature(rawBody, signatureHeader, dodoSecret, timestampHeader, webhookIdHeader)
      : false;

    if (!signatureValid) {
      if (debugMode) {
        console.warn("[billing.webhook] Signature INVALID but debug mode enabled — proceeding anyway");
      } else {
        console.error("[billing.webhook] Signature verification FAILED — rejecting webhook");
        res.status(401).json({ error: "Invalid Dodo webhook signature" });
        return;
      }
    } else {
      console.log("[billing.webhook] Signature verification PASSED");
    }

    const metadata = readWebhookMetadata(payload);
    const goalId = readString(metadata.goalId);
    const issueId = readString(metadata.issueId);
    const eventType =
      firstString(payload, ["type", "event", "event_type"]) ?? "payment.success";

    console.log("[billing.webhook] Event type:", eventType);

    const PAYMENT_SUCCESS_EVENT_TYPES = new Set([
      "payment.success",
      "payment.succeeded",
      "payment_succeeded",
      "payment.completed",
      "payment_completed",
      "checkout.session.completed",
      "checkout.completed",
      "checkout_completed",
      "payment.paid",
      "invoice.paid",
      "charge.succeeded",
      "order.completed",
      "subscription.active",
      "subscription.renewed",
      "subscription.created",
      "subscription.paid",
      "subscription.updated",
    ]);

    const successEvent = PAYMENT_SUCCESS_EVENT_TYPES.has(eventType);

    if (!successEvent) {
      console.log("[billing.webhook] Non-success event type, accepting but ignoring:", eventType);
      res.status(202).json({ accepted: true, ignored: true, eventType });
      return;
    }

    console.log("[billing.webhook] SUCCESS event detected — processing payment");

    const companyId = await resolveWebhookCompanyId(db, payload, metadata);

    console.log("[billing.webhook] Resolved companyId:", companyId);
    console.log("[billing.webhook] Metadata:", JSON.stringify(metadata));

    if (!companyId) {
      console.error("[billing.webhook] FAILED — could not resolve companyId from payload/metadata/DB");
      res.status(400).json({ error: "companyId is required in webhook metadata" });
      return;
    }

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "billing-webhook",
      agentId: null,
      runId: null,
      action: "billing.webhook.received",
      entityType: "company",
      entityId: companyId,
      details: {
        provider: "dodo",
        endpoint: req.path,
        eventType,
        signatureHeaderPresent: true,
      },
    });

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "billing-webhook",
      agentId: null,
      runId: null,
      action: "billing.webhook.verified",
      entityType: "company",
      entityId: companyId,
      details: {
        provider: "dodo",
        endpoint: req.path,
        eventType,
        signatureVerified: true,
      },
    });

    const sessionId = firstString(payload, [
      "sessionId",
      "session_id",
      "payment_id",
      "data.payment_id",
      "data.subscription_id",
      "data.id",
      "data.checkout_session_id",
      "data.object.id",
      "id",
    ]);
    const settlementAmount = firstNumber(payload, [
      "data.settlement_amount",
      "settlement_amount",
    ]);
    const rawAmount = firstNumber(payload, [
      "amountCents",
      "amount_cents",
      "amount_total",
      "payment_amount_cents",
      "amount",
      "data.amount",
      "data.total_amount",
      "data.amount_total",
      "data.recurring_pre_tax_amount",
      "data.object.amount_total",
      "data.object.amount",
    ]);
    const settlementCurrency = firstString(payload, [
      "data.settlement_currency",
      "settlement_currency",
    ]);
    const localCurrency = firstString(payload, ["currency", "data.currency", "data.object.currency"]);

    const isCrossCurrency = settlementCurrency && localCurrency
      && settlementCurrency.toLowerCase() !== localCurrency.toLowerCase();
    const amountCents = Math.max(0, Math.round(
      (isCrossCurrency && settlementAmount != null) ? settlementAmount : (settlementAmount ?? rawAmount ?? 0),
    ));
    const currency = (isCrossCurrency ? settlementCurrency : localCurrency) ?? "usd";
    const revenueSource =
      readString(metadata.source)
      ?? (() => {
        const variantId = readString(metadata.variantId) ?? readString(metadata.variant_id);
        return variantId ? `landing_variant_${variantId}` : null;
      })()
      ?? "landing_variant_unknown";
    const revenueUserId =
      readString(metadata.userId)
      ?? readString(metadata.user_id)
      ?? firstString(payload, [
        "data.customer.id",
        "data.object.customer.id",
        "data.customer.email",
        "data.object.customer_email",
        "customer_id",
        "customer_email",
        "email",
      ])
      ?? "anonymous";

    console.log("[billing.webhook] Extracted payment details:", {
      sessionId,
      amountCents,
      currency,
      eventType,
      settlementAmount,
      rawAmount,
      settlementCurrency,
      localCurrency,
      isCrossCurrency,
    });

    const { externalEventId, transactionKey } = resolvePaymentEventIdentity("dodo", payload, rawBody);
    if (hasRecentTransaction(transactionKey) || (await hasRecordedTransaction(db, companyId, transactionKey))) {
      rememberRecentTransaction(transactionKey);
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "billing-webhook",
        agentId: null,
        runId: null,
        action: "billing.webhook.duplicate_ignored",
        entityType: "payment_transaction",
        entityId: transactionKey,
        details: {
          provider: "dodo",
          externalEventId,
          sessionId,
          amountCents,
          currency,
          goalId,
          issueId,
          metadata,
        },
      });
      res.status(202).json({
        accepted: true,
        duplicate: true,
        companyId,
        provider: "dodo",
        sessionId,
        amountCents,
        currency,
      });
      return;
    }

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "billing-webhook",
      agentId: null,
      runId: null,
      action: "billing.transaction.recorded",
      entityType: "payment_transaction",
      entityId: transactionKey,
      details: {
        provider: "dodo",
        externalEventId,
        sessionId,
        amountCents,
        currency,
        revenueSource,
        revenueUserId,
        goalId,
        issueId,
        metadata,
        signatureVerified: true,
      },
    });
    rememberRecentTransaction(transactionKey);

    console.log("[billing.webhook] Processing payment:", {
      companyId,
      amountCents,
      currency,
      sessionId,
      externalEventId,
      transactionKey,
    });

    const financeSnapshot = await creditCompanyFinanceForPayment(db, {
      companyId,
      amountCents,
    });

    console.log("[billing.webhook] Finance credited:", {
      revenueCents: financeSnapshot.revenueCents,
      creditsCents: financeSnapshot.creditsCents,
      spentCents: financeSnapshot.spentCents,
    });

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "billing-webhook",
      agentId: null,
      runId: null,
      action: "billing.finance.credited",
      entityType: "company",
      entityId: companyId,
      details: {
        provider: "dodo",
        externalEventId,
        sessionId,
        amountCents,
        revenueCents: financeSnapshot.revenueCents,
        creditsCents: financeSnapshot.creditsCents,
        spentCents: financeSnapshot.spentCents,
      },
    });

    const preMetricSnapshot = await getRecentSystemMetricsSnapshot(db, companyId, 180);

    await recordSystemMetric(db, {
      companyId,
      sourceType: "tool_action",
      sourceId: transactionKey,
      traffic: 1,
      conversions: 1,
      revenueCents: amountCents,
      metadata: {
        provider: "dodo",
        currency,
        eventId: externalEventId,
        sessionId,
        webhookType: "payment_success",
        source: revenueSource,
        userId: revenueUserId,
        goalId,
        issueId,
        checkoutMetadata: metadata,
        signatureVerified: true,
      },
    });

    console.log("[billing.webhook] System metric recorded");

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "billing-webhook",
      agentId: null,
      runId: null,
      action: "billing.payment.succeeded",
      entityType: "company",
      entityId: companyId,
      details: {
        provider: "dodo",
        externalEventId,
        sessionId,
        amountCents,
        currency,
        revenueSource,
        revenueUserId,
        goalId,
        issueId,
        metadata,
        signatureVerified: true,
      },
    });

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "billing-webhook",
      agentId: null,
      runId: null,
      action: "billing.revenue.attributed",
      entityType: "payment_transaction",
      entityId: transactionKey,
      details: {
        revenue: amountCents,
        userId: revenueUserId,
        source: revenueSource,
        sessionId,
        currency,
      },
    });

    const postMetricSnapshot = await getRecentSystemMetricsSnapshot(db, companyId, 180);
    const rpvDecision = classifyRpvDecision(preMetricSnapshot.revenue_per_visit, postMetricSnapshot.revenue_per_visit);

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "billing-webhook",
      agentId: null,
      runId: null,
      action: "billing.rpv.decision_hint",
      entityType: "company",
      entityId: companyId,
      details: {
        previousRpv: preMetricSnapshot.revenue_per_visit,
        currentRpv: postMetricSnapshot.revenue_per_visit,
        trend: rpvDecision.trend,
        decision: rpvDecision.decision,
        source: revenueSource,
      },
    });

    const emailForPosthog =
      readString(metadata.email) ??
      firstString(payload, [
        "data.customer.email",
        "data.object.customer_email",
        "data.object.customer.email",
        "data.email",
        "customer_email",
        "email",
      ]);
    const customerName = firstString(payload, [
      "data.customer.name",
      "data.object.customer.name",
      "data.name",
      "customer_name",
    ]);

    console.log("[billing.webhook] Firing PostHog payment_completed event:", {
      email: emailForPosthog,
      customerName,
      amountCents,
      provider: "dodo",
    });

    await capturePosthogEvent("payment_completed", {
      provider: "dodo",
      companyId,
      amountCents,
      currency,
      sessionId,
      source: revenueSource,
      email: emailForPosthog,
      customerName,
      entry_point: "dodo_webhook",
      $current_url: `${(process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ?? "http://localhost:3100").replace(/\/$/, "")}/api/payments/dodo/webhook`,
      screen: "payment_webhook",
    });

    await markColdEmailUserPaid(db, {
      companyId,
      metadata,
      payload,
      amountCents,
      currency,
      sessionId,
    });

    console.log("[billing.webhook] payment_completed PostHog event fired");

    try {
      await persistPaymentLearningRecord(db, {
        companyId,
        provider: "dodo",
        amountCents,
        currency,
        sessionId,
        source: readString(metadata.source) ?? "billing_webhook",
        goalId,
        issueId,
        metadata,
      });
    } catch (error) {
      console.warn("[billing.webhook] persistPaymentLearningRecord failed", {
        companyId,
        provider: "dodo",
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let decisionDispatch: { mode: "queued" | "async_fallback"; jobId?: string } = { mode: "async_fallback" };
    try {
      decisionDispatch = await dispatchDecisionCycle(db, {
        companyId,
        source: "manual",
        reason: "billing.payment.succeeded",
        dedupeKey: `${transactionKey}:decision`,
      });
    } catch (error) {
      console.warn("[billing.webhook] dispatchDecisionCycle failed", {
        companyId,
        provider: "dodo",
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "billing-webhook",
      agentId: null,
      runId: null,
      action: "billing.decision.dispatch",
      entityType: "payment_transaction",
      entityId: transactionKey,
      details: {
        provider: "dodo",
        externalEventId,
        sessionId,
        decisionDispatch,
      },
    });

    console.log("[billing.webhook] ====== WEBHOOK FULLY PROCESSED ======", {
      companyId,
      amountCents,
      currency,
      revenueCents: financeSnapshot.revenueCents,
      sessionId,
    });

    res.status(202).json({
      accepted: true,
      companyId,
      provider: "dodo",
      sessionId,
      amountCents,
      currency,
      signatureVerified: true,
      decisionDispatch,
      finance: {
        revenueCents: financeSnapshot.revenueCents,
        creditsCents: financeSnapshot.creditsCents,
        spentCents: financeSnapshot.spentCents,
      },
    });
  };

  router.post("/payments/dodo/webhook", handleDodoWebhook);
  router.post("/billing/webhook", handleDodoWebhook);

  const createCheckoutForCompany = async (
    req: Request,
    res: Response,
    companyId: string,
    body: JsonRecord,
  ) => {
    assertCompanyAccess(req, companyId);

    const provider = readString(body.provider) === "dodo" ? "dodo" : "stripe";
    const successUrl =
      readString(body.successUrl) ??
      readString(process.env.BILLING_SUCCESS_URL) ??
      "http://localhost:3100/ai-dashboard?checkout=success";
    const cancelUrl =
      readString(body.cancelUrl) ??
      readString(process.env.BILLING_CANCEL_URL) ??
      "http://localhost:3100/ai-dashboard?checkout=cancel";

    const goalId = readString(body.goalId) ?? readString(body.goal_id);
    const issueId = readString(body.issueId) ?? readString(body.issue_id);
    const lineItemsRaw = Array.isArray(body.lineItems) ? body.lineItems : [];
    if (lineItemsRaw.length === 0) {
      res.status(400).json({ error: "lineItems[] is required" });
      return;
    }

    const lineItems = lineItemsRaw.map((entry) => {
      const row = asRecord(entry);
      return {
        name: readString(row.name) ?? "Paperclip Service",
        amountCents: Math.max(1, Math.round(readNumber(row.amountCents) ?? 0)),
        quantity: Math.max(1, Math.round(readNumber(row.quantity) ?? 1)),
        currency: readString(row.currency) ?? readString(body.currency) ?? "usd",
      };
    });

    if (lineItems.some((item) => item.amountCents <= 0)) {
      res.status(400).json({ error: "Each line item must include a positive amountCents" });
      return;
    }

    let created: JsonRecord;
    if (provider === "dodo") {
      const payload = asRecord(body.payload);
      const payloadMetadata = asRecord(payload.metadata);
      const mergedMetadata = compactJsonRecord({
        ...payloadMetadata,
        companyId: readString(payloadMetadata.companyId) ?? companyId,
        goalId: readString(payloadMetadata.goalId) ?? goalId,
        issueId: readString(payloadMetadata.issueId) ?? issueId,
        source: readString(payloadMetadata.source) ?? "paperclip.billing.checkout",
      });
      const dodoPayload =
        Object.keys(payload).length > 0
          ? { ...payload, metadata: mergedMetadata }
          : {
              success_url: successUrl,
              cancel_url: cancelUrl,
              metadata: mergedMetadata,
              items: lineItems,
            };

      created = asRecord(
        await createDodoCheckoutSession(
          { integrationEnv: {} },
          {
            payload: dodoPayload,
            hostedCheckoutUrl: readString(body.hostedCheckoutUrl) ?? undefined,
            fallbackToHostedCheckoutUrl: true,
          },
        ),
      );
    } else {
      created = asRecord(
        await createStripeCheckoutSession(
          { integrationEnv: {} },
          {
            successUrl,
            cancelUrl,
            mode: readString(body.mode) ?? "payment",
            currency: readString(body.currency) ?? "usd",
            lineItems,
          },
        ),
      );
    }

    const actor = getActorInfo(req);
    const sessionId = extractSessionId(created) ?? randomUUID();
    const checkoutUrl = extractCheckoutUrl(created);

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "billing.checkout.created",
      entityType: "company",
      entityId: companyId,
      details: {
        provider,
        sessionId,
        checkoutUrl,
        lineItems,
        goalId,
        issueId,
      },
    });

    res.status(201).json({
      companyId,
      provider,
      sessionId,
      checkoutUrl,
      checkout_url: checkoutUrl,
      raw: created,
    });
  };

  router.post("/companies/:companyId/billing/checkout", async (req, res) => {
    const companyId = req.params.companyId;
    await createCheckoutForCompany(req, res, companyId, asRecord(req.body));
  });

  router.post("/billing/create-checkout", async (req, res) => {
    const body = asRecord(req.body);
    const companyId = readString(body.companyId);
    if (!companyId) {
      res.status(400).json({ error: "companyId is required" });
      return;
    }

    await createCheckoutForCompany(req, res, companyId, body);
  });

  router.post("/billing/webhooks/success", async (req, res) => {
    const payload = asRecord(req.body);
    const provider = detectWebhookProvider(req, payload);
    const rawBody = readRawBody(req);

    const stripeSecret = readString(process.env.STRIPE_WEBHOOK_SECRET);
    const dodoSecret =
      readString(process.env.DODO_WEBHOOK_SECRET) ??
      readString(process.env.DODO_PAYMENTS_WEBHOOK_SECRET) ??
      readString(process.env.DODO_PAYMENTS_SIGNING_SECRET);
    const providerSignatureRequired = readBoolean(process.env.BILLING_WEBHOOK_SIGNATURE_REQUIRED, false);

    let signatureVerified = false;

    if (provider === "stripe" && stripeSecret) {
      const headerValue = readString(req.header("stripe-signature"));
      if (!headerValue || !verifyStripeSignature(rawBody, headerValue, stripeSecret)) {
        res.status(401).json({ error: "Invalid Stripe webhook signature" });
        return;
      }
      signatureVerified = true;
    } else if (provider === "dodo" && dodoSecret) {
      const headerValue = readDodoSignatureHeader(req);
      const timestampHeader = readDodoTimestampHeader(req);
      const webhookIdHeader = readDodoWebhookIdHeader(req);
      if (!headerValue || !verifyDodoSignature(rawBody, headerValue, dodoSecret, timestampHeader, webhookIdHeader)) {
        res.status(401).json({ error: "Invalid Dodo webhook signature" });
        return;
      }
      signatureVerified = true;
    } else {
      const requiredSecret = readString(process.env.BILLING_WEBHOOK_SECRET);
      if (requiredSecret) {
        const incomingSecret = readString(req.header("x-paperclip-webhook-secret"));
        if (!incomingSecret || incomingSecret !== requiredSecret) {
          res.status(401).json({ error: "Invalid webhook secret" });
          return;
        }
      } else if (providerSignatureRequired) {
        res.status(401).json({ error: `Missing configured ${provider} webhook secret` });
        return;
      }
    }

    const metadata = readWebhookMetadata(payload);
    const companyId = await resolveWebhookCompanyId(db, payload, metadata);
    if (!companyId) {
      res.status(400).json({ error: "companyId is required" });
      return;
    }

    const goalId = readString(metadata.goalId);
    const issueId = readString(metadata.issueId);
    const providerFromPayload = firstString(payload, ["provider", "source", "data.object.provider"]);
    const normalizedProvider = providerFromPayload === "dodo" ? "dodo" : provider;
    const sessionId = firstString(payload, [
      "sessionId",
      "session_id",
      "payment_id",
      "data.payment_id",
      "data.checkout_session_id",
      "data.object.id",
      "id",
    ]);
    const amountCents = Math.max(
      0,
      Math.round(
        firstNumber(payload, [
          "amountCents",
          "amount_cents",
          "amount_total",
          "payment_amount_cents",
          "data.total_amount",
          "data.amount_total",
          "data.amount",
          "data.settlement_amount",
          "data.object.amount_total",
          "data.object.amount_subtotal",
        ]) ?? 0,
      ),
    );
    const currency = firstString(payload, ["currency", "data.object.currency"]) ?? "usd";
    const { externalEventId, transactionKey } = resolvePaymentEventIdentity(normalizedProvider, payload, rawBody);
    if (hasRecentTransaction(transactionKey) || (await hasRecordedTransaction(db, companyId, transactionKey))) {
      rememberRecentTransaction(transactionKey);
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "billing-webhook",
        agentId: null,
        runId: null,
        action: "billing.webhook.duplicate_ignored",
        entityType: "payment_transaction",
        entityId: transactionKey,
        details: {
          provider: normalizedProvider,
          externalEventId,
          sessionId,
          amountCents,
          currency,
          goalId,
          issueId,
          metadata,
          signatureVerified,
        },
      });
      res.status(202).json({
        accepted: true,
        duplicate: true,
        companyId,
        provider: normalizedProvider,
        sessionId,
        amountCents,
        currency,
      });
      return;
    }

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "billing-webhook",
      agentId: null,
      runId: null,
      action: "billing.transaction.recorded",
      entityType: "payment_transaction",
      entityId: transactionKey,
      details: {
        provider: normalizedProvider,
        externalEventId,
        sessionId,
        amountCents,
        currency,
        goalId,
        issueId,
        metadata,
        signatureVerified,
      },
    });
    rememberRecentTransaction(transactionKey);

    const financeSnapshot = await creditCompanyFinanceForPayment(db, {
      companyId,
      amountCents,
    });

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "billing-webhook",
      agentId: null,
      runId: null,
      action: "billing.finance.credited",
      entityType: "company",
      entityId: companyId,
      details: {
        provider: normalizedProvider,
        externalEventId,
        sessionId,
        amountCents,
        revenueCents: financeSnapshot.revenueCents,
        creditsCents: financeSnapshot.creditsCents,
        spentCents: financeSnapshot.spentCents,
        signatureVerified,
      },
    });

    await recordSystemMetric(db, {
      companyId,
      sourceType: "tool_action",
      sourceId: transactionKey,
      traffic: 1,
      conversions: 1,
      revenueCents: amountCents,
      metadata: {
        provider: normalizedProvider,
        currency,
        eventId: externalEventId,
        sessionId,
        webhookType: "payment_success",
        goalId,
        issueId,
        checkoutMetadata: metadata,
        signatureVerified,
      },
    });

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "billing-webhook",
      agentId: null,
      runId: null,
      action: "billing.payment.succeeded",
      entityType: "company",
      entityId: companyId,
      details: {
        provider: normalizedProvider,
        externalEventId,
        sessionId,
        amountCents,
        currency,
        goalId,
        issueId,
        metadata,
        signatureVerified,
      },
    });

    await capturePosthogEvent("payment_completed", {
      provider: normalizedProvider,
      companyId,
      amountCents,
      currency,
      sessionId,
      source: readString(metadata.source) ?? "billing_webhook",
      email: readString(metadata.email),
    });

    await markColdEmailUserPaid(db, {
      companyId,
      metadata,
      payload,
      amountCents,
      currency,
      sessionId,
    });

    try {
      await persistPaymentLearningRecord(db, {
        companyId,
        provider: normalizedProvider,
        amountCents,
        currency,
        sessionId,
        source: readString(metadata.source) ?? "billing_webhook",
        goalId,
        issueId,
        metadata,
      });
    } catch (error) {
      console.warn("[billing.webhook] persistPaymentLearningRecord failed", {
        companyId,
        provider: normalizedProvider,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let decisionDispatch: { mode: "queued" | "async_fallback"; jobId?: string } = { mode: "async_fallback" };
    try {
      decisionDispatch = await dispatchDecisionCycle(db, {
        companyId,
        source: "manual",
        reason: "billing.payment.succeeded",
        dedupeKey: `${transactionKey}:decision`,
      });
    } catch (error) {
      console.warn("[billing.webhook] dispatchDecisionCycle failed", {
        companyId,
        provider: normalizedProvider,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "billing-webhook",
      agentId: null,
      runId: null,
      action: "billing.decision.dispatch",
      entityType: "payment_transaction",
      entityId: transactionKey,
      details: {
        provider: normalizedProvider,
        externalEventId,
        sessionId,
        decisionDispatch,
      },
    });

    res.status(202).json({
      accepted: true,
      companyId,
      provider: normalizedProvider,
      sessionId,
      amountCents,
      currency,
      signatureVerified,
      decisionDispatch,
      finance: {
        revenueCents: financeSnapshot.revenueCents,
        creditsCents: financeSnapshot.creditsCents,
        spentCents: financeSnapshot.spentCents,
      },
    });
  });

  router.get("/companies/:companyId/billing/revenue", async (req, res) => {
    const companyId = req.params.companyId;
    assertCompanyAccess(req, companyId);

    const windowMinutes = Math.max(10, Math.round(readNumber(req.query.windowMinutes) ?? 30 * 24 * 60));
    const snapshot = await getRecentSystemMetricsSnapshot(db, companyId, windowMinutes);

    res.json({
      companyId,
      windowMinutes,
      revenueCents: snapshot.revenue,
      conversions: snapshot.conversions,
      traffic: snapshot.traffic,
      conversionRate: snapshot.conversion_rate,
      sampleCount: snapshot.sample_count,
    });
  });

  const getFinanceSnapshot = async (req: Request, res: Response) => {
    const companyId = readString(req.params.companyId);
    if (!companyId) {
      res.status(400).json({ error: "companyId is required" });
      return;
    }
    assertCompanyAccess(req, companyId);

    const finance = await getCompanyFinanceSnapshot(db, companyId);

    res.json({
      companyId,
      revenueCents: finance.revenueCents,
      creditsCents: finance.creditsCents,
      spentCents: finance.spentCents,
      updatedAt: finance.updatedAt,
    });
  };

  router.get("/companies/:companyId/billing/finance", getFinanceSnapshot);
  router.get("/companies/:companyId/finance", getFinanceSnapshot);

  return router;
}
