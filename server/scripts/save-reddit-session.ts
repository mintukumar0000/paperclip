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

async function main(): Promise<void> {
  const storagePath = resolveRedditStorageStatePath(getConfiguredRedditStorageStatePath());
  const waitMs = Math.max(30000, Number(process.env.REDDIT_MANUAL_LOGIN_GRACE_MS ?? 60000));
  const minOpenMs = Math.max(0, Number(process.env.REDDIT_SAVE_SESSION_MIN_OPEN_MS ?? waitMs));

  console.log(`[reddit-session] opening Chromium (headful) to save state at: ${storagePath}`);
  console.log(`[reddit-session] you have ${Math.round(waitMs / 1000)}s to complete Reddit login manually`);

  const browser = await chromium.launch({ headless: false, slowMo: 120 });
  const context = await browser.newContext();
  const page = await context.newPage();
  const openedAt = Date.now();

  try {
    await page.goto("https://www.reddit.com/login/", { waitUntil: "domcontentloaded" });

    const deadline = Date.now() + waitMs;
    let submitReady = false;

    while (Date.now() < deadline) {
      try {
        await page.goto("https://www.reddit.com/submit", { waitUntil: "domcontentloaded" });
        const currentUrl = page.url();
        if (!/\/login/i.test(currentUrl)) {
          submitReady = true;
          break;
        }
      } catch {
        // Ignore transient navigation failures while waiting for manual auth.
      }
      await page.waitForTimeout(1500);
    }

    if (!submitReady) {
      throw new Error("Timed out waiting for manual Reddit login. Still redirected to /login.");
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
