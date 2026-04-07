import { api } from "./client";

export interface StabilityAssessment {
  stabilityScore: number;
  stage: string;
  action: string;
  indicators: {
    companyCount: number;
    agentCount: number;
    totalGoals: number;
    activeGoals: number;
    taskBacklog: number;
    agentUtilization: number;
    goalGrowthRate: number;
    companyGrowthRate: number;
    resourceBalance: number;
  };
  reasons: string[];
  timestamp: string;
}

export interface CanExpandResult {
  allowed: boolean;
  reason: string;
  stabilityScore: number;
  stage: string;
}

export interface StabilityEvent {
  id: string;
  companyId: string | null;
  eventType: string;
  severity: string;
  stabilityScore: number;
  trigger: string;
  action: string;
  details: Record<string, unknown>;
  resolvedAt: string | null;
  createdAt: string;
}

export interface StabilityMetric {
  id: string;
  companyCount: number;
  agentCount: number;
  goalCount: number;
  activeGoalCount: number;
  taskBacklog: number;
  agentUtilization: number;
  stabilityScore: number;
  expansionPressure: number;
  snapshotAt: string;
  createdAt: string;
}

export interface StabilityThresholds {
  maxCompanies: number;
  maxAgentsPerCompany: number;
  maxGoalsPerCompany: number;
  maxTaskBacklog: number;
  minUtilization: number;
  maxGrowthRate: number;
  [key: string]: number;
}

export const stabilityApi = {
  assessment: () => api.get<StabilityAssessment>("/stability/assessment"),
  canExpand: () => api.get<CanExpandResult>("/stability/can-expand"),
  canCompanyExpand: (companyId: string) =>
    api.get<CanExpandResult>(`/companies/${companyId}/stability/can-expand`),
  history: (limit?: number) =>
    api.get<StabilityMetric[]>(`/stability/history${limit ? `?limit=${limit}` : ""}`),
  events: (limit?: number) =>
    api.get<StabilityEvent[]>(`/stability/events${limit ? `?limit=${limit}` : ""}`),
  limits: () => api.get<Record<string, unknown>[]>("/stability/limits"),
  thresholds: () => api.get<StabilityThresholds>("/stability/thresholds"),
  updateThresholds: (overrides: Partial<StabilityThresholds>) =>
    api.patch<{ updated: boolean; thresholds: StabilityThresholds }>("/stability/thresholds", overrides),
  resetThresholds: () =>
    api.post<{ reset: boolean; thresholds: StabilityThresholds }>("/stability/thresholds/reset", {}),
};
