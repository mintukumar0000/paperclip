import type { Db } from "@paperclipai/db";
import { companies, waitlistSignups, activityLog, aiLearningRecords } from "@paperclipai/db";
import { and, eq, sql, desc } from "@paperclipai/db";
import pino from "pino";
import { eventBus } from "../events/eventBus.js";
import { getRecentSystemMetricsSnapshot, recordSystemMetric } from "../ai/feedback/metricsEngine.js";
import { recordContentPerformance } from "../memory/embeddingMemory.js";
import { getSkillsByCategory } from "../ai/skills/skillStore.js";
import { buildSkillPromptBlock } from "../ai/skills/applySkills.js";
import { validateOutput } from "../ai/quality/executionQualityGate.js";
import { getActiveCompanyId, listScopedCompanyIds } from "./companyScope.js";
import { resolvePublicBaseUrl, isPublicDeployment } from "../public-base-url.js";
import { resolveExistingRedditStorageStatePath, resolveRedditStorageStatePath } from "../reddit-storage-state.js";
import {
  createSystemDecision,
  getSystemControls,
  hasOpenDecisionForActionKey,
  shouldRequireApprovalForAction,
} from "../services/system-controls.js";
import { setCycleState } from "../services/cycle-state.js";
import { logActivity } from "../services/activity-log.js";

const logger = pino({ name: "traffic-loop" });

function usesCompletionTokens(model: string): boolean {
  return /^gpt-5(?:$|[.-])/.test(model);
}

type Channel = "reddit" | "twitter" | "indie_hackers" | "hacker_news";
type RedditFormat = "story" | "tool" | "question";

const DEFAULT_SUBREDDITS = [
  "startups",
  "SideProject",
  "Entrepreneur",
  "EntrepreneurRideAlong",
  "indiehackers",
  "microsaas",
];

const SUBREDDIT_DESCRIPTIONS: Record<string, string> = {
  startups: "Founders sharing startup execution lessons, traction updates, and operational insights.",
  sideproject: "Builders showcasing projects, asking for practical product feedback, and sharing build logs.",
  entrepreneur: "General entrepreneurship audience with stricter anti-promo moderation.",
  entrepreneurridealong: "Operator-focused discussions about execution, systems, and learning publicly.",
  indiehackers: "Bootstrapped SaaS and maker content focused on transparent metrics and product learnings.",
  microsaas: "Niche SaaS builder community; product updates are accepted when educational and non-spammy.",
};

function getConfiguredSubreddits(fromControls?: string[] | null): string[] {
  const controlEntries = Array.isArray(fromControls)
    ? fromControls.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : [];
  if (controlEntries.length > 0) {
    return controlEntries;
  }

  return [...DEFAULT_SUBREDDITS];
}

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
- Urgency-based: "{name}, your $9 founder offer closes in 24h"
- ROI-focused: "{name}, turn $9 into faster outbound replies this week"
- Social proof: "{name}, founders are using this $9 pack to close more calls"

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
- Tests pricing variants ($9/$19/$29)
- Learns from payment data
- Creates tasks without human input

{signups} signups, {revenue} revenue. All autonomous.

{tracking_link}`,
  },
];

const INDIE_HACKERS_TEMPLATES = [
  {
    title: "Built an autonomous growth loop for a tiny SaaS - metrics and mistakes",
    body: `Sharing a transparent build update on an autonomous growth loop I've been shipping.

What it currently does:
- Generates and posts distribution content
- Tracks attribution into payment events
- Re-prioritizes actions around revenue-per-visit (RPV)

Current numbers:
- {signups} signups
- {revenue} revenue
- {conversion_rate}% signup conversion

Biggest lesson: attribution wiring mattered more than generation quality in the first phase.

If you're building in public too, what broke first for you: channel quality, conversion, or pricing?

{tracking_link}`,
  },
];

const HACKER_NEWS_TEMPLATES = [
  {
    title: "Show HN: autonomous startup control loop with RPV-first decisions",
    text: `I built a control loop that ships distribution + monetization steps, then routes decisions by revenue-per-visit.

Current snapshot: {signups} signups, {revenue} revenue, {conversion_rate}% conversion.

What worked:
- strict attribution from post -> signup -> payment
- deterministic verification after each cycle
- preserving human override boundaries

Would love feedback on where you'd harden this architecture next.

