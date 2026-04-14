import type { Db } from "@paperclipai/db";
import { companies, waitlistSignups, activityLog } from "@paperclipai/db";
import { eq, sql, desc } from "@paperclipai/db";
import pino from "pino";
import { eventBus } from "../events/eventBus.js";
import { recordSystemMetric } from "../ai/feedback/metricsEngine.js";
import { recordContentPerformance } from "../memory/embeddingMemory.js";
import { getSkillsByCategory } from "../ai/skills/skillStore.js";
import { buildSkillPromptBlock } from "../ai/skills/applySkills.js";
import { validateOutput } from "../ai/quality/executionQualityGate.js";
import { getActiveCompanyId, listScopedCompanyIds } from "./companyScope.js";
import { resolvePublicBaseUrl, isPublicDeployment } from "../public-base-url.js";
import { resolveExistingRedditStorageStatePath, resolveRedditStorageStatePath } from "../reddit-storage-state.js";

const logger = pino({ name: "traffic-loop" });

function usesCompletionTokens(model: string): boolean {
  return /^gpt-5(?:$|[.-])/.test(model);
}

type Channel = "reddit" | "twitter";

const SUBREDDITS = [
  "SideProject",
  "startups",
  "EntrepreneurRideAlong",
  "indiehackers",
  "microsaas",
];

const POST_TEMPLATES = [
  {
    angle: "story",
    titleTemplate: "I built a system that runs a business autonomously — here's what I learned",
    bodyTemplate: `I've been working on an AI system that handles the full startup lifecycle: landing pages, email capture, monetization, and decision-making.

The most surprising thing? The decision engine generates its own improvement tasks based on real metrics — conversion rates, revenue per visitor, payment conversion.

Current results:
- {signups} email signups captured
- {revenue} revenue generated
- {conversion_rate}% conversion rate

The system automatically creates issues like "Rewrite landing headline" or "Run ICP repositioning test" when metrics drop below thresholds.

Would love feedback from other builders. What metrics do you track for autonomous systems?

{tracking_link}`,
  },
  {
    angle: "value",
    titleTemplate: "Free cold email templates that actually convert — built by an AI system",
    bodyTemplate: `My AI-powered startup system generates and tests outbound email templates automatically.

Here are the top-performing patterns so far:
- Urgency-based: "{name}, your $5 founder offer closes in 24h"
- ROI-focused: "{name}, turn $5 into faster outbound replies this week"
- Social proof: "{name}, founders are using this $5 pack to close more calls"

These are real templates from a live system with {signups} signups and {revenue} in revenue.

Grab the template pack here: {tracking_link}

Happy to share more about how the AI decides which subject line to use for each audience segment.`,
  },
  {
    angle: "technical",
    titleTemplate: "How I wired a decision engine that creates its own tasks from business metrics",
    bodyTemplate: `Built a system where the decision engine analyzes metrics every 30 seconds and creates actionable tasks.

Architecture:
1. Metrics layer: tracks traffic, conversions, revenue, payment conversion rate
2. Behavior feedback: threshold rules detect problems (conversion < 2%, traffic too low)
3. Decision mapping: feedback → concrete issues ("Improve landing page", "Scale distribution")
4. Execution: agents pick up issues and execute

Current stats:
- {signups} signups, {revenue} revenue
- Decision engine has generated {issue_count} autonomous improvement tasks
- Payment conversion rate: {payment_conv_rate}%

The next step is adding LLM into the decision loop so it can reason about WHY metrics are low, not just detect THAT they are.

Code is open source. AMA about the architecture.

{tracking_link}`,
  },
];

const TWITTER_TEMPLATES = [
  {
    angle: "thread_opener",
    template: `I built an AI system that autonomously runs a startup.

Here's what it does:
- Captures leads ({signups} so far)
- Sends monetization emails
- Processes payments ({revenue} revenue)
- Makes decisions based on metrics
- Creates its own improvement tasks

The decision engine runs every 30s and asks:
"Is conversion low? → Rewrite landing page"
"Traffic dropping? → Increase content output"

It's not just rule-based anymore — it uses LLM to analyze WHY.

{tracking_link}`,
  },
  {
    angle: "insight",
    template: `Most "AI businesses" are just wrappers.

My system actually:
- Generates its own Reddit posts
- Tests pricing variants ($5/$9/$19)
- Learns from payment data
- Creates tasks without human input

{signups} signups, {revenue} revenue. All autonomous.

{tracking_link}`,
  },
];

