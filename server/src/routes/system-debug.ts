import { existsSync, readFileSync } from "node:fs";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companies, eq, sql, waitlistSignups } from "@paperclipai/db";
import { getLLMBudgetSnapshot } from "../ai/llmRouter.js";
import {
  isLoopbackHttpUrl,
  resolvePublicBaseUrl,
  resolveSignupEndpoint,
  type PublicBaseUrlHints,
} from "../public-base-url.js";
import {
  getConfiguredRedditStorageStatePath,
  getRedditStorageRuntimeInfo,
  isRedditStorageStateRequired,
  parseBooleanEnv,
  resolveRedditStorageStatePath,
} from "../reddit-storage-state.js";

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

type DatabaseTarget = {
  configured: boolean;
  provider: "embedded" | "supabase" | "render" | "other" | "invalid_url";
  host: string | null;
  database: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isUuid(value: string | null): boolean {
  return Boolean(value && UUID_RE.test(value));
}

function resolveConfiguredTelemetryCompanyId(): string | null {
  const active = normalizeOptionalString(process.env.ACTIVE_COMPANY_ID);
  if (isUuid(active)) return active;
  const fallback = normalizeOptionalString(process.env.BILLING_WEBHOOK_COMPANY_ID);
  if (isUuid(fallback)) return fallback;
  return null;
}

function inspectDatabaseTarget(): DatabaseTarget {
  const connectionString = (process.env.DATABASE_URL ?? "").trim();
  if (!connectionString) {
    return {
      configured: false,
      provider: "embedded",
      host: null,
      database: null,
    };
  }

  try {
    const parsed = new URL(connectionString);
    const host = parsed.hostname || null;
    const database = parsed.pathname ? parsed.pathname.replace(/^\//, "") : null;
    const loweredHost = (host ?? "").toLowerCase();
    const provider = loweredHost.includes("supabase.co")
      ? "supabase"
      : (loweredHost.includes("render.com") || loweredHost.startsWith("dpg-"))
        ? "render"
        : "other";

    return {
      configured: true,
      provider,
      host,
      database,
    };
  } catch {
    return {
      configured: true,
      provider: "invalid_url",
      host: null,
      database: null,
    };
  }
}

function extractRequestHints(req: {
  protocol?: string;
  get: (name: string) => string | undefined;
}): PublicBaseUrlHints {
  const forwardedProto = req.get("x-forwarded-proto") ?? req.protocol ?? "http";
  const forwardedHost = req.get("x-forwarded-host") ?? null;
  const host = req.get("host") ?? null;
  const requestOrigin = host ? `${forwardedProto}://${host}` : null;

  return {
    requestOrigin,
    host,
    forwardedHost,
    forwardedProto,
  };
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

function inspectRedditSession(): LayerResult<Record<string, unknown>> {
  const runtimeInfo = getRedditStorageRuntimeInfo();
  const configuredPath = getConfiguredRedditStorageStatePath();
  const resolvedPath = resolveRedditStorageStatePath(configuredPath);

  const requireStorageState = isRedditStorageStateRequired(true);
  const allowPasswordLogin = parseBooleanEnv(process.env.REDDIT_ALLOW_PASSWORD_LOGIN, false);
  const headful = parseBooleanEnv(process.env.REDDIT_HEADFUL, false);

  if (!existsSync(resolvedPath)) {
    const missingStorageIsFailure = requireStorageState || !allowPasswordLogin;
    return {
      status: missingStorageIsFailure ? "fail" : "warn",
      details: {
        storagePath: resolvedPath,
        configuredStoragePath: configuredPath,
        storageExists: false,
        base64Configured: runtimeInfo.base64Configured,
        materializedStoragePath: runtimeInfo.materializedPath,
        materializationError: runtimeInfo.materializationError,
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
        configuredStoragePath: configuredPath,
        storageExists: true,
        base64Configured: runtimeInfo.base64Configured,
        materializedStoragePath: runtimeInfo.materializedPath,
        materializationError: runtimeInfo.materializationError,
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
        configuredStoragePath: configuredPath,
        storageExists: true,
        base64Configured: runtimeInfo.base64Configured,
        materializedStoragePath: runtimeInfo.materializedPath,
        materializationError: runtimeInfo.materializationError,
        requireStorageState,
        allowPasswordLogin,
        headful,
        reason: "reddit_storage_state_unreadable",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function inspectBackend(
  db: Db,
  requestHints: PublicBaseUrlHints,
): Promise<LayerResult<Record<string, unknown>>> {
  const port = (process.env.PORT ?? "3100").trim() || "3100";
  const localSignupEndpoint = `http://127.0.0.1:${port}/api/waitlist/signup`;
  const publicApiBaseUrl = resolvePublicBaseUrl(requestHints);
  const signupResolution = resolveSignupEndpoint(publicApiBaseUrl);
  const signupEndpoint = signupResolution.endpoint;
  const signupEndpointLooksLoopback = isLoopbackHttpUrl(signupEndpoint);

  const [localProbe, publicProbe] = await Promise.all([
    probeEndpoint(localSignupEndpoint, { method: "OPTIONS", timeoutMs: 4000 }),
    signupEndpoint && !signupEndpointLooksLoopback
      ? probeEndpoint(signupEndpoint, { method: "OPTIONS", timeoutMs: 7000 })
      : Promise.resolve<HttpProbe | null>(null),
  ]);

  const databaseTarget = inspectDatabaseTarget();

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

  let waitlistSchemaCompatible = false;
  let waitlistSchemaError: string | null = null;
  try {
    await db
      .select({
        id: waitlistSignups.id,
        companyId: waitlistSignups.companyId,
        email: waitlistSignups.email,
        source: waitlistSignups.source,
        metadata: waitlistSignups.metadata,
        createdAt: waitlistSignups.createdAt,
      })
      .from(waitlistSignups)
      .limit(1);
    waitlistSchemaCompatible = true;
  } catch (error) {
    waitlistSchemaCompatible = false;
    waitlistSchemaError = error instanceof Error ? error.message : String(error);
  }

  const telemetryCompanyId = resolveConfiguredTelemetryCompanyId();
  let telemetryCompanyExists: boolean | null = null;
  let telemetryCompanyError: string | null = null;
  if (telemetryCompanyId) {
    try {
      const row = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, telemetryCompanyId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      telemetryCompanyExists = Boolean(row);
    } catch (error) {
      telemetryCompanyError = error instanceof Error ? error.message : String(error);
    }
  }

  const telemetryCompanyStatus: LayerStatus = telemetryCompanyId
    ? (telemetryCompanyExists === true ? "ok" : "warn")
    : "ok";

  const status = summarizeStatus([
    localProbe.ok ? "ok" : "fail",
    dbReadable ? "ok" : "fail",
    waitlistSchemaCompatible ? "ok" : "fail",
    signupEndpoint && !signupEndpointLooksLoopback && publicProbe?.ok
      ? "ok"
      : "fail",
    telemetryCompanyStatus,
  ]);

  const reason = !dbReadable
    ? "waitlist_db_unreadable"
    : !waitlistSchemaCompatible
      ? "waitlist_schema_incompatible"
      : telemetryCompanyId && telemetryCompanyExists === false
        ? "telemetry_company_missing"
        : !signupEndpoint
          ? "signup_endpoint_missing"
          : signupEndpointLooksLoopback
            ? "signup_endpoint_loopback"
            : publicProbe?.ok
              ? "backend_public_reachable"
              : "backend_public_unreachable";

  return {
    status,
    details: {
      databaseTarget,
      dbReadable,
      dbError,
      waitlistSchemaCompatible,
      waitlistSchemaError,
      totalSignups,
      telemetryCompanyId,
      telemetryCompanyExists,
      telemetryCompanyError,
      localSignupEndpoint,
      localSignupProbe: localProbe,
      publicApiBaseUrl,
      signupEndpoint,
      explicitSignupEndpoint: signupResolution.explicitEndpoint,
      explicitSignupEndpointLoopback: signupResolution.explicitEndpointLoopback,
      ignoredExplicitLoopback: signupResolution.ignoredExplicitLoopback,
      signupEndpointLooksLoopback,
      publicSignupProbe: publicProbe,
      reason,
    },
  };
}

async function inspectLanding(
  requestHints: PublicBaseUrlHints,
): Promise<LayerResult<Record<string, unknown>>> {
  const publicApiBaseUrl = resolvePublicBaseUrl(requestHints);
  const signupResolution = resolveSignupEndpoint(publicApiBaseUrl);
  const signupEndpoint = signupResolution.endpoint;
  const signupEndpointLooksLoopback = isLoopbackHttpUrl(signupEndpoint);

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
      explicitSignupEndpoint: signupResolution.explicitEndpoint,
      explicitSignupEndpointLoopback: signupResolution.explicitEndpointLoopback,
      ignoredExplicitLoopback: signupResolution.ignoredExplicitLoopback,
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

  router.get("/debug/system", async (req, res) => {
    const requestHints = extractRequestHints(req);
    const [backend, landing, resend] = await Promise.all([
      inspectBackend(db, requestHints),
      inspectLanding(requestHints),
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
