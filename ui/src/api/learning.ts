import { api } from "./client";

export interface LearningRecord {
  id: string;
  companyId: string;
  goalId?: string;
  agentId?: string;
  recordType: string;
  category: string;
  summary: string;
  details: Record<string, unknown>;
  scores?: Record<string, number>;
  recommendedChange?: string;
  applied: boolean;
  appliedAt?: string;
  rolledBack: boolean;
  rolledBackAt?: string;
  parentRecordId?: string;
  createdAt: string;
}

export interface ImprovementPlan {
  id: string;
  category: string;
  summary: string;
  applied: boolean;
  appliedAt?: string;
  rolledBack: boolean;
}

export interface PerformanceMetrics {
  agentId: string;
  metrics: Record<string, number>;
}

export const learningApi = {
  records: (companyId: string, type?: string, category?: string) => {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    if (category) params.set("category", category);
    const qs = params.toString();
    return api.get<LearningRecord[]>(`/companies/${companyId}/learning/records${qs ? `?${qs}` : ""}`);
  },
  performance: (companyId: string) =>
    api.get<PerformanceMetrics[]>(`/companies/${companyId}/learning/performance`),
  improvements: (companyId: string) =>
    api.get<ImprovementPlan[]>(`/companies/${companyId}/learning/improvements`),
  applyImprovement: (companyId: string, planId: string) =>
    api.post<ImprovementPlan>(`/companies/${companyId}/learning/improvements/${planId}/apply`, {}),
  rollbackImprovement: (companyId: string, planId: string) =>
    api.post<ImprovementPlan>(`/companies/${companyId}/learning/improvements/${planId}/rollback`, {}),
  runCycle: (companyId: string) =>
    api.post<Record<string, unknown>>(`/companies/${companyId}/learning/cycle`, {}),
  reflect: (companyId: string) =>
    api.post<Record<string, unknown>>(`/companies/${companyId}/learning/reflect`, {}),
};
