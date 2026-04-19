import type { Db } from "@paperclipai/db";
import { desc, eq } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";

export type ExecutionFeedCategory = "traffic" | "email" | "decision" | "execution" | "revenue" | "system";
export type ExecutionFeedStatus = "info" | "success" | "failed" | "pending" | "blocked" | "skipped";

export type ExecutionEvidenceType = "reddit_post" | "deployment" | "checkout" | "email";

export interface ExecutionFeedEvent {
  id: string;
  companyId: string;
  createdAt: string;
  category: ExecutionFeedCategory;
  status: ExecutionFeedStatus;
  reason: string | null;
  traceId: string;
  linkedIssueId: string | null;
  linkedGoalId: string | null;
  linkedAgentId: string | null;
  action: string;
  message: string;
  decisionId: string | null;
  details: Record<string, unknown>;
}

export interface ExecutionFeedFilters {
  limit?: number;
  categories?: ExecutionFeedCategory[];
  statuses?: ExecutionFeedStatus[];
}

function normalizeActionLabel(action: string): string {
  return action.replace(/\./g, " ").replace(/_/g, " ");
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    const normalized = readString(value);
    if (normalized) return normalized;
  }
  return null;
}

function firstStringFromArray(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    const normalized = readString(entry);
    if (normalized) return normalized;
  }
  return null;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mapReason(value: string): string {
  if (value === "issue_already_open") return "duplicate_prevention";
  return value;
}

function inferCategory(action: string): ExecutionFeedCategory {
  const lower = action.toLowerCase();
  if (lower.startsWith("traffic.") || lower.startsWith("distribution.")) return "traffic";
  if (lower.startsWith("email.")) return "email";
  if (lower.startsWith("ai.decision.") || lower.startsWith("system.decision.")) return "decision";
  if (lower.startsWith("execution.") || lower.startsWith("loop.")) return "execution";
  if (lower.startsWith("pricing.") || lower.startsWith("revenue.") || lower.startsWith("billing.")) return "revenue";
  return "system";
}

function inferStatus(action: string, details: Record<string, unknown>): ExecutionFeedStatus {
  const explicit = typeof details.status === "string" ? details.status.toLowerCase() : null;
  if (explicit === "success" || explicit === "succeeded" || explicit === "executed" || explicit === "completed") {
    return "success";
  }
  if (explicit === "failed" || explicit === "error") return "failed";
  if (explicit === "pending" || explicit === "awaiting_approval") return "pending";
  if (explicit === "skipped") return "skipped";
  if (explicit === "blocked" || explicit === "overridden") return "blocked";

  if (details.skipped === true) return "skipped";
  if (details.pendingApproval === true) return "pending";

  const lower = action.toLowerCase();
  if (lower.includes(".failed") || lower.includes(".error")) return "failed";
  if (lower.includes("awaiting_approval") || lower.includes(".pending")) return "pending";
  if (lower.includes(".skipped")) return "skipped";
  if (lower.includes(".blocked") || lower.includes(".overridden") || lower.includes(".skipped")) return "blocked";
  if (
    lower.includes(".completed")
    || lower.includes(".executed")
    || lower.includes(".posted")
    || lower.includes(".sent")
    || lower.includes(".result")
  ) {
    if (typeof details.success === "boolean") {
      return details.success ? "success" : "failed";
    }
    return "success";
  }

  return "info";
}

function inferReason(action: string, details: Record<string, unknown>, status: ExecutionFeedStatus): string | null {
  const explicitReason = readString(details.reason);
  if (explicitReason) return mapReason(explicitReason);

  const errorReason = readString(details.error);
  if (errorReason && (status === "failed" || status === "blocked")) return errorReason;

  if (status === "pending" || status === "blocked") {
    if (details.pendingApproval === true || action.toLowerCase().includes("awaiting_approval")) {
      return "awaiting_approval";
    }
  }

  if (status === "skipped") {
    if (details.skipped === true && !explicitReason) {
      return "duplicate_prevention";
    }
  }

  return null;
}

