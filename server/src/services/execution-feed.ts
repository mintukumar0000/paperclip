import type { Db } from "@paperclipai/db";
import { desc, eq } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";

export type ExecutionFeedCategory = "traffic" | "email" | "decision" | "execution" | "revenue" | "system";
export type ExecutionFeedStatus = "info" | "success" | "failed" | "pending" | "blocked";

export interface ExecutionFeedEvent {
  id: string;
  companyId: string;
  createdAt: string;
  category: ExecutionFeedCategory;
  status: ExecutionFeedStatus;
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
  if (explicit === "blocked" || explicit === "overridden" || explicit === "skipped") return "blocked";

  const lower = action.toLowerCase();
  if (lower.includes(".failed") || lower.includes(".error")) return "failed";
  if (lower.includes("awaiting_approval") || lower.includes(".pending")) return "pending";
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
  return {
    id: input.id,
    companyId: input.companyId,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : input.createdAt.toISOString(),
    category: inferCategory(input.action),
    status: inferStatus(input.action, details),
    action: input.action,
    message: typeof details.message === "string" ? details.message : normalizeActionLabel(input.action),
    decisionId: toDecisionId(details),
    details,
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
