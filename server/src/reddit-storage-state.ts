import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function resolveWorkspaceRoot(): string {
  const cwd = process.cwd();
  const candidates = [cwd, path.resolve(cwd, ".."), path.resolve(cwd, "../..")] as const;
  for (const candidate of candidates) {
    if (existsSync(path.resolve(candidate, "pnpm-workspace.yaml"))) {
      return candidate;
    }
  }
  return cwd;
}

function resolveAbsolute(candidate: string, workspaceRoot: string): string {
  if (path.isAbsolute(candidate)) return candidate;
  return path.resolve(workspaceRoot, candidate);
}

type RuntimeMaterializationState = {
  attempted: boolean;
  materializedPath: string | null;
  error: string | null;
};

const runtimeMaterializationState: RuntimeMaterializationState = {
  attempted: false,
  materializedPath: null,
  error: null,
};

function normalizeBase64Payload(payload: string): string {
  return payload.replace(/\s+/g, "").trim();
}

function maybeMaterializeRedditStorageStateFromBase64(): string | null {
  if (runtimeMaterializationState.attempted) {
    return runtimeMaterializationState.materializedPath;
  }

  runtimeMaterializationState.attempted = true;
  const raw = (process.env.REDDIT_STORAGE_BASE64 ?? "").trim();
  if (!raw) return null;

  const workspaceRoot = resolveWorkspaceRoot();
  const runtimePathCandidate = (process.env.REDDIT_STORAGE_RUNTIME_PATH ?? "/tmp/reddit-storage-state.json").trim()
    || "/tmp/reddit-storage-state.json";
  const runtimePath = resolveAbsolute(runtimePathCandidate, workspaceRoot);

  try {
    const decoded = Buffer.from(normalizeBase64Payload(raw), "base64").toString("utf-8");
    if (!decoded.trim()) {
      throw new Error("Decoded REDDIT_STORAGE_BASE64 payload is empty");
    }

    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Decoded REDDIT_STORAGE_BASE64 payload is not a valid JSON object");
    }

    mkdirSync(path.dirname(runtimePath), { recursive: true });
    writeFileSync(runtimePath, JSON.stringify(parsed), { encoding: "utf-8", mode: 0o600 });

    runtimeMaterializationState.materializedPath = runtimePath;
    runtimeMaterializationState.error = null;
    return runtimePath;
  } catch (err) {
    runtimeMaterializationState.materializedPath = null;
    runtimeMaterializationState.error = err instanceof Error ? err.message : String(err);
    return null;
  }
}

export function getRedditStorageRuntimeInfo(): {
  base64Configured: boolean;
  materializedPath: string | null;
  materializationError: string | null;
} {
  const materializedPath = maybeMaterializeRedditStorageStateFromBase64();
  return {
    base64Configured: Boolean((process.env.REDDIT_STORAGE_BASE64 ?? "").trim()),
    materializedPath,
    materializationError: runtimeMaterializationState.error,
  };
}

export function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (typeof value !== "string") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

export function getConfiguredRedditStorageStatePath(): string {
  const configured = (process.env.REDDIT_STORAGE_STATE_PATH ?? process.env.REDDIT_STORAGE_PATH ?? "storage/reddit.json").trim();
  return configured || "storage/reddit.json";
}

export function getRedditStorageStateCandidates(configuredPath?: string): string[] {
  const materializedPath = maybeMaterializeRedditStorageStateFromBase64();
  const configured = (configuredPath ?? getConfiguredRedditStorageStatePath()).trim() || "storage/reddit.json";
  const candidates = [
    configured,
    process.env.REDDIT_STORAGE_STATE_PATH,
    process.env.REDDIT_STORAGE_PATH,
    "storage/reddit.json",
    "data/playwright/reddit-storage-state.json",
    "server/data/playwright/reddit-storage-state.json",
    materializedPath,
    process.env.REDDIT_STORAGE_RUNTIME_PATH,
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);

  return Array.from(new Set(candidates));
}

export function resolveRedditStorageStatePath(configuredPath?: string): string {
  const workspaceRoot = resolveWorkspaceRoot();
  const candidates = getRedditStorageStateCandidates(configuredPath);

  for (const candidate of candidates) {
    const absolute = resolveAbsolute(candidate, workspaceRoot);
    if (existsSync(absolute)) return absolute;
  }

  return resolveAbsolute(candidates[0] ?? "storage/reddit.json", workspaceRoot);
}

export function resolveExistingRedditStorageStatePath(configuredPath?: string): string | null {
  const workspaceRoot = resolveWorkspaceRoot();
  const candidates = getRedditStorageStateCandidates(configuredPath);
  for (const candidate of candidates) {
    const absolute = resolveAbsolute(candidate, workspaceRoot);
    if (existsSync(absolute)) return absolute;
  }
  return null;
}

export function isRedditStorageStateRequired(defaultValue = true): boolean {
  return parseBooleanEnv(process.env.REDDIT_REQUIRE_STORAGE_STATE ?? process.env.REDDIT_REQUIRE_STORAGE, defaultValue);
}
