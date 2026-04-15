import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { postToRedditPlaywright, type IntegrationContext } from "../src/ai/tools/externalTools.js";
import { getConfiguredRedditStorageStatePath, resolveRedditStorageStatePath } from "../src/reddit-storage-state.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

loadDotenv({ path: path.resolve(repoRoot, ".env"), override: true });
loadDotenv({ path: path.resolve(process.cwd(), ".env"), override: false });

async function main(): Promise<void> {
  const integrationCtx: IntegrationContext = { integrationEnv: {} };
  const url = process.env.TEST_REDDIT_URL ?? "https://example.com";
  const storageStatePath = resolveRedditStorageStatePath(getConfiguredRedditStorageStatePath());
  const manualLoginWaitMs = Math.max(0, Number(process.env.REDDIT_MANUAL_LOGIN_GRACE_MS ?? 60_000));

  if (manualLoginWaitMs > 0) {
    console.log(`[Reddit] Manual login grace window enabled: ${Math.round(manualLoginWaitMs / 1000)}s`);
  }

  const result = await postToRedditPlaywright(integrationCtx, {
    subreddit: process.env.TEST_REDDIT_SUBREDDIT ?? "test",
    title: `Automation test post ${new Date().toISOString()}`,
    kind: "link",
    url,
    storageStatePath,
    requireStorageState: true,
    allowPasswordLogin: false,
    headless: false,
    manualLoginWaitMs,
    timeoutMs: Number(process.env.PLAYWRIGHT_TIMEOUT_MS ?? 120000),
  });

  console.log(JSON.stringify({ url, result }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
