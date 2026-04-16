import { config as loadDotenv } from "dotenv";
import { chromium } from "playwright";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getConfiguredRedditStorageStatePath,
} from "../src/reddit-storage-state.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

loadDotenv({ path: path.resolve(repoRoot, ".env"), override: true });
loadDotenv({ path: path.resolve(process.cwd(), ".env"), override: false });

function parseMs(raw: string | undefined, fallbackMs: number, minMs: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallbackMs;
  }
  return Math.max(minMs, Math.round(parsed));
}

function resolveConfiguredStoragePath(): string {
  const configured = getConfiguredRedditStorageStatePath().trim() || "storage/reddit.json";
  if (path.isAbsolute(configured)) {
    return configured;
  }
  return path.resolve(repoRoot, configured);
}

function resolveRedditUserDataDir(): string {
  const configured = (
    process.env.REDDIT_USER_DATA_DIR
    ?? process.env.PLAYWRIGHT_USER_DATA_DIR
    ?? "storage/playwright/reddit-profile"
  ).trim();
  if (path.isAbsolute(configured)) {
    return configured;
  }
  return path.resolve(repoRoot, configured);
}

function getLaunchOptions(channelOverride?: string): {
  headless: boolean;
  slowMo: number;
  channel?: string;
  args: string[];
} {
  const configuredChannel = (
    process.env.REDDIT_BROWSER_CHANNEL
    ?? process.env.PLAYWRIGHT_BROWSER_CHANNEL
    ?? ""
  ).trim();
  const channel = channelOverride ?? configuredChannel;
  return {
    headless: false,
    slowMo: 120,
    channel: channel && channel.length > 0 ? channel : undefined,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--disable-dev-shm-usage",
    ],
  };
}

function cleanupStaleProfileLocks(userDataDir: string): void {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"]) {
    try {
      rmSync(path.join(userDataDir, name), { force: true });
    } catch {
      // Ignore lock cleanup failures; launch will report actionable errors.
    }
  }
}

async function launchPersistentRedditContext(userDataDir: string): Promise<import("playwright").BrowserContext> {
  const configured = (
    process.env.REDDIT_BROWSER_CHANNEL
    ?? process.env.PLAYWRIGHT_BROWSER_CHANNEL
    ?? ""
  ).trim();
  const channelCandidates = configured
    ? [configured]
    : (process.platform === "darwin" ? ["chrome", ""] : [""]);

  let lastError: unknown = null;
  for (const candidate of channelCandidates) {
    try {
      const options = getLaunchOptions(candidate || undefined);
      return await chromium.launchPersistentContext(userDataDir, options);
    } catch (err) {
      lastError = err;
      if (candidate) {
        console.warn(`[reddit-session] failed launching with channel='${candidate}', retrying fallback channel`);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main(): Promise<void> {
  const storagePath = resolveConfiguredStoragePath();
  const userDataDir = resolveRedditUserDataDir();
  const waitMs = parseMs(process.env.REDDIT_MANUAL_LOGIN_GRACE_MS, 60_000, 30_000);
  const minOpenMs = parseMs(process.env.REDDIT_SAVE_SESSION_MIN_OPEN_MS, waitMs, 60_000);

  console.log(`[reddit-session] opening Chromium (headful) to save state at: ${storagePath}`);
  console.log(`[reddit-session] using persistent profile at: ${userDataDir}`);
  console.log(`[reddit-session] you have ${Math.round(waitMs / 1000)}s to complete Reddit login manually`);

  await mkdir(userDataDir, { recursive: true });
  cleanupStaleProfileLocks(userDataDir);
  const context = await launchPersistentRedditContext(userDataDir);
  const page = await context.newPage();
  const openedAt = Date.now();

  try {
    await page.goto("https://www.reddit.com/login/", { waitUntil: "domcontentloaded" });

    // Wait for manual login completion without interrupting the form by forced redirects.
    const loginDetected = await page
      .waitForURL(
        (url) => url.hostname.includes("reddit.com") && !url.pathname.includes("/login"),
        { timeout: waitMs },
      )
      .then(() => true)
      .catch(() => false);

    if (!loginDetected) {
      throw new Error("Timed out waiting for manual Reddit login. Still redirected to /login.");
    }

    await page.waitForTimeout(1200);
    await page.goto("https://www.reddit.com/submit", { waitUntil: "domcontentloaded" });
    if (/\/login/i.test(page.url())) {
      throw new Error("Reddit login appeared complete, but /submit still redirects to /login.");
    }

    const elapsedOpenMs = Date.now() - openedAt;
    const remainingOpenMs = Math.max(0, minOpenMs - elapsedOpenMs);
    if (remainingOpenMs > 0) {
      console.log(
        `[reddit-session] login detected quickly; keeping browser open for ${Math.round(remainingOpenMs / 1000)}s`,
      );
      await page.waitForTimeout(remainingOpenMs);
    }

    await context.storageState({ path: storagePath });
    console.log(`[reddit-session] session saved to ${storagePath}`);
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
