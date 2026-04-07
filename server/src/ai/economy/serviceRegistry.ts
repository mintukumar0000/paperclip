// ---------------------------------------------------------------------------
// Service Registry — Companies expose services to the internal marketplace
// ---------------------------------------------------------------------------

import { eq, and, sql } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { companies, agents } from "@paperclipai/db";
import { publishEvent } from "../../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "service-registry" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServiceCategory =
  | "analytics"
  | "marketing"
  | "engineering"
  | "customer_support"
  | "seo"
  | "content"
  | "infrastructure"
  | "security"
  | "compliance"
  | "design";

export type ServiceStatus = "active" | "paused" | "deprecated";

export interface ServiceListing {
  id: string;
  companyId: string;
  companyName: string;
  serviceName: string;
  description: string;
  category: ServiceCategory;
  capabilities: string[];
  pricePerRequestCents: number;
  maxRequestsPerDay: number;
  currentLoad: number; // 0.0 – 1.0
  performanceScore: number; // 0.0 – 1.0
  status: ServiceStatus;
  registeredAt: string;
  metadata?: Record<string, unknown>;
}

export interface RegisterServiceInput {
  companyId: string;
  serviceName: string;
  description: string;
  category: ServiceCategory;
  capabilities: string[];
  pricePerRequestCents: number;
  maxRequestsPerDay: number;
}

export interface RegistryStats {
  totalServices: number;
  activeServices: number;
  servicesByCategory: Record<string, number>;
  averagePrice: number;
  topProviders: { companyId: string; companyName: string; serviceCount: number }[];
}

// ---------------------------------------------------------------------------
// In-memory registry (backed by company/agent metadata)
// ---------------------------------------------------------------------------

const serviceStore = new Map<string, ServiceListing>();
let nextServiceId = 1;

function generateId(): string {
  return `svc_${nextServiceId++}`;
}

// ---------------------------------------------------------------------------
// Category → default capabilities mapping
// ---------------------------------------------------------------------------

export const CATEGORY_CAPABILITIES: Record<ServiceCategory, string[]> = {
  analytics: ["data_analysis", "reporting", "visualization", "predictive_modeling"],
  marketing: ["campaign_management", "audience_targeting", "content_creation", "ab_testing"],
  engineering: ["code_review", "architecture", "debugging", "deployment"],
  customer_support: ["ticket_resolution", "live_chat", "knowledge_base", "escalation"],
  seo: ["keyword_research", "link_building", "site_audit", "ranking_analysis"],
  content: ["copywriting", "blog_posts", "social_media", "video_scripts"],
  infrastructure: ["hosting", "scaling", "monitoring", "ci_cd"],
  security: ["vulnerability_scanning", "penetration_testing", "compliance_audit", "incident_response"],
  compliance: ["regulatory_review", "policy_creation", "audit_preparation", "risk_assessment"],
  design: ["ui_design", "ux_research", "branding", "prototyping"],
};

// ---------------------------------------------------------------------------
// Registry operations
// ---------------------------------------------------------------------------

/** Register a new service from a company */
export async function registerService(
  db: Db,
  input: RegisterServiceInput,
): Promise<ServiceListing> {
  // Verify company exists
  const [company] = await db.select().from(companies).where(eq(companies.id, input.companyId));
  if (!company) {
    throw new Error(`Company ${input.companyId} not found`);
  }

  const listing: ServiceListing = {
    id: generateId(),
    companyId: input.companyId,
    companyName: company.name,
    serviceName: input.serviceName,
    description: input.description,
    category: input.category,
    capabilities: input.capabilities.length > 0
      ? input.capabilities
      : CATEGORY_CAPABILITIES[input.category] ?? [],
    pricePerRequestCents: input.pricePerRequestCents,
    maxRequestsPerDay: input.maxRequestsPerDay,
    currentLoad: 0,
    performanceScore: 0.8, // default starting score
    status: "active",
    registeredAt: new Date().toISOString(),
  };

  serviceStore.set(listing.id, listing);

  logger.info({ serviceId: listing.id, companyId: input.companyId, serviceName: input.serviceName }, "Service registered");

  await publishEvent("ai.economy.service.registered", {
    serviceId: listing.id,
    companyId: input.companyId,
    serviceName: input.serviceName,
    category: input.category,
  });

  return listing;
}

