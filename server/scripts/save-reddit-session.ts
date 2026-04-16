import { config as loadDotenv } from "dotenv";
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getConfiguredRedditStorageStatePath,
  resolveRedditStorageStatePath,
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

async function main(): Promise<void> {
  const storagePath = resolveRedditStorageStatePath(getConfiguredRedditStorageStatePath());
  const waitMs = parseMs(process.env.REDDIT_MANUAL_LOGIN_GRACE_MS, 60_000, 30_000);
  const minOpenMs = parseMs(process.env.REDDIT_SAVE_SESSION_MIN_OPEN_MS, waitMs, 60_000);

  console.log(`[reddit-session] opening Chromium (headful) to save state at: ${storagePath}`);
  console.log(`[reddit-session] you have ${Math.round(waitMs / 1000)}s to complete Reddit login manually`);

  const browser = await chromium.launch({ headless: false, slowMo: 120 });
  const context = await browser.newContext();
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
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