interface TrafficLoopContext {
  db: Db;
  baseUrl: string;
}

interface PostResult {
  posted: boolean;
  channel: Channel;
  method: string;
  error?: string;
  retries: number;
  upvotes?: number;
  comments?: number;
}

interface TrafficCycleSummary {
  results: PostResult[];
  successCount: number;
  failCount: number;
  error?: string;
}

// STEP 6: Self-healing retry state
const channelHealth = new Map<Channel, {
  consecutiveFailures: number;
  lastFailure: number;
  lastSuccess: number;
  backoffMs: number;
}>();

function getChannelHealth(channel: Channel) {
  if (!channelHealth.has(channel)) {
    channelHealth.set(channel, {
      consecutiveFailures: 0,
      lastFailure: 0,
      lastSuccess: 0,
      backoffMs: 0,
    });
  }
  return channelHealth.get(channel)!;
}

function isChannelHealthy(channel: Channel): boolean {
  const health = getChannelHealth(channel);
  if (health.consecutiveFailures === 0) return true;
  if (health.consecutiveFailures >= 5) {
    const timeSinceFailure = Date.now() - health.lastFailure;
    return timeSinceFailure > health.backoffMs;
  }
  return true;
}

function recordChannelSuccess(channel: Channel): void {
  const health = getChannelHealth(channel);
  health.consecutiveFailures = 0;
  health.lastSuccess = Date.now();
  health.backoffMs = 0;
}

function recordChannelFailure(channel: Channel): void {
  const health = getChannelHealth(channel);
  health.consecutiveFailures++;
  health.lastFailure = Date.now();
  health.backoffMs = Math.min(
    6 * 60 * 60_000,
    (health.backoffMs || 5 * 60_000) * 2,
  );
}