{tracking_link}`,
  },
];

interface TrafficLoopContext {
  db: Db;
  baseUrl: string;
  decisionId?: string | null;
  traceId?: string | null;
}

interface PostResult {
  posted: boolean;
  channel: Channel;
  method: string;
  postUrl?: string | null;
  error?: string;
  retries: number;
  upvotes?: number;
  comments?: number;
}

interface RedditVariantCandidate {
  format: RedditFormat;
  title: string;
  body: string;
  hook: string;
  score: number;
  scoreReason: string;
}

interface RedditPostContent {
  title: string;
  body: string;
  subreddit: string;
  format: RedditFormat;
  hook: string;
  selectionReason: string;
  variantScores: Array<{ format: RedditFormat; score: number; reason: string }>;
}

interface TrafficCycleSummary {
  results: PostResult[];
  successCount: number;
  failCount: number;
  status: "success" | "failed" | "blocked";
  blockReason?: string;
  error?: string;
}

interface ExpansionPostContent {
  title: string;
  body: string;
  trackingLink: string;
}

interface TrafficLearningBias {
  channelScores: Record<Channel, number>;
  preferredSubreddits: string[];
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

interface TrafficRuntimeControls {
  trafficEnabled: boolean;
  redditEnabled: boolean;
  twitterEnabled: boolean;
  indieHackersEnabled: boolean;
  hackerNewsEnabled: boolean;
  maxMultiplier: number;
  postFrequency: number;
  subredditTargets: string[];
  trafficChannels: Channel[];
  trafficMultiplier: number;
  trafficPostIntervalMs: number;
  trafficMaxPostsPerCycle: number;
  trafficSubredditWhitelist: string[];
  trafficMode: "conservative" | "balanced" | "aggressive";
  decisionMode: "approval_required" | "approval_for_high_impact" | "auto_execute";
}

interface TrafficCycleRunOptions {
  bypassDecisionGate?: boolean;
  decisionId?: string;
  traceId?: string;
  channelsOverride?: Array<"reddit" | "twitter" | "indie_hackers" | "hacker_news">;
}

function sortChannelsByBias(channels: Channel[], bias: Record<Channel, number>): Channel[] {
  return [...channels].sort((left, right) => {
    if (left === "reddit") return -1;
    if (right === "reddit") return 1;
    return (bias[right] ?? 0) - (bias[left] ?? 0);
  });
}

function applySubredditBias(subreddits: string[], preferred: string[]): string[] {
  if (preferred.length === 0) return subreddits;

  const preferredLower = preferred.map((entry) => entry.toLowerCase());
  const preferredSet = new Set(preferredLower);
  const pinned: string[] = [];
  const rest: string[] = [];

  for (const subreddit of subreddits) {
    if (preferredSet.has(subreddit.toLowerCase())) {
      pinned.push(subreddit);
    } else {
      rest.push(subreddit);
    }
  }

  pinned.sort((a, b) => preferredLower.indexOf(a.toLowerCase()) - preferredLower.indexOf(b.toLowerCase()));
  return [...pinned, ...rest];
}

async function getTrafficLearningBias(db: Db, companyId: string | null): Promise<TrafficLearningBias> {
  const defaultBias: TrafficLearningBias = {
    channelScores: {
      reddit: 1,
      twitter: 1,
      indie_hackers: 1,
      hacker_news: 1,
    },
    preferredSubreddits: [],
  };
  if (!companyId) return defaultBias;

  const rows = await db
    .select({ action: activityLog.action, details: activityLog.details })
    .from(activityLog)
    .where(eq(activityLog.companyId, companyId))
    .orderBy(desc(activityLog.createdAt))
    .limit(240)
    .catch(() => []);

  const channelTotals: Record<Channel, { score: number; count: number }> = {
    reddit: { score: 0, count: 0 },
    twitter: { score: 0, count: 0 },
    indie_hackers: { score: 0, count: 0 },
    hacker_news: { score: 0, count: 0 },
  };
  const subredditTotals = new Map<string, { score: number; count: number }>();

  for (const row of rows) {
    const action = row.action ?? "";
    const details = (row.details ?? {}) as Record<string, unknown>;

    let channel: Channel | null = null;
    if (action.startsWith("distribution.reddit.")) channel = "reddit";
    else if (action.startsWith("distribution.twitter.")) channel = "twitter";
    else if (action.startsWith("distribution.indie_hackers.")) channel = "indie_hackers";
    else if (action.startsWith("distribution.hacker_news.")) channel = "hacker_news";

    if (!channel) continue;

    const posted = action.endsWith(".posted");
    const base = posted ? 1 : -0.75;
    const upvotes = Number(details.upvotes ?? 0);
    const comments = Number(details.comments ?? 0);
    const conversions = Number(details.conversion ?? details.conversions ?? 0);
    const engagementBoost = (Number.isFinite(upvotes) ? upvotes : 0) * 0.05
      + (Number.isFinite(comments) ? comments : 0) * 0.1
      + (Number.isFinite(conversions) ? conversions : 0) * 0.8;
    const score = base + Math.max(0, engagementBoost);

    channelTotals[channel].score += score;
    channelTotals[channel].count += 1;

    if (channel === "reddit") {
      const subreddit = typeof details.subreddit === "string" ? details.subreddit.trim() : "";
      if (subreddit) {
        const current = subredditTotals.get(subreddit) ?? { score: 0, count: 0 };
        current.score += score;
        current.count += 1;
        subredditTotals.set(subreddit, current);
      }
    }
  }

  const channelScores: Record<Channel, number> = {
    reddit: channelTotals.reddit.count > 0 ? channelTotals.reddit.score / channelTotals.reddit.count : 1,
    twitter: channelTotals.twitter.count > 0 ? channelTotals.twitter.score / channelTotals.twitter.count : 1,
    indie_hackers: channelTotals.indie_hackers.count > 0 ? channelTotals.indie_hackers.score / channelTotals.indie_hackers.count : 1,
    hacker_news: channelTotals.hacker_news.count > 0 ? channelTotals.hacker_news.score / channelTotals.hacker_news.count : 1,
  };

  const preferredSubreddits = [...subredditTotals.entries()]
    .sort((left, right) => {
      const leftScore = left[1].score / Math.max(1, left[1].count);
      const rightScore = right[1].score / Math.max(1, right[1].count);
      return rightScore - leftScore;
    })
    .slice(0, 3)
    .map(([subreddit]) => subreddit);

  return { channelScores, preferredSubreddits };
}

async function getRpvTrafficMultiplier(
  db: Db,
  companyId: string | null,
  controls?: TrafficRuntimeControls | null,
): Promise<number> {
  const configuredMultiplier = controls
    ? Math.max(1, Math.min(20, Math.floor(controls.trafficMultiplier || controls.maxMultiplier || 1)))
    : 1;
  if (!companyId) return 1;

  const snapshot = await getRecentSystemMetricsSnapshot(db, companyId, 240).catch(() => null);
  const rpv = snapshot ? Math.max(0, snapshot.revenue_per_visit) : 0;

  const mode = controls?.trafficMode ?? "balanced";
  let adaptiveMultiplier = 1;
  if (rpv >= 50) adaptiveMultiplier = mode === "aggressive" ? 3 : 2;
  else if (rpv >= 20) adaptiveMultiplier = mode === "conservative" ? 1 : 2;

  if (mode === "aggressive" && adaptiveMultiplier < configuredMultiplier) {
    adaptiveMultiplier = Math.min(configuredMultiplier, adaptiveMultiplier + 1);
  }

  return Math.min(configuredMultiplier, Math.max(1, adaptiveMultiplier));
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

async function chooseSubredditWithLLM(
  subreddits: string[],
  stats: {
    signups: number;
    revenue: string;
    conversionRate: string;
    paymentConvRate: string;
    issueCount: number;
  },
): Promise<string | null> {
  const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey || subreddits.length <= 1) return null;

  const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim();
  const model = (process.env.OPENAI_MODEL ?? "gpt-4o-mini").trim();
  const subredditProfiles = subreddits
    .map((name) => `- ${name}: ${SUBREDDIT_DESCRIPTIONS[name.toLowerCase()] ?? "General startup/building audience."}`)
    .join("\n");

  try {
    const requestBody: Record<string, unknown> = {
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: "You are a Reddit distribution planner. Choose the single best subreddit from the provided options for a build-in-public startup post. Prioritize communities where educational, non-spam operator content is likely to survive moderation.",
        },
        {
          role: "user",
          content: `Business snapshot:\n- Signups: ${stats.signups}\n- Revenue: ${stats.revenue}\n- Conversion: ${stats.conversionRate}%\n- Payment conversion: ${stats.paymentConvRate}%\n- Open improvement tasks: ${stats.issueCount}\n\nCandidate subreddits:\n${subredditProfiles}\n\nReturn strict JSON: {"subreddit":"<exact subreddit name>","reason":"<short reason>"}`,
        },
      ],
      response_format: { type: "json_object" },
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

    if (!response.ok) return null;
    const payload = (await response.json()) as Record<string, unknown>;
    const choices = payload.choices as Array<{ message?: { content?: string } }> | undefined;
    const content = choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    const parsed = JSON.parse(content) as { subreddit?: string; reason?: string };
    const picked = (parsed.subreddit ?? "").trim();
    if (!picked) return null;
    const match = subreddits.find((entry) => entry.toLowerCase() === picked.toLowerCase());
    if (!match) return null;

    logger.info({ subreddit: match, reason: parsed.reason ?? null }, "LLM selected subreddit for this cycle");
    return match;
  } catch {
    return null;
  }
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
    : channel === "indie_hackers"
      ? `You write Indie Hackers post titles for transparent build-in-public updates. Keep it practical and metric-driven. Return ONLY the title text.${skillBlock}`
      : channel === "hacker_news"
        ? `You write Hacker News Show HN style titles. Technical, direct, no hype, no clickbait. Return ONLY the title text.${skillBlock}`
        : `You write Reddit post titles for r/${subreddit ?? "SideProject"}. Short, authentic, no clickbait. Return ONLY the title text, nothing else.${skillBlock}`;

  try {
    const requestBody: Record<string, unknown> = {
      model,
      temperature: 0.8,
      messages: [
        { role: "system", content: channelPrompt },
        {
          role: "user",
          content: `Write a ${channel} ${channel === "twitter" ? "opening" : "title"} for:\n\n${context.slice(0, 500)}`,
        },
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
): Promise<RedditPostContent> {
  const stats = await getSystemStats(db);
  const trackingLink = `${baseUrl.replace(/\/$/, "")}/api/cold-email?utm_source=reddit&utm_campaign=auto_loop`;

  const companyId = getTelemetryCompanyId();
  const historicalFormatScores = await getRedditHistoricalFormatScores(db, companyId);
  const candidates = await buildRedditVariants(db, subreddit, trackingLink, stats);
  const llmScores = await scoreRedditVariantsWithLLM(subreddit, candidates);

  let best = candidates[0]!;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const historical = historicalFormatScores[candidate.format] ?? 0;
    const llmScore = llmScores?.[i]?.score ?? 50;
    const merged = historical * 0.6 + llmScore * 0.4;
    candidate.score = merged;
    candidate.scoreReason = `historical=${historical.toFixed(1)}, llm=${llmScore.toFixed(1)}${llmScores?.[i]?.reason ? `, llmReason=${llmScores[i]!.reason}` : ""}`;
    if (merged > best.score) {
      best = candidate;
    }
  }

  return {
    title: best.title,
    body: best.body,
    subreddit,
    format: best.format,
    hook: best.hook,
    selectionReason: best.scoreReason,
    variantScores: candidates.map((candidate) => ({
      format: candidate.format,
      score: Number(candidate.score.toFixed(2)),
      reason: candidate.scoreReason,
    })),
  };
}

function getRedditBodyByFormat(
  format: RedditFormat,
  trackingLink: string,
  stats: {
    signups: number;
    revenue: string;
    conversionRate: string;
    paymentConvRate: string;
    issueCount: number;
  },
): string {
  if (format === "story") {
    return `I spent the last few weeks trying to automate growth loops for a tiny startup and finally got a version that does real work without daily babysitting.

