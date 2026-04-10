import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import pino from "pino";
import { generateWithQualityGate } from "../quality/executionQualityGate.js";
import { eventBus } from "../../events/eventBus.js";
import { recordContentPerformance } from "../../memory/embeddingMemory.js";
import {
  isRedditStorageStateRequired,
  parseBooleanEnv,
  resolveExistingRedditStorageStatePath,
  resolveRedditStorageStatePath,
} from "../../reddit-storage-state.js";

const logger = pino({ name: "reddit-reply-agent" });

interface RedditComment {
  id: string;
  author: string;
  body: string;
  score: number;
  postTitle: string;
  subreddit: string;
  permalink: string;
  isQuestion: boolean;
}

interface ReplyResult {
  commentId: string;
  replied: boolean;
  replyText?: string;
  error?: string;
}

const repliedComments = new Set<string>();
const REPLY_COOLDOWN_MS = 15 * 60_000;
let lastReplyTime = 0;

const PRODUCT_CONTEXT = `
Product: AI-powered cold email template system for founders
Offer: $5-$9 template pack with proven outbound sequences
Landing: https://writenaturallyai.com
Value prop: Save hours writing cold emails, use templates that actually convert
Audience: Indie hackers, startup founders, solopreneurs
`.trim();

const MONITORED_SUBREDDITS = [
  "SideProject",
  "startups",
  "EntrepreneurRideAlong",
  "indiehackers",
  "microsaas",
  "Entrepreneur",
  "SaaS",
  "coldEmail",
];

async function fetchRecentComments(subreddit: string): Promise<RedditComment[]> {
  try {
    const response = await fetch(
      `https://www.reddit.com/r/${subreddit}/comments.json?limit=25&sort=new`,
      {
        headers: {
          "User-Agent": "paperclip-agent/1.0 (monitoring)",
        },
      },
    );

    if (!response.ok) return [];

    const data = (await response.json()) as Record<string, unknown>;
    const listing = data.data as { children?: Array<{ data: Record<string, unknown> }> } | undefined;
    if (!listing?.children) return [];

    return listing.children
      .map((child) => {
        const d = child.data;
        const body = String(d.body ?? "");
        return {
          id: String(d.id ?? ""),
          author: String(d.author ?? ""),
          body,
          score: Number(d.score ?? 0),
          postTitle: String(d.link_title ?? ""),
          subreddit: String(d.subreddit ?? subreddit),
          permalink: `https://www.reddit.com${d.permalink ?? ""}`,
          isQuestion: body.includes("?") || /\b(how|what|where|which|any|recommend|suggest|help|tips|advice)\b/i.test(body),
        };
      })
      .filter((c) => c.id && c.author !== "[deleted]" && c.body.length > 15);
  } catch (err) {
    logger.debug({ err, subreddit }, "Failed to fetch Reddit comments");
    return [];
  }
}

type ReplyStrategy = "pure_value" | "story" | "insight" | "soft_cta";

function scoreComment(comment: RedditComment): number {
  let score = 0;
  score += comment.score * 2;
  if (comment.isQuestion) score += 5;
  if (comment.body.length > 50) score += 2;
  if (comment.body.length > 150) score += 1;

  const highValueKeywords = ["cold email", "outbound", "template", "email sequence", "lead gen", "prospecting"];
  const bodyLower = comment.body.toLowerCase();
  for (const kw of highValueKeywords) {
    if (bodyLower.includes(kw)) score += 3;
  }

  return score;
}

const REPLY_SCORE_THRESHOLD = 4;

function pickReplyStrategy(): ReplyStrategy {
  const roll = Math.random();
  if (roll < 0.70) return "pure_value";
  if (roll < 0.90) return "story";
  return "soft_cta";
}

