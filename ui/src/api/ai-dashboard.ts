import { api } from "./client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoalProgress {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
}

export interface ActiveGoal {
  id: string;
  goal: string;
  agentId: string;
  issueId: string | null;
  status: string;
  isRunning: boolean;
  progress: GoalProgress;
  nextStep: string | null;
  iterationsUsed: number;
  maxIterations: number;
  createdAt: string;
  updatedAt: string;
}

export interface RecentGoal {
  id: string;
  goal: string;
  agentId: string;
  issueId: string | null;
  status: string;
  iterationsUsed: number;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AgentState {
  id: string;
  name: string;
  status: string;
  currentGoal: { planId: string; goal: string } | null;
  totalGoals: number;
  completedGoals: number;
  failedGoals: number;
}

export interface EngineInfo {
  name: string;
  kind: string;
  enabled: boolean;
}

export interface EngineStatus {
  capabilities: Record<string, boolean>;
  engines: EngineInfo[];
  categories: { brains: EngineInfo[]; hands: EngineInfo[] };
}

export interface AIDashboardSummary {
  goalStats: {
    active: number;
    completed: number;
    failed: number;
    cancelled: number;
    planning: number;
    total: number;
  };
  activeGoals: ActiveGoal[];
  recentGoals: RecentGoal[];
  agentStates: AgentState[];
  engineStatus: EngineStatus;
  systemStatus: {
    loopState: "running" | "idle" | "degraded";
    queueState: "healthy" | "normal" | "backlogged";
    queueDepth: number;
    workersActive: number;
    failuresLast10m: number;
  };
}

export interface GoalMemory {
  planId: string;
  issueId: string | null;
  agentId: string;
  status: string;
  iterationsUsed: number;
  maxIterations: number;
  goal: string;
  episodes: Array<{
    action?: string;
    observation?: { verdict?: string; error?: string };
  }>;
  steps: Array<{
    id: string;
    name: string;
    description?: string;
    dependsOn?: string[];
    status: string;
    retries?: number;
    maxRetries?: number;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    output?: string;
    error?: string;
  }>;
}

export interface CreateAIGoalInput {
  agentId: string;
  issueId: string;
  goal: string;
  maxSteps?: number;
  maxIterations?: number;
  deterministic?: boolean;
  deterministicSteps?: Array<{
    name: string;
    description: string;
    dependsOn?: string[];
    toolName?: string;
    toolArgs?: Record<string, unknown>;
  }>;
}

export interface CreatedAIGoal {
  planId: string;
  goal: string;
  status: string;
  runId: string;
}

export interface GovernanceSystemMetricsResponse {
  snapshot: Record<string, unknown>;
  recent: Array<Record<string, unknown>>;
}

export interface DecisionCycleResponse {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export const aiDashboardApi = {
  summary: (companyId: string) =>
    api.get<AIDashboardSummary>(`/companies/${companyId}/ai/dashboard`),

  goalMemory: (companyId: string, goalId: string) =>
    api.get<GoalMemory>(`/companies/${companyId}/ai/goals/${goalId}/memory`),

  retryGoal: (companyId: string, goalId: string) =>
    api.post<{ status: string; planId: string; retriedStep: string }>(
      `/companies/${companyId}/ai/goals/${goalId}/retry`,
      {},
    ),

  cancelGoal: (companyId: string, goalId: string) =>
    api.post<{ status: string; planId: string }>(
      `/companies/${companyId}/ai/goals/${goalId}/cancel`,
      {},
    ),

  reassignGoal: (companyId: string, goalId: string, agentId: string) =>
    api.post<{ status: string; planId: string; previousAgentId: string; newAgentId: string }>(
      `/companies/${companyId}/ai/goals/${goalId}/reassign`,
      { agentId },
    ),

  createGoal: (companyId: string, payload: CreateAIGoalInput) =>
    api.post<CreatedAIGoal>(`/companies/${companyId}/ai/goals`, payload),

  systemMetrics: (companyId: string, windowMinutes = 180) =>
    api.get<GovernanceSystemMetricsResponse>(
      `/companies/${companyId}/governance/system-metrics?windowMinutes=${encodeURIComponent(String(windowMinutes))}`,
    ),

  runDecisionCycle: (companyId: string, windowMinutes = 180) =>
    api.post<DecisionCycleResponse>(
      `/companies/${companyId}/governance/decision-cycle`,
      { windowMinutes },
    ),

  feedbackActions: (companyId: string) =>
    api.get<Array<Record<string, unknown>>>(
      `/governance/feedback/actions?companyId=${encodeURIComponent(companyId)}`,
    ),
};
