import { api } from "./client";

export interface GovernanceRule {
  id: string;
  companyId: string;
  ruleName: string;
  ruleType: string;
  ruleDefinition: string;
  severity: string;
  description?: string;
  active: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InstitutionalKnowledge {
  id: string;
  companyId: string;
  title: string;
  category: string;
  content: string;
  source?: string;
  tags: string[];
  status: string;
  contributedBy?: string;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Playbook {
  id: string;
  companyId: string;
  title: string;
  description: string;
  category: string;
  steps: Array<{ order: number; title: string; description: string }>;
  triggerCondition?: string;
  active: boolean;
  timesApplied: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GoalContainmentStats {
  totalGoals: number;
  activeGoals: number;
  maxActiveGoals: number;
  maxDepth: number;
  maxChildGoals: number;
  maxTasksPerPlanCycle: number;
  deepestGoalDepth: number;
}

export interface GovernanceDashboard {
  governance: Record<string, unknown>;
  rateLimits: Record<string, unknown>;
  sandbox: Record<string, unknown>;
  feedbackConfig: Record<string, unknown>;
  pendingActions: unknown[];
  autonomyLimits: Record<string, number>;
}

export const governanceApi = {
  // Dashboard
  dashboard: () => api.get<GovernanceDashboard>("/governance/dashboard"),
  limits: () => api.get<Record<string, number>>("/governance/limits"),
  goalContainment: (companyId: string) =>
    api.get<GoalContainmentStats>(`/companies/${companyId}/governance/goal-containment`),

  // Constitutional Rules
  listRules: (companyId: string) =>
    api.get<GovernanceRule[]>(`/companies/${companyId}/governance/rules`),
  createRule: (companyId: string, data: Partial<GovernanceRule>) =>
    api.post<GovernanceRule>(`/companies/${companyId}/governance/rules`, data),
  updateRule: (companyId: string, ruleId: string, data: Partial<GovernanceRule>) =>
    api.patch<GovernanceRule>(`/companies/${companyId}/governance/rules/${ruleId}`, data),
  deleteRule: (companyId: string, ruleId: string) =>
    api.delete<void>(`/companies/${companyId}/governance/rules/${ruleId}`),

  // Institutional Knowledge
  listKnowledge: (companyId: string) =>
    api.get<InstitutionalKnowledge[]>(`/companies/${companyId}/governance/knowledge`),
  createKnowledge: (companyId: string, data: Partial<InstitutionalKnowledge>) =>
    api.post<InstitutionalKnowledge>(`/companies/${companyId}/governance/knowledge`, data),
  approveKnowledge: (companyId: string, id: string) =>
    api.post<InstitutionalKnowledge>(`/companies/${companyId}/governance/knowledge/${id}/approve`, {}),

  // Playbooks
  listPlaybooks: (companyId: string) =>
    api.get<Playbook[]>(`/companies/${companyId}/governance/playbooks`),
  createPlaybook: (companyId: string, data: Partial<Playbook>) =>
    api.post<Playbook>(`/companies/${companyId}/governance/playbooks`, data),
  updatePlaybook: (companyId: string, id: string, data: Partial<Playbook>) =>
    api.patch<Playbook>(`/companies/${companyId}/governance/playbooks/${id}`, data),
  applyPlaybook: (companyId: string, id: string) =>
    api.post<Record<string, unknown>>(`/companies/${companyId}/governance/playbooks/${id}/apply`, {}),
};
