import { api } from "./client";

export interface ExpansionGap {
  role: string;
  severity: string;
  description: string;
  recommendation: string;
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

export interface ExpansionLimits {
  maxAgentsPerCompany: number;
  currentAgents: number;
  maxDepartments: number;
  currentDepartments: number;
}

export interface ExpansionPipelineResult {
  expanded: boolean;
  reason?: string;
  gapsFound?: number;
  agentsDesigned?: number;
  results?: Array<{
    role: string;
    created: boolean;
    reason?: string;
    status?: string;
    approvalLevel?: string;
    requestId?: string;
    agentId?: string;
  }>;
}

export const expansionApi = {
  gaps: (companyId: string) =>
    api.get<ExpansionGap[]>(`/companies/${companyId}/expansion/gaps`),
  expand: (companyId: string, data?: { requestedBy?: string }) =>
    api.post<ExpansionPipelineResult>(`/companies/${companyId}/expansion/expand`, data ?? {}),
  requests: (companyId: string) =>
    api.get<ExpansionRequest[]>(`/companies/${companyId}/expansion/requests`),
  pendingRequests: (companyId: string) =>
    api.get<ExpansionRequest[]>(`/companies/${companyId}/expansion/requests/pending`),
  limits: (companyId: string) =>
    api.get<ExpansionLimits>(`/companies/${companyId}/expansion/limits`),
  approveRequest: (companyId: string, requestId: string) =>
    api.post<ExpansionRequest>(`/companies/${companyId}/expansion/requests/${requestId}/approve`, {}),
  rejectRequest: (companyId: string, requestId: string, reason: string) =>
    api.post<ExpansionRequest>(`/companies/${companyId}/expansion/requests/${requestId}/reject`, { rejectionReason: reason }),
};
