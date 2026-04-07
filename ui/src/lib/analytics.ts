import { posthog, posthogConfigured } from "@/lib/posthog";

function getUtmSource(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get("utm_source") || params.get("source") || null;
}

function getAttributionSource(): string {
  const utm = getUtmSource();
  if (utm) return utm;

  if (typeof document !== "undefined" && document.referrer) {
    try {
      const referrer = new URL(document.referrer);
      return referrer.hostname || "referral";
    } catch {
      return "referral";
    }
  }

  return "direct";
}

function capture(event: string, properties: Record<string, unknown>): void {
  if (!posthogConfigured) return;
  posthog.capture(event, {
    source: getAttributionSource(),
    ...properties,
  });
}

export function trackScreen(pathname: string, search: string): void {
  capture("$screen", {
    $screen_name: pathname,
    path: pathname,
    search,
  });
}

export function trackLandingView(page: string): void {
  capture("landing_view", { page });
}

export function trackCtaClicked(location: string, page?: string): void {
  capture("cta_clicked", {
    location,
    ...(page ? { page } : {}),
  });
}

export function trackEmailSubmitted(source: string, email?: string, page?: string): void {
  const emailDomain =
    typeof email === "string" && email.includes("@")
      ? email.split("@").pop() ?? undefined
      : undefined;

  capture("email_submitted", {
    source,
    ...(page ? { page } : {}),
    ...(emailDomain ? { email_domain: emailDomain } : {}),
  });
}

export function trackPaymentStarted(provider: string, amountUsd?: number): void {
  capture("payment_started", {
    provider,
    ...(typeof amountUsd === "number" ? { amount: amountUsd } : {}),
  });
}

export function trackPaymentCompleted(provider: string, amountUsd?: number): void {
  capture("payment_completed", {
    provider,
    ...(typeof amountUsd === "number" ? { amount: amountUsd } : {}),
  });
}
