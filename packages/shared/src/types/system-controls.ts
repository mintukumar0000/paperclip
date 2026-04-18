import type {
  AutonomyLevel,
  CycleMode,
  CycleStateStatus,
  DecisionMode,
  SystemDecisionStatus,
  TrafficChannel,
  TrafficMode,
} from "../constants.js";

export interface SystemControls {
  companyId: string;
  systemActive?: boolean;
  loopIntervalSeconds?: number;
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
  createdAt: Date;
  updatedAt: Date;
}

export interface SystemDecision {
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
  approvedAt: Date | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  executedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SystemCycleState {
  companyId: string;
  loopKey: string;
  status: CycleStateStatus;
  stage: string | null;
  currentAction: string | null;
  decisionId: string | null;
  lastError: string | null;
  lastRunStartedAt: Date | null;
  lastRunCompletedAt: Date | null;
  lastRunDurationMs: number | null;
  details: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExecutionFeedEvent {
  id: string;
  companyId: string;
  createdAt: string;
  category: "traffic" | "email" | "decision" | "execution" | "revenue" | "system";
  status: "info" | "success" | "failed" | "pending" | "blocked" | "skipped";
  reason?: string | null;
  traceId?: string;
  linkedIssueId?: string | null;
  linkedGoalId?: string | null;
  linkedAgentId?: string | null;
  action: string;
  message: string;
  decisionId: string | null;
  details: Record<string, unknown>;
}

export type SystemCycleStepKey = "execution" | "traffic" | "decision" | "email";

export interface SystemCycleStepResult {
  step: SystemCycleStepKey;
  status: "success" | "failed";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  details?: Record<string, unknown>;
  error?: string;
}

export interface SystemCycleRunResult {
  companyId: string;
  cycleType: CycleMode;
  status: "success" | "partial_failed" | "failed";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  steps: SystemCycleStepResult[];
}