async function getSystemStats(db: Db): Promise<{
  signups: number;
  revenue: string;
  conversionRate: string;
  paymentConvRate: string;
  issueCount: number;
}> {
  const [signupRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(waitlistSignups);

  const [companyId] = await listScopedCompanyIds(db, { limit: 1 });

  let issueCount = 0;
  let revenueCents = 0;
  if (companyId) {
    const { issues: issuesTable, companyFinance } = await import("@paperclipai/db");
    const [issueRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(issuesTable)
      .where(eq(issuesTable.companyId, companyId));
    issueCount = Number(issueRow?.count ?? 0);

    try {
      const [finRow] = await db
        .select({ rev: companyFinance.revenueCents })
        .from(companyFinance)
        .where(eq(companyFinance.companyId, companyId))
        .limit(1);
      revenueCents = Number(finRow?.rev ?? 0);
    } catch { /* table may not exist */ }
  }

  const totalSignups = Number(signupRow?.count ?? 0);
  const convRate = totalSignups > 0 ? ((1 / totalSignups) * 100).toFixed(1) : "0";

  return {
    signups: totalSignups,
    revenue: `$${(revenueCents / 100).toFixed(2)}`,
    conversionRate: convRate,
    paymentConvRate: totalSignups > 0 ? ((1 / totalSignups) * 100).toFixed(2) : "0",
    issueCount,
  };
}

function getTelemetryCompanyId(): string | null {
  const scopedCompanyId = getActiveCompanyId();
  if (scopedCompanyId) return scopedCompanyId;

  const billingCompanyId = (process.env.BILLING_WEBHOOK_COMPANY_ID ?? "").trim();
  return billingCompanyId || null;
}

function getLLMHeaders(): Record<string, string> {
  const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  const siteUrl = (process.env.OPENROUTER_SITE_URL ?? "").trim();
  const appName = (process.env.OPENROUTER_APP_NAME ?? "").trim();
  if (siteUrl) headers["HTTP-Referer"] = siteUrl;
  if (appName) headers["X-Title"] = appName;
  return headers;
}

async function generateLLMTitle(context: string, channel: Channel, subreddit?: string, db?: Db): Promise<string | null> {
  const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) return null;

  const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim();
  const model = (process.env.OPENAI_MODEL ?? "gpt-4o-mini").trim();

  let skillBlock = "";
  if (db) {
    try {
      const companyId = getTelemetryCompanyId();
      if (companyId) {
        const skills = await getSkillsByCategory(db as Db, companyId, "traffic", 0.3, 5);
        skillBlock = buildSkillPromptBlock(skills);
      }
    } catch { /* skills unavailable */ }
  }

  const channelPrompt = channel === "twitter"
    ? `You write engaging tweet threads. Short, punchy, no hashtags spam. Return ONLY the tweet text.${skillBlock}`
    : `You write Reddit post titles for r/${subreddit ?? "SideProject"}. Short, authentic, no clickbait. Return ONLY the title text, nothing else.${skillBlock}`;

  try {
    const requestBody: Record<string, unknown> = {
      model,
      temperature: 0.8,
      messages: [
        { role: "system", content: channelPrompt },
        { role: "user", content: `Write a ${channel} ${channel === "reddit" ? "title" : "opening"} for:\n\n${context.slice(0, 500)}` },
      ],
    };
    if (usesCompletionTokens(model)) {
      requestBody.max_completion_tokens = 120;
    } else {
      requestBody.max_tokens = 120;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify(requestBody),
    });

    if (response.ok) {
      const data = (await response.json()) as Record<string, unknown>;
      const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
      const generated = choices?.[0]?.message?.content?.trim();
      if (generated && generated.length > 10 && generated.length < 300) {
        const cleaned = generated.replace(/^["']|["']$/g, "");
        const contentType = channel === "twitter" ? "tweet" as const : "reddit_post" as const;
        const { valid, reasons } = validateOutput(cleaned, contentType);
        if (!valid) {
          logger.debug({ channel, reasons }, "Quality gate rejected LLM title");
          return null;
        }
        return cleaned;
      }
    }
  } catch (err) {
    logger.warn({ err, channel }, "LLM content generation failed");
  }

  return null;
}

async function generatePostContent(
  db: Db,
  subreddit: string,
  baseUrl: string,
): Promise<{ title: string; body: string; subreddit: string }> {
  const stats = await getSystemStats(db);
  const template = POST_TEMPLATES[Math.floor(Math.random() * POST_TEMPLATES.length)]!;
  const trackingLink = `${baseUrl.replace(/\/$/, "")}/api/cold-email?utm_source=reddit&utm_campaign=auto_loop`;

  const body = template.bodyTemplate
    .replace(/\{signups\}/g, String(stats.signups))
    .replace(/\{revenue\}/g, stats.revenue)
    .replace(/\{conversion_rate\}/g, stats.conversionRate)
    .replace(/\{payment_conv_rate\}/g, stats.paymentConvRate)
    .replace(/\{issue_count\}/g, String(stats.issueCount))
    .replace(/\{tracking_link\}/g, trackingLink)
    .replace(/\{name\}/g, "Founder");

  const llmTitle = await generateLLMTitle(body, "reddit", subreddit, db);

  return { title: llmTitle ?? template.titleTemplate, body, subreddit };
}

async function generateTweetContent(
  db: Db,
  baseUrl: string,
): Promise<{ text: string }> {
  const stats = await getSystemStats(db);
  const template = TWITTER_TEMPLATES[Math.floor(Math.random() * TWITTER_TEMPLATES.length)]!;
  const trackingLink = `${baseUrl.replace(/\/$/, "")}/api/cold-email?utm_source=twitter&utm_campaign=auto_loop`;

  let text = template.template
    .replace(/\{signups\}/g, String(stats.signups))
    .replace(/\{revenue\}/g, stats.revenue)
    .replace(/\{tracking_link\}/g, trackingLink);

  const llmText = await generateLLMTitle(text, "twitter", undefined, db);
  if (llmText && llmText.length > 30) {
    text = llmText + (llmText.includes(trackingLink) ? "" : `\n\n${trackingLink}`);
  }

  return { text };
}

// STEP 6: Self-healing retry wrapper
async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries: number; delayMs: number; channel: Channel },
): Promise<T & { retries: number }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const result = await fn();
      return { ...result, retries: attempt };
    } catch (err) {
      lastError = err;
      if (attempt < opts.maxRetries) {
        const delay = opts.delayMs * Math.pow(2, attempt);
        logger.warn({ attempt, channel: opts.channel, delay }, "Retrying after failure");
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

async function postToReddit(
  ctx: TrafficLoopContext,
  content: { title: string; body: string; subreddit: string },
): Promise<PostResult> {
  const username = (process.env.REDDIT_USERNAME ?? "").trim();
  const existingStoragePath = resolveExistingRedditStorageStatePath();
  const storagePath = existingStoragePath ?? resolveRedditStorageStatePath();

  if (!username) {
    return { posted: false, channel: "reddit", method: "none", error: "REDDIT_USERNAME not set", retries: 0 };
  }

  if (!existingStoragePath) {
    return {
      posted: false,
      channel: "reddit",
      method: "none",
      error: `Reddit storage state missing at ${storagePath}. Bootstrap session first: pnpm reddit:bootstrap-session`,
      retries: 0,
    };
  }

  if (!isChannelHealthy("reddit")) {
    const health = getChannelHealth("reddit");
    return { posted: false, channel: "reddit", method: "backoff", error: `Channel unhealthy (${health.consecutiveFailures} failures, backoff ${Math.round(health.backoffMs / 60_000)}min)`, retries: 0 };
  }

  try {
    const result = await withRetry(async () => {
      const { postToRedditPlaywright } = await import("../ai/tools/externalTools.js");
      const r = (await postToRedditPlaywright({ integrationEnv: {} }, {
        subreddit: content.subreddit,
        fallbackSubreddits: SUBREDDITS.filter((entry) => entry.toLowerCase() !== content.subreddit.toLowerCase()),
        title: content.title,
        text: content.body,
        kind: "self",
        username,
        storageStatePath: storagePath || undefined,
        headless: false,
        requireStorageState: true,
        allowPasswordLogin: false,
      })) as Record<string, unknown>;
      logger.info(
        {
          storageUsed: Boolean(storagePath),
          currentUrl: typeof r.currentUrl === "string" ? r.currentUrl : null,
          authMode: typeof r.authMode === "string" ? r.authMode : null,
          attempt: typeof r.attempt === "number" ? r.attempt : null,
          subreddit: content.subreddit,
          upvotes: typeof r.upvotes === "number" ? r.upvotes : null,
          comments: typeof r.comments === "number" ? r.comments : null,
          verificationSuccess: r.verificationSuccess === true,
        },
        "REDDIT DEBUG",
      );
      return {
        posted: r.posted === true,
        postUrl: r.postUrl,
        upvotes: typeof r.upvotes === "number" && Number.isFinite(r.upvotes) ? Math.max(0, r.upvotes) : 0,
        comments: typeof r.comments === "number" && Number.isFinite(r.comments) ? Math.max(0, r.comments) : 0,
      };
    }, { maxRetries: 2, delayMs: 5_000, channel: "reddit" });

    if (result.posted) {
      recordChannelSuccess("reddit");
      const companyId = getTelemetryCompanyId();
      if (companyId) {
        await recordSystemMetric(ctx.db, {
          companyId,
          sourceType: "tool_action",
          sourceId: `reddit_post_${content.subreddit}_${Date.now()}`,
          traffic: 1,
          conversions: 0,
          revenueCents: 0,
          metadata: {
            channel: "reddit",
            subreddit: content.subreddit,
            title: content.title,
            postUrl: result.postUrl ?? null,
            upvotes: result.upvotes ?? 0,
            comments: result.comments ?? 0,
          },
        });
        await ctx.db.insert(activityLog).values({
          companyId,
          actorType: "system",
          actorId: "traffic-loop",
          agentId: null,
          runId: null,
          action: "distribution.reddit.posted",
          entityType: "company",
          entityId: companyId,
          details: {
            subreddit: content.subreddit,
            title: content.title,
            postUrl: result.postUrl ?? null,
            method: "playwright",
            retries: result.retries,
            upvotes: result.upvotes ?? 0,
            comments: result.comments ?? 0,
          },
        });
        await recordContentPerformance(ctx.db, companyId, "reddit", content.title, true, {
          subreddit: content.subreddit,
          upvotes: result.upvotes ?? 0,
          comments: result.comments ?? 0,
        });
      }
    } else {
      recordChannelFailure("reddit");
    }

    return {
      posted: result.posted,
      channel: "reddit",
      method: "playwright",
      retries: result.retries,
      upvotes: result.upvotes,
      comments: result.comments,
    };
  } catch (err) {
    recordChannelFailure("reddit");
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, subreddit: content.subreddit }, "Reddit post failed after retries");

    const companyId = getTelemetryCompanyId();
    if (companyId) {
      await recordContentPerformance(ctx.db, companyId, "reddit", content.title, false, { error: message });
    }

    return { posted: false, channel: "reddit", method: "playwright", error: message, retries: 2 };
  }
}

