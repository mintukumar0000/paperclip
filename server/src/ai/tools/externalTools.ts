import { createHmac, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  getConfiguredRedditStorageStatePath,
  isRedditStorageStateRequired,
  resolveExistingRedditStorageStatePath,
  resolveRedditStorageStatePath,
} from "../../reddit-storage-state.js";

type JsonObject = Record<string, unknown>;

export interface IntegrationContext {
  integrationEnv: Record<string, string>;
}

type XBearerTokenResolution = {
  token: string;
  source: "bearer" | "client_credentials";
};

const X_CLIENT_CREDENTIALS_TOKEN_ENDPOINTS = [
  "https://api.x.com/2/oauth2/token",
  "https://api.twitter.com/2/oauth2/token",
  "https://api.twitter.com/oauth2/token",
];

const ALLOWED_HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

function asObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

function asStringRecord(value: unknown): Record<string, string> {
  const obj = asObject(value);
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(obj)) {
    if (typeof raw === "string") out[key] = raw;
    else if (typeof raw === "number" || typeof raw === "boolean") out[key] = String(raw);
  }
  return out;
}

function pickCredential(
  ctx: IntegrationContext,
  inlineValue: unknown,
  envNames: string[],
): string | null {
  if (typeof inlineValue === "string" && inlineValue.trim().length > 0) {
    return inlineValue.trim();
  }

  for (const name of envNames) {
    const fromIntegration = ctx.integrationEnv[name];
    if (typeof fromIntegration === "string" && fromIntegration.trim().length > 0) {
      return fromIntegration.trim();
    }

    const fromProcess = process.env[name];
    if (typeof fromProcess === "string" && fromProcess.trim().length > 0) {
      return fromProcess.trim();
    }
  }

  return null;
}

function parseBoolean(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function isLoopbackHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return ["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function resolveSessionPath(value: string): string {
  if (path.isAbsolute(value)) return value;
  const cwd = process.cwd();
  const fromCwd = path.resolve(cwd, value);
  if (path.basename(cwd) === "server") {
    const fromRepoRoot = path.resolve(cwd, "..", value);
    if (existsSync(fromRepoRoot)) return fromRepoRoot;
    if (!existsSync(fromCwd)) return fromRepoRoot;
  }
  return fromCwd;
}

function resolveExistingSessionPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate || candidate.trim().length === 0) continue;
    const resolved = resolveSessionPath(candidate.trim());
    if (existsSync(resolved)) return resolved;
  }
  return null;
}

function getPlaywrightLaunchOptions(headless: boolean): {
  headless: boolean;
  channel?: string;
  args?: string[];
} {
  const channel = process.env.PLAYWRIGHT_BROWSER_CHANNEL?.trim();
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--disable-dev-shm-usage",
  ];

  return {
    headless,
    channel: channel && channel.length > 0 ? channel : undefined,
    args,
  };
}

function getPlaywrightContextOptions(storageStatePath?: string): {
  storageState?: string;
  viewport: { width: number; height: number };
  locale: string;
  timezoneId: string;
} {
  return {
    storageState: storageStatePath,
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
  };
}

async function saveStorageState(
  context: { storageState: (arg: { path: string }) => Promise<unknown> },
  filePath: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await context.storageState({ path: filePath });
}