function inferTraceId(input: { id: string; companyId: string; action: string; details: Record<string, unknown> }): string {
  const trace = firstString([
    input.details.traceId,
    input.details.trace_id,
  ]);
  if (trace) return trace;
  return `${input.action}:${input.companyId}:${input.id}`;
}

function inferLinkedIssueId(details: Record<string, unknown>): string | null {
  return firstString([
    details.issueId,
    details.issue_id,
    details.linkedIssueId,
    details.linked_issue_id,
    firstStringFromArray(details.linkedIssueIds),
    firstStringFromArray(details.issueIds),
    firstStringFromArray(details.linked_issue_ids),
    firstStringFromArray(details.issue_ids),
    firstStringFromArray(details.dispatchedIssueIds),
  ]);
}

function inferLinkedGoalId(details: Record<string, unknown>): string | null {
  return firstString([
    details.goalId,
    details.goal_id,
    details.linkedGoalId,
    details.linked_goal_id,
    firstStringFromArray(details.linkedGoalIds),
    firstStringFromArray(details.goalIds),
    firstStringFromArray(details.linked_goal_ids),
    firstStringFromArray(details.goal_ids),
  ]);
}

function inferLinkedAgentId(details: Record<string, unknown>): string | null {
  return firstString([
    details.agentId,
    details.agent_id,
    details.linkedAgentId,
    details.linked_agent_id,
    firstStringFromArray(details.linkedAgentIds),
    firstStringFromArray(details.agentIds),
    firstStringFromArray(details.linked_agent_ids),
    firstStringFromArray(details.agent_ids),
    firstStringFromArray(details.activatedAgentIds),
  ]);
}

function inferEvidenceType(action: string, details: Record<string, unknown>): ExecutionEvidenceType | null {
  const explicit = readString(details.type);
  if (explicit === "reddit_post" || explicit === "deployment" || explicit === "checkout" || explicit === "email") {
    return explicit;
  }

  const lower = action.toLowerCase();
  const redditUrl = readString(details.postUrl)
    ?? readString(details.post_url)
    ?? readString(details.permalink)
    ?? null;
  if (redditUrl && lower.startsWith("distribution.reddit.post")) return "reddit_post";

  const checkoutUrl = readString(details.checkoutUrl)
    ?? readString(details.checkout_url)
    ?? readString(details.paymentLink)
    ?? null;
  if (checkoutUrl && (lower.includes("checkout") || lower.startsWith("billing."))) return "checkout";

  const deploymentUrl = readString(details.deploymentUrl)
    ?? readString(details.deployment_url)
    ?? null;
  if (deploymentUrl && (lower.includes("deploy") || lower.includes("deployment"))) return "deployment";

  const emailPreviewUrl = readString(details.previewUrl)
    ?? readString(details.preview_url)
    ?? readString(details.emailPreviewUrl)
    ?? readString(details.email_preview_url)
    ?? null;
  if (emailPreviewUrl && lower.startsWith("email.")) return "email";

  return null;
}

function inferEvidenceUrl(type: ExecutionEvidenceType | null, details: Record<string, unknown>): string | null {
  if (type === "reddit_post") {
    return readString(details.postUrl)
      ?? readString(details.post_url)
      ?? readString(details.permalink)
      ?? readString(details.url);
  }

  if (type === "deployment") {
    return readString(details.deploymentUrl)
      ?? readString(details.deployment_url)
      ?? readString(details.url);
  }

  if (type === "checkout") {
    return readString(details.checkoutUrl)
      ?? readString(details.checkout_url)
      ?? readString(details.paymentLink)
      ?? readString(details.url);
  }

  if (type === "email") {
    return readString(details.previewUrl)
      ?? readString(details.preview_url)
      ?? readString(details.emailPreviewUrl)
      ?? readString(details.email_preview_url)
      ?? readString(details.url);
  }

  return null;
}