// STEP 5: Twitter/X channel
async function postToTwitter(
  ctx: TrafficLoopContext,
  content: { text: string },
): Promise<PostResult> {
  const username = (process.env.X_USERNAME ?? "").trim();
  const password = (process.env.X_PASSWORD ?? "").trim();

  if (!username || !password) {
    return { posted: false, channel: "twitter", method: "none", error: "X_USERNAME or X_PASSWORD not set", retries: 0 };
  }

  if (!isChannelHealthy("twitter")) {
    const health = getChannelHealth("twitter");
    return { posted: false, channel: "twitter", method: "backoff", error: `Channel unhealthy (${health.consecutiveFailures} failures, backoff ${Math.round(health.backoffMs / 60_000)}min)`, retries: 0 };
  }

  try {
    const result = await withRetry(async () => {
      const { postToTwitterPlaywright } = await import("../ai/tools/externalTools.js");
      const r = (await postToTwitterPlaywright({ integrationEnv: {} }, {
        text: content.text,
        username,
        password,
        headless: true,
      })) as Record<string, unknown>;
      return { posted: r.posted === true, tweetUrl: r.tweetUrl };
    }, { maxRetries: 2, delayMs: 5_000, channel: "twitter" });

    if (result.posted) {
      recordChannelSuccess("twitter");
      const companyId = getTelemetryCompanyId();
      if (companyId) {
        await recordSystemMetric(ctx.db, {
          companyId,
          sourceType: "tool_action",
          sourceId: `twitter_post_${Date.now()}`,
          traffic: 1,
          conversions: 0,
          revenueCents: 0,
          metadata: { channel: "twitter", text: content.text.slice(0, 100), tweetUrl: result.tweetUrl ?? null },
        });
        await ctx.db.insert(activityLog).values({
          companyId,
          actorType: "system",
          actorId: "traffic-loop",
          agentId: null,
          runId: null,
          action: "distribution.twitter.posted",
          entityType: "company",
          entityId: companyId,
          details: { text: content.text.slice(0, 200), tweetUrl: result.tweetUrl ?? null, method: "playwright", retries: result.retries },
        });
        await recordContentPerformance(ctx.db, companyId, "twitter", content.text.slice(0, 80), true, {});
      }
    } else {
      recordChannelFailure("twitter");
    }

    return { posted: result.posted, channel: "twitter", method: "playwright", retries: result.retries };
  } catch (err) {
    recordChannelFailure("twitter");
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Twitter post failed after retries");

    const companyId = getTelemetryCompanyId();
    if (companyId) {
      await recordContentPerformance(ctx.db, companyId, "twitter", content.text.slice(0, 80), false, { error: message });
    }

    return { posted: false, channel: "twitter", method: "playwright", error: message, retries: 2 };
  }
}

