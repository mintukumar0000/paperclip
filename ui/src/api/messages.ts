import { api } from "./client";

export const messagesApi = {
  list: (companyId: string) =>
    api.get<any[]>(`/companies/${companyId}/messages`),
  send: (companyId: string, data: { fromAgentId: string; toAgentId: string; message: string }) =>
    api.post<any>(`/companies/${companyId}/messages`, data),
  inbox: (companyId: string, agentId: string) =>
    api.get<any[]>(`/companies/${companyId}/agents/${agentId}/inbox`),
  outbox: (companyId: string, agentId: string) =>
    api.get<any[]>(`/companies/${companyId}/agents/${agentId}/outbox`),
  conversation: (companyId: string, agentA: string, agentB: string) =>
    api.get<any[]>(`/companies/${companyId}/conversations/${agentA}/${agentB}`),
  markRead: (messageId: string) =>
    api.patch<any>(`/messages/${messageId}/read`, {}),
};
