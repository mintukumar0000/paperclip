import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { sql, waitlistSignups } from "@paperclipai/db";
import { getLLMBudgetSnapshot } from "../ai/llmRouter.js";

type LayerStatus = "ok" | "warn" | "fail";

type HttpProbe = {
  ok: boolean;
  statusCode: number | null;
  durationMs: number;
  error?: string;
};

type LayerResult<T extends Record<string, unknown>> = {
  status: LayerStatus;
  details: T;
};

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeBaseUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/$/, "");
}

function isLoopbackUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
  } catch {
    return /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(value);
  }
}

function resolvePublicApiBaseUrl(): string | null {
  return normalizeBaseUrl(
    process.env.PUBLIC_API_BASE
    ?? process.env.WAITLIST_PUBLIC_BASE_URL
    ?? process.env.PAPERCLIP_PUBLIC_BASE_URL
    ?? process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL
    ?? null,
  );
}

function resolveSignupEndpoint(publicApiBaseUrl: string | null): string | null {
  const explicitSignup = normalizeBaseUrl(process.env.SIGNUP_ENDPOINT ?? null);
  if (explicitSignup) return explicitSignup;
  if (!publicApiBaseUrl) return null;
  return `${publicApiBaseUrl}/api/waitlist/signup`;
}

async function probeEndpoint(
  url: string,
  opts?: {
    method?: "GET" | "POST" | "OPTIONS";
    timeoutMs?: number;
    headers?: Record<string, string>;
  },
): Promise<HttpProbe> {
  const method = opts?.method ?? "GET";
  const timeoutMs = Math.max(500, opts?.timeoutMs ?? 5000);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        ...(method === "OPTIONS" ? { "Access-Control-Request-Method": "POST" } : {}),
        ...(opts?.headers ?? {}),
      },
    });
    return {
      ok: response.ok,
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeStatus(statuses: LayerStatus[]): LayerStatus {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  return "ok";
}

function resolveRedditStoragePath(configuredPath: string): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const roots = [
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../.."),
    path.resolve(moduleDir, "../../.."),
    path.resolve(moduleDir, "../../../.."),
  ];

  const uniqueRoots = Array.from(new Set(roots));
  const relativeCandidates = [
    configuredPath,
    "storage/reddit.json",
    "data/playwright/reddit-storage-state.json",
    "server/data/playwright/reddit-storage-state.json",
  ].filter((value, index, arr) => value.length > 0 && arr.indexOf(value) === index);

  for (const candidate of relativeCandidates) {
    if (path.isAbsolute(candidate) && existsSync(candidate)) {
      return candidate;
    }
    for (const root of uniqueRoots) {
      const absolute = path.resolve(root, candidate);
      if (existsSync(absolute)) {
        return absolute;
      }
    }
  }

  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }
  return path.resolve(process.cwd(), configuredPath);
}