function getEnabledChannels(): Channel[] {
  const channels: Channel[] = ["reddit"];
  const twitterEnabled = (process.env.TRAFFIC_LOOP_TWITTER_ENABLED ?? "true").trim().toLowerCase();
  if (twitterEnabled !== "false" && twitterEnabled !== "0") {
    channels.push("twitter");
  }
  return channels;
}

let trafficLoopRunning = false;
let trafficLoopInterval: ReturnType<typeof setInterval> | null = null;
let postIndex = 0;

async function runTrafficCycle(ctx: TrafficLoopContext): Promise<TrafficCycleSummary> {
  if (trafficLoopRunning) {
    logger.warn("Traffic loop cycle already in progress, skipping");
    return { results: [], successCount: 0, failCount: 0, error: "already_running" };
  }

  trafficLoopRunning = true;
  const results: PostResult[] = [];

  try {
    const channels = getEnabledChannels();

    // Reddit post
    if (channels.includes("reddit")) {
      const subreddit = SUBREDDITS[postIndex % SUBREDDITS.length]!;
      logger.info({ subreddit, postIndex }, "Traffic loop: generating Reddit content");
      const content = await generatePostContent(ctx.db, subreddit, ctx.baseUrl);
      logger.info({ subreddit, title: content.title.slice(0, 60) }, "Traffic loop: posting to Reddit");
      results.push(await postToReddit(ctx, content));
    }

    // Twitter post (staggered 2 min after Reddit to avoid rate limits)
    if (channels.includes("twitter")) {
      await new Promise((resolve) => setTimeout(resolve, 2 * 60_000));
      logger.info({}, "Traffic loop: generating Twitter content");
      const tweet = await generateTweetContent(ctx.db, ctx.baseUrl);
      logger.info({ textPreview: tweet.text.slice(0, 60) }, "Traffic loop: posting to Twitter");
      results.push(await postToTwitter(ctx, tweet));
    }

    postIndex++;

    const successCount = results.filter((r) => r.posted).length;
    const failCount = results.filter((r) => !r.posted && r.method !== "none" && r.method !== "backoff").length;

    logger.info({
      successCount,
      failCount,
      channels: results.map((r) => `${r.channel}:${r.posted ? "ok" : r.error?.slice(0, 30) ?? "fail"}`),
    }, "Traffic loop cycle completed");

    eventBus.publish("traffic.loop.cycle.completed", {
      results: results.map((r) => ({ channel: r.channel, posted: r.posted, retries: r.retries, error: r.error ?? null })),
      timestamp: new Date().toISOString(),
    });

    return {
      results,
      successCount,
      failCount,
    };
  } catch (err) {
    logger.error({ err }, "Traffic loop cycle failed");
    const message = err instanceof Error ? err.message : String(err);
    return {
      results,
      successCount: results.filter((r) => r.posted).length,
      failCount: results.filter((r) => !r.posted && r.method !== "none" && r.method !== "backoff").length,
      error: message,
    };
  } finally {
    trafficLoopRunning = false;
  }
}

