import { api } from "./client";

export interface ServiceRegistration {
  id: string;
  companyId: string;
  name: string;
  category: string;
  description: string;
  pricePerRequestCents: number;
  status: string;
  createdAt: string;
}

export interface ServiceContract {
  id: string;
  requestingCompanyId: string;
  providingCompanyId: string;
  serviceId: string;
  status: string;
  pricePerRequestCents: number;
  maxRequestsPerDay: number;
  successRate: number;
  avgResponseTimeMs: number;
  totalExecutions: number;
  createdAt: string;
}

export interface MarketplaceStats {
  totalServices: number;
  activeContracts: number;
  totalExecutions: number;
  categories: string[];
}

export interface EconomyAnalysis {
  totalRevenueCents: number;
  totalSpendCents: number;
  activeServices: number;
  activeContracts: number;
  topCategories: Array<{ category: string; count: number }>;
}

export const economyApi = {
  services: () => api.get<ServiceRegistration[]>("/economy/services"),
  serviceStats: () => api.get<MarketplaceStats>("/economy/services/stats"),
  companyServices: (companyId: string) =>
    api.get<ServiceRegistration[]>(`/companies/${companyId}/economy/services`),
  contracts: () => api.get<ServiceContract[]>("/economy/contracts"),
  companyContracts: (companyId: string) =>
    api.get<ServiceContract[]>(`/companies/${companyId}/economy/contracts`),
  marketplaceStats: () => api.get<MarketplaceStats>("/economy/marketplace/stats"),
  analysis: () => api.get<EconomyAnalysis>("/economy/analysis"),
  companyPerformance: (companyId: string) =>
    api.get<Record<string, unknown>>(`/companies/${companyId}/economy/performance`),
};
