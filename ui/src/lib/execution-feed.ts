import type { ExecutionFeedEventResponse } from "../api/system-controls";

export type ExecutionStatusTone = "success" | "failed" | "blocked" | "pending" | "skipped" | "info";

export interface ExecutionEvidence {
  type: "reddit_post" | "deployment" | "checkout" | "email";
  label: string;
  title: string;
  url: string | null;
  metadata: Record<string, unknown> | null;
}

export interface TraceLink {
  traceId: string;
  decisionId: string | null;
  issueId: string | null;
  goalId: string | null;
  agentId: string | null;
}

export interface FeedSpamSummary {
  status: "failed" | "blocked" | "pending" | "skipped";
  count: number;
}

export interface GroupedFeedEvent {
  event: ExecutionFeedEventResponse;
  count: number;
  reason: string | null;
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

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isValidEvidenceUrl(type: ExecutionEvidence["type"], url: string): boolean {
  if (!isHttpUrl(url)) return false;

  const lower = url.toLowerCase();
  if (type === "reddit_post") {
    return lower.includes("reddit.com") || lower.includes("redd.it");
  }
  if (type === "checkout") {
    return lower.includes("checkout") || lower.includes("dodo") || lower.includes("stripe");
  }
  if (type === "deployment") {
    return true;
  }
  return true;
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

export function getTraceLink(event: ExecutionFeedEventResponse): TraceLink {
  return {
    traceId: event.traceId,
    decisionId: event.decisionId,
    issueId: event.linkedIssueId,
    goalId: event.linkedGoalId,
    agentId: event.linkedAgentId,
  };
}

export function summarizeFeedSpam(events: ExecutionFeedEventResponse[]): FeedSpamSummary[] {
  const counts: Record<"failed" | "blocked" | "pending" | "skipped", number> = {
    failed: 0,
    blocked: 0,
    pending: 0,
    skipped: 0,
  };

  for (const event of events) {
    if (event.status === "failed" || event.status === "blocked" || event.status === "pending" || event.status === "skipped") {
      counts[event.status] += 1;
    }
  }

  return (Object.keys(counts) as Array<keyof typeof counts>)
    .map((status) => ({ status, count: counts[status] }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);
}

export function groupExecutionFeed(events: ExecutionFeedEventResponse[], limit = 20): GroupedFeedEvent[] {
  const groups: GroupedFeedEvent[] = [];
  const indexByKey = new Map<string, number>();

  for (const event of events) {
    const reason = getEventReason(event);
    const key = [event.status, event.category, event.action, reason ?? ""].join("|");
    const existingIndex = indexByKey.get(key);

    if (existingIndex == null) {
      indexByKey.set(key, groups.length);
      groups.push({ event, count: 1, reason });
      continue;
    }

    const current = groups[existingIndex];
    const currentTs = new Date(current.event.createdAt).getTime();
    const incomingTs = new Date(event.createdAt).getTime();
    groups[existingIndex] = {
      event: incomingTs > currentTs ? event : current.event,
      count: current.count + 1,
      reason: current.reason,
    };
  }

  return groups
    .sort((a, b) => new Date(b.event.createdAt).getTime() - new Date(a.event.createdAt).getTime())
    .slice(0, limit);
}

export function extractEvidence(event: ExecutionFeedEventResponse): ExecutionEvidence | null {
  const details = event.details;
  const type = isEvidenceType(details.type) ? details.type : null;
  if (!type) return null;

  const metadata = readRecord(details.metadata);

  const url = (type === "reddit_post"
    ? (readString(details.postUrl) ?? readString(details.post_url) ?? readString(details.permalink) ?? readString(details.url))
    : type === "checkout"
      ? (readString(details.checkoutUrl) ?? readString(details.checkout_url) ?? readString(details.paymentLink) ?? readString(details.url))
      : type === "deployment"
        ? (readString(details.deploymentUrl) ?? readString(details.deployment_url) ?? readString(details.url))
        : (readString(details.previewUrl)
          ?? readString(details.preview_url)
          ?? readString(details.emailPreviewUrl)
          ?? readString(details.email_preview_url)
          ?? readString(details.url)))
    ?? null;

  if (!url || !isValidEvidenceUrl(type, url)) return null;

  if (type === "email") {
    const providerId = readString(details.emailId)
      ?? readString(details.email_id)
      ?? readString(details.providerMessageId)
      ?? readString(details.provider_message_id)
      ?? readString(details.messageId)
      ?? readString(details.message_id)
      ?? null;
    if (!providerId) return null;
  }

  if (type === "reddit_post") {
    return {
      type,
      label: "Reddit Post",
      title: "Post Created",
      url,
      metadata,
    };
  }

  if (type === "deployment") {
    return {
      type,
      label: "Deployment",
      title: "Deployment Created",
      url,
      metadata,
    };
  }

  if (type === "checkout") {
    return {
      type,
      label: "Checkout",
      title: "Checkout Link Created",
      url,
      metadata,
    };
  }

  return {
    type,
    label: "Email",
    title: "Email Activity",
    url,
    metadata,
  };
}