function inferEvidenceMetadata(type: ExecutionEvidenceType | null, details: Record<string, unknown>): Record<string, unknown> | null {
  if (type === "reddit_post") {
    return {
      subreddit: details.subreddit ?? null,
      title: details.title ?? null,
      method: details.method ?? null,
      upvotes: details.upvotes ?? null,
      comments: details.comments ?? null,
    };
  }

  if (type === "deployment") {
    return {
      deploymentId: details.deploymentId ?? details.id ?? null,
      status: details.status ?? null,
      source: details.source ?? null,
    };
  }

  if (type === "checkout") {
    return {
      provider: details.provider ?? null,
      sessionId: details.sessionId ?? details.session_id ?? null,
      productId: details.productId ?? details.product_id ?? null,
    };
  }

  if (type === "email") {
    return {
      email: details.email ?? null,
      step: details.step ?? null,
      subject: details.subject ?? null,
      emailStatus: details.status ?? null,
      emailId: details.emailId ?? details.email_id ?? null,
    };
  }

  return null;
}

function inferArtifactId(type: ExecutionEvidenceType | null, action: string, details: Record<string, unknown>): string | null {
  const explicit = readString(details.artifactId) ?? readString(details.artifact_id);
  if (explicit) return explicit;

  const url = inferEvidenceUrl(type, details);
  if (url) return `${action}:${url}`;
  if (type) return `${action}:${readString(details.id) ?? "artifact"}`;
  return null;
}

function inferArtifactMetrics(type: ExecutionEvidenceType | null, details: Record<string, unknown>): Record<string, unknown> | null {
  if (!type) return null;

  const clicksRaw = Number(details.clicks ?? details.upvotes ?? 0);
  const conversionsRaw = Number(details.conversions ?? details.paymentConversions ?? 0);
  const revenueRaw = Number(details.revenueCents ?? details.revenue ?? 0);

  const clicks = Number.isFinite(clicksRaw) ? Math.max(0, Math.round(clicksRaw)) : 0;
  const conversions = Number.isFinite(conversionsRaw) ? Math.max(0, Math.round(conversionsRaw)) : 0;
  const revenueCents = Number.isFinite(revenueRaw) ? Math.max(0, Math.round(revenueRaw)) : 0;

  return {
    clicks,
    conversions,
    revenueCents,
  };
}

function enrichDetails(action: string, details: Record<string, unknown>, status: ExecutionFeedStatus): Record<string, unknown> {
  const next = { ...details };
  const evidenceType = inferEvidenceType(action, next);
  const evidenceUrl = inferEvidenceUrl(evidenceType, next);
  const evidenceMetadata = inferEvidenceMetadata(evidenceType, next);
  const reason = inferReason(action, next, status);

  if (evidenceType && typeof next.type !== "string") {
    next.type = evidenceType;
  }

  if (evidenceUrl && typeof next.url !== "string") {
    next.url = evidenceUrl;
  }

  if (evidenceMetadata && !("metadata" in next)) {
    next.metadata = evidenceMetadata;
  }

  if (reason && typeof next.reason !== "string") {
    next.reason = reason;
  }

  const artifactId = inferArtifactId(evidenceType, action, next);
  if (artifactId && typeof next.artifactId !== "string") {
    next.artifactId = artifactId;
  }

  const artifactMetrics = inferArtifactMetrics(evidenceType, next);
  if (artifactMetrics && !("artifactMetrics" in next)) {
    next.artifactMetrics = artifactMetrics;
  }

  if (typeof next.linkedDecisionId !== "string") {
    const linkedDecisionId = readString(next.decisionId) ?? readString(next.decision_id);
    if (linkedDecisionId) {
      next.linkedDecisionId = linkedDecisionId;
    }
  }

  if (typeof next.traceId !== "string" && typeof next.trace_id !== "string") {
    next.traceId = null;
  }

  if (typeof next.linkedIssueId !== "string" && typeof next.issueId !== "string" && typeof next.issue_id !== "string") {
    next.linkedIssueId = null;
  }

  if (typeof next.linkedGoalId !== "string" && typeof next.goalId !== "string" && typeof next.goal_id !== "string") {
    next.linkedGoalId = null;
  }

  if (typeof next.linkedAgentId !== "string" && typeof next.agentId !== "string" && typeof next.agent_id !== "string") {
    next.linkedAgentId = null;
  }

  return next;
}

