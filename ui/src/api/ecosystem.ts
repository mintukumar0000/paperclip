import { api } from "./client";

export interface Opportunity {
  id: string;
  title: string;
  description: string;
  sourceType: string;
  marketCategory: string;
  potentialRevenue: string;
  confidence: number;
  suggestedProduct: string;
  targetMarket: string;
  discoveredAt: string;
  metadata: Record<string, unknown>;
}

export interface EcosystemStatus {
  companies: number;
  totalAgents: number;
  limits: Record<string, number>;
}

export interface ExpansionRequest {
  id: string;
  companyId: string;
  requestType: string;
  status: string;
  approvalLevel: string;
  requestedRole?: string;
  requestedCapabilities?: string;
  reason: string;
  gapAnalysis?: Record<string, unknown>;
  designSpec?: Record<string, unknown>;
  resultAgentId?: string;
  resultDepartmentId?: string;
  requestedBy?: string;
  approvedBy?: string;
  rejectionReason?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const ecosystemApi = {
  opportunities: (companyId: string) =>
    api.get<Opportunity[]>(`/companies/${companyId}/ecosystem/opportunities`),
  status: () => api.get<EcosystemStatus>("/ecosystem/status"),
  limits: () => api.get<Record<string, number>>("/ecosystem/limits"),
  requests: (companyId: string) =>
    api.get<ExpansionRequest[]>(`/companies/${companyId}/ecosystem/requests`),
  pendingRequests: (companyId: string) =>
    api.get<ExpansionRequest[]>(`/companies/${companyId}/ecosystem/requests/pending`),
  approveRequest: (companyId: string, requestId: string) =>
    api.post<ExpansionRequest>(`/companies/${companyId}/ecosystem/requests/${requestId}/approve`, {}),
  rejectRequest: (companyId: string, requestId: string, reason: string) =>
    api.post<ExpansionRequest>(`/companies/${companyId}/ecosystem/requests/${requestId}/reject`, { rejectionReason: reason }),
};
