import { config as loadDotenv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
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

function main(): void {
  const storagePath = resolveRedditStorageStatePath(getConfiguredRedditStorageStatePath());

  if (!existsSync(storagePath)) {
    throw new Error(`Reddit session file not found at ${storagePath}`);
  }

  const raw = readFileSync(storagePath, "utf8");
  JSON.parse(raw);

  const encoded = Buffer.from(raw, "utf8").toString("base64");

  console.log("REDDIT_STORAGE_BASE64=");
  console.log(encoded);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
