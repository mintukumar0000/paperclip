import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { activityLog, and, companies, desc, eq, sql, waitlistSignups } from "@paperclipai/db";
import { createDodoCheckoutSession } from "../ai/tools/externalTools.js";
import { resolvePublicBaseUrl as resolveSharedPublicBaseUrl } from "../public-base-url.js";
import { logger } from "../middleware/logger.js";

type JsonRecord = Record<string, unknown>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEMPLATE_PLACEHOLDER_RE = /\[[^\]\n]{1,80}\]|\{\{[^}\n]{1,80}\}\}|<[^>\n]{1,80}>/g;
const TEMPLATE_PLACEHOLDER_TEST_RE = /\[[^\]\n]{1,80}\]|\{\{[^}\n]{1,80}\}\}|<[^>\n]{1,80}>/;
const scheduledFollowUps = new Set<string>();

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

function getFreeLimit(): number {
  const raw = Number(process.env.COLD_EMAIL_FREE_LIMIT ?? "3");
  if (!Number.isFinite(raw)) return 3;
  return Math.max(1, Math.round(raw));
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

  const company = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)
    .then((rows) => rows[0] ?? null)
    .catch((error) => {
      logger.warn({ err: error }, "Failed to validate telemetry company id for cold email route");
      return null;
    });

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
): Promise<string | null> {
  const productId = (process.env.DODO_PRODUCT_ID ?? "").trim();
  const hosted = (process.env.DODO_PAYMENTS_CHECKOUT_URL ?? process.env.WAITLIST_OFFER_PAYMENT_LINK ?? "").trim();
  const hostedConfigured = hosted.length > 0;

  if (!productId && !hosted) {
    logger.warn("Cold-email checkout unavailable: DODO_PRODUCT_ID and DODO_PAYMENTS_CHECKOUT_URL are both missing");
    return null;
  }

  const metadata: JsonRecord = {
    source: "cold_email_tool",
    email,
    feature: "cold_email_unlimited",
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
  email: string;
  companyId: string | null;
  baseUrl: string;
  checkoutUrl: string | null;
}): Promise<void> {
  const checkoutTarget = args.checkoutUrl ?? `${args.baseUrl}/api/cold-email`;
  const steps: Array<{ step: "day1" | "day2"; subject: string; html: string }> = [
    {
      step: "day1",
      subject: "3 quick upgrades for better cold email replies",
      html: [
        "<p>3 quick ways to improve cold-email conversion today:</p>",
        "<p>1. Use one concrete outcome in line one.</p>",
        "<p>2. Ask for one tiny next step (not a full demo).</p>",
        "<p>3. Keep email under 120 words.</p>",
        `<p><a href=\"${renderTrackedClick(args.baseUrl, args.email, "cold_email_day1", args.companyId, checkoutTarget)}\">Generate another personalized email</a></p>`,
        `<img src=\"${renderTrackedPixel(args.baseUrl, args.email, "cold_email_day1", args.companyId)}\" alt=\"\" width=\"1\" height=\"1\"/>`,
      ].join(""),
    },
    {
      step: "day2",
      subject: "Unlock unlimited personalized cold emails",
      html: [
        "<p>You have limited free generations.</p>",
        "<p>Upgrade to unlimited and keep shipping outbound faster.</p>",
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
      void sendResendEmail({
        to: args.email,
        subject: step.subject,
        html: step.html,
      });
    }, getFollowUpDelayMs(step.step));
  }
}

