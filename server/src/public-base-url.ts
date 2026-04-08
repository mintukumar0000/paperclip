function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (typeof value !== "string") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

export function normalizeBaseUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/$/, "");
}

export function isLoopbackHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
  } catch {
    return /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(value);
  }
}

function derivePublicBaseUrlFromApiBaseUrl(): string | null {
  const apiBaseUrl = normalizeBaseUrl(process.env.PAPERCLIP_API_BASE_URL ?? null);
  if (!apiBaseUrl) return null;
  return apiBaseUrl.endsWith("/api") ? apiBaseUrl.slice(0, -4) : apiBaseUrl;
}

export function isPublicDeployment(): boolean {
  const runningOnRender =
    parseBooleanEnv(process.env.RENDER, false) ||
    (process.env.RENDER_SERVICE_ID ?? "").trim().length > 0;
  const nodeEnv = (process.env.NODE_ENV ?? "").trim().toLowerCase();
  const deploymentMode = (process.env.PAPERCLIP_DEPLOYMENT_MODE ?? "").trim().toLowerCase();
  const deploymentModeIsPublic = deploymentMode.length > 0 && deploymentMode !== "local_trusted";
  return runningOnRender || nodeEnv === "production" || deploymentModeIsPublic;
}

export type PublicBaseUrlHints = {
  requestOrigin?: string | null;
  host?: string | null;
  forwardedHost?: string | null;
  forwardedProto?: string | null;
};

export function resolvePublicBaseUrl(hints?: PublicBaseUrlHints): string | null {
  const rejectLoopback = isPublicDeployment();
  const port = (process.env.PORT ?? "3100").trim() || "3100";

  const forwardedHost = normalizeBaseUrl(hints?.forwardedHost ?? null);
  const forwardedProto = (hints?.forwardedProto ?? "https").trim() || "https";
  const host = normalizeBaseUrl(hints?.host ?? null);
  const requestOrigin = normalizeBaseUrl(hints?.requestOrigin ?? null);

  const candidates = [
    process.env.PUBLIC_API_BASE,
    process.env.WAITLIST_PUBLIC_BASE_URL,
    process.env.PAPERCLIP_PUBLIC_BASE_URL,
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL,
    process.env.RENDER_EXTERNAL_URL,
    derivePublicBaseUrlFromApiBaseUrl(),
    process.env.VERCEL_URL
      ? ((process.env.VERCEL_URL ?? "").startsWith("http://") || (process.env.VERCEL_URL ?? "").startsWith("https://")
        ? process.env.VERCEL_URL
        : `https://${process.env.VERCEL_URL}`)
      : null,
    requestOrigin,
    forwardedHost ? `${forwardedProto}://${forwardedHost}` : null,
    host ? `http://${host}` : null,
    `http://localhost:${port}`,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeBaseUrl(candidate ?? null);
    if (!normalized) continue;
    if (rejectLoopback && isLoopbackHttpUrl(normalized)) continue;
    return normalized;
  }

  return null;
}

export type SignupEndpointResolution = {
  endpoint: string | null;
  explicitEndpoint: string | null;
  explicitEndpointLoopback: boolean;
  ignoredExplicitLoopback: boolean;
};

export function resolveSignupEndpoint(publicBaseUrl: string | null): SignupEndpointResolution {
  const explicitEndpoint = normalizeBaseUrl(process.env.SIGNUP_ENDPOINT ?? null);
  const explicitEndpointLoopback = isLoopbackHttpUrl(explicitEndpoint);
  const rejectLoopback = isPublicDeployment();

  if (explicitEndpoint && (!explicitEndpointLoopback || !rejectLoopback)) {
    return {
      endpoint: explicitEndpoint,
      explicitEndpoint,
      explicitEndpointLoopback,
      ignoredExplicitLoopback: false,
    };
  }

  if (publicBaseUrl) {
    return {
      endpoint: `${publicBaseUrl}/api/waitlist/signup`,
      explicitEndpoint,
      explicitEndpointLoopback,
      ignoredExplicitLoopback: Boolean(explicitEndpoint && explicitEndpointLoopback && rejectLoopback),
    };
  }

  return {
    endpoint: explicitEndpoint,
    explicitEndpoint,
    explicitEndpointLoopback,
    ignoredExplicitLoopback: false,
  };
}