export function startTrafficLoop(db: Db, intervalMs = 3 * 60 * 60_000): () => void {
  const enabled = (process.env.TRAFFIC_LOOP_ENABLED ?? "true").trim().toLowerCase();
  if (enabled === "false" || enabled === "0" || enabled === "no") {
    logger.info("Traffic loop disabled via TRAFFIC_LOOP_ENABLED=false");
    return () => {};
  }

  const baseUrl = resolvePublicBaseUrl();
  if (!baseUrl) {
    if (isPublicDeployment()) {
      logger.error(
        "Traffic loop disabled: no public base URL configured. Set PUBLIC_API_BASE (or WAITLIST_PUBLIC_BASE_URL/PAPERCLIP_AUTH_PUBLIC_BASE_URL).",
      );
      return () => {};
    }
  }

  const ctx: TrafficLoopContext = { db, baseUrl: baseUrl ?? "http://localhost:3100" };

  const customInterval = Number(process.env.TRAFFIC_LOOP_INTERVAL_MS);
  const effectiveInterval = Number.isFinite(customInterval) && customInterval > 0
    ? customInterval
    : intervalMs;

  const channels = getEnabledChannels();
  logger.info(
    { intervalMs: effectiveInterval, channels, subreddits: SUBREDDITS },
    "Starting multi-channel traffic loop",
  );

  setTimeout(() => void runTrafficCycle(ctx), 30_000);

  trafficLoopInterval = setInterval(() => {
    void runTrafficCycle(ctx);
  }, effectiveInterval);

  return () => {
    if (trafficLoopInterval) {
      clearInterval(trafficLoopInterval);
      trafficLoopInterval = null;
    }
    logger.info("Traffic loop stopped");
  };
}

export { runTrafficCycle as _runTrafficCycleForTest };