function inspectRedditSession(): LayerResult<Record<string, unknown>> {
  const configuredPath = (process.env.REDDIT_STORAGE_STATE_PATH ?? "storage/reddit.json").trim() || "storage/reddit.json";
  const resolvedPath = resolveRedditStoragePath(configuredPath);

  const requireStorageState = parseBooleanEnv(
    process.env.REDDIT_REQUIRE_STORAGE_STATE ?? process.env.REDDIT_REQUIRE_STORAGE,
    true,
  );
  const allowPasswordLogin = parseBooleanEnv(process.env.REDDIT_ALLOW_PASSWORD_LOGIN, false);
  const headful = parseBooleanEnv(process.env.REDDIT_HEADFUL, false);

  if (!existsSync(resolvedPath)) {
    const missingStorageIsFailure = requireStorageState || !allowPasswordLogin;
    return {
      status: missingStorageIsFailure ? "fail" : "warn",
      details: {
        storagePath: resolvedPath,
        storageExists: false,
        requireStorageState,
        allowPasswordLogin,
        headful,
        reason: "reddit_storage_state_missing",
      },
    };
  }

  try {
    const raw = readFileSync(resolvedPath, "utf-8");
    const parsed = JSON.parse(raw) as { cookies?: unknown[] };
    const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
    const nowUnixSeconds = Math.floor(Date.now() / 1000);

    const redditCookies = cookies.filter((cookie) => {
      if (!cookie || typeof cookie !== "object") return false;
      const domain = (cookie as { domain?: unknown }).domain;
      return typeof domain === "string" && /reddit\.com$/i.test(domain.replace(/^\./, ""));
    }) as Array<{ name?: string; expires?: number }>;

    const unexpiredCookies = redditCookies.filter((cookie) => {
      if (typeof cookie.expires !== "number") return true;
      if (cookie.expires <= 0) return true;
      return cookie.expires > nowUnixSeconds;
    });

    const sessionLikeCookies = redditCookies.filter((cookie) => {
      const name = typeof cookie.name === "string" ? cookie.name : "";
      return /(session|token|reddit_session|loid)/i.test(name);
    });

    const valid = redditCookies.length > 0 && unexpiredCookies.length > 0 && sessionLikeCookies.length > 0;

    return {
      status: valid ? "ok" : "fail",
      details: {
        storagePath: resolvedPath,
        storageExists: true,
        requireStorageState,
        allowPasswordLogin,
        headful,
        redditCookieCount: redditCookies.length,
        unexpiredRedditCookieCount: unexpiredCookies.length,
        sessionLikeCookieCount: sessionLikeCookies.length,
        reason: valid ? "reddit_storage_state_valid" : "reddit_storage_state_invalid",
      },
    };
  } catch (error) {
    return {
      status: "fail",
      details: {
        storagePath: resolvedPath,
        storageExists: true,
        requireStorageState,
        allowPasswordLogin,
        headful,
        reason: "reddit_storage_state_unreadable",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function inspectBackend(db: Db): Promise<LayerResult<Record<string, unknown>>> {
  const port = (process.env.PORT ?? "3100").trim() || "3100";
  const localSignupEndpoint = `http://127.0.0.1:${port}/api/waitlist/signup`;
  const publicApiBaseUrl = resolvePublicApiBaseUrl();
  const signupEndpoint = resolveSignupEndpoint(publicApiBaseUrl);
  const signupEndpointLooksLoopback = isLoopbackUrl(signupEndpoint);

  const [localProbe, publicProbe] = await Promise.all([
    probeEndpoint(localSignupEndpoint, { method: "OPTIONS", timeoutMs: 4000 }),
    signupEndpoint && !signupEndpointLooksLoopback
      ? probeEndpoint(signupEndpoint, { method: "OPTIONS", timeoutMs: 7000 })
      : Promise.resolve<HttpProbe | null>(null),
  ]);

  let dbReadable = false;
  let totalSignups = 0;
  let dbError: string | null = null;
  try {
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(waitlistSignups);
    dbReadable = true;
    totalSignups = Number(row?.count ?? 0);
  } catch (error) {
    dbReadable = false;
    dbError = error instanceof Error ? error.message : String(error);
  }

  const status = summarizeStatus([
    localProbe.ok ? "ok" : "fail",
    dbReadable ? "ok" : "fail",
    signupEndpoint && !signupEndpointLooksLoopback && publicProbe?.ok
      ? "ok"
      : "fail",
  ]);

  return {
    status,
    details: {
      dbReadable,
      dbError,
      totalSignups,
      localSignupEndpoint,
      localSignupProbe: localProbe,
      publicApiBaseUrl,
      signupEndpoint,
      signupEndpointLooksLoopback,
      publicSignupProbe: publicProbe,
      reason:
        !signupEndpoint
          ? "signup_endpoint_missing"
          : signupEndpointLooksLoopback
            ? "signup_endpoint_loopback"
            : publicProbe?.ok
              ? "backend_public_reachable"
              : "backend_public_unreachable",
    },
  };
}

async function inspectLanding(): Promise<LayerResult<Record<string, unknown>>> {
  const publicApiBaseUrl = resolvePublicApiBaseUrl();
  const signupEndpoint = resolveSignupEndpoint(publicApiBaseUrl);
  const signupEndpointLooksLoopback = isLoopbackUrl(signupEndpoint);

  const signupProbe = signupEndpoint && !signupEndpointLooksLoopback
    ? await probeEndpoint(signupEndpoint, { method: "OPTIONS", timeoutMs: 7000 })
    : null;

  const status = summarizeStatus([
    signupEndpoint ? "ok" : "fail",
    signupEndpointLooksLoopback ? "fail" : "ok",
    signupProbe ? (signupProbe.ok ? "ok" : "fail") : "fail",
  ]);

  return {
    status,
    details: {
      publicApiBaseUrl,
      signupEndpoint,
      signupEndpointLooksLoopback,
      signupProbe,
      reason:
        !signupEndpoint
          ? "signup_endpoint_missing"
          : signupEndpointLooksLoopback
            ? "signup_endpoint_loopback"
            : signupProbe?.ok
              ? "landing_to_backend_ok"
              : "landing_to_backend_unreachable",
    },
  };
}

async function inspectResend(): Promise<LayerResult<Record<string, unknown>>> {
  const hasApiKey = Boolean((process.env.RESEND_API_KEY ?? "").trim());
  const hasFromEmail = Boolean((process.env.RESEND_FROM_EMAIL ?? "").trim());

  if (!hasApiKey || !hasFromEmail) {
    return {
      status: "fail",
      details: {
        configured: false,
        hasApiKey,
        hasFromEmail,
        reason: "resend_not_configured",
      },
    };
  }

  const resendApiKey = (process.env.RESEND_API_KEY ?? "").trim();
  const probe = await probeEndpoint("https://api.resend.com/domains?limit=1", {
    method: "GET",
    timeoutMs: 7000,
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
    },
  });
  const status: LayerStatus = probe.ok ? "ok" : "fail";

  return {
    status,
    details: {
      configured: true,
      hasApiKey,
      hasFromEmail,
      apiProbe: probe,
      reason: probe.ok ? "resend_api_reachable" : "resend_api_unreachable",
    },
  };
}

function inspectLlmUsage(): LayerResult<Record<string, unknown>> {
  const budget = getLLMBudgetSnapshot();
  const status: LayerStatus = budget.remainingCalls <= 0
    ? "fail"
    : budget.remainingCalls <= Math.max(1, Math.floor(budget.maxCalls * 0.1))
      ? "warn"
      : "ok";

  return {
    status,
    details: {
      ...budget,
      reason:
        budget.remainingCalls <= 0
          ? "llm_budget_exhausted"
          : budget.remainingCalls <= Math.max(1, Math.floor(budget.maxCalls * 0.1))
            ? "llm_budget_low"
            : "llm_budget_healthy",
    },
  };
}

export function systemDebugRoutes(db: Db) {
  const router = Router();

  router.get("/debug/system", async (_req, res) => {
    const [backend, landing, resend] = await Promise.all([
      inspectBackend(db),
      inspectLanding(),
      inspectResend(),
    ]);

    const reddit = inspectRedditSession();
    const llmUsage = inspectLlmUsage();
    const overall = summarizeStatus([
      reddit.status,
      landing.status,
      backend.status,
      resend.status,
      llmUsage.status,
    ]);

    res.setHeader("Cache-Control", "no-store");
    res.json({
      status: overall,
      generatedAt: new Date().toISOString(),
      reddit,
      landing,
      backend,
      resend,
      llm_usage: llmUsage,
    });
  });

  return router;
}