function isRelevantComment(comment: RedditComment): boolean {
  if (repliedComments.has(comment.id)) return false;
  if (comment.author.toLowerCase() === (process.env.REDDIT_USERNAME ?? "").toLowerCase()) return false;

  const keywords = [
    "cold email", "outbound", "template", "email sequence", "startup tool",
    "saas", "landing page", "conversion", "side project", "revenue",
    "automation", "ai tool", "founder", "indie hacker", "growth",
    "email marketing", "lead gen", "prospecting", "sales email",
  ];

  const bodyLower = comment.body.toLowerCase();
  const titleLower = comment.postTitle.toLowerCase();
  const combinedText = `${bodyLower} ${titleLower}`;

  const keywordMatch = keywords.some((kw) => combinedText.includes(kw));
  const isQuestion = comment.isQuestion;
  const hasEngagement = comment.score >= 1;

  if (!((keywordMatch && (isQuestion || hasEngagement)) || (isQuestion && comment.score >= 2))) {
    return false;
  }

  return scoreComment(comment) >= REPLY_SCORE_THRESHOLD;
}

async function fetchPostContext(comment: RedditComment): Promise<string> {
  try {
    const postUrl = comment.permalink.replace(/\/[^/]*\/?$/, ".json");
    const response = await fetch(`https://www.reddit.com${postUrl}?limit=5`, {
      headers: { "User-Agent": "paperclip-agent/1.0 (context)" },
    });
    if (!response.ok) return "";

    const data = (await response.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(data) || data.length < 2) return "";

    const postData = data[0] as Record<string, unknown>;
    const postListing = (postData?.data as Record<string, unknown>)?.children as Array<{ data: Record<string, unknown> }> | undefined;
    const postBody = postListing?.[0]?.data?.selftext ?? "";

    const commentListing = data[1] as Record<string, unknown>;
    const commentChildren = (commentListing?.data as Record<string, unknown>)?.children as Array<{ data: Record<string, unknown> }> | undefined;
    const topComments = (commentChildren ?? [])
      .slice(0, 3)
      .map((c) => String(c.data?.body ?? "").slice(0, 100))
      .filter((c) => c.length > 10);

    let context = "";
    if (typeof postBody === "string" && postBody.length > 10) {
      context += `\nOriginal post body: "${String(postBody).slice(0, 300)}"`;
    }
    if (topComments.length > 0) {
      context += `\nTop comments in thread: ${topComments.map((c) => `"${c}"`).join(" | ")}`;
    }
    return context;
  } catch {
    return "";
  }
}

const STRATEGY_INSTRUCTIONS: Record<ReplyStrategy, string> = {
  pure_value: `Reply with PURE VALUE. Do NOT mention any product, link, or tool. Just be genuinely helpful. Share a real insight or tip they can use immediately.`,
  story: `Reply with a SHORT STORY from your experience. "I had the same problem, here's what I did..." Do NOT pitch anything. Just relate human-to-human.`,
  insight: `Reply with a NON-OBVIOUS INSIGHT. Challenge their assumption or share a counterintuitive take. Be interesting, not helpful-in-a-boring-way.`,
  soft_cta: `Reply helpfully first, then naturally mention "I actually built something for this" with the link. Make it feel like an afterthought, not the point of the reply.`,
};

async function generateReply(comment: RedditComment): Promise<string | null> {
  const strategy = pickReplyStrategy();
  const postContext = await fetchPostContext(comment);

  return generateWithQualityGate("reply", [
    {
      role: "system",
      content: `You are a solo founder named Mintu who builds AI tools for startups. You reply the way a real person texts — casual, direct, sometimes messy grammar, never corporate.

## Your personality
- You share from real experience ("I tried X and it actually worked")
- You use contractions, slang sometimes ("tbh", "ngl", "haha")
- You ask follow-up questions sometimes
- You NEVER use bullet points in Reddit replies
- You NEVER sound like ChatGPT (no "Great question!", "I'd be happy to help!")

## Reply strategy for THIS reply: ${strategy.toUpperCase()}
${STRATEGY_INSTRUCTIONS[strategy]}

## Subreddit style: r/${comment.subreddit}
${comment.subreddit === "SideProject" ? "Casual, show-and-tell vibe. People share what they built." : ""}
${comment.subreddit === "startups" ? "More serious, strategic discussions. Be thoughtful." : ""}
${comment.subreddit === "coldEmail" ? "Technical, people want specific tactics." : ""}
${comment.subreddit === "Entrepreneur" ? "Mixed crowd. Some experienced, some new. Adapt." : ""}

${PRODUCT_CONTEXT}`,
    },
    {
      role: "user",
      content: `Subreddit: r/${comment.subreddit}
Post: "${comment.postTitle}"
${postContext}

u/${comment.author} wrote (${comment.score} upvotes):
"${comment.body}"

Reply as Mintu using the ${strategy} strategy. 2-4 sentences max. Sound human.`,
    },
  ], "reddit_reply", 3);
}