function toDecisionId(details: Record<string, unknown>): string | null {
  if (typeof details.decisionId === "string" && details.decisionId.length > 0) return details.decisionId;
  if (typeof details.decision_id === "string" && details.decision_id.length > 0) return details.decision_id;
  return null;
}

function toFeedEvent(input: {
  id: string;
  companyId: string;
  createdAt: Date | string;
  action: string;
  details: unknown;
}): ExecutionFeedEvent {
  const details = toRecord(input.details);
  const status = inferStatus(input.action, details);
  const enrichedDetails = enrichDetails(input.action, details, status);
  const reason = inferReason(input.action, enrichedDetails, status);
  const traceId = inferTraceId({ id: input.id, companyId: input.companyId, action: input.action, details: enrichedDetails });
  const linkedIssueId = inferLinkedIssueId(enrichedDetails);
  const linkedGoalId = inferLinkedGoalId(enrichedDetails);
  const linkedAgentId = inferLinkedAgentId(enrichedDetails);

  if (typeof enrichedDetails.traceId !== "string") {
    enrichedDetails.traceId = traceId;
  }
  if (linkedIssueId && typeof enrichedDetails.linkedIssueId !== "string") {
    enrichedDetails.linkedIssueId = linkedIssueId;
  }
  if (linkedGoalId && typeof enrichedDetails.linkedGoalId !== "string") {
    enrichedDetails.linkedGoalId = linkedGoalId;
  }
  if (linkedAgentId && typeof enrichedDetails.linkedAgentId !== "string") {
    enrichedDetails.linkedAgentId = linkedAgentId;
  }

  return {
    id: input.id,
    companyId: input.companyId,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : input.createdAt.toISOString(),
    category: inferCategory(input.action),
    status,
    reason,
    traceId,
    linkedIssueId,
    linkedGoalId,
    linkedAgentId,
    action: input.action,
    message: typeof enrichedDetails.message === "string"
      ? enrichedDetails.message
      : normalizeActionLabel(input.action),
    decisionId: toDecisionId(enrichedDetails),
    details: enrichedDetails,
  };
}

function applyFilters(
  events: ExecutionFeedEvent[],
  filters: ExecutionFeedFilters,
): ExecutionFeedEvent[] {
  const categorySet = filters.categories ? new Set(filters.categories) : null;
  const statusSet = filters.statuses ? new Set(filters.statuses) : null;

  return events.filter((event) => {
    if (categorySet && !categorySet.has(event.category)) return false;
    if (statusSet && !statusSet.has(event.status)) return false;
    return true;
  });
}

export async function listExecutionFeed(
  db: Db,
  companyId: string,
  filters: ExecutionFeedFilters = {},
): Promise<ExecutionFeedEvent[]> {
  const safeLimit = Math.max(1, Math.min(400, Math.trunc(filters.limit ?? 120)));

  const rows = await db
    .select({
      id: activityLog.id,
      companyId: activityLog.companyId,
      action: activityLog.action,
      details: activityLog.details,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .where(eq(activityLog.companyId, companyId))
    .orderBy(desc(activityLog.createdAt))
    .limit(Math.max(safeLimit * 3, 180));

  const mapped = rows.map((row) => toFeedEvent(row));
  return applyFilters(mapped, filters).slice(0, safeLimit);
}

export function toExecutionFeedEventFromLivePayload(input: {
  companyId: string;
  action: string;
  details?: unknown;
  timestamp?: string;
  id?: string;
}): ExecutionFeedEvent {
  return toFeedEvent({
    id: input.id ?? `live-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    companyId: input.companyId,
    action: input.action,
    details: input.details,
    createdAt: input.timestamp ?? new Date().toISOString(),
  });
}
