import { api } from "./client";

export const templatesApi = {
  list: () => api.get<Array<{ id: string; name: string; description: string }>>("/templates"),
  get: (id: string) => api.get<any>(`/templates/${id}`),
  deploy: (id: string, companyName: string) =>
    api.post<any>(`/templates/${id}/deploy`, { companyName }),
};
