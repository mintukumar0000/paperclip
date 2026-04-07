import { config as loadDotenv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

loadDotenv({ path: path.resolve(repoRoot, ".env"), override: true });
loadDotenv({ path: path.resolve(process.cwd(), ".env"), override: false });

type StorageState = {
  cookies?: Array<{
    name?: string;
    domain?: string;
    expires?: number;
  }>;
};

function resolvePath(value: string): string {
  if (path.isAbsolute(value)) return value;
  return path.resolve(repoRoot, value);
}

function pickStoragePath(): string {
  const configured = (process.env.REDDIT_STORAGE_STATE_PATH ?? "storage/reddit.json").trim() || "storage/reddit.json";
  const candidates = [
    configured,
    "storage/reddit.json",
    "data/playwright/reddit-storage-state.json",
    "server/data/playwright/reddit-storage-state.json",
  ];

  for (const candidate of candidates) {
    const resolved = resolvePath(candidate);
    if (existsSync(resolved)) return resolved;
  }

  return resolvePath(configured);
}

function main(): void {
  const storagePath = pickStoragePath();
  if (!existsSync(storagePath)) {
    console.error(`REDDIT_SESSION_INVALID: storage file not found at ${storagePath}`);
    process.exit(1);
  }

  const raw = readFileSync(storagePath, "utf8");
  let parsed: StorageState;
  try {
    parsed = JSON.parse(raw) as StorageState;
  } catch {
    console.error(`REDDIT_SESSION_INVALID: storage file is not valid JSON (${storagePath})`);
    process.exit(1);
    return;
  }

  const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
  const redditCookies = cookies.filter((cookie) => String(cookie.domain ?? "").includes("reddit.com"));
  const hasDotDomain = redditCookies.some((cookie) => String(cookie.domain ?? "").startsWith(".reddit.com"));
  const hasSessionishCookie = redditCookies.some((cookie) => {
    const name = String(cookie.name ?? "").toLowerCase();
    return name.includes("session") || name.includes("token") || name === "reddit_session";
  });

  const nowEpoch = Math.floor(Date.now() / 1000);
  const nonExpired = redditCookies.filter((cookie) => {
    const expires = typeof cookie.expires === "number" ? cookie.expires : -1;
    return expires === -1 || expires > nowEpoch;
  });

  if (redditCookies.length === 0 || !hasDotDomain || !hasSessionishCookie || nonExpired.length === 0) {
    console.error("REDDIT_SESSION_INVALID: missing required reddit cookies for posting context");
    console.error(
      JSON.stringify(
        {
          storagePath,
          redditCookieCount: redditCookies.length,
          hasDotDomain,
          hasSessionishCookie,
          nonExpiredCookieCount: nonExpired.length,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        status: "ok",
        storagePath,
        redditCookieCount: redditCookies.length,
        hasDotDomain,
        hasSessionishCookie,
        nonExpiredCookieCount: nonExpired.length,
      },
      null,
      2,
    ),
  );
}

main();
