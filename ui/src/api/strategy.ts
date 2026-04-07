import { api } from "./client";

export const strategyApi = {
  analyze: (companyId: string) =>
    api.post<any>(`/companies/${companyId}/strategy/analyze`, {}),
  listPlans: (companyId: string) =>
    api.get<any[]>(`/companies/${companyId}/strategy/plans`),
};
