import type {
  AutonomyLevel,
  CycleMode,
  DecisionMode,
  SystemCycleRunResult,
  SystemDecisionStatus,
  TrafficChannel,
  TrafficMode,
  UpdateSystemControls,
} from "@paperclipai/shared";
import { api } from "./client";

export interface SystemControlsResponse {
  companyId: string;
  trafficEnabled: boolean;
  redditEnabled: boolean;
  twitterEnabled: boolean;
  indieHackersEnabled: boolean;
  hackerNewsEnabled: boolean;
  maxMultiplier: number;
  postFrequency: number;
  subredditTargets: string[];
  pricingVariant: string;
  paywallTriggerCount: number;
  cycleMode: CycleMode;
  autonomyLevel: AutonomyLevel;
  trafficChannels: TrafficChannel[];
  trafficMultiplier: number;
  trafficPostIntervalMs: number;
  trafficMaxPostsPerCycle: number;
  trafficSubredditWhitelist: string[];
  trafficMode: TrafficMode;
  decisionMode: DecisionMode;
  createdAt: string;
  updatedAt: string;
}

export interface SystemCycleStateResponse {
  companyId: string;
  loopKey: string;
  status: string;
  stage: string | null;
  currentAction: string | null;
  decisionId: string | null;
  lastError: string | null;
  lastRunStartedAt: string | null;
  lastRunCompletedAt: string | null;
  lastRunDurationMs: number | null;
  details: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionFeedEventResponse {
  id: string;
  companyId: string;
  createdAt: string;
  category: "traffic" | "email" | "decision" | "execution" | "revenue" | "system";
  status: "info" | "success" | "failed" | "pending" | "blocked" | "skipped";
  reason: string | null;
  traceId: string;
  linkedIssueId: string | null;
  linkedGoalId: string | null;
  linkedAgentId: string | null;
  action: string;
  message: string;
  decisionId: string | null;
  details: Record<string, unknown> & {
    type?: "reddit_post" | "deployment" | "checkout" | "email";
    url?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface SystemDecisionResponse {
  id: string;
  companyId: string;
  source: string;
  actionType: string;
  actionKey: string;
  reason: string;
  metricName: string | null;
  metricValue: number | null;
  thresholdValue: number | null;
  actionPayload: Record<string, unknown>;
  status: SystemDecisionStatus;
  overrideNote: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  executedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const systemControlsApi = {
  getControls: (companyId: string) =>
    api.get<SystemControlsResponse>(`/companies/${companyId}/system-controls`),

  updateControls: (companyId: string, patch: UpdateSystemControls) =>
    api.patch<SystemControlsResponse>(`/companies/${companyId}/system-controls`, patch),

  listDecisions: (companyId: string, limit = 100) =>
    api.get<SystemDecisionResponse[]>(
      `/companies/${companyId}/decisions?limit=${encodeURIComponent(String(limit))}`,
    ),

  approveDecision: (companyId: string, decisionId: string, note?: string) =>
    api.post<{ decision: SystemDecisionResponse | null; execution: Record<string, unknown> }>(
      `/companies/${companyId}/decisions/${decisionId}/approve`,
      { note: note ?? null },
    ),

  rejectDecision: (companyId: string, decisionId: string, note?: string) =>
    api.post<SystemDecisionResponse>(`/companies/${companyId}/decisions/${decisionId}/reject`, {
      note: note ?? null,
    }),

  getCycleState: (companyId: string) =>
    api.get<SystemCycleStateResponse[]>(`/companies/${companyId}/cycle-state`),

  getExecutionFeed: (
    companyId: string,
    options?: { limit?: number; categories?: string[]; statuses?: string[] },
  ) => {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.categories && options.categories.length > 0) {
      params.set("categories", options.categories.join(","));
    }
    if (options?.statuses && options.statuses.length > 0) {
      params.set("statuses", options.statuses.join(","));
    }
    const query = params.toString();
    const suffix = query ? `?${query}` : "";
    return api.get<ExecutionFeedEventResponse[]>(`/companies/${companyId}/execution-feed${suffix}`);
  },

  runCycle: (companyId: string, cycleType: CycleMode, reason?: string) =>
    api.post<SystemCycleRunResult>("/cycle/run", {
      companyId,
      cycleType,
      reason: reason ?? null,
    }),

  runCycleFromIntent: (companyId: string, intent: string, reason?: string) =>
    api.post<{ intent: string; mappedCycleType: CycleMode; result: SystemCycleRunResult }>(
      "/cycle/run-from-intent",
      {
        companyId,
        intent,
        reason: reason ?? null,
      },
    ),
};
