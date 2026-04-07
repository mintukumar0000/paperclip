import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { postToTwitterPlaywright, type IntegrationContext } from "../src/ai/tools/externalTools.js";

loadDotenv({ path: path.resolve(process.cwd(), ".env"), override: false });

async function main(): Promise<void> {
  const integrationCtx: IntegrationContext = { integrationEnv: {} };
  const text = `Test post from automation (${new Date().toISOString()})`;

  const result = await postToTwitterPlaywright(integrationCtx, {
    text,
    storageStatePath: process.env.X_STORAGE_STATE_PATH ?? "server/data/playwright/x-storage-state.json",
    headless: false,
    timeoutMs: Number(process.env.PLAYWRIGHT_TIMEOUT_MS ?? 120000),
  });

  console.log(JSON.stringify({ text, result }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