async function postReplyViaPlaywright(
  comment: RedditComment,
  replyText: string,
): Promise<boolean> {
  const username = (process.env.REDDIT_USERNAME ?? "").trim();
  if (!username) return false;

  async function resolveWelcomeBack(page: {
    locator: (selector: string) => {
      first: () => {
        isVisible: () => Promise<boolean>;
        click?: () => Promise<void>;
      };
    };
    waitForTimeout: (ms: number) => Promise<void>;
  }): Promise<boolean> {
    const welcomeBackBanner = page.locator("text=Welcome back!").first();
    const welcomeBackVisible = await welcomeBackBanner.isVisible().catch(() => false);
    if (!welcomeBackVisible) return false;

    const followLink = page.locator('a:has-text("this link"), a[href*="reddit.com"]').first();
    if (await followLink.isVisible().catch(() => false)) {
      await followLink.click?.().catch(() => undefined);
      await page.waitForTimeout(1800);
      return true;
    }

    return false;
  }

  async function ensurePermalinkAccess(page: {
    goto: (url: string, opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"; timeout?: number }) => Promise<unknown>;
    url: () => string;
    locator: (selector: string) => {
      first: () => {
        count: () => Promise<number>;
        isVisible: () => Promise<boolean>;
      };
    };
    waitForTimeout: (ms: number) => Promise<void>;
  }, permalink: string, timeoutMs: number): Promise<{ reachable: boolean; currentUrl: string; welcomeRecovered: boolean }> {
    await page.goto(permalink, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(1500);

    const recovered = await resolveWelcomeBack(page);
    if (recovered || page.url().includes("/login")) {
      await page.goto(permalink, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      await page.waitForTimeout(1500);
    }

    const currentUrl = page.url();
    const loginPage = currentUrl.includes("/login");
    const replyButtonVisible = await page.locator('button:has-text("Reply"), button:has-text("reply")').first().isVisible().catch(() => false);
    const joinConversationVisible = await page.locator('text=Join the conversation').first().isVisible().catch(() => false);
    const isReachable = !loginPage && (replyButtonVisible || joinConversationVisible);

    return { reachable: isReachable, currentUrl, welcomeRecovered: recovered };
  }

  try {
    const playwright = await import("playwright");
    const existingStoragePath = resolveExistingRedditStorageStatePath();
    const storagePath = existingStoragePath ?? resolveRedditStorageStatePath();
    const requireStorageState = isRedditStorageStateRequired(true);
    const allowPasswordLogin = parseBooleanEnv(process.env.REDDIT_ALLOW_PASSWORD_LOGIN, false);
    const password = (process.env.REDDIT_PASSWORD ?? "").trim();
    const timeoutMs = Math.max(12_000, Number(process.env.PLAYWRIGHT_TIMEOUT_MS ?? 60_000));
    const headful = parseBooleanEnv(process.env.REDDIT_HEADFUL, false);
    const headless = headful ? false : parseBooleanEnv(process.env.PLAYWRIGHT_HEADLESS, true);

    if (requireStorageState && !existingStoragePath) {
      logger.warn({ commentId: comment.id, storagePath }, "Reddit reply skipped: required storage state is missing");
      return false;
    }

    const launchOpts: Record<string, unknown> = {
      headless,
    };

    const browser = await playwright.chromium.launch(launchOpts);
    const contextOpts: Record<string, unknown> = {};

    const storageUsed = Boolean(existingStoragePath);
    if (storageUsed) {
      contextOpts.storageState = storagePath;
    }

    const context = await browser.newContext(contextOpts);
    const page = await context.newPage();

    try {
      let access = await ensurePermalinkAccess(page, comment.permalink, timeoutMs);
      logger.info({
        commentId: comment.id,
        storageUsed,
        currentUrl: access.currentUrl,
        reachable: access.reachable,
        welcomeRecovered: access.welcomeRecovered,
      }, "REDDIT REPLY DEBUG");

      if (!access.reachable) {
        if (!allowPasswordLogin) {
          logger.warn({ commentId: comment.id, currentUrl: access.currentUrl }, "Reddit reply skipped: storage state is not authenticated and password-login fallback is disabled");
          return false;
        }

        if (!password) {
          logger.warn({ commentId: comment.id }, "Reddit reply skipped: REDDIT_PASSWORD missing while password-login fallback is enabled");
          return false;
        }

        await page.goto("https://www.reddit.com/login", { waitUntil: "domcontentloaded", timeout: timeoutMs });
        const usernameInput = page.locator('input[name="username"], #loginUsername, input[autocomplete="username"]').first();
        const passwordInput = page.locator('input[name="password"], #loginPassword, input[type="password"]').first();
        await usernameInput.fill(username);
        await passwordInput.fill(password);
        await passwordInput.press("Enter");
        await page.waitForTimeout(3000);

        await resolveWelcomeBack(page);
        access = await ensurePermalinkAccess(page, comment.permalink, timeoutMs);
        logger.info({
          commentId: comment.id,
          storageUsed,
          currentUrl: access.currentUrl,
          reachable: access.reachable,
          welcomeRecovered: access.welcomeRecovered,
          phase: "post_login_recovery",
        }, "REDDIT REPLY DEBUG");

        if (!access.reachable) {
          logger.warn({ commentId: comment.id, currentUrl: access.currentUrl }, "Reddit reply skipped: still unreachable after login recovery");
          return false;
        }
      }

      const replySelectors = [
        `#thing_t1_${comment.id} button:has-text("Reply")`,
        `[id*="${comment.id}"] button:has-text("Reply")`,
        `[id*="${comment.id}"] button:has-text("reply")`,
        'button[data-testid*="comment-reply"]',
        'button:has-text("Reply")',
      ];

      let replyClicked = false;
      for (const selector of replySelectors) {
        const button = page.locator(selector).first();
        if (!(await button.isVisible().catch(() => false))) continue;
        await button.click().catch(() => undefined);
        replyClicked = true;
        break;
      }

      if (replyClicked) {
        await page.waitForTimeout(1000);
      }

      const textarea = page.locator('textarea, [contenteditable="true"], div[role="textbox"]').last();
      if (await textarea.count() > 0) {
        await textarea.click().catch(() => undefined);
        await textarea.fill(replyText).catch(async () => {
          await page.keyboard.type(replyText, { delay: 8 });
        });
        await page.waitForTimeout(500);

        const submitBtn = page.locator('button:has-text("Comment"), button:has-text("Reply"), button[type="submit"]').last();
        if (await submitBtn.count() > 0) {
          await submitBtn.click();
          await page.waitForTimeout(2000);

          if (storagePath) {
            await context.storageState({ path: storagePath });
          }

          logger.info({ commentId: comment.id, currentUrl: page.url(), storageUsed }, "REDDIT REPLY DEBUG");

          return true;
        }
      }

      return false;
    } finally {
      await browser.close();
    }
  } catch (err) {
    logger.warn({ err, commentId: comment.id }, "Playwright reply failed");
    return false;
  }
}

async function processComment(
  db: Db,
  comment: RedditComment,
): Promise<ReplyResult> {
  const replyText = await generateReply(comment);
  if (!replyText) {
    return { commentId: comment.id, replied: false, error: "LLM generation failed" };
  }

  const posted = await postReplyViaPlaywright(comment, replyText);

  repliedComments.add(comment.id);
  lastReplyTime = Date.now();

  const companyId = (process.env.BILLING_WEBHOOK_COMPANY_ID ?? "").trim();
  if (companyId) {
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "reddit-reply-agent",
      agentId: null,
      runId: null,
      action: posted ? "distribution.reddit.reply.posted" : "distribution.reddit.reply.generated",
      entityType: "company",
      entityId: companyId,
      details: {
        subreddit: comment.subreddit,
        commentId: comment.id,
        commentAuthor: comment.author,
        commentScore: comment.score,
        postTitle: comment.postTitle.slice(0, 100),
        replyText: replyText.slice(0, 300),
        posted,
      },
    });

    await recordContentPerformance(db, companyId, "reddit_reply", replyText.slice(0, 80), posted, {
      subreddit: comment.subreddit,
      commentAuthor: comment.author,
      commentScore: comment.score,
    }).catch(() => {});
  }

  return { commentId: comment.id, replied: posted, replyText };
}

let replyAgentRunning = false;

async function runReplyCycle(db: Db): Promise<void> {
  if (replyAgentRunning) return;
  if (Date.now() - lastReplyTime < REPLY_COOLDOWN_MS) return;

  replyAgentRunning = true;
  try {
    const allComments: RedditComment[] = [];
    for (const sub of MONITORED_SUBREDDITS) {
      const comments = await fetchRecentComments(sub);
      allComments.push(...comments);
      await new Promise((r) => setTimeout(r, 1500));
    }

    const relevant = allComments.filter(isRelevantComment);
    relevant.sort((a, b) => scoreComment(b) - scoreComment(a));

    const toReply = relevant.slice(0, 5);

    if (toReply.length === 0) {
      logger.debug("Reddit reply agent: no relevant comments found");
      return;
    }

    logger.info({ count: toReply.length, subreddits: [...new Set(toReply.map((c) => c.subreddit))] }, "Reddit reply agent: processing comments");

    const results: ReplyResult[] = [];
    for (const comment of toReply) {
      const result = await processComment(db, comment);
      results.push(result);
      await new Promise((r) => setTimeout(r, 30_000));
    }

    const posted = results.filter((r) => r.replied).length;
    const generated = results.filter((r) => r.replyText).length;

    logger.info({ posted, generated, total: results.length }, "Reddit reply agent cycle completed");

    eventBus.publish("reddit.reply.cycle.completed", {
      posted,
      generated,
      total: results.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err }, "Reddit reply agent cycle failed");
  } finally {
    replyAgentRunning = false;
  }
}

let replyInterval: ReturnType<typeof setInterval> | null = null;

export function startRedditReplyAgent(db: Db, intervalMs = 15 * 60_000): () => void {
  const enabled = (process.env.REDDIT_REPLY_AGENT_ENABLED ?? "true").trim().toLowerCase();
  if (enabled === "false" || enabled === "0") {
    logger.info("Reddit reply agent disabled");
    return () => {};
  }

  const customInterval = Number(process.env.REDDIT_REPLY_INTERVAL_MS);
  const effectiveInterval = Number.isFinite(customInterval) && customInterval > 0
    ? customInterval
    : intervalMs;

  logger.info({ intervalMs: effectiveInterval, subreddits: MONITORED_SUBREDDITS }, "Starting Reddit reply agent");

  setTimeout(() => void runReplyCycle(db), 60_000);

  replyInterval = setInterval(() => {
    void runReplyCycle(db);
  }, effectiveInterval);

  return () => {
    if (replyInterval) {
      clearInterval(replyInterval);
      replyInterval = null;
    }
  };
}
