import { api } from "./client";

export const workflowsApi = {
  list: (companyId: string) => api.get<any[]>(`/companies/${companyId}/workflows`),
  create: (companyId: string, data: { name: string; description?: string; definition: any }) =>
    api.post<any>(`/companies/${companyId}/workflows`, data),
  trigger: (workflowId: string, context?: Record<string, unknown>) =>
    api.post<any>(`/workflows/${workflowId}/trigger`, { context }),
  listRuns: (companyId: string) => api.get<any[]>(`/companies/${companyId}/workflow-runs`),
};