Current snapshot:
- ${stats.signups} signups
- ${stats.revenue} revenue
- ${stats.conversionRate}% conversion

Big lesson: autonomous systems only work when attribution and payment loops are wired first.

If anyone is building similar systems, what bottleneck hurt you most: traffic, conversion, or monetization?

${trackingLink}`;
  }

  if (format === "tool") {
    return `Built a cold-email generation workflow that writes outbound drafts from product + ICP + benefit in seconds.

What it currently includes:
- Soft paywall before hard lock
- Attribution on every traffic link
- Follow-up sequence automation
- Decision feedback from revenue metrics

Live metrics so far: ${stats.signups} signups, ${stats.revenue} revenue, payment conversion ${stats.paymentConvRate}%.

If you want to test the flow, here it is: ${trackingLink}`;
  }

  return `Question for founders shipping outbound systems:

If you had to choose one growth priority for the next 7 days, which would you pick and why?
1) More traffic
2) Higher signup conversion
3) Better payment conversion

We track this with an autonomous decision loop and right now it generated ${stats.issueCount} improvement tasks based on real metrics.

Context: ${stats.signups} signups, ${stats.revenue} revenue.

${trackingLink}`;
}

function extractHookFromBody(body: string): string {
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
  return firstLine.slice(0, 140);
}

async function buildRedditVariants(
  db: Db,
  subreddit: string,
  trackingLink: string,
  stats: {
    signups: number;
    revenue: string;
    conversionRate: string;
    paymentConvRate: string;
    issueCount: number;
  },
): Promise<RedditVariantCandidate[]> {
  const variants: RedditVariantCandidate[] = [];

  for (const format of ["story", "tool", "question"] as const) {
    const body = getRedditBodyByFormat(format, trackingLink, stats);
    const llmTitle = await generateLLMTitle(body, "reddit", subreddit, db);
    const fallbackTitle =
      format === "story"
        ? "I finally got an autonomous startup loop working - what I learned"
        : format === "tool"
        ? "Built a cold-email workflow that now drives signups automatically"
        : "Founders: traffic vs conversion vs monetization - what should win this week?";

    variants.push({
      format,
      title: llmTitle ?? fallbackTitle,
      body,
      hook: extractHookFromBody(body),
      score: 0,
      scoreReason: "unscored",
    });
  }

  return variants;
}

async function scoreRedditVariantsWithLLM(
  subreddit: string,
  candidates: RedditVariantCandidate[],
): Promise<Array<{ score: number; reason: string }> | null> {
  const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) return null;

  const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").trim();
  const model = (process.env.OPENAI_MODEL ?? "gpt-4o-mini").trim();

  const prompt = candidates.map((candidate, index) => (
    `${index}. format=${candidate.format}\nTITLE: ${candidate.title}\nBODY: ${candidate.body.slice(0, 600)}`
  )).join("\n\n---\n\n");

  try {
    const requestBody: Record<string, unknown> = {
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: `You are an expert Reddit growth editor for r/${subreddit}. Score each candidate for authentic engagement and conversion intent. Return strict JSON: {"scores":[{"index":0,"score":0-100,"reason":"..."}]}`,
        },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    };

    if (usesCompletionTokens(model)) {
      requestBody.max_completion_tokens = 300;
    } else {
      requestBody.max_tokens = 300;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: getLLMHeaders(),
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) return null;

    const payload = (await response.json()) as Record<string, unknown>;
    const choices = payload.choices as Array<{ message?: { content?: string } }> | undefined;
    const content = choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    const parsed = JSON.parse(content) as { scores?: Array<{ index?: number; score?: number; reason?: string }> };
    if (!Array.isArray(parsed.scores)) return null;

    const byIndex = new Map<number, { score: number; reason: string }>();
    for (const row of parsed.scores) {
      if (typeof row.index !== "number") continue;
      const score = Number(row.score ?? 50);
      byIndex.set(row.index, {
        score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 50,
        reason: String(row.reason ?? "LLM score"),
      });
    }

    return candidates.map((_, index) => byIndex.get(index) ?? { score: 50, reason: "LLM fallback score" });
  } catch {
    return null;
  }
}

async function getRedditHistoricalFormatScores(
  db: Db,
  companyId: string | null,
): Promise<Record<RedditFormat, number>> {
  const scores: Record<RedditFormat, number> = {
    story: 40,
    tool: 40,
    question: 40,
  };
  if (!companyId) return scores;

  const rows = await db
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "distribution.reddit.posted")))
    .orderBy(desc(activityLog.createdAt))
    .limit(60)
    .catch(() => []);

  const aggregate = new Map<RedditFormat, { total: number; count: number }>();

  for (const row of rows) {
    const details = (row.details ?? {}) as Record<string, unknown>;
    const formatRaw = String(details.format ?? "story").toLowerCase();
    const format: RedditFormat = formatRaw === "tool" || formatRaw === "question" ? formatRaw : "story";
    const upvotes = Number(details.upvotes ?? 0);
    const comments = Number(details.comments ?? 0);
    const conversion = Number(details.conversion ?? details.conversions ?? 0);
    const score = Math.max(0, upvotes * 0.7 + comments * 1.0 + conversion * 8);
    const current = aggregate.get(format) ?? { total: 0, count: 0 };
    aggregate.set(format, { total: current.total + score, count: current.count + 1 });
  }

  for (const format of ["story", "tool", "question"] as const) {
    const current = aggregate.get(format);
    if (!current || current.count === 0) continue;
    scores[format] = Math.min(100, Math.max(10, current.total / current.count));
  }

  return scores;
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
  content: RedditPostContent,
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
    const configuredSubreddits = getConfiguredSubreddits();
    const result = await withRetry(async () => {
      const { postToRedditPlaywright } = await import("../ai/tools/externalTools.js");
      const r = (await postToRedditPlaywright({ integrationEnv: {} }, {
        subreddit: content.subreddit,
        fallbackSubreddits: configuredSubreddits.filter((entry) => entry.toLowerCase() !== content.subreddit.toLowerCase()),
        title: content.title,
        text: content.body,
        kind: "self",
        username,
        storageStatePath: storagePath || undefined,
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
        postUrl: typeof r.postUrl === "string" ? r.postUrl : null,
        upvotes: typeof r.upvotes === "number" && Number.isFinite(r.upvotes) ? Math.max(0, r.upvotes) : 0,
        comments: typeof r.comments === "number" && Number.isFinite(r.comments) ? Math.max(0, r.comments) : 0,
      };
    }, { maxRetries: 2, delayMs: 5_000, channel: "reddit" });

    const companyId = getTelemetryCompanyId();
    const artifactId = `artifact:reddit:${content.subreddit}:${Date.now()}`;
    if (companyId) {
      await ctx.db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "traffic-loop",
        agentId: null,
        runId: null,
        action: result.posted ? "distribution.reddit.posted" : "distribution.reddit.post.failed",
        entityType: "company",
        entityId: companyId,
        details: {
          artifactId,
          decisionId: ctx.decisionId ?? null,
          traceId: ctx.traceId ?? null,
          subreddit: content.subreddit,
          title: content.title,
          hook: content.hook,
          format: content.format,
          selectionReason: content.selectionReason,
          variantScores: content.variantScores,
          posted: result.posted,
          method: "playwright",
          postMethod: "playwright",
          postUrl: result.postUrl ?? null,
          error: result.posted ? null : "Reddit post attempt completed without confirmation",
          retries: result.retries,
          upvotes: result.upvotes ?? 0,
          comments: result.comments ?? 0,
          conversion: 0,
        },
      });
    }

    if (result.posted) {
      recordChannelSuccess("reddit");
      if (companyId) {
        await recordSystemMetric(ctx.db, {
          companyId,
          sourceType: "tool_action",
          sourceId: `reddit_post_${content.subreddit}_${Date.now()}`,
          traffic: 1,
          conversions: 0,
          revenueCents: 0,
          metadata: {
            artifactId,
            linkedDecisionId: ctx.decisionId ?? null,
            traceId: ctx.traceId ?? null,
            channel: "reddit",
            subreddit: content.subreddit,
            title: content.title,
            hook: content.hook,
            format: content.format,
            postUrl: result.postUrl ?? null,
            upvotes: result.upvotes ?? 0,
            comments: result.comments ?? 0,
            conversion: 0,
          },
        });

        await ctx.db.insert(aiLearningRecords).values({
          companyId,
          recordType: "insight",
          category: "performance",
          summary: `Reddit ${content.format} post performance: ${content.title.slice(0, 120)}`,
          details: {
            channel: "reddit",
            subreddit: content.subreddit,
            title: content.title,
            hook: content.hook,
            format: content.format,
            upvotes: result.upvotes ?? 0,
            comments: result.comments ?? 0,
            conversion: 0,
            postUrl: result.postUrl ?? null,
          },
          scores: {
            engagement: Number((((result.upvotes ?? 0) * 0.7) + ((result.comments ?? 0) * 1.0)).toFixed(2)),
          },
        }).catch(() => undefined);

        await recordContentPerformance(ctx.db, companyId, "reddit", content.title, true, {
          subreddit: content.subreddit,
          format: content.format,
          hook: content.hook,
          upvotes: result.upvotes ?? 0,
          comments: result.comments ?? 0,
          conversion: 0,
        });
      }
    } else {
      recordChannelFailure("reddit");
    }

    return {
      posted: result.posted,
      channel: "reddit",
      method: "playwright",
      postUrl: result.postUrl ?? null,
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
      await ctx.db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "traffic-loop",
        agentId: null,
        runId: null,
        action: "distribution.reddit.post.failed",
        entityType: "company",
        entityId: companyId,
        details: {
          subreddit: content.subreddit,
          title: content.title,
          hook: content.hook,
          format: content.format,
          selectionReason: content.selectionReason,
          variantScores: content.variantScores,
          posted: false,
          method: "playwright",
          postMethod: "playwright",
          postUrl: null,
          error: message,
          retries: 2,
          upvotes: 0,
          comments: 0,
          conversion: 0,
        },
      });

      await recordContentPerformance(ctx.db, companyId, "reddit", content.title, false, {
        error: message,
        format: content.format,
        hook: content.hook,
        conversion: 0,
      });
    }

    return { posted: false, channel: "reddit", method: "playwright", postUrl: null, error: message, retries: 2 };
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
      const artifactId = `artifact:twitter:${Date.now()}`;
      if (companyId) {
        await recordSystemMetric(ctx.db, {
          companyId,
          sourceType: "tool_action",
          sourceId: `twitter_post_${Date.now()}`,
          traffic: 1,
          conversions: 0,
          revenueCents: 0,
          metadata: {
            artifactId,
            linkedDecisionId: ctx.decisionId ?? null,
            traceId: ctx.traceId ?? null,
            channel: "twitter",
            text: content.text.slice(0, 100),
            tweetUrl: result.tweetUrl ?? null,
          },
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
          details: {
            artifactId,
            decisionId: ctx.decisionId ?? null,
            traceId: ctx.traceId ?? null,
            channel: "twitter",
            text: content.text.slice(0, 200),
            tweetUrl: result.tweetUrl ?? null,
            method: "playwright",
            retries: result.retries,
          },
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

function getDistributionActionPrefix(channel: Channel): string {
  if (channel === "reddit") return "distribution.reddit";
  if (channel === "twitter") return "distribution.twitter";
  if (channel === "indie_hackers") return "distribution.indie_hackers";
  return "distribution.hacker_news";
}

function getWebhookUrlForChannel(channel: Channel): string {
  if (channel === "indie_hackers") {
    return (process.env.TRAFFIC_LOOP_INDIE_HACKERS_WEBHOOK_URL ?? "").trim();
  }
  if (channel === "hacker_news") {
    return (process.env.TRAFFIC_LOOP_HACKER_NEWS_WEBHOOK_URL ?? "").trim();
  }
  return "";
}

async function generateExpansionContent(
  db: Db,
  baseUrl: string,
  channel: "indie_hackers" | "hacker_news",
): Promise<ExpansionPostContent> {
  const stats = await getSystemStats(db);
  const trackingLink = `${baseUrl.replace(/\/$/, "")}/api/cold-email?utm_source=${channel}&utm_campaign=auto_loop`;

  if (channel === "indie_hackers") {
    const template = INDIE_HACKERS_TEMPLATES[Math.floor(Math.random() * INDIE_HACKERS_TEMPLATES.length)]!;
    const body = template.body
      .replace(/\{signups\}/g, String(stats.signups))
      .replace(/\{revenue\}/g, stats.revenue)
      .replace(/\{conversion_rate\}/g, stats.conversionRate)
      .replace(/\{tracking_link\}/g, trackingLink);
    const llmTitle = await generateLLMTitle(body, "indie_hackers", undefined, db);
    return {
      title: llmTitle ?? template.title,
      body,
      trackingLink,
    };
  }

  const template = HACKER_NEWS_TEMPLATES[Math.floor(Math.random() * HACKER_NEWS_TEMPLATES.length)]!;
  const body = template.text
    .replace(/\{signups\}/g, String(stats.signups))
    .replace(/\{revenue\}/g, stats.revenue)
    .replace(/\{conversion_rate\}/g, stats.conversionRate)
    .replace(/\{tracking_link\}/g, trackingLink);
  const llmTitle = await generateLLMTitle(body, "hacker_news", undefined, db);
  return {
    title: llmTitle ?? template.title,
    body,
    trackingLink,
  };
}

async function postToExpansionWebhook(
  ctx: TrafficLoopContext,
  channel: "indie_hackers" | "hacker_news",
  content: ExpansionPostContent,
): Promise<PostResult> {
  const webhookUrl = getWebhookUrlForChannel(channel);
  if (!webhookUrl) {
    return {
      posted: false,
      channel,
      method: "none",
      error: `${channel.toUpperCase()} webhook URL not configured`,
      retries: 0,
    };
  }

  if (!isChannelHealthy(channel)) {
    const health = getChannelHealth(channel);
    return {
      posted: false,
      channel,
      method: "backoff",
      error: `Channel unhealthy (${health.consecutiveFailures} failures, backoff ${Math.round(health.backoffMs / 60_000)}min)`,
      retries: 0,
    };
  }

  try {
    const result = await withRetry(async () => {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel,
          title: content.title,
          body: content.body,
          trackingLink: content.trackingLink,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const posted = response.ok && payload.posted !== false;
      const postUrl = typeof payload.postUrl === "string"
        ? payload.postUrl
        : typeof payload.url === "string"
          ? payload.url
          : null;
      const error = !posted
        ? (typeof payload.error === "string" ? payload.error : `Webhook returned ${response.status}`)
        : null;
      return { posted, postUrl, error };
    }, { maxRetries: 2, delayMs: 5_000, channel });

    const companyId = getTelemetryCompanyId();
    const actionPrefix = getDistributionActionPrefix(channel);
    if (result.posted) {
      recordChannelSuccess(channel);
      if (companyId) {
        const artifactId = `artifact:${channel}:${Date.now()}`;
        await recordSystemMetric(ctx.db, {
          companyId,
          sourceType: "tool_action",
          sourceId: `${channel}_post_${Date.now()}`,
          traffic: 1,
          conversions: 0,
          revenueCents: 0,
          metadata: {
            artifactId,
            linkedDecisionId: ctx.decisionId ?? null,
            traceId: ctx.traceId ?? null,
            channel,
            title: content.title,
            postUrl: result.postUrl,
          },
        });
        await ctx.db.insert(activityLog).values({
          companyId,
          actorType: "system",
          actorId: "traffic-loop",
          agentId: null,
          runId: null,
          action: `${actionPrefix}.posted`,
          entityType: "company",
          entityId: companyId,
          details: {
            artifactId,
            decisionId: ctx.decisionId ?? null,
            traceId: ctx.traceId ?? null,
            channel,
            title: content.title,
            postUrl: result.postUrl,
            method: "webhook",
            retries: result.retries,
          },
        });
        await recordContentPerformance(ctx.db, companyId, channel, content.title, true, {
          method: "webhook",
          postUrl: result.postUrl,
        });
      }
    } else {
      recordChannelFailure(channel);
      if (companyId) {
        await ctx.db.insert(activityLog).values({
          companyId,
          actorType: "system",
          actorId: "traffic-loop",
          agentId: null,
          runId: null,
          action: `${actionPrefix}.post.failed`,
          entityType: "company",
          entityId: companyId,
          details: {
            channel,
            title: content.title,
            method: "webhook",
            retries: result.retries,
            error: result.error,
          },
        }).catch(() => undefined);
      }
    }

    return {
      posted: result.posted,
      channel,
      method: "webhook",
      postUrl: result.postUrl,
      error: result.error ?? undefined,
      retries: result.retries,
    };
  } catch (err) {
    recordChannelFailure(channel);
    const message = err instanceof Error ? err.message : String(err);
    return {
      posted: false,
      channel,
      method: "webhook",
      error: message,
      retries: 2,
    };
  }
}

function getEnabledChannels(controls?: TrafficRuntimeControls | null): Channel[] {
  if (controls) {
    if (controls.trafficChannels.length > 0) {
      return controls.trafficChannels;
    }

    const channels: Channel[] = [];
    if (controls.redditEnabled) channels.push("reddit");
    if (controls.twitterEnabled) channels.push("twitter");
    if (controls.indieHackersEnabled) channels.push("indie_hackers");
    if (controls.hackerNewsEnabled) channels.push("hacker_news");
    return channels;
  }

  return ["reddit", "twitter", "indie_hackers", "hacker_news"];
}

function getChannelPostPlan(
  multiplier: number,
  controls?: TrafficRuntimeControls | null,
): Record<Channel, number> {
  const basePosts = controls ? Math.max(1, Math.min(24, Math.floor(controls.postFrequency))) : 1;
  return {
    reddit: Math.max(0, Math.min(12, basePosts * multiplier)),
    twitter: Math.max(0, Math.min(8, basePosts * Math.max(1, multiplier - 1))),
    indie_hackers: 1,
    hacker_news: 1,
  };
}

let trafficLoopRunning = false;
let trafficLoopInterval: ReturnType<typeof setInterval> | null = null;
let postIndex = 0;

async function runTrafficCycle(
  ctx: TrafficLoopContext,
  options: TrafficCycleRunOptions = {},
): Promise<TrafficCycleSummary> {
  if (trafficLoopRunning) {
    logger.warn("Traffic loop cycle already in progress, skipping");
    return {
      results: [],
      successCount: 0,
      failCount: 0,
      status: "blocked",
      blockReason: "already_running",
      error: "already_running",
    };
  }

  trafficLoopRunning = true;
  const results: PostResult[] = [];
  const cycleStartedAt = Date.now();
  const cycleTraceId = options.traceId ?? ctx.traceId ?? `traffic_cycle:${cycleStartedAt}`;
  const runCtx: TrafficLoopContext = {
    ...ctx,
    decisionId: options.decisionId ?? ctx.decisionId ?? null,
    traceId: cycleTraceId,
  };

  try {
    const companyId = getTelemetryCompanyId();
    const controls = companyId
      ? await getSystemControls(ctx.db, companyId).catch(() => null)
      : null;

    if (companyId) {
      await setCycleState(ctx.db, companyId, "traffic", {
        status: "running",
        stage: "planning",
        currentAction: "building_plan",
        lastError: null,
        lastRunStartedAt: new Date(cycleStartedAt),
      }).catch(() => undefined);
    }

    if (controls && !controls.trafficEnabled) {
      if (companyId) {
        await logActivity(ctx.db, {
          companyId,
          actorType: "system",
          actorId: "traffic-loop",
          action: "traffic.execution.result",
          entityType: "company",
          entityId: companyId,
          details: {
            status: "blocked",
            traceId: cycleTraceId,
            reason: "traffic_disabled",
            successCount: 0,
            failCount: 0,
          },
        }).catch(() => undefined);
        await setCycleState(ctx.db, companyId, "traffic", {
          status: "blocked",
          stage: "idle",
          currentAction: null,
          lastRunCompletedAt: new Date(),
          lastRunDurationMs: Date.now() - cycleStartedAt,
          details: { reason: "traffic_disabled" },
        }).catch(() => undefined);
      }
      return {
        results: [],
        successCount: 0,
        failCount: 0,
        status: "blocked",
        blockReason: "traffic_disabled",
      };
    }

    const trafficControls: TrafficRuntimeControls | null = controls
      ? {
          trafficEnabled: controls.trafficEnabled,
          redditEnabled: controls.redditEnabled,
          twitterEnabled: controls.twitterEnabled,
          indieHackersEnabled: controls.indieHackersEnabled,
          hackerNewsEnabled: controls.hackerNewsEnabled,
          maxMultiplier: controls.maxMultiplier,
          postFrequency: controls.postFrequency,
          subredditTargets: controls.subredditTargets,
          trafficChannels: Array.isArray(controls.trafficChannels)
            ? controls.trafficChannels.filter((entry): entry is Channel =>
              entry === "reddit" || entry === "twitter" || entry === "indie_hackers" || entry === "hacker_news",
            )
            : [],
          trafficMultiplier: controls.trafficMultiplier,
          trafficPostIntervalMs: controls.trafficPostIntervalMs,
          trafficMaxPostsPerCycle: controls.trafficMaxPostsPerCycle,
          trafficSubredditWhitelist: Array.isArray(controls.trafficSubredditWhitelist)
            ? controls.trafficSubredditWhitelist
            : [],
          trafficMode: (controls.trafficMode ?? "balanced") as "conservative" | "balanced" | "aggressive",
          decisionMode: (controls.decisionMode ?? "approval_for_high_impact") as "approval_required" | "approval_for_high_impact" | "auto_execute",
        }
      : null;

    const learningBias = await getTrafficLearningBias(ctx.db, companyId);
    const multiplier = await getRpvTrafficMultiplier(ctx.db, companyId, trafficControls);
    const configuredSubredditSource =
      trafficControls?.trafficSubredditWhitelist.length
        ? trafficControls.trafficSubredditWhitelist
        : trafficControls?.subredditTargets;
    const subreddits = applySubredditBias(
      getConfiguredSubreddits(configuredSubredditSource),
      learningBias.preferredSubreddits,
    );
    const channels = sortChannelsByBias(getEnabledChannels(trafficControls), learningBias.channelScores);
    const requestedChannels = Array.isArray(options.channelsOverride)
      ? options.channelsOverride.filter((entry): entry is Channel => (
        entry === "reddit" || entry === "twitter" || entry === "indie_hackers" || entry === "hacker_news"
      ))
      : [];
    const effectiveChannels = requestedChannels.length > 0
      ? channels.filter((entry) => requestedChannels.includes(entry))
      : channels;
    const draftPlan = getChannelPostPlan(multiplier, trafficControls);
    const maxPostsPerCycle = Math.max(1, Math.min(40, trafficControls?.trafficMaxPostsPerCycle ?? 8));
    const channelPlan: Record<Channel, number> = {
      reddit: 0,
      twitter: 0,
      indie_hackers: 0,
      hacker_news: 0,
    };
    let postsRemaining = maxPostsPerCycle;
    for (const channel of effectiveChannels) {
      const requested = draftPlan[channel] ?? 0;
      const granted = Math.max(0, Math.min(requested, postsRemaining));
      channelPlan[channel] = granted;
      postsRemaining -= granted;
    }

    const postSpacingMs = Math.max(5_000, trafficControls?.trafficPostIntervalMs ?? 60_000);
    const twitterStaggerMs = postSpacingMs * 2;

    if (effectiveChannels.length === 0) {
      if (companyId) {
        await logActivity(ctx.db, {
          companyId,
          actorType: "system",
          actorId: "traffic-loop",
          action: "traffic.execution.result",
          entityType: "company",
          entityId: companyId,
          details: {
            status: "blocked",
            traceId: cycleTraceId,
            reason: "no_channels_enabled",
            successCount: 0,
            failCount: 0,
          },
        }).catch(() => undefined);
        await setCycleState(ctx.db, companyId, "traffic", {
          status: "blocked",
          stage: "idle",
          currentAction: null,
          lastRunCompletedAt: new Date(),
          lastRunDurationMs: Date.now() - cycleStartedAt,
          details: {
            reason: "no_channels_enabled",
          },
        }).catch(() => undefined);
      }
      return {
        results: [],
        successCount: 0,
        failCount: 0,
        status: "blocked",
        blockReason: "no_channels_enabled",
      };
    }

    const runtimeTrafficMode = trafficControls?.trafficMode ?? "balanced";
    const runtimeDecisionMode = trafficControls?.decisionMode ?? "approval_for_high_impact";

    const trafficDecisionKey = multiplier > 1 || runtimeTrafficMode === "aggressive"
      ? "traffic.execution.scale"
      : "traffic.execution.cycle";

    const requiresApproval = companyId && trafficControls && !options.bypassDecisionGate
      ? shouldRequireApprovalForAction(trafficControls.decisionMode, "run_traffic_cycle", trafficDecisionKey)
      : false;

    if (companyId && requiresApproval) {
      const hasOpenDecision = await hasOpenDecisionForActionKey(ctx.db, companyId, trafficDecisionKey, 90);
      let decisionId: string | null = null;

      if (!hasOpenDecision) {
        const decision = await createSystemDecision(ctx.db, {
          companyId,
          source: "traffic_loop",
          actionType: "run_traffic_cycle",
          actionKey: trafficDecisionKey,
          reason: "Traffic cycle requires approval under current decision mode.",
          actionPayload: {
            baseUrl: ctx.baseUrl,
            traceId: cycleTraceId,
            channels: effectiveChannels,
            channelPlan,
            multiplier,
            trafficMode: runtimeTrafficMode,
          },
          status: "awaiting_approval",
        });
        decisionId = decision.id;
      }

      await logActivity(ctx.db, {
        companyId,
        actorType: "system",
        actorId: "traffic-loop",
        action: "traffic.execution.awaiting_approval",
        entityType: "company",
        entityId: companyId,
        details: {
          status: "pending",
          decisionMode: runtimeDecisionMode,
          actionKey: trafficDecisionKey,
          decisionId,
            traceId: cycleTraceId,
            channels: effectiveChannels,
          channelPlan,
          multiplier,
        },
      }).catch(() => undefined);

      await setCycleState(ctx.db, companyId, "traffic", {
        status: "blocked",
        stage: "awaiting_approval",
        currentAction: "awaiting_operator_approval",
        decisionId,
        lastRunCompletedAt: new Date(),
        lastRunDurationMs: Date.now() - cycleStartedAt,
        details: {
          decisionMode: runtimeDecisionMode,
          actionKey: trafficDecisionKey,
          traceId: cycleTraceId,
          channels: effectiveChannels,
          channelPlan,
        },
      }).catch(() => undefined);

      return {
        results: [],
        successCount: 0,
        failCount: 0,
        status: "blocked",
        blockReason: "awaiting_approval",
      };
    }

    if (companyId) {
      await logActivity(ctx.db, {
        companyId,
        actorType: "system",
        actorId: "traffic-loop",
        action: "traffic.execution.plan",
        entityType: "company",
        entityId: companyId,
        details: {
          status: "pending",
          decisionId: options.decisionId ?? null,
          traceId: cycleTraceId,
          channels: effectiveChannels,
          channelPlan,
          subreddits,
          multiplier,
          postSpacingMs,
          maxPostsPerCycle,
          trafficMode: trafficControls?.trafficMode ?? "balanced",
          decisionMode: trafficControls?.decisionMode ?? "approval_for_high_impact",
        },
      }).catch(() => undefined);

      await setCycleState(ctx.db, companyId, "traffic", {
        status: "running",
        stage: "executing",
        currentAction: effectiveChannels[0] ?? "none",
        details: {
          traceId: cycleTraceId,
          channels: effectiveChannels,
          channelPlan,
          multiplier,
        },
      }).catch(() => undefined);
    }

    logger.info(
      {
        multiplier,
        channels: effectiveChannels,
        redditPlan: channelPlan.reddit,
        twitterPlan: channelPlan.twitter,
        preferredSubreddits: learningBias.preferredSubreddits,
      },
      "Traffic loop dominate plan",
    );

    // Reddit post
    if (effectiveChannels.includes("reddit")) {
      const stats = await getSystemStats(ctx.db);
      const llmSelectedSubreddit = await chooseSubredditWithLLM(subreddits, stats);

      for (let redditIndex = 0; redditIndex < channelPlan.reddit; redditIndex++) {
        const defaultSubreddit = subreddits[(postIndex + redditIndex) % subreddits.length]!;
        const subreddit = redditIndex === 0
          ? (llmSelectedSubreddit ?? defaultSubreddit)
          : defaultSubreddit;
        logger.info({ subreddit, postIndex, redditIndex }, "Traffic loop: generating Reddit content");
        const content = await generatePostContent(runCtx.db, subreddit, runCtx.baseUrl);
        logger.info({ subreddit, title: content.title.slice(0, 60), redditIndex }, "Traffic loop: posting to Reddit");
        results.push(await postToReddit(runCtx, content));

        if (redditIndex < channelPlan.reddit - 1 && postSpacingMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, postSpacingMs));
        }
      }
    }

    // Twitter post (staggered 2 min after Reddit to avoid rate limits)
    if (effectiveChannels.includes("twitter")) {
      if (twitterStaggerMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, twitterStaggerMs));
      }
      for (let twitterIndex = 0; twitterIndex < channelPlan.twitter; twitterIndex++) {
        logger.info({ twitterIndex }, "Traffic loop: generating Twitter content");
        const tweet = await generateTweetContent(runCtx.db, runCtx.baseUrl);
        logger.info({ textPreview: tweet.text.slice(0, 60), twitterIndex }, "Traffic loop: posting to Twitter");
        results.push(await postToTwitter(runCtx, tweet));

        if (twitterIndex < channelPlan.twitter - 1 && postSpacingMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, postSpacingMs));
        }
      }
    }

    if (effectiveChannels.includes("indie_hackers")) {
      logger.info({}, "Traffic loop: generating Indie Hackers content");
      const indieContent = await generateExpansionContent(runCtx.db, runCtx.baseUrl, "indie_hackers");
      logger.info({ title: indieContent.title.slice(0, 80) }, "Traffic loop: posting to Indie Hackers webhook");
      results.push(await postToExpansionWebhook(runCtx, "indie_hackers", indieContent));
    }

    if (effectiveChannels.includes("hacker_news")) {
      logger.info({}, "Traffic loop: generating Hacker News content");
      const hnContent = await generateExpansionContent(runCtx.db, runCtx.baseUrl, "hacker_news");
      logger.info({ title: hnContent.title.slice(0, 80) }, "Traffic loop: posting to Hacker News webhook");
      results.push(await postToExpansionWebhook(runCtx, "hacker_news", hnContent));
    }

    if (companyId) {
      await logActivity(ctx.db, {
        companyId,
        actorType: "system",
        actorId: "traffic-loop",
        action: "traffic.learning.bias.applied",
        entityType: "company",
        entityId: companyId,
        details: {
          status: "info",
          traceId: cycleTraceId,
          multiplier,
          channels: effectiveChannels,
          channelPlan,
          preferredSubreddits: learningBias.preferredSubreddits,
          channelScores: learningBias.channelScores,
        },
      }).catch(() => undefined);
    }

    postIndex++;

    const successCount = results.filter((r) => r.posted).length;
    const failCount = results.filter((r) => !r.posted && r.method !== "none" && r.method !== "backoff").length;

    logger.info({
      successCount,
      failCount,
      channels: results.map((r) => `${r.channel}:${r.posted ? "ok" : r.error?.slice(0, 30) ?? "fail"}`),
    }, "Traffic loop cycle completed");

    if (companyId) {
      await logActivity(ctx.db, {
        companyId,
        actorType: "system",
        actorId: "traffic-loop",
        action: "traffic.execution.result",
        entityType: "company",
        entityId: companyId,
        details: {
          status: failCount > 0 ? "failed" : "success",
          success: failCount === 0,
          decisionId: options.decisionId ?? null,
          traceId: cycleTraceId,
          successCount,
          failCount,
          channelMetrics: ["reddit", "twitter", "indie_hackers", "hacker_news"].map((channel) => {
            const rows = results.filter((row) => row.channel === channel);
            return {
              channel,
              attempts: rows.length,
              successes: rows.filter((row) => row.posted).length,
              failures: rows.filter((row) => !row.posted).length,
            };
          }),
          channels: results.map((r) => ({
            channel: r.channel,
            posted: r.posted,
            retries: r.retries,
            error: r.error ?? null,
          })),
        },
      }).catch(() => undefined);
      await setCycleState(ctx.db, companyId, "traffic", {
        status: failCount > 0 ? "failed" : "completed",
        stage: "idle",
        currentAction: null,
        lastRunCompletedAt: new Date(),
        lastRunDurationMs: Date.now() - cycleStartedAt,
        details: {
          traceId: cycleTraceId,
          successCount,
          failCount,
        },
      }).catch(() => undefined);
    }

    eventBus.publish("traffic.loop.cycle.completed", {
      traceId: cycleTraceId,
      results: results.map((r) => ({ channel: r.channel, posted: r.posted, retries: r.retries, error: r.error ?? null })),
      timestamp: new Date().toISOString(),
    });

    return {
      results,
      successCount,
      failCount,
      status: failCount > 0 ? "failed" : "success",
    };
  } catch (err) {
    logger.error({ err }, "Traffic loop cycle failed");
    const message = err instanceof Error ? err.message : String(err);
    const companyId = getTelemetryCompanyId();
    if (companyId) {
      await logActivity(ctx.db, {
        companyId,
        actorType: "system",
        actorId: "traffic-loop",
        action: "traffic.execution.result",
        entityType: "company",
        entityId: companyId,
        details: {
          status: "failed",
          success: false,
          decisionId: options.decisionId ?? null,
          traceId: cycleTraceId,
          error: message,
          successCount: results.filter((r) => r.posted).length,
          failCount: results.filter((r) => !r.posted && r.method !== "none" && r.method !== "backoff").length,
        },
      }).catch(() => undefined);
      await setCycleState(ctx.db, companyId, "traffic", {
        status: "failed",
        stage: "idle",
        currentAction: null,
        lastError: message,
        lastRunCompletedAt: new Date(),
        lastRunDurationMs: Date.now() - cycleStartedAt,
      }).catch(() => undefined);
    }
    return {
      results,
      successCount: results.filter((r) => r.posted).length,
      failCount: results.filter((r) => !r.posted && r.method !== "none" && r.method !== "backoff").length,
      status: "failed",
      error: message,
    };
  } finally {
    trafficLoopRunning = false;
  }
}

export function startTrafficLoop(db: Db, intervalMs = 3 * 60 * 60_000): () => void {
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
  const effectiveInterval = intervalMs;

  const channels = getEnabledChannels();
  const subreddits = getConfiguredSubreddits();
  logger.info(
    { intervalMs: effectiveInterval, channels, subreddits },
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

export async function runTrafficCycleWithDecision(
  ctx: TrafficLoopContext,
  options: TrafficCycleRunOptions = {},
): Promise<TrafficCycleSummary> {
  return runTrafficCycle(ctx, options);
}

export async function _runTrafficCycleForTest(ctx: TrafficLoopContext): Promise<TrafficCycleSummary> {
  return runTrafficCycle(ctx, { bypassDecisionGate: true });
}