function renderLandingPage(
  baseUrl: string,
  freeLimit: number,
  opts?: {
    initialEmail?: string | null;
    paymentState?: "success" | "cancel" | null;
  },
): string {
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
        <span id="usage-pill" class="urgency">Limited free usage: ${freeLimit} generations</span>
        <h1>Turn your offer into reply-ready cold emails that convert</h1>
        <p class="sub">Input your product, audience, and key benefit. Get a personalized outreach email instantly.</p>

        <label for="email">Work Email (required before full output)</label>
        <input id="email" type="email" placeholder="you@company.com" />

        <label for="product">Your Product</label>
        <input id="product" placeholder="AI SDR assistant for B2B SaaS" />

        <label for="audience">Target Audience</label>
        <input id="audience" placeholder="SaaS founders running outbound" />

        <label for="benefit">Key Benefit</label>
        <input id="benefit" placeholder="Get qualified replies faster" />

        <button id="generate" type="button" class="btn">Generate your first email free</button>
        <div class="hint">By generating, you agree to receive your result and 2 tactical follow-ups.</div>
        <div id="status" class="status"></div>
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

      if (!statusNode || !outputNode || !button || !emailNode) {
        return;
      }

      function showPaywallStatus(checkoutUrl) {
        statusNode.textContent = "Free limit reached. ";
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

      function showCheckoutError(message) {
        var msg = (message && String(message).trim()) || "Checkout is not configured yet.";
        statusNode.textContent = "Free limit reached. " + msg;
      }

      async function requestCheckoutUrl(emailValue) {
        var response = await fetch("/api/cold-email/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: emailValue }),
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
        body: JSON.stringify({ event: "landing_view" }),
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
}): Promise<{ checkoutUrl: string | null; companyId: string | null }> {
  const companyId = await resolveTelemetryCompanyIdForDb(args.db);
  const checkoutUrl = await resolveCheckoutUrl(args.email, companyId, args.baseUrl);
  return { checkoutUrl, companyId };
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
        details: {
          source: "public_landing",
          host: req.header("host") ?? null,
        },
      }).catch(() => undefined);
    }

    await capturePosthogEvent("cold_email_landing_viewed", {
      source: "public_landing",
      host: req.header("host") ?? null,
      distinctId: req.ip,
    });

    const initialEmail = normalizeEmail(req.query.email);
    const paymentStateRaw = normalizeOptionalString(req.query.payment);
    const paymentState = paymentStateRaw === "success" || paymentStateRaw === "cancel"
      ? paymentStateRaw
      : null;

    res
      .status(200)
      .set({ "Content-Type": "text/html; charset=utf-8" })
      .send(renderLandingPage(baseUrl, getFreeLimit(), { initialEmail, paymentState }));
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
    const paid = metadata.coldEmailPaid === true;
    const freeLimit = getFreeLimit();

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
    await capturePosthogEvent(`cold_email_${event}`, {
      source: "landing_client",
      distinctId: req.ip,
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

    const { checkoutUrl, companyId } = await createCheckoutForEmail({
      db,
      email,
      baseUrl,
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
        details: { email, checkoutUrl },
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

    const { checkoutUrl } = await createCheckoutForEmail({
      db,
      email,
      baseUrl,
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
      const source = "cold_email_tool";
      const now = new Date();

      await db
        .insert(waitlistSignups)
        .values({
          email,
          companyId,
          source,
          metadata: {
            coldEmailGenerationCount: 0,
            coldEmailPaid: false,
          },
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
      const freeLimit = getFreeLimit();
      const generationCount = Math.max(0, Number(metadata.coldEmailGenerationCount ?? 0));
      const paid = metadata.coldEmailPaid === true;

      if (!paid && generationCount >= freeLimit) {
        const checkoutUrl = await resolveCheckoutUrl(email, companyId, baseUrl);

        await capturePosthogEvent("cold_email_paywall_hit", {
          source,
          email,
          companyId,
          generationCount,
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
              checkoutUrl,
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
      const nextMetadata: JsonRecord = {
        ...metadata,
        source,
        coldEmailGenerationCount: updatedGenerationCount,
        coldEmailLastGeneratedAt: now.toISOString(),
        coldEmailPaid: paid,
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
        })
        .where(eq(waitlistSignups.id, signup.id));

      const checkoutUrl = await resolveCheckoutUrl(email, companyId, baseUrl);
      const upgradeTarget = checkoutUrl ?? `${baseUrl}/api/cold-email`;

      const sentResultEmail = await sendResendEmail({
        to: email,
        subject: "Your personalized cold email is ready",
        html: [
          "<p>Your personalized cold email:</p>",
          `<pre style=\"white-space:pre-wrap;border:1px solid #e5e7eb;padding:12px;border-radius:8px;\">${generated.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`,
          `<p><a href=\"${renderTrackedClick(baseUrl, email, "cold_email_result", companyId, upgradeTarget)}\">${paid ? "Generate another" : "Upgrade to unlimited"}</a></p>`,
          `<img src=\"${renderTrackedPixel(baseUrl, email, "cold_email_result", companyId)}\" alt=\"\" width=\"1\" height=\"1\"/>`,
        ].join(""),
      });

      await scheduleFollowUps({
        email,
        companyId,
        baseUrl,
        checkoutUrl,
      });

      await capturePosthogEvent("cold_email_generated", {
        source,
        email,
        companyId,
        generationCount: updatedGenerationCount,
        paid,
        resultEmailSent: sentResultEmail,
      });

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
          },
        }).catch(() => undefined);
      }

      res.json({
        success: true,
        emailCopy: generated,
        paid,
        generationCount: updatedGenerationCount,
        remainingFree: paid ? Number.MAX_SAFE_INTEGER : Math.max(0, freeLimit - updatedGenerationCount),
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
          sql`coalesce((${waitlistSignups.metadata} ->> 'coldEmailPaid')::boolean, false) = true`,
        ),
      );

    res.json({
      success: true,
      companyId,
      visitors: Number(activity?.visitors ?? 0),
      generated: Number(activity?.generated ?? 0),
      paywallHits: Number(activity?.paywallHits ?? 0),
      paidUsers: Number(paidUsers?.count ?? 0),
      freeLimit: getFreeLimit(),
    });
  });

  return router;
}