async function ensureXLogin(page: {
  goto: (url: string, opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"; timeout?: number }) => Promise<unknown>;
  locator: (selector: string) => {
    first: () => {
      waitFor: (opts?: { timeout?: number }) => Promise<void>;
      fill: (value: string) => Promise<void>;
      click: () => Promise<void>;
      press: (value: string) => Promise<void>;
      isVisible: () => Promise<boolean>;
    };
    count: () => Promise<number>;
  };
  waitForTimeout: (ms: number) => Promise<void>;
}, params: {
  username: string;
  password?: string;
  timeoutMs: number;
}): Promise<void> {
  await page.goto("https://x.com/login", { waitUntil: "domcontentloaded", timeout: params.timeoutMs });

  const userInput = page.locator('input[name="text"], input[autocomplete="username"], input[data-testid="ocfEnterTextTextInput"]').first();
  await userInput.waitFor({ timeout: params.timeoutMs });
  await userInput.fill(params.username);
  await userInput.press("Enter");

  await page.waitForTimeout(1000);

  const passwordField = page.locator('input[name="password"], input[type="password"]').first();
  await passwordField.waitFor({ timeout: params.timeoutMs });
  if (!params.password) {
    throw new Error(
      "X login requires X_PASSWORD when no valid storage state is available. Set X_PASSWORD for bootstrap login, then keep X_STORAGE_STATE_PATH for future runs.",
    );
  }
  await passwordField.fill(params.password);
  await passwordField.press("Enter");

  await page.waitForTimeout(2500);
}

export async function postToTwitterPlaywright(
  _ctx: IntegrationContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const playwright = await import("playwright");
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) throw new Error("text is required for post_twitter");

  const usernameRaw =
    typeof args.username === "string" && args.username.trim().length > 0
      ? args.username.trim()
      : (process.env.X_USERNAME ?? "").trim();
  const username = usernameRaw.replace(/^@/, "");
  if (!username) {
    throw new Error("X_USERNAME is required for Playwright Twitter posting");
  }

  const password =
    typeof args.password === "string" && args.password.trim().length > 0
      ? args.password.trim()
      : (process.env.X_PASSWORD ?? "").trim();

  const sessionPathRaw =
    typeof args.storageStatePath === "string" && args.storageStatePath.trim().length > 0
      ? args.storageStatePath.trim()
      : (process.env.X_STORAGE_STATE_PATH ?? "data/playwright/x-storage-state.json");
  const sessionPath = resolveSessionPath(sessionPathRaw);
  const userDataDirRaw =
    typeof args.userDataDir === "string" && args.userDataDir.trim().length > 0
      ? args.userDataDir.trim()
      : (process.env.PLAYWRIGHT_USER_DATA_DIR ?? "").trim();
  const userDataDir = userDataDirRaw ? resolveSessionPath(userDataDirRaw) : null;

  const timeoutMs = Math.max(10_000, Number(args.timeoutMs ?? process.env.PLAYWRIGHT_TIMEOUT_MS ?? 60_000));
  const headless =
    typeof args.headless === "boolean"
      ? args.headless
      : parseBoolean(process.env.PLAYWRIGHT_HEADLESS, false);

  let browser: Awaited<ReturnType<typeof playwright.chromium.launch>> | null = null;
  let context: Awaited<ReturnType<typeof playwright.chromium.launchPersistentContext>>;

  if (userDataDir) {
    await mkdir(userDataDir, { recursive: true });
    context = await playwright.chromium.launchPersistentContext(userDataDir, {
      ...getPlaywrightLaunchOptions(headless),
      ...getPlaywrightContextOptions(),
    });
  } else {
    browser = await playwright.chromium.launch(getPlaywrightLaunchOptions(headless));
    const hasState = existsSync(sessionPath);
    context = await browser.newContext(
      hasState ? getPlaywrightContextOptions(sessionPath) : getPlaywrightContextOptions(),
    );
  }
  const page = await context.newPage();

  try {
    await page.goto("https://x.com/compose/post", { waitUntil: "domcontentloaded", timeout: timeoutMs });

    const composer = page.locator('[data-testid="tweetTextarea_0"]').first();
    if (!(await composer.isVisible().catch(() => false))) {
      await ensureXLogin(page, { username, password: password || undefined, timeoutMs });
      await page.goto("https://x.com/compose/post", { waitUntil: "domcontentloaded", timeout: timeoutMs });
    }

    const finalComposer = page.locator('[data-testid="tweetTextarea_0"]').first();
    await finalComposer.waitFor({ timeout: timeoutMs });
    await finalComposer.click();
    await finalComposer.fill("");
    await page.keyboard.type(text, { delay: 18 });

    const composerText = await finalComposer.textContent().catch(() => "");
    if (!composerText || composerText.trim().length === 0) {
      throw new Error("X composer stayed empty after typing; posting aborted");
    }

    const inlinePostButton = page.locator('[data-testid="tweetButtonInline"]').first();
    const standardPostButton = page.locator('[data-testid="tweetButton"]').first();
    await inlinePostButton.waitFor({ timeout: timeoutMs });
    const inlineDisabled = await inlinePostButton.getAttribute("aria-disabled");
    if (inlineDisabled === "true") {
      await standardPostButton.waitFor({ timeout: timeoutMs });
      const standardDisabled = await standardPostButton.getAttribute("aria-disabled");
      if (standardDisabled === "true") {
        throw new Error("X post button disabled after typing text");
      }
      await standardPostButton.click();
    } else {
      await inlinePostButton.click();
    }

    await page.waitForTimeout(2500);
    let tweetUrl: string | null = null;
    try {
      await page.goto(`https://x.com/${username}`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      const latestTweetLink = page.locator('article a[href*="/status/"]').first();
      await latestTweetLink.waitFor({ timeout: timeoutMs });
      const href = await latestTweetLink.getAttribute("href");
      if (href && href.includes("/status/")) {
        const cleanHref = href.split("?")[0] ?? href;
        tweetUrl = cleanHref.startsWith("http") ? cleanHref : `https://x.com${cleanHref}`;
      }
    } catch {
      tweetUrl = null;
    }

    await saveStorageState(context, sessionPath);

    return {
      posted: true,
      platform: "x",
      username,
      tweetUrl,
      userDataDir,
      storageStatePath: sessionPath,
      textLength: text.length,
      mode: "playwright",
    };
  } finally {
    await context.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

async function ensureRedditLogin(page: {
  goto: (url: string, opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"; timeout?: number }) => Promise<unknown>;
  url: () => string;
  locator: (selector: string) => {
    first: () => {
      waitFor: (opts?: { timeout?: number }) => Promise<void>;
      fill: (value: string) => Promise<void>;
      click: () => Promise<void>;
      press: (value: string) => Promise<void>;
      isVisible: () => Promise<boolean>;
    };
  };
  waitForTimeout: (ms: number) => Promise<void>;
}, params: {
  username: string;
  password?: string;
  timeoutMs: number;
}): Promise<void> {
  await page.goto("https://www.reddit.com/login", { waitUntil: "domcontentloaded", timeout: params.timeoutMs });

  const userInput = page.locator('input[name="username"], input#loginUsername, input[autocomplete="username"]').first();
  await userInput.waitFor({ timeout: params.timeoutMs });
  await userInput.fill(params.username);

  const passwordInput = page.locator('input[name="password"], input#loginPassword, input[type="password"]').first();
  await passwordInput.waitFor({ timeout: params.timeoutMs });

  if (!params.password) {
    throw new Error(
      "Reddit login requires REDDIT_PASSWORD when no valid storage state is available. Set REDDIT_PASSWORD for bootstrap login, then keep REDDIT_STORAGE_STATE_PATH for future runs.",
    );
  }

  await passwordInput.fill(params.password);
  await passwordInput.press("Enter");
  await page.waitForTimeout(3500);

  const followLoginRedirect = page.locator('a:has-text("this link"), a[href*="reddit.com"]').first();
  if (await followLoginRedirect.isVisible().catch(() => false)) {
    await followLoginRedirect.click().catch(() => undefined);
    await page.waitForTimeout(2000);
  }

  await page.goto("https://www.reddit.com/submit", { waitUntil: "domcontentloaded", timeout: params.timeoutMs });
  await page.waitForTimeout(2000);
  if (page.url().includes("/login")) {
    throw new Error("SESSION_EXPIRED: Reddit login completed but submit page still redirects to /login");
  }
}

async function resolveWelcomeBackLoop(page: {
  locator: (selector: string) => {
    first: () => {
      click: () => Promise<void>;
      isVisible: () => Promise<boolean>;
    };
  };
  waitForTimeout: (ms: number) => Promise<void>;
}): Promise<void> {
  const followRedirect = page.locator('a:has-text("this link"), a[href*="reddit.com"]').first();
  if (await followRedirect.isVisible().catch(() => false)) {
    await followRedirect.click().catch(() => undefined);
    await page.waitForTimeout(2000);
  }
}

async function hasRedditSubmitAccess(page: {
  goto: (url: string, opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"; timeout?: number }) => Promise<unknown>;
  url: () => string;
  locator: (selector: string) => {
    first: () => {
      click: () => Promise<void>;
      isVisible: () => Promise<boolean>;
    };
  };
  waitForTimeout: (ms: number) => Promise<void>;
}, subreddit: string, timeoutMs: number): Promise<boolean> {
  await page.goto(`https://www.reddit.com/r/${subreddit}/submit`, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await page.waitForTimeout(1500);

  if (page.url().includes("/login")) {
    await resolveWelcomeBackLoop(page);
    await page.goto(`https://www.reddit.com/r/${subreddit}/submit`, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page.waitForTimeout(1500);
  }

  const titleInput = page
    .locator('textarea[name="title"], textarea[name="title-textarea"], textarea#innerTextArea')
    .first();
  return await titleInput.isVisible().catch(() => false);
}

export async function postToRedditPlaywright(
  _ctx: IntegrationContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const playwright = await import("playwright");
  const subreddit = typeof args.subreddit === "string" ? args.subreddit.trim().replace(/^r\//i, "") : "";
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!subreddit || !title) {
    throw new Error("subreddit and title are required for post_reddit");
  }

  const kind = args.kind === "link" ? "link" : "self";
  const text = typeof args.text === "string" ? args.text : "";
  const linkUrl = typeof args.url === "string" ? args.url.trim() : "";
  if (kind === "link" && !linkUrl) {
    throw new Error("url is required when kind=link for post_reddit");
  }

  const usernameRaw =
    typeof args.username === "string" && args.username.trim().length > 0
      ? args.username.trim()
      : (process.env.REDDIT_USERNAME ?? "").trim();
  const username = usernameRaw.replace(/^u\//i, "");
  if (!username) {
    throw new Error("REDDIT_USERNAME is required for Playwright Reddit posting");
  }

  const password =
    typeof args.password === "string" && args.password.trim().length > 0
      ? args.password.trim()
      : (process.env.REDDIT_PASSWORD ?? "").trim();

  const explicitSessionPath =
    typeof args.storageStatePath === "string" && args.storageStatePath.trim().length > 0
      ? args.storageStatePath.trim()
      : null;
  const configuredSessionPathRaw = explicitSessionPath ?? getConfiguredRedditStorageStatePath();
  const configuredSessionPath = resolveRedditStorageStatePath(configuredSessionPathRaw);
  const sessionPath =
    resolveExistingRedditStorageStatePath(configuredSessionPathRaw)
    ?? configuredSessionPath;
  const userDataDirRaw =
    typeof args.userDataDir === "string" && args.userDataDir.trim().length > 0
      ? args.userDataDir.trim()
      : (process.env.PLAYWRIGHT_USER_DATA_DIR ?? "").trim();
  const userDataDir = userDataDirRaw ? resolveSessionPath(userDataDirRaw) : null;

  const hasInitialStorageState = existsSync(sessionPath);
  const requireStorageState =
    typeof args.requireStorageState === "boolean"
      ? args.requireStorageState
      : isRedditStorageStateRequired(true);
  const allowPasswordLogin =
    typeof args.allowPasswordLogin === "boolean"
      ? args.allowPasswordLogin
      : parseBoolean(process.env.REDDIT_ALLOW_PASSWORD_LOGIN, false);

  if (requireStorageState && !hasInitialStorageState) {
    throw new Error(
      `Reddit storage state is required but missing. Looked for ${sessionPath}. Run 'pnpm reddit:bootstrap-session' to create a fresh session and set REDDIT_STORAGE_STATE_PATH (or REDDIT_STORAGE_PATH), or provide REDDIT_STORAGE_BASE64 for runtime materialization.`,
    );
  }

  if (!hasInitialStorageState && !allowPasswordLogin) {
    throw new Error(
      "No Reddit storage state found and password-login fallback is disabled. Set REDDIT_ALLOW_PASSWORD_LOGIN=true only for one-time recovery, then bootstrap storage state.",
    );
  }

  const timeoutMs = Math.max(10_000, Number(args.timeoutMs ?? process.env.PLAYWRIGHT_TIMEOUT_MS ?? 60_000));
  const maxAttempts = Math.max(1, Math.min(6, Math.round(Number(args.maxAttempts ?? process.env.REDDIT_MAX_ATTEMPTS ?? 3))));
  const retryDelayMs = Math.max(0, Math.round(Number(args.retryDelayMs ?? process.env.REDDIT_RETRY_DELAY_MS ?? 8_000)));
  const preSubmitDelayMs = Math.max(0, Math.round(Number(args.preSubmitDelayMs ?? process.env.REDDIT_PRE_SUBMIT_DELAY_MS ?? 3_000)));
  const uniqueUserDataDir = parseBoolean(args.uniqueUserDataDir ?? process.env.REDDIT_UNIQUE_USER_DATA_DIR, true);
  const headfulRequested = parseBoolean(process.env.REDDIT_HEADFUL, false);
  const headless =
    typeof args.headless === "boolean"
      ? args.headless
      : (headfulRequested ? false : parseBoolean(process.env.PLAYWRIGHT_HEADLESS, false));

  const fallbackUrlSelectors = [
    'input[name="url"]:not([disabled])',
    'input[name="link"]:not([disabled])',
    'textarea[name="link"]:not([disabled])',
    'textarea[name="outboundUrl"]:not([disabled])',
    'input[placeholder*="https"]:not([disabled])',
    'input[aria-label*="URL" i]:not([disabled])',
    'textarea[aria-label*="URL" i]:not([disabled])',
    '#innerTextArea[name="outboundUrl"]',
  ];

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let browser: Awaited<ReturnType<typeof playwright.chromium.launch>> | null = null;
    let context: Awaited<ReturnType<typeof playwright.chromium.launchPersistentContext>> | null = null;

    const attemptUserDataDir =
      userDataDir && uniqueUserDataDir ? path.join(userDataDir, `reddit-${Date.now()}-${attempt}`) : userDataDir;

    try {
      if (attemptUserDataDir) {
        await mkdir(attemptUserDataDir, { recursive: true });
        const hasState = existsSync(sessionPath);
        context = await playwright.chromium.launchPersistentContext(attemptUserDataDir, {
          ...getPlaywrightLaunchOptions(headless),
          ...(hasState ? getPlaywrightContextOptions(sessionPath) : getPlaywrightContextOptions()),
        });
      } else {
        browser = await playwright.chromium.launch(getPlaywrightLaunchOptions(headless));
        const hasState = existsSync(sessionPath);
        context = await browser.newContext(
          hasState ? getPlaywrightContextOptions(sessionPath) : getPlaywrightContextOptions(),
        );
      }

      const page = await context.newPage();
      await page.waitForTimeout(500 + Math.min(2_500, attempt * 400));
      let submitAccess = await hasRedditSubmitAccess(page, subreddit, timeoutMs);
      console.log("REDDIT DEBUG:", {
        storageUsed: existsSync(sessionPath),
        currentUrl: page.url(),
        subreddit,
        attempt,
        submitAccess,
      });
      if (!submitAccess) {
        const welcomeBackLoop = await page.locator("text=Welcome back!").first().isVisible().catch(() => false);
        console.log("REDDIT DEBUG:", {
          storageUsed: existsSync(sessionPath),
          currentUrl: page.url(),
          subreddit,
          attempt,
          submitAccess,
          welcomeBackLoop,
          requireStorageState,
          allowPasswordLogin,
        });
        if (!allowPasswordLogin) {
          throw new Error(
            `Reddit session is not authenticated for /r/${subreddit}/submit (url=${page.url()}, welcomeBack=${welcomeBackLoop}). Re-bootstrap storage state and retry.`,
          );
        }

        if (!password) {
          throw new Error("REDDIT_PASSWORD is required when REDDIT_ALLOW_PASSWORD_LOGIN=true and storage state is invalid.");
        }

        if (page.url().includes("/login") || welcomeBackLoop) {
          await ensureRedditLogin(page, { username, password: password || undefined, timeoutMs });
          await page.waitForTimeout(3000);
          submitAccess = await hasRedditSubmitAccess(page, subreddit, timeoutMs);
          console.log("REDDIT DEBUG:", {
            storageUsed: existsSync(sessionPath),
            currentUrl: page.url(),
            subreddit,
            attempt,
            submitAccess,
            phase: "post_login_recovery",
          });
        }

        if (!submitAccess) {
          throw new Error(`SESSION_EXPIRED: unable to access /r/${subreddit}/submit after login recovery`);
        }
      }

      const finalTitleInput = page
        .locator('textarea[name="title"], textarea[name="title-textarea"], textarea#innerTextArea')
        .first();
      await finalTitleInput.waitFor({ timeout: timeoutMs });
      await finalTitleInput.fill(title);

      if (kind === "self") {
        const bodyInput = page.locator('[data-testid="post-content-textarea"]').first();
        if (await bodyInput.isVisible().catch(() => false)) {
          await bodyInput.fill(text || "Generated by Paperclip agent");
        } else {
          const fallbackEditor = page.locator('div[contenteditable="true"]').first();
          await fallbackEditor.waitFor({ timeout: timeoutMs });
          await fallbackEditor.fill(text || "Generated by Paperclip agent");
        }
      } else {
        const linkTab = page
          .locator(
            'button:has-text("Link"), [role="tab"]:has-text("Link"), button[aria-label*="Link"], button[data-testid*="tab-link"], [role="tab"][aria-label*="Link"]',
          )
          .first();
        if (await linkTab.isVisible().catch(() => false)) {
          await linkTab.click().catch(() => undefined);
          await page.waitForTimeout(1500);
        }

        let filledUrl = false;
        for (const selector of fallbackUrlSelectors) {
          const candidate = page.locator(selector).first();
          if (!(await candidate.isVisible().catch(() => false))) {
            continue;
          }
          await candidate.fill(linkUrl).catch(() => undefined);
          const value = await candidate.inputValue().catch(() => "");
          if (value && value.trim().length > 0) {
            filledUrl = true;
            break;
          }
        }
        if (!filledUrl) {
          throw new Error(`Unable to locate visible Reddit URL input after trying ${fallbackUrlSelectors.length} selectors`);
        }
      }

      if (preSubmitDelayMs > 0) {
        await page.waitForTimeout(preSubmitDelayMs);
      }

      const submitButton = page
        .locator('button:has-text("Post"), button[type="submit"], [data-testid*="post-submit"]')
        .first();
      await submitButton.waitFor({ timeout: timeoutMs });
      await submitButton.click();

      await page.waitForTimeout(3500);
      const postUrl = page.url();
      const looksLikeSubmitPage = postUrl.includes("/submit") || postUrl.includes("type=LINK");
      if (looksLikeSubmitPage) {
        throw new Error(`Reddit post was not confirmed. Final URL stayed on submit flow: ${postUrl}`);
      }

      await saveStorageState(context, sessionPath);

      return {
        posted: true,
        platform: "reddit",
        username,
        subreddit,
        kind,
        postUrl,
        currentUrl: page.url(),
        userDataDir: attemptUserDataDir,
        storageStatePath: sessionPath,
        mode: "playwright",
        authMode: hasInitialStorageState ? "storage_state" : "password_login",
        attempt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = new Error(`Reddit attempt ${attempt}/${maxAttempts} failed: ${message}`);
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs);
      }
    } finally {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }

  throw lastError ?? new Error("Reddit posting failed with unknown error");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDeploymentUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function normalizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function scoreCopyVariant(params: { headline: string; subheadline: string; cta: string }): number {
  const headline = params.headline.toLowerCase();
  const subheadline = params.subheadline.toLowerCase();
  const cta = params.cta.toLowerCase();

  let score = 40;
  if (/\d/.test(headline)) score += 15;
  if (/(founder|builder|startup|team|marketer)/.test(headline)) score += 12;
  if (/(free|weekly|today|minutes|hours)/.test(subheadline)) score += 10;
  if (/(join|start|get|try|subscribe)/.test(cta)) score += 12;
  if (headline.length >= 28 && headline.length <= 80) score += 8;
  if (cta.length >= 8 && cta.length <= 26) score += 3;

  return Math.max(1, Math.min(100, score));
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function exchangeXClientCredentialsForToken(params: {
  endpoint: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const basic = Buffer.from(`${params.clientId}:${params.clientSecret}`).toString("base64");

  const primaryBody = new URLSearchParams();
  primaryBody.set("grant_type", "client_credentials");
  primaryBody.set("client_id", params.clientId);

  const primaryResponse = await fetch(params.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: primaryBody.toString(),
  });

  let body = await primaryResponse.json().catch(() => ({}));
  if (!primaryResponse.ok) {
    const fallbackBody = new URLSearchParams();
    fallbackBody.set("grant_type", "client_credentials");
    fallbackBody.set("client_id", params.clientId);
    fallbackBody.set("client_secret", params.clientSecret);

    const fallbackResponse = await fetch(params.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: fallbackBody.toString(),
    });

    body = await fallbackResponse.json().catch(() => ({}));
    if (!fallbackResponse.ok) {
      throw new Error(
        `Token exchange failed at ${params.endpoint} (status ${fallbackResponse.status}): ${JSON.stringify(body)}`,
      );
    }
  }

  const accessToken = typeof body?.access_token === "string" ? body.access_token.trim() : "";
  if (!accessToken) {
    throw new Error(`Token exchange response from ${params.endpoint} missing access_token`);
  }

  return accessToken;
}

export async function resolveXBearerToken(
  ctx: IntegrationContext,
  args: Record<string, unknown>,
): Promise<XBearerTokenResolution | null> {
  const bearerToken = pickCredential(ctx, args.bearerToken, [
    "X_BEARER_TOKEN",
    "X_API_KEY",
    "TWITTER_BEARER_TOKEN",
  ]);
  if (bearerToken) {
    return { token: bearerToken, source: "bearer" };
  }

  const clientId = pickCredential(ctx, args.clientId, ["X_CLIENT_ID", "X_API_CLIENT_ID", "TWITTER_CLIENT_ID"]);
  const clientSecret = pickCredential(ctx, args.clientSecret, [
    "X_CLIENT_SECRET",
    "X_API_CLIENT_SECRET",
    "TWITTER_CLIENT_SECRET",
  ]);

  if (!clientId || !clientSecret) {
    return null;
  }

  const customEndpoint =
    typeof args.oauthTokenUrl === "string" && args.oauthTokenUrl.trim().length > 0
      ? args.oauthTokenUrl.trim()
      : null;

  const endpointCandidates = customEndpoint
    ? [customEndpoint, ...X_CLIENT_CREDENTIALS_TOKEN_ENDPOINTS]
    : [...X_CLIENT_CREDENTIALS_TOKEN_ENDPOINTS];
  const endpoints = [...new Set(endpointCandidates)];

  let lastError: Error | null = null;
  for (const endpoint of endpoints) {
    try {
      const token = await exchangeXClientCredentialsForToken({
        endpoint,
        clientId,
        clientSecret,
      });
      return { token, source: "client_credentials" };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw new Error(
    `Could not exchange X client credentials for access token: ${lastError?.message ?? "unknown error"}`,
  );
}

function buildOAuth1Header(params: {
  method: string;
  requestUrl: string;
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}): string {
  const url = new URL(params.requestUrl);
  const method = params.method.toUpperCase();
  const nonce = randomBytes(16).toString("hex");
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: params.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: params.accessToken,
    oauth_version: "1.0",
  };

  const allParams: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams.entries()) {
    allParams.push([key, value]);
  }
  for (const [key, value] of Object.entries(oauthParams)) {
    allParams.push([key, value]);
  }

  allParams.sort(([aKey, aValue], [bKey, bValue]) => {
    if (aKey === bKey) return aValue.localeCompare(bValue);
    return aKey.localeCompare(bKey);
  });

  const normalizedParams = allParams
    .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`)
    .join("&");

  const normalizedUrl = `${url.protocol}//${url.host}${url.pathname}`;
  const baseString = [
    method,
    percentEncode(normalizedUrl),
    percentEncode(normalizedParams),
  ].join("&");

  const signingKey = `${percentEncode(params.consumerSecret)}&${percentEncode(params.accessTokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  const headerParams = {
    ...oauthParams,
    oauth_signature: signature,
  };

  const authValue = Object.entries(headerParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
    .join(", ");

  return `OAuth ${authValue}`;
}

function normalizeMethod(raw: unknown): string {
  const method = typeof raw === "string" ? raw.toUpperCase() : "GET";
  if (!ALLOWED_HTTP_METHODS.has(method)) {
    throw new Error(`Unsupported HTTP method: ${method}`);
  }
  return method;
}

function addQueryParams(url: URL, query: unknown) {
  const params = asObject(query);
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item == null) continue;
        url.searchParams.append(key, String(item));
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
}

async function parseHttpResponse(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      return { parseError: "Invalid JSON response" };
    }
  }

  if (contentType.startsWith("text/")) {
    const text = await res.text();
    return text.length > 20_000 ? `${text.slice(0, 20_000)}...(truncated)` : text;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const base64 = buffer.toString("base64");
  return {
    encoding: "base64",
    data: base64.length > 24_000 ? `${base64.slice(0, 24_000)}...(truncated)` : base64,
    sizeBytes: buffer.byteLength,
  };
}

export async function executeHttpApiRequest(
  _ctx: IntegrationContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const method = normalizeMethod(args.method);
  const rawUrl = typeof args.url === "string" ? args.url : "";
  if (!rawUrl) throw new Error("url is required");

  const url = new URL(rawUrl);
  addQueryParams(url, args.query);

  const headers = asStringRecord(args.headers);
  const timeoutMs = Math.max(1_000, Number(args.timeoutMs ?? 30_000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let body: BodyInit | undefined;
  if (args.body != null && method !== "GET" && method !== "HEAD") {
    if (typeof args.body === "string") {
      body = args.body;
    } else {
      if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }
      body = JSON.stringify(args.body);
    }
  }

  try {
    const response = await fetch(url.toString(), {
      method,
      headers,
      body,
      signal: controller.signal,
    });

    const parsedBody = await parseHttpResponse(response);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: parsedBody,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function tavilyWebSearch(
  ctx: IntegrationContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const apiKey = pickCredential(ctx, args.apiKey, ["TAVILY_API_KEY"]);
  if (!apiKey) throw new Error("Missing Tavily API key (TAVILY_API_KEY)");

  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("query is required for Tavily web search");

  const searchDepth = args.searchDepth === "advanced" ? "advanced" : "basic";
  const maxResultsRaw = Number(args.maxResults ?? 5);
  const maxResults = Number.isFinite(maxResultsRaw)
    ? Math.max(1, Math.min(20, Math.floor(maxResultsRaw)))
    : 5;

  const payload: Record<string, unknown> = {
    query,
    search_depth: searchDepth,
    max_results: maxResults,
  };

  if (typeof args.includeAnswer === "boolean") payload.include_answer = args.includeAnswer;
  if (typeof args.includeImages === "boolean") payload.include_images = args.includeImages;
  if (typeof args.topic === "string" && args.topic.trim().length > 0) payload.topic = args.topic.trim();

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Tavily API error ${res.status}: ${JSON.stringify(body)}`);
  }

  return {
    query,
    answer: typeof body?.answer === "string" ? body.answer : null,
    results: Array.isArray(body?.results)
      ? body.results.map((entry: unknown) => {
          const row = asObject(entry);
          return {
            title: typeof row.title === "string" ? row.title : null,
            url: typeof row.url === "string" ? row.url : null,
            content: typeof row.content === "string" ? row.content : null,
            score: typeof row.score === "number" ? row.score : null,
          };
        })
      : [],
  };
}

export async function posthogTrackEvent(
  ctx: IntegrationContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const apiKey = pickCredential(ctx, args.apiKey, ["POSTHOG_API_KEY"]);
  if (!apiKey) throw new Error("Missing PostHog API key (POSTHOG_API_KEY)");

  const event = typeof args.event === "string" ? args.event.trim() : "";
  if (!event) throw new Error("event is required for posthog_track_event");

  const distinctId =
    typeof args.distinctId === "string" && args.distinctId.trim().length > 0
      ? args.distinctId.trim()
      : "paperclip-agent";

  const hostRaw = pickCredential(ctx, args.host, ["POSTHOG_HOST"]);
  const host = (hostRaw ?? "https://us.i.posthog.com").replace(/\/$/, "");
  const properties = asObject(args.properties);

  const payload: Record<string, unknown> = {
    api_key: apiKey,
    event,
    distinct_id: distinctId,
    properties,
  };

  const timestamp = typeof args.timestamp === "string" ? args.timestamp.trim() : "";
  if (timestamp) payload.timestamp = timestamp;

  const res = await fetch(`${host}/capture/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`PostHog API error ${res.status}: ${JSON.stringify(body)}`);
  }

  return {
    status: "tracked",
    event,
    distinctId,
    host,
    response: body,
  };
}

type BrowserStepAction =
  | "goto"
  | "click"
  | "fill"
  | "press"
  | "wait_for_selector"
  | "extract_text"
  | "screenshot";

interface BrowserStep {
  action: BrowserStepAction;
  selector?: string;
  value?: string;
  key?: string;
  url?: string;
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  timeoutMs?: number;
  name?: string;
  fullPage?: boolean;
}

export async function executeBrowserAutomation(
  _ctx: IntegrationContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const playwright = await import("playwright");
  const headless = args.headless !== false;
  const timeoutMs = Math.max(1_000, Number(args.timeoutMs ?? 30_000));
  const initialUrl = typeof args.url === "string" ? args.url : null;
  const stepsInput = Array.isArray(args.steps) ? args.steps : [];
  const steps = stepsInput.map((step) => asObject(step) as unknown as BrowserStep);

  const browser = await playwright.chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  const extracted: Record<string, string | null> = {};
  const screenshots: Array<{ name: string; dataBase64: string }> = [];

  try {
    if (initialUrl) {
      await page.goto(initialUrl, { waitUntil: "domcontentloaded" });
    }

    for (const rawStep of steps) {
      const step = rawStep;
      const action = step.action;

      if (!action) continue;

      if (action === "goto") {
        if (!step.url) throw new Error("browser step 'goto' requires url");
        await page.goto(step.url, {
          waitUntil: step.waitUntil ?? "domcontentloaded",
          timeout: step.timeoutMs ?? timeoutMs,
        });
        continue;
      }

      if (action === "click") {
        if (!step.selector) throw new Error("browser step 'click' requires selector");
        await page.click(step.selector, { timeout: step.timeoutMs ?? timeoutMs });
        continue;
      }

      if (action === "fill") {
        if (!step.selector) throw new Error("browser step 'fill' requires selector");
        await page.fill(step.selector, step.value ?? "", { timeout: step.timeoutMs ?? timeoutMs });
        continue;
      }

      if (action === "press") {
        if (!step.key) throw new Error("browser step 'press' requires key");
        await page.keyboard.press(step.key);
        continue;
      }

      if (action === "wait_for_selector") {
        if (!step.selector) throw new Error("browser step 'wait_for_selector' requires selector");
        await page.waitForSelector(step.selector, { timeout: step.timeoutMs ?? timeoutMs });
        continue;
      }

      if (action === "extract_text") {
        if (!step.selector) throw new Error("browser step 'extract_text' requires selector");
        const value = await page.textContent(step.selector, { timeout: step.timeoutMs ?? timeoutMs });
        const key = step.name ?? step.selector;
        extracted[key] = value?.trim() ?? null;
        continue;
      }

      if (action === "screenshot") {
        const buffer = await page.screenshot({ fullPage: step.fullPage ?? true });
        const base64 = buffer.toString("base64");
        screenshots.push({
          name: step.name ?? `shot_${screenshots.length + 1}`,
          dataBase64: base64.length > 24_000 ? `${base64.slice(0, 24_000)}...(truncated)` : base64,
        });
      }
    }

    return {
      url: page.url(),
      title: await page.title(),
      extracted,
      screenshots,
    };
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

export async function postXThread(
  ctx: IntegrationContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const xMockMode =
    parseBoolean(args.mockMode, false) ||
    parseBoolean(ctx.integrationEnv.X_MOCK_MODE, false) ||
    parseBoolean(process.env.X_MOCK_MODE, false);

  const consumerKey = pickCredential(ctx, args.consumerKey, ["X_CONSUMER_KEY"]);
  const consumerSecret = pickCredential(ctx, args.consumerSecret, ["X_CONSUMER_SECRET", "X_CONSUMER_KEY_SECRET", "X_API_SECRET"]);
  const accessToken = pickCredential(ctx, args.accessToken, ["X_ACCESS_TOKEN"]);
  const accessTokenSecret = pickCredential(ctx, args.accessTokenSecret, ["X_ACCESS_TOKEN_SECRET"]);

  const useOAuth1 =
    !!consumerKey &&
    !!consumerSecret &&
    !!accessToken &&
    !!accessTokenSecret;

  const bearerResolution = useOAuth1
    ? null
    : await resolveXBearerToken(ctx, args);
  const bearerToken = bearerResolution?.token ?? null;

  if (!useOAuth1 && !bearerToken) {
    throw new Error(
      "Missing X credentials. Provide bearer token (X_BEARER_TOKEN), client credentials (X_CLIENT_ID + X_CLIENT_SECRET), or OAuth1a user credentials (X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET)",
    );
  }

  const apiBaseUrl =
    typeof args.apiBaseUrl === "string" && args.apiBaseUrl.trim().length > 0
      ? args.apiBaseUrl
      : "https://api.twitter.com/2";

  const parts: string[] = [];
  if (typeof args.text === "string" && args.text.trim()) {
    parts.push(args.text.trim());
  }
  if (Array.isArray(args.thread)) {
    for (const part of args.thread) {
      if (typeof part === "string" && part.trim()) parts.push(part.trim());
    }
  }
  if (parts.length === 0) throw new Error("Provide text or thread[] to post on X");

  if (xMockMode) {
    const now = Date.now();
    const tweets = parts.map((text, index) => ({
      id: `mock_${now}_${index + 1}`,
      text,
    }));

    return {
      mocked: true,
      message: "X mock mode enabled (X_MOCK_MODE=true). No request sent to X API.",
      postedCount: tweets.length,
      tweets,
    };
  }

  let replyTo = typeof args.replyToTweetId === "string" ? args.replyToTweetId : null;
  const posted: Array<{ id: string; text: string }> = [];

  for (const text of parts) {
    const payload: Record<string, unknown> = { text };
    if (replyTo) {
      payload.reply = { in_reply_to_tweet_id: replyTo };
    }

    const res = await fetch(`${apiBaseUrl}/tweets`, {
      method: "POST",
      headers: {
        Authorization: useOAuth1
          ? buildOAuth1Header({
              method: "POST",
              requestUrl: `${apiBaseUrl}/tweets`,
              consumerKey: consumerKey!,
              consumerSecret: consumerSecret!,
              accessToken: accessToken!,
              accessTokenSecret: accessTokenSecret!,
            })
          : `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`X API error ${res.status}: ${JSON.stringify(body)}`);
    }

    const id = typeof body?.data?.id === "string" ? body.data.id : null;
    if (!id) throw new Error("X API response missing tweet id");

    posted.push({ id, text });
    replyTo = id;
  }

  return {
    authMode: useOAuth1 ? "oauth1a" : (bearerResolution?.source ?? "bearer"),
    postedCount: posted.length,
    tweets: posted,
  };
}

export async function submitRedditPost(
  ctx: IntegrationContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const token = pickCredential(ctx, args.accessToken, ["REDDIT_ACCESS_TOKEN"]);
  if (!token) throw new Error("Missing Reddit access token (REDDIT_ACCESS_TOKEN)");

  const subreddit = typeof args.subreddit === "string" ? args.subreddit.trim() : "";
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!subreddit || !title) {
    throw new Error("subreddit and title are required");
  }

  const kind = args.kind === "link" ? "link" : "self";
  const apiBaseUrl =
    typeof args.apiBaseUrl === "string" && args.apiBaseUrl.trim().length > 0
      ? args.apiBaseUrl
      : "https://oauth.reddit.com";
  const userAgent =
    typeof args.userAgent === "string" && args.userAgent.trim().length > 0
      ? args.userAgent
      : "paperclip-agent/1.0";

  const form = new URLSearchParams();
  form.set("sr", subreddit);
  form.set("title", title);
  form.set("kind", kind);
  form.set("resubmit", "true");
  form.set("sendreplies", "true");
  form.set("api_type", "json");

  if (kind === "self") {
    form.set("text", typeof args.text === "string" ? args.text : "");
  } else {
    const linkUrl = typeof args.url === "string" ? args.url.trim() : "";
    if (!linkUrl) throw new Error("url is required for link posts");
    form.set("url", linkUrl);
  }

  const res = await fetch(`${apiBaseUrl}/api/submit`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body: form.toString(),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Reddit API error ${res.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

export async function createNotionPage(
  ctx: IntegrationContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const token = pickCredential(ctx, args.apiKey, ["NOTION_API_KEY"]);
  if (!token) throw new Error("Missing Notion API key (NOTION_API_KEY)");

  const parentPageId = typeof args.parentPageId === "string" ? args.parentPageId.trim() : "";
  const parentDatabaseId =
    typeof args.parentDatabaseId === "string" ? args.parentDatabaseId.trim() : "";

  if (!parentPageId && !parentDatabaseId) {
    throw new Error("parentPageId or parentDatabaseId is required");
  }

  const title = typeof args.title === "string" ? args.title.trim() : "Untitled";
  const titlePropertyName =
    typeof args.titlePropertyName === "string" && args.titlePropertyName.trim().length > 0
      ? args.titlePropertyName.trim()
      : parentDatabaseId
        ? "Name"
        : "title";

  const payload: Record<string, unknown> = {
    parent: parentDatabaseId
      ? { database_id: parentDatabaseId }
      : { page_id: parentPageId },
  };

  const properties = asObject(args.properties);
  payload.properties =
    Object.keys(properties).length > 0
      ? properties
      : {
          [titlePropertyName]: {
            title: [{ type: "text", text: { content: title } }],
          },
        };

  if (Array.isArray(args.children)) {
    payload.children = args.children;
  }

  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Notion API error ${res.status}: ${JSON.stringify(body)}`);
  }

  return {
    id: body.id,
    url: body.url,
    createdTime: body.created_time,
    archived: body.archived,
  };
}

interface CheckoutLineItem {
  name: string;
  amountCents: number;
  quantity?: number;
  currency?: string;
}

function parseLineItems(raw: unknown, defaultCurrency: string): CheckoutLineItem[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("lineItems[] is required");
  }

  const items: CheckoutLineItem[] = [];
  for (const entry of raw) {
    const row = asObject(entry);
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const amountCents = Number(row.amountCents);
    if (!name || !Number.isFinite(amountCents) || amountCents <= 0) {
      throw new Error("Each line item must include name and positive amountCents");
    }

    items.push({
      name,
      amountCents: Math.round(amountCents),
      quantity: Number.isFinite(Number(row.quantity)) ? Math.max(1, Number(row.quantity)) : 1,
      currency:
        typeof row.currency === "string" && row.currency.trim().length > 0
          ? row.currency.toLowerCase()
          : defaultCurrency,
    });
  }
  return items;
}

export async function createStripeCheckoutSession(
  ctx: IntegrationContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const apiKey = pickCredential(ctx, args.apiKey, ["STRIPE_API_KEY"]);
  if (!apiKey) throw new Error("Missing Stripe API key (STRIPE_API_KEY)");

  const successUrl = typeof args.successUrl === "string" ? args.successUrl.trim() : "";
  const cancelUrl = typeof args.cancelUrl === "string" ? args.cancelUrl.trim() : "";
  if (!successUrl || !cancelUrl) {
    throw new Error("successUrl and cancelUrl are required");
  }

  const mode = args.mode === "subscription" ? "subscription" : "payment";
  const defaultCurrency =
    typeof args.currency === "string" && args.currency.trim().length > 0
      ? args.currency.trim().toLowerCase()
      : "usd";

  const lineItems = parseLineItems(args.lineItems, defaultCurrency);

  const form = new URLSearchParams();
  form.set("mode", mode);
  form.set("success_url", successUrl);
  form.set("cancel_url", cancelUrl);

  lineItems.forEach((item, index) => {
    form.set(`line_items[${index}][quantity]`, String(item.quantity ?? 1));
    form.set(`line_items[${index}][price_data][currency]`, item.currency ?? defaultCurrency);
    form.set(`line_items[${index}][price_data][unit_amount]`, String(item.amountCents));
    form.set(`line_items[${index}][price_data][product_data][name]`, item.name);
  });

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Stripe API error ${res.status}: ${JSON.stringify(body)}`);
  }

  return {
    id: body.id,
    url: body.url,
    mode: body.mode,
    status: body.status,
  };
}

export async function createDodoCheckoutSession(
  ctx: IntegrationContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const hostedCheckoutUrl = pickCredential(ctx, args.hostedCheckoutUrl, ["DODO_PAYMENTS_CHECKOUT_URL"]);
  const useHostedCheckoutUrl =
    parseBoolean(args.useHostedCheckoutUrl, false) ||
    parseBoolean(ctx.integrationEnv.DODO_USE_HOSTED_CHECKOUT_URL, false) ||
    parseBoolean(process.env.DODO_USE_HOSTED_CHECKOUT_URL, false);
  const fallbackToHostedCheckoutUrl =
    parseBoolean(args.fallbackToHostedCheckoutUrl, true) &&
    !!hostedCheckoutUrl;

  if (useHostedCheckoutUrl) {
    if (!hostedCheckoutUrl) {
      throw new Error(
        "Hosted checkout mode requested but DODO_PAYMENTS_CHECKOUT_URL is not configured",
      );
    }

    return {
      mode: "hosted_checkout_url",
      url: hostedCheckoutUrl,
      source: "dodo_hosted_checkout",
      message: "Using configured Dodo hosted checkout URL.",
    };
  }

  const apiKey = pickCredential(ctx, args.apiKey, ["DODO_PAYMENTS_API_KEY", "DODO_API_KEY"]);
  if (!apiKey) {
    if (fallbackToHostedCheckoutUrl) {
      return {
        mode: "hosted_checkout_url",
        url: hostedCheckoutUrl,
        source: "dodo_hosted_checkout_fallback",
        warning: "Dodo API key is missing, using hosted checkout URL fallback.",
      };
    }
    throw new Error("Missing Dodo Payments API key (DODO_PAYMENTS_API_KEY)");
  }

  const dodoEnvironment = (process.env.DODO_PAYMENTS_ENVIRONMENT ?? "").trim().toLowerCase();
  const defaultBaseUrl = dodoEnvironment === "test_mode"
    ? "https://test.dodopayments.com"
    : "https://live.dodopayments.com";
  const baseUrl =
    typeof args.apiBaseUrl === "string" && args.apiBaseUrl.trim().length > 0
      ? args.apiBaseUrl.trim()
      : (ctx.integrationEnv.DODO_PAYMENTS_BASE_URL ?? process.env.DODO_PAYMENTS_BASE_URL ?? defaultBaseUrl);

  const endpointPath =
    typeof args.endpointPath === "string" && args.endpointPath.trim().length > 0
      ? args.endpointPath.trim()
      : "/checkouts";

  const payload = asObject(args.payload);
  if (Object.keys(payload).length === 0) {
    throw new Error("payload is required for Dodo checkout session creation");
  }

  const res = await fetch(`${baseUrl}${endpointPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (fallbackToHostedCheckoutUrl) {
      return {
        mode: "hosted_checkout_url",
        url: hostedCheckoutUrl,
        source: "dodo_hosted_checkout_fallback",
        warning: `Dodo API returned ${res.status}; using hosted checkout URL fallback.`,
        apiError: body,
      };
    }
    throw new Error(`Dodo Payments API error ${res.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

export async function sendResendEmail(
  ctx: IntegrationContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const apiKey = pickCredential(ctx, args.apiKey, ["RESEND_API_KEY"]);
  if (!apiKey) throw new Error("Missing Resend API key (RESEND_API_KEY)");

  const from = typeof args.from === "string" ? args.from.trim() : "";
  const subject = typeof args.subject === "string" ? args.subject.trim() : "";
  const to = Array.isArray(args.to)
    ? args.to.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : typeof args.to === "string" && args.to.trim().length > 0
      ? [args.to]
      : [];

  if (!from || !subject || to.length === 0) {
    throw new Error("from, to, and subject are required for email sending");
  }

  const payload: Record<string, unknown> = {
    from,
    to,
    subject,
  };

  if (typeof args.html === "string" && args.html.length > 0) payload.html = args.html;
  if (typeof args.text === "string" && args.text.length > 0) payload.text = args.text;
  if (Array.isArray(args.cc)) payload.cc = args.cc;
  if (Array.isArray(args.bcc)) payload.bcc = args.bcc;
  if (typeof args.replyTo === "string" && args.replyTo.trim().length > 0) {
    payload.reply_to = args.replyTo.trim();
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Resend API error ${res.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

export async function triggerVercelDeploy(
  ctx: IntegrationContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  let payloadWarnings: string[] = [];

  const parseDeployMode = (value: unknown): "auto" | "api" | "deploy_hook" => {
    if (typeof value !== "string") return "auto";
    const normalized = value.trim().toLowerCase();
    if (!normalized) return "auto";
    if (["api", "dynamic", "v13"].includes(normalized)) return "api";
    if (["deploy_hook", "hook"].includes(normalized)) return "deploy_hook";
    return "auto";
  };

  const parseProjectIdFromHookUrl = (value: string): string => {
    try {
      const url = new URL(value);
      const parts = url.pathname.split("/").filter(Boolean);
      const deployIndex = parts.findIndex((part) => part === "deploy");
      if (deployIndex >= 0 && parts.length > deployIndex + 1) {
        return parts[deployIndex + 1] ?? "";
      }
    } catch {
      return "";
    }
    return "";
  };

  const buildApiPayload = (
    inputArgs: Record<string, unknown>,
    explicitPayload: JsonObject,
  ): JsonObject => {
    payloadWarnings = [];
    if (Object.keys(explicitPayload).length > 0) {
      return explicitPayload;
    }

    const filesInput = Array.isArray(inputArgs.files) ? inputArgs.files : [];
    const files = filesInput
      .map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        const objectEntry = entry as Record<string, unknown>;
        const file = typeof objectEntry.file === "string" ? objectEntry.file.trim() : "";
        const data = typeof objectEntry.data === "string" ? objectEntry.data : "";
        if (!file || !data) return null;
        return { file, data };
      })
      .filter((entry): entry is { file: string; data: string } => entry !== null);

    if (files.length > 0) {
      const generatedName = `paperclip-dynamic-${Date.now()}`;
      const payload: JsonObject = {
        name:
          typeof inputArgs.name === "string" && inputArgs.name.trim().length > 0
            ? inputArgs.name.trim()
            : generatedName,
        files,
      };

      if (typeof inputArgs.target === "string" && inputArgs.target.trim().length > 0) {
        payload.target = inputArgs.target.trim();
      }

      const projectSettings = asObject(inputArgs.projectSettings);
      if (Object.keys(projectSettings).length > 0) payload.projectSettings = projectSettings;

      const gitSource = asObject(inputArgs.gitSource);
      if (Object.keys(gitSource).length > 0) payload.gitSource = gitSource;

      return payload;
    }

    const generatedName = `paperclip-landing-${Date.now()}`;
    const headlineVariants = normalizeStringList(inputArgs.headlineVariants);
    const ctaVariants = normalizeStringList(inputArgs.ctaVariants);
    const subheadline =
      typeof inputArgs.subheadline === "string" && inputArgs.subheadline.trim().length > 0
        ? inputArgs.subheadline.trim()
        : "Join 1,200+ builders learning faster every week";

    const defaultHeadlines = [
      "5 AI Tools Saving Founders 10+ Hours Weekly",
      "Steal the Weekly AI Workflow Top Startups Use",
      "Turn AI Noise Into Growth in 15 Minutes a Week",
    ];
    const defaultCtas = ["Subscribe", "Get Weekly Playbook", "Start Free Weekly Digest"];

    const finalHeadlines = headlineVariants.length > 0 ? headlineVariants : defaultHeadlines;
    const finalCtas = ctaVariants.length > 0 ? ctaVariants : defaultCtas;

    const abVariants = finalHeadlines.map((headline, index) => {
      const cta = finalCtas[index % finalCtas.length] ?? finalCtas[0] ?? "Subscribe";
      return {
        headline,
        cta,
        score: scoreCopyVariant({ headline, subheadline, cta }),
      };
    }).sort((a, b) => b.score - a.score);

    const selectedVariant = abVariants[0] ?? {
      headline: defaultHeadlines[0],
      cta: defaultCtas[0],
      score: scoreCopyVariant({ headline: defaultHeadlines[0], subheadline, cta: defaultCtas[0] }),
    };

    const abVariantScript = JSON.stringify(abVariants);
    const defaultCompanyId = typeof inputArgs.companyId === "string" && inputArgs.companyId.trim().length > 0
      ? inputArgs.companyId.trim()
      : "";

    const explicitPublicBaseUrl = pickCredential(ctx, inputArgs.publicBaseUrl, [
      "PUBLIC_API_BASE",
      "WAITLIST_PUBLIC_BASE_URL",
      "PAPERCLIP_PUBLIC_BASE_URL",
      "PAPERCLIP_AUTH_PUBLIC_BASE_URL",
    ]);
    const normalizedPublicBaseUrl = (explicitPublicBaseUrl ?? "").replace(/\/$/, "");
    const explicitSignupEndpoint = pickCredential(ctx, inputArgs.signupEndpoint, [
      "VITE_SIGNUP_ENDPOINT",
      "SIGNUP_ENDPOINT",
    ]);
    const explicitOfferClickEndpoint = pickCredential(ctx, inputArgs.offerClickEndpoint, [
      "WAITLIST_OFFER_CLICK_ENDPOINT",
      "OFFER_CLICK_ENDPOINT",
    ]);
    const derivedSignupEndpoint = normalizedPublicBaseUrl
      ? `${normalizedPublicBaseUrl}/api/waitlist/signup`
      : "";
    const derivedOfferClickEndpoint = normalizedPublicBaseUrl
      ? `${normalizedPublicBaseUrl}/api/waitlist/offer-click`
      : "";
    const preferDerivedSignupEndpoint =
      explicitSignupEndpoint != null
      && isLoopbackHttpUrl(explicitSignupEndpoint)
      && Boolean(derivedSignupEndpoint)
      && !isLoopbackHttpUrl(derivedSignupEndpoint);

    const preferDerivedOfferClickEndpoint =
      explicitOfferClickEndpoint != null
      && isLoopbackHttpUrl(explicitOfferClickEndpoint)
      && Boolean(derivedOfferClickEndpoint)
      && !isLoopbackHttpUrl(derivedOfferClickEndpoint);

    const signupEndpoint = (
      preferDerivedSignupEndpoint
        ? derivedSignupEndpoint
        : (explicitSignupEndpoint || derivedSignupEndpoint)
    ).trim();
    const offerClickEndpoint = (
      preferDerivedOfferClickEndpoint
        ? derivedOfferClickEndpoint
        : (explicitOfferClickEndpoint || derivedOfferClickEndpoint)
    ).trim();

    if (!signupEndpoint) {
      payloadWarnings.push(
      "Signup endpoint is not configured. Set PUBLIC_API_BASE (or WAITLIST_PUBLIC_BASE_URL/SIGNUP_ENDPOINT) to a public backend URL before sending traffic.",
      );
    } else if (isLoopbackHttpUrl(signupEndpoint)) {
      payloadWarnings.push(
        `Signup endpoint resolves to loopback (${signupEndpoint}). Deployed landing pages cannot post to localhost.`,
      );
    }

    if (!offerClickEndpoint && !pickCredential(ctx, inputArgs.paymentLink, ["WAITLIST_OFFER_PAYMENT_LINK", "DODO_PAYMENTS_CHECKOUT_URL"])) {
      payloadWarnings.push("Offer click endpoint/payment link is not configured; checkout redirect will be skipped after signup.");
    }
    const paymentLink = pickCredential(ctx, inputArgs.paymentLink, [
      "WAITLIST_OFFER_PAYMENT_LINK",
      "DODO_PAYMENTS_CHECKOUT_URL",
    ]);
    const posthogKey = pickCredential(ctx, inputArgs.posthogApiKey, [
      "VITE_POSTHOG_KEY",
      "POSTHOG_API_KEY",
    ]);
    const posthogHost = pickCredential(ctx, inputArgs.posthogHost, [
      "VITE_POSTHOG_HOST",
      "POSTHOG_HOST",
    ]) || "https://us.i.posthog.com";

    const defaultLandingHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Paperclip Weekly</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f8f5f0;
        --card: #fffefb;
        --ink: #1f2937;
        --muted: #4b5563;
        --accent: #0f766e;
      }
      body {
        margin: 0;
        font-family: "Georgia", "Times New Roman", serif;
        background: radial-gradient(circle at top right, #d9f3e8 0%, var(--bg) 58%);
        color: var(--ink);
      }
      main {
        max-width: 760px;
        margin: 48px auto;
        padding: 32px;
        border: 1px solid #e5e7eb;
        border-radius: 18px;
        background: var(--card);
        box-shadow: 0 24px 60px rgba(17, 24, 39, 0.08);
      }
      h1 {
        font-size: clamp(2rem, 4vw, 3rem);
        margin: 0 0 14px;
        line-height: 1.1;
      }
      p {
        margin: 0;
        font-size: 1.05rem;
        color: var(--muted);
      }
      ul {
        margin: 24px 0;
        padding-left: 20px;
        color: var(--muted);
      }
      li + li {
        margin-top: 8px;
      }
      form {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 22px;
      }
      input {
        flex: 1 1 260px;
        padding: 12px 14px;
        border: 1px solid #cbd5e1;
        border-radius: 10px;
        font: inherit;
      }
      button {
        padding: 12px 18px;
        border: none;
        border-radius: 10px;
        background: var(--accent);
        color: #ffffff;
        font: inherit;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <main>
      <h1 id="headline">${selectedVariant.headline}</h1>
      <p id="subheadline">${subheadline}</p>
      <ul>
        <li>Automate research and validation before shipping</li>
        <li>Capture and prioritize customer signals in one loop</li>
        <li>Turn weekly experiments into repeatable growth</li>
      </ul>
      <form id="waitlist-form">
        <input id="email" name="email" type="email" required placeholder="Enter email" aria-label="Email" />
        <button id="cta" type="button">${selectedVariant.cta}</button>
      </form>
      <p id="form-status" style="margin-top:10px;font-size:0.9rem;color:#0f766e;display:none;"></p>
      <p id="copy-score" style="margin-top:12px;font-size:0.9rem;color:#6b7280;">Copy score: ${selectedVariant.score}/100</p>
    </main>
    <script>
      (function () {
        var variants = ${abVariantScript};
        var SIGNUP_ENDPOINT = ${JSON.stringify(signupEndpoint)};
        var OFFER_CLICK_ENDPOINT = ${JSON.stringify(offerClickEndpoint)};
        var PAYMENT_LINK = ${JSON.stringify(paymentLink)};
        var POSTHOG_KEY = ${JSON.stringify(posthogKey)};
        var POSTHOG_HOST = ${JSON.stringify(posthogHost)};
        var posthogReady = false;

        if (POSTHOG_KEY) {
          !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split('.');2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement('script')).type='text/javascript',p.async=!0,p.src='https://us.i.posthog.com/static/array.js',(r=t.getElementsByTagName('script')[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a='posthog',u.people=u.people||[],u.toString=function(t){var e='posthog';return'posthog'!==a&&(e+='.'+a),t||(e+=' (stub)'),e},u.people.toString=function(){return u.toString(1)+'.people (stub)'},o='capture identify alias people.set people.set_once'.split(' '),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
          window.posthog.init(POSTHOG_KEY, { api_host: POSTHOG_HOST });
          posthogReady = true;
        }

        var capture = function (event, properties) {
          if (!posthogReady || !window.posthog) return;
          window.posthog.capture(event, properties || {});
        };

        var endpointLooksLoopback = /^https?:\/\/(localhost|127\.|0\.0\.0\.0)/i.test(SIGNUP_ENDPOINT);
        var runningOnLoopbackHost = /^(localhost|127\.|0\.0\.0\.0)$/i.test(window.location.hostname);
        if (endpointLooksLoopback && !runningOnLoopbackHost) {
          // Prevent silent production failures when a deployed page points to localhost.
          SIGNUP_ENDPOINT = "";
        }

        if (!Array.isArray(variants) || variants.length < 2) return;

        var key = "pc_ab_variant";
        var stored = window.localStorage.getItem(key);
        var chosenIndex = Number(stored);
        if (!Number.isInteger(chosenIndex) || chosenIndex < 0 || chosenIndex >= variants.length) {
          chosenIndex = Math.floor(Math.random() * variants.length);
          window.localStorage.setItem(key, String(chosenIndex));
        }

        var chosen = variants[chosenIndex];
        var headline = document.getElementById("headline");
        var cta = document.getElementById("cta");
        var score = document.getElementById("copy-score");
        var form = document.getElementById("waitlist-form");
        var emailInput = document.getElementById("email");
        var formStatus = document.getElementById("form-status");
        var companyId = ${JSON.stringify(defaultCompanyId)};
        if (headline) headline.textContent = chosen.headline;
        if (cta) cta.textContent = chosen.cta;
        if (score) score.textContent = "Copy score: " + chosen.score + "/100 (variant " + (chosenIndex + 1) + ")";

        capture("landing_view", {
          source: "vercel_landing",
          page_version: "vercel_dynamic",
          variant_id: chosen.id,
        });

        var showStatus = function (message, isError) {
          if (!formStatus) return;
          formStatus.style.display = "block";
          formStatus.style.color = isError ? "#dc2626" : "#0f766e";
          formStatus.textContent = message;
        };

        var submitSignup = async function () {
          if (!emailInput || !cta) return;
          var email = String(emailInput.value || "").trim().toLowerCase();
          if (!email || email.indexOf("@") < 1) {
            capture("signup_error", {
              source: "vercel_landing",
              page_version: "vercel_dynamic",
              variant_id: chosen.id,
              error: "invalid_email",
            });
            showStatus("Enter a valid email address.", true);
            return;
          }

          if (!SIGNUP_ENDPOINT) {
            capture("signup_error", {
              source: "vercel_landing",
              page_version: "vercel_dynamic",
              variant_id: chosen.id,
              error: "signup_endpoint_not_configured",
            });
            showStatus("Signup backend is not configured for this deployment.", true);
            return;
          }

          capture("cta_clicked", {
            source: "vercel_landing",
            page_version: "vercel_dynamic",
            variant_id: chosen.id,
            cta_text: chosen.cta,
          });
          capture("signup_submitted", {
            source: "vercel_landing",
            page_version: "vercel_dynamic",
            variant_id: chosen.id,
            email_domain: email.indexOf("@") >= 0 ? email.split("@")[1] : "",
          });

          cta.disabled = true;
          try {
            var signupPayload = {
              email: email,
              source: "vercel_landing",
              variantId: chosen.id,
              pageVersion: "vercel_dynamic",
              metadata: {
                deployedBy: "vercel_trigger_deploy",
                headline: chosen.headline,
                cta: chosen.cta,
                copyScore: chosen.score,
              }
            };
            if (companyId) signupPayload.companyId = companyId;

            var signupRes = await fetch(SIGNUP_ENDPOINT, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(signupPayload),
            });

            if (!signupRes.ok) {
              capture("signup_error", {
                source: "vercel_landing",
                page_version: "vercel_dynamic",
                variant_id: chosen.id,
                error: "signup_api_" + signupRes.status,
              });
              showStatus("Signup failed. Please retry.", true);
              return;
            }

            capture("user_signed_up", {
              source: "vercel_landing",
              page_version: "vercel_dynamic",
              variant_id: chosen.id,
              mode: "api",
            });

            showStatus("Great. Redirecting to founder offer...", false);
            var redirectTarget = OFFER_CLICK_ENDPOINT || PAYMENT_LINK || "";
            if (redirectTarget) {
              if (OFFER_CLICK_ENDPOINT) {
                redirectTarget += "?email=" + encodeURIComponent(email) + "&tier=entry";
                if (companyId) redirectTarget += "&companyId=" + encodeURIComponent(companyId);
              }
              capture("payment_started", {
                source: "vercel_landing",
                page_version: "vercel_dynamic",
                variant_id: chosen.id,
                entry: "landing_cta",
              });
              window.location.assign(redirectTarget);
            }
          } catch (err) {
            capture("signup_error", {
              source: "vercel_landing",
              page_version: "vercel_dynamic",
              variant_id: chosen.id,
              error: "network_error",
            });
            showStatus("Network error. Please retry.", true);
          } finally {
            cta.disabled = false;
          }
        };

        if (cta) {
          cta.addEventListener("click", function (event) {
            event.preventDefault();
            void submitSignup();
          });
        }

        if (form) {
          form.addEventListener("submit", function (event) {
            event.preventDefault();
            void submitSignup();
          });
        }
      })();
    </script>
  </body>
</html>`;

    const payload: JsonObject = {
      name: typeof inputArgs.name === "string" && inputArgs.name.trim().length > 0
        ? inputArgs.name.trim()
        : generatedName,
      files: [{ file: "index.html", data: defaultLandingHtml }],
    };

    const configuredTarget =
      typeof inputArgs.target === "string" && inputArgs.target.trim().length > 0
        ? inputArgs.target.trim()
        : (process.env.VERCEL_DEPLOY_TARGET ?? "").trim();

    if (configuredTarget) {
      payload.target = configuredTarget;
    }

    const projectSettings = asObject(inputArgs.projectSettings);
    if (Object.keys(projectSettings).length > 0) payload.projectSettings = projectSettings;

    const gitSource = asObject(inputArgs.gitSource);
    if (Object.keys(gitSource).length > 0) payload.gitSource = gitSource;

    return payload;
  };

  const waitForApiDeploymentReady = async (
    apiToken: string,
    apiDeploymentId: string,
  ): Promise<{ status: string; createdAt?: number; deploymentUrl: string | null }> => {
    const params = new URLSearchParams();
    if (teamId) params.set("teamId", teamId);
    const endpoint = `${baseUrl}/v13/deployments/${apiDeploymentId}${params.toString() ? `?${params.toString()}` : ""}`;

    let finalBody: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const statusRes = await fetch(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
      });

      const statusBody = await statusRes.json().catch(() => ({}));
      if (!statusRes.ok) {
        throw new Error(`Vercel deployment status error ${statusRes.status}: ${JSON.stringify(statusBody)}`);
      }

      finalBody = asObject(statusBody);
      const stateRaw = finalBody.readyState ?? finalBody.state;
      const state = typeof stateRaw === "string" ? stateRaw.toLowerCase() : "unknown";
      if (state === "ready") {
        return {
          status: "ready",
          createdAt: typeof finalBody.createdAt === "number" ? finalBody.createdAt : undefined,
          deploymentUrl: normalizeDeploymentUrl(finalBody.url),
        };
      }
      if (["error", "failed", "canceled", "cancelled"].includes(state)) {
        throw new Error(`Vercel deployment ${apiDeploymentId} entered terminal state: ${state}`);
      }

      await sleep(2_000);
    }

    return {
      status: "pending",
      createdAt: typeof finalBody.createdAt === "number" ? finalBody.createdAt : undefined,
      deploymentUrl: normalizeDeploymentUrl(finalBody.url),
    };
  };

  const verifyDeploymentIsReachable = async (
    deploymentUrl: string,
  ): Promise<{ httpStatus: number; checkedAt: string; protected: boolean }> => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetch(deploymentUrl, { method: "GET" });
      if (response.status === 200) {
        return {
          httpStatus: response.status,
          checkedAt: new Date().toISOString(),
          protected: false,
        };
      }

      // Treat auth-protected Vercel deployments as reachable.
      if (response.status === 401 || response.status === 403) {
        return {
          httpStatus: response.status,
          checkedAt: new Date().toISOString(),
          protected: true,
        };
      }

      if (response.status >= 500 || response.status === 404 || response.status === 429) {
        await sleep(2_000);
        continue;
      }

      throw new Error(`Deployment verification failed: ${deploymentUrl} returned HTTP ${response.status}`);
    }

    throw new Error(`Deployment verification failed after retries: ${deploymentUrl}`);
  };

  const isApiFallbackEligible = (error: unknown): boolean => {
    if (!(error instanceof Error)) return false;
    return /Vercel API error (401|403|404|409|422|429)/.test(error.message);
  };

  const mode = parseDeployMode(args.mode);
  const deployHookUrl = pickCredential(ctx, args.deployHookUrl, ["VERCEL_DEPLOY_HOOK_URL"]);
  const apiKey = pickCredential(ctx, args.apiKey, [
    "AI_GATEWAY_API_KEY",
    "VERCEL_TOKEN",
    "VERCEL_API_TOKEN",
  ]);

  const explicitPayload = asObject(args.payload);
  const payload = buildApiPayload(args, explicitPayload);

  const configuredProjectId = typeof args.projectId === "string" ? args.projectId.trim() : "";
  const inferredProjectId =
    deployHookUrl && configuredProjectId.length === 0 ? parseProjectIdFromHookUrl(deployHookUrl) : "";
  const projectId = configuredProjectId || inferredProjectId;
  const teamId = typeof args.teamId === "string" ? args.teamId.trim() : "";
  const skipAutoDetectionConfirmation =
    typeof args.skipAutoDetectionConfirmation === "boolean"
      ? args.skipAutoDetectionConfirmation
      : true;
  const baseUrl =
    typeof args.apiBaseUrl === "string" && args.apiBaseUrl.trim().length > 0
      ? args.apiBaseUrl.trim().replace(/\/$/, "")
      : "https://api.vercel.com";

  const hasPayload = Object.keys(payload).length > 0;
  const canUseApi = Boolean(apiKey && projectId && hasPayload);
  const canUseHook = Boolean(deployHookUrl);

  const runHookDeploy = async (): Promise<unknown> => {
    if (!deployHookUrl) {
      throw new Error("deployHookUrl is required for deploy hook mode");
    }

    const hookResponse = await fetch(deployHookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(Object.keys(payload).length > 0 ? payload : {}),
    });

    const hookBody = await hookResponse.json().catch(() => ({}));
    if (!hookResponse.ok) {
      throw new Error(`Vercel deploy hook error ${hookResponse.status}: ${JSON.stringify(hookBody)}`);
    }

    return {
      success: true,
      deploymentUrl: normalizeDeploymentUrl((hookBody as Record<string, unknown>)?.url),
      mode: "deploy_hook",
      status: "triggered",
      timestamp: new Date().toISOString(),
      warnings: payloadWarnings,
      data: hookBody,
    };
  };

  const runApiDeploy = async (): Promise<unknown> => {
    if (!apiKey) {
      throw new Error("Missing Vercel API token (AI_GATEWAY_API_KEY/VERCEL_TOKEN/VERCEL_API_TOKEN)");
    }
    if (!projectId) {
      throw new Error("projectId is required for dynamic Vercel API deploy mode");
    }
    if (!hasPayload) {
      throw new Error("payload or files[] is required for dynamic Vercel API deploy mode");
    }

    const params = new URLSearchParams();
    params.set("projectId", projectId);
    if (teamId) params.set("teamId", teamId);
    if (skipAutoDetectionConfirmation) params.set("skipAutoDetectionConfirmation", "1");

    const endpoint = `${baseUrl}/v13/deployments?${params.toString()}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Vercel API error ${res.status}: ${JSON.stringify(body)}`);
    }

    const deploymentId = typeof body.id === "string" ? body.id : "";
    const readyStatus = deploymentId
      ? await waitForApiDeploymentReady(apiKey, deploymentId)
      : {
          status: "pending",
          createdAt: typeof body.createdAt === "number" ? body.createdAt : undefined,
          deploymentUrl: normalizeDeploymentUrl(body.url),
        };

    const deploymentUrl = readyStatus.deploymentUrl ?? normalizeDeploymentUrl(body.url);
    if (!deploymentUrl) {
      throw new Error("Vercel API response missing deployment URL");
    }

    const verification = await verifyDeploymentIsReachable(deploymentUrl);
    const createdAtIso = readyStatus.createdAt ? new Date(readyStatus.createdAt).toISOString() : new Date().toISOString();

    return {
      success: true,
      deploymentUrl,
      status: "ready",
      timestamp: createdAtIso,
      mode: "api",
      id: deploymentId || undefined,
      deploymentId: deploymentId || undefined,
      url: typeof body.url === "string" ? body.url : null,
      inspectorUrl: body.inspectorUrl,
      state: readyStatus.status,
      createdAt: readyStatus.createdAt ?? body.createdAt,
      teamId: body.teamId ?? null,
      projectId: body.projectId ?? projectId,
      warnings: payloadWarnings,
      verification: {
        verified: true,
        httpStatus: verification.httpStatus,
        checkedAt: verification.checkedAt,
        protected: verification.protected,
        warning: verification.protected
          ? "Deployment is access-protected (401/403). Disable Vercel deployment protection or use a bypass token for public funnel tests."
          : null,
      },
    };
  };

  if (mode === "api") {
    return runApiDeploy();
  }
  if (mode === "deploy_hook") {
    return runHookDeploy();
  }

  if (canUseApi) {
    try {
      return await runApiDeploy();
    } catch (error) {
      if (canUseHook && isApiFallbackEligible(error)) {
        const hookResult = await runHookDeploy();
        return {
          success: true,
          mode: "deploy_hook_fallback",
          fallbackFrom: "api",
          deploymentUrl: normalizeDeploymentUrl(asObject(hookResult).deploymentUrl),
          status: asObject(hookResult).status ?? "triggered",
          timestamp: asObject(hookResult).timestamp ?? new Date().toISOString(),
          reason: error instanceof Error ? error.message : "unknown_api_error",
          data: hookResult,
        };
      }
      throw error;
    }
  }

  if (canUseHook) {
    return runHookDeploy();
  }

  throw new Error(
    "Missing Vercel deployment configuration. Provide API mode inputs (apiKey + projectId + payload/files) or deployHookUrl.",
  );
}

export function buildIntegrationContext(adapterConfig: Record<string, unknown> | undefined): IntegrationContext {
  const env = asStringRecord(adapterConfig?.env);
  return {
    integrationEnv: env,
  };
}