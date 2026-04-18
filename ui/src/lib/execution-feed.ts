import type { ExecutionFeedEventResponse } from "../api/system-controls";

export type ExecutionStatusTone = "success" | "failed" | "blocked" | "pending" | "skipped" | "info";

export interface ExecutionEvidence {
  type: "reddit_post" | "deployment" | "checkout" | "email";
  label: string;
  title: string;
  url: string | null;
  metadata: Record<string, unknown> | null;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isEvidenceType(value: unknown): value is ExecutionEvidence["type"] {
  return value === "reddit_post" || value === "deployment" || value === "checkout" || value === "email";
}

export function toTitleCase(value: unknown, fallback = "-"): string {
  const text = readString(value) ?? fallback;
  return text
    .replace(/_/g, " ")
    .replace(/\./g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatRelativeTime(input: string | null): string {
  if (!input) return "-";
  const ts = new Date(input).getTime();
  if (!Number.isFinite(ts)) return "-";

  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;

  if (abs < minute) return "just now";
  if (abs < hour) {
    const minutes = Math.max(1, Math.round(abs / minute));
    return `${minutes}m ago`;
  }
  const hours = Math.max(1, Math.round(abs / hour));
  return `${hours}h ago`;
}

export function normalizeReason(reason: string | null | undefined): string | null {
  const raw = readString(reason);
  if (!raw) return null;

  if (raw === "cooldown_active") return "Cooldown active (6h)";
  if (raw === "awaiting_approval") return "Awaiting approval";
  if (raw === "duplicate_prevention" || raw === "issue_already_open") return "Duplicate prevention";
  if (raw === "blocked_by_operator_override") return "Blocked by operator override";

  return toTitleCase(raw);
}

export function getEventReason(event: ExecutionFeedEventResponse): string | null {
  const direct = normalizeReason(event.reason);
  if (direct) return direct;

  const detailsReason = normalizeReason(readString(event.details.reason));
  if (detailsReason) return detailsReason;

  if (event.status === "pending" && event.action.includes("awaiting_approval")) {
    return "Awaiting approval";
  }

  return null;
}

export function getExecutionStatusTone(status: ExecutionFeedEventResponse["status"]): ExecutionStatusTone {
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "pending") return "pending";
  if (status === "skipped") return "skipped";
  return "info";
}

export function getExecutionStatusLabel(status: ExecutionFeedEventResponse["status"]): string {
  if (status === "success") return "SUCCESS";
  if (status === "failed") return "FAILED";
  if (status === "blocked") return "BLOCKED";
  if (status === "pending") return "WAITING";
  if (status === "skipped") return "SKIPPED";
  return "INFO";
}

export function extractEvidence(event: ExecutionFeedEventResponse): ExecutionEvidence | null {
  const details = event.details;
  const type = isEvidenceType(details.type) ? details.type : null;
  const metadata = readRecord(details.metadata);

  const url = readString(details.url)
    ?? readString(details.postUrl)
    ?? readString(details.deploymentUrl)
    ?? readString(details.checkoutUrl)
    ?? readString(details.checkout_url)
    ?? null;

  const inferredType: ExecutionEvidence["type"] | null = type
    ?? (event.action.startsWith("distribution.reddit.post") ? "reddit_post" : null)
    ?? (event.action.startsWith("billing.") || event.action.includes("checkout") ? "checkout" : null)
    ?? (event.action.startsWith("email.") ? "email" : null)
    ?? (event.action.includes("deploy") || readString(details.deploymentUrl) ? "deployment" : null);

  if (!inferredType) return null;

  if (inferredType === "reddit_post") {
    return {
      type: inferredType,
      label: "Reddit Post",
      title: "Post Created",
      url,
      metadata,
    };
  }

  if (inferredType === "deployment") {
    return {
      type: inferredType,
      label: "Deployment",
      title: "Deployment Created",
      url,
      metadata,
    };
  }

  if (inferredType === "checkout") {
    return {
      type: inferredType,
      label: "Checkout",
      title: "Checkout Link Created",
      url,
      metadata,
    };
  }

  return {
    type: inferredType,
    label: "Email",
    title: "Email Activity",
    url,
    metadata,
  };
}
