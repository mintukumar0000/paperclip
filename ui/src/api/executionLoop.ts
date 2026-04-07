import { api } from "./client";

export const executionLoopApi = {
  runCycle: (companyId: string) =>
    api.post<any>(`/companies/${companyId}/loop/run`, {}),
};
