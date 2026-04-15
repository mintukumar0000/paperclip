import { config as loadDotenv } from "dotenv";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  getConfiguredRedditStorageStatePath,
  resolveRedditStorageStatePath,
} from "../src/reddit-storage-state.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

loadDotenv({ path: path.resolve(repoRoot, ".env"), override: true });
loadDotenv({ path: path.resolve(process.cwd(), ".env"), override: false });

function resolvePath(value: string): string {
  if (path.isAbsolute(value)) return value;
  return path.resolve(repoRoot, value);
}

function resolvePreferredStoragePath(configuredPath: string, legacyPath: string): string {
  const resolvedConfigured = resolvePath(configuredPath);
  const resolvedLegacy = resolvePath(legacyPath);
  if (existsSync(resolvedConfigured)) return resolvedConfigured;
  if (existsSync(resolvedLegacy)) return resolvedLegacy;
  return resolvedConfigured;
}

function getBootstrapLaunchOptions(): { headless: boolean; channel?: string; args?: string[] } {
  const channel = process.env.PLAYWRIGHT_BROWSER_CHANNEL?.trim();
  return {
    headless: false,
    channel: channel && channel.length > 0 ? channel : undefined,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--disable-dev-shm-usage",
    ],
  };
}

function resolveUserDataDir(): string | null {
  const raw = (process.env.PLAYWRIGHT_USER_DATA_DIR ?? "").trim();
  if (!raw) return null;
  return resolvePath(raw);
}

async function waitForLoggedIn(page: import("playwright").Page, hostMatch: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = page.url();
    if (url.includes(hostMatch) && !url.includes("/login")) {
      return;
    }

    await page.waitForTimeout(1000);
  }
  throw new Error(`Login timeout after ${Math.round(timeoutMs / 1000)}s`);
}

function isExpectedNavigationInterruption(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("interrupted by another navigation") ||
    message.includes("Navigation failed because page was closed") ||
    message.includes("net::ERR_ABORTED")
  );
}

async function gotoWithRedirectTolerance(
  page: import("playwright").Page,
  url: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  } catch (error) {
    if (!isExpectedNavigationInterruption(error)) {
      throw error;
    }

    // Reddit may bounce across login/challenge pages and abort the original navigation.
    await page.waitForTimeout(1500);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  }
}

async function waitForRedditSessionReady(page: import("playwright").Page, timeoutMs: number): Promise<void> {
  const start = Date.now();
  const manualLoginCheckWindowMs = Math.max(30_000, Number(process.env.REDDIT_MANUAL_LOGIN_GRACE_MS ?? 60_000));

  while (Date.now() - start < timeoutMs) {
    const currentUrl = page.url();
    if (currentUrl.includes("/login")) {
      // Give human login/challenge flow uninterrupted time before probing submit again.
      await page
        .waitForURL(
          (url) => url.hostname.includes("reddit.com") && !url.pathname.includes("/login"),
          { timeout: manualLoginCheckWindowMs },
        )
        .catch(() => undefined);
    }

    const followLink = page.locator('a:has-text("this link"), a[href*="reddit.com"]').first();
    if (await followLink.isVisible().catch(() => false)) {
      await followLink.click().catch(() => undefined);
      await page.waitForTimeout(1500);
    }

    await gotoWithRedirectTolerance(page, "https://www.reddit.com/submit", 20_000);
    await page.waitForTimeout(2000);

    if (page.url().includes("/login")) {
      await page.waitForTimeout(1500);
      continue;
    }

    const titleInput = page
      .locator('textarea[name="title"], textarea[name="title-textarea"], textarea#innerTextArea')
      .first();
    if (await titleInput.isVisible().catch(() => false)) {
      return;
    }

    await page.waitForTimeout(3000);
  }

  throw new Error(`Reddit session readiness timeout after ${Math.round(timeoutMs / 1000)}s`);
}

async function verifyRedditSession(page: import("playwright").Page, timeoutMs: number): Promise<void> {
  await gotoWithRedirectTolerance(page, "https://www.reddit.com/submit", timeoutMs);
  await page.waitForTimeout(3000);
  const titleInput = page
    .locator('textarea[name="title"], textarea[name="title-textarea"], textarea#innerTextArea')
    .first();
  if (await titleInput.isVisible().catch(() => false)) {
    return;
  }

  const onLogin = page.url().includes("/login");
  const welcomeBackLoop = await page.locator("text=Welcome back!").first().isVisible().catch(() => false);
  throw new Error(
    `Reddit session verification failed. submit page not accessible (url=${page.url()}, login=${onLogin}, welcomeBack=${welcomeBackLoop}).`,
  );
}

async function bootstrapX(): Promise<void> {
  const statePath = resolvePreferredStoragePath(
    process.env.X_STORAGE_STATE_PATH ?? "data/playwright/x-storage-state.json",
    "server/data/playwright/x-storage-state.json",
  );
  const userDataDir = resolveUserDataDir();
  let browser: import("playwright").Browser | null = null;
  let context: import("playwright").BrowserContext;

  if (userDataDir) {
    await mkdir(userDataDir, { recursive: true });
    context = await chromium.launchPersistentContext(userDataDir, getBootstrapLaunchOptions());
  } else {
    browser = await chromium.launch(getBootstrapLaunchOptions());
    context = await browser.newContext();
  }
  const page = await context.newPage();

  try {
    await page.goto("https://x.com/login", { waitUntil: "domcontentloaded" });
    console.log("[X] Complete login manually in the opened browser window...");
    await waitForLoggedIn(page, "x.com", 5 * 60_000);

    await mkdir(path.dirname(statePath), { recursive: true });
    await context.storageState({ path: statePath });
    console.log(`[X] Saved storage state: ${statePath}`);
  } finally {
    await context.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

async function bootstrapReddit(): Promise<void> {
  const configuredStatePath = getConfiguredRedditStorageStatePath();
  const statePath = resolveRedditStorageStatePath(configuredStatePath);
  const userDataDir = resolveUserDataDir();
  let browser: import("playwright").Browser | null = null;
  let context: import("playwright").BrowserContext;

  if (userDataDir) {
    await mkdir(userDataDir, { recursive: true });
    context = await chromium.launchPersistentContext(userDataDir, getBootstrapLaunchOptions());
  } else {
    browser = await chromium.launch(getBootstrapLaunchOptions());
    context = await browser.newContext();
  }
  const page = await context.newPage();

  try {
    await page.goto("https://www.reddit.com/login", { waitUntil: "domcontentloaded" });
    console.log("[Reddit] Complete login manually in the opened browser window...");
    console.log(`[Reddit] Waiting up to ${Math.round((Math.max(30_000, Number(process.env.REDDIT_MANUAL_LOGIN_GRACE_MS ?? 60_000))) / 1000)}s before submit re-check while login is in progress.`);
    await waitForRedditSessionReady(page, 5 * 60_000);
    await verifyRedditSession(page, 60_000);

    await mkdir(path.dirname(statePath), { recursive: true });
    await context.storageState({ path: statePath });
    console.log(`[Reddit] Saved storage state: ${statePath}`);
  } finally {
    await context.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const platform = (process.argv[2] ?? "both").toLowerCase();

  if (platform === "x" || platform === "both") {
    await bootstrapX();
  }

  if (platform === "reddit" || platform === "both") {
    await bootstrapReddit();
  }

  console.log("Bootstrap complete.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
