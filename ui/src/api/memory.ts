import { api } from "./client";

export const memoryApi = {
  list: (companyId: string, type?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();
    return api.get<any[]>(`/companies/${companyId}/memories${qs ? `?${qs}` : ""}`);
  },
  create: (companyId: string, data: { agentId?: string; type: string; title: string; content: string; metadata?: Record<string, unknown> }) =>
    api.post<any>(`/companies/${companyId}/memories`, data),
  search: (companyId: string, q: string) =>
    api.get<any[]>(`/companies/${companyId}/memories/search?q=${encodeURIComponent(q)}`),
};