/** Auto-register services from a company based on its agents' capabilities */
export async function autoRegisterFromCompany(
  db: Db,
  companyId: string,
): Promise<ServiceListing[]> {
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
  if (!company) {
    throw new Error(`Company ${companyId} not found`);
  }

  const companyAgents = await db.select().from(agents).where(eq(agents.companyId, companyId));

  // Derive service categories from agent roles
  const categorySet = new Set<ServiceCategory>();
  for (const agent of companyAgents) {
    const role = (agent.role ?? "").toLowerCase();
    if (role.includes("analyt") || role.includes("data")) categorySet.add("analytics");
    if (role.includes("market")) categorySet.add("marketing");
    if (role.includes("engineer") || role.includes("develop") || role.includes("code")) categorySet.add("engineering");
    if (role.includes("support") || role.includes("customer")) categorySet.add("customer_support");
    if (role.includes("seo")) categorySet.add("seo");
    if (role.includes("content") || role.includes("writ")) categorySet.add("content");
    if (role.includes("infra") || role.includes("devops") || role.includes("ops")) categorySet.add("infrastructure");
    if (role.includes("secur")) categorySet.add("security");
    if (role.includes("compli") || role.includes("legal")) categorySet.add("compliance");
    if (role.includes("design") || role.includes("ux") || role.includes("ui")) categorySet.add("design");
  }

  const listings: ServiceListing[] = [];
  for (const category of categorySet) {
    // Don't re-register duplicates
    const existing = findServicesByCompany(companyId).find((s) => s.category === category);
    if (existing) continue;

    const listing = await registerService(db, {
      companyId,
      serviceName: `${company.name} ${category.replace(/_/g, " ")} service`,
      description: `${category.replace(/_/g, " ")} services provided by ${company.name}`,
      category,
      capabilities: CATEGORY_CAPABILITIES[category] ?? [],
      pricePerRequestCents: DEFAULT_CATEGORY_PRICE[category] ?? 5,
      maxRequestsPerDay: 1000,
    });
    listings.push(listing);
  }

  return listings;
}

/** Default starting prices by category (cents per request) */
export const DEFAULT_CATEGORY_PRICE: Record<ServiceCategory, number> = {
  analytics: 8,
  marketing: 6,
  engineering: 12,
  customer_support: 4,
  seo: 7,
  content: 5,
  infrastructure: 10,
  security: 15,
  compliance: 10,
  design: 8,
};

/** Get a service by ID */
export function getService(serviceId: string): ServiceListing | undefined {
  return serviceStore.get(serviceId);
}

/** List all active services */
export function listActiveServices(): ServiceListing[] {
  return Array.from(serviceStore.values()).filter((s) => s.status === "active");
}

/** Find services by category */
export function findServicesByCategory(category: ServiceCategory): ServiceListing[] {
  return listActiveServices().filter((s) => s.category === category);
}

/** Find services by company */
export function findServicesByCompany(companyId: string): ServiceListing[] {
  return Array.from(serviceStore.values()).filter((s) => s.companyId === companyId);
}

/** Update service load */
export function updateServiceLoad(serviceId: string, load: number): boolean {
  const svc = serviceStore.get(serviceId);
  if (!svc) return false;
  svc.currentLoad = Math.max(0, Math.min(1, load));
  return true;
}

/** Update service performance score */
export function updateServicePerformance(serviceId: string, score: number): boolean {
  const svc = serviceStore.get(serviceId);
  if (!svc) return false;
  svc.performanceScore = Math.max(0, Math.min(1, score));
  return true;
}

/** Pause a service */
export function pauseService(serviceId: string): boolean {
  const svc = serviceStore.get(serviceId);
  if (!svc) return false;
  svc.status = "paused";
  return true;
}

/** Resume a service */
export function resumeService(serviceId: string): boolean {
  const svc = serviceStore.get(serviceId);
  if (!svc || svc.status === "deprecated") return false;
  svc.status = "active";
  return true;
}

/** Deprecate a service */
export function deprecateService(serviceId: string): boolean {
  const svc = serviceStore.get(serviceId);
  if (!svc) return false;
  svc.status = "deprecated";
  return true;
}

/** Get registry statistics */
export function getRegistryStats(): RegistryStats {
  const all = Array.from(serviceStore.values());
  const active = all.filter((s) => s.status === "active");

  const byCategory: Record<string, number> = {};
  for (const svc of active) {
    byCategory[svc.category] = (byCategory[svc.category] ?? 0) + 1;
  }

  const byCompany = new Map<string, { companyName: string; count: number }>();
  for (const svc of active) {
    const entry = byCompany.get(svc.companyId) ?? { companyName: svc.companyName, count: 0 };
    entry.count++;
    byCompany.set(svc.companyId, entry);
  }

  const topProviders = Array.from(byCompany.entries())
    .map(([companyId, data]) => ({ companyId, companyName: data.companyName, serviceCount: data.count }))
    .sort((a, b) => b.serviceCount - a.serviceCount)
    .slice(0, 5);

  const avgPrice = active.length > 0
    ? Math.round(active.reduce((sum, s) => sum + s.pricePerRequestCents, 0) / active.length)
    : 0;

  return {
    totalServices: all.length,
    activeServices: active.length,
    servicesByCategory: byCategory,
    averagePrice: avgPrice,
    topProviders,
  };
}

/** Clear the registry (for testing) */
export function clearRegistry(): void {
  serviceStore.clear();
  nextServiceId = 1;
}
