// ---------------------------------------------------------------------------
// Profit Optimizer — Analyzes ecosystem performance and recommends actions
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { eq, sql } from "@paperclipai/db";
import { publishEvent } from "../../events/eventPublisher.js";
import {
  listActiveServices,
  findServicesByCompany,
  getRegistryStats,
  type ServiceListing,
} from "./serviceRegistry.js";
import {
  listActiveContracts,
  getCompanyRevenue,
  getCompanySpending,
  getContractSummary,
} from "./contractManager.js";
import pino from "pino";

const logger = pino({ name: "profit-optimizer" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OptimizationAction =
  | "expand_company"
  | "shutdown_company"
  | "increase_prices"
  | "decrease_prices"
  | "add_service"
  | "remove_service"
  | "rebalance_budget"
  | "no_action";

export type CompanyHealthStatus = "thriving" | "profitable" | "stable" | "struggling" | "critical";

export interface CompanyPerformance {
  companyId: string;
  companyName: string;
  revenueCents: number;
  spendingCents: number;
  profitCents: number;
  profitMargin: number; // -1.0 to 1.0+
  serviceCount: number;
  activeContractCount: number;
  avgServicePerformance: number;
  healthStatus: CompanyHealthStatus;
}

export interface OptimizationRecommendation {
  id: string;
  companyId: string;
  companyName: string;
  action: OptimizationAction;
  reason: string;
  expectedImpactCents: number;
  priority: "critical" | "high" | "medium" | "low";
  createdAt: string;
}

export interface EcosystemAnalysis {
  totalCompanies: number;
  totalRevenueCents: number;
  totalSpendingCents: number;
  netProfitCents: number;
  ecosystemEfficiency: number; // 0.0 – 1.0
  companyPerformances: CompanyPerformance[];
  recommendations: OptimizationRecommendation[];
  analyzedAt: string;
}

// ---------------------------------------------------------------------------
// In-memory recommendation store
// ---------------------------------------------------------------------------

const recommendationHistory: OptimizationRecommendation[] = [];
let nextRecId = 1;

// ---------------------------------------------------------------------------
// Health assessment
// ---------------------------------------------------------------------------

function assessHealth(profitMargin: number, serviceCount: number): CompanyHealthStatus {
  if (profitMargin > 0.3 && serviceCount >= 2) return "thriving";
  if (profitMargin > 0.1) return "profitable";
  if (profitMargin >= 0) return "stable";
  if (profitMargin >= -0.2) return "struggling";
  return "critical";
}

// ---------------------------------------------------------------------------
// Analysis functions
// ---------------------------------------------------------------------------

/** Analyze performance of a single company */
export function analyzeCompanyPerformance(companyId: string, companyName: string): CompanyPerformance {
  const revenue = getCompanyRevenue(companyId);
  const spending = getCompanySpending(companyId);
  const profit = revenue - spending;
  const totalActivity = revenue + spending;
  const profitMargin = totalActivity > 0 ? profit / totalActivity : 0;

  const services = findServicesByCompany(companyId);
  const activeContracts = listActiveContracts().filter(
    (c) => c.providerCompanyId === companyId || c.consumerCompanyId === companyId,
  );

  const avgPerf = services.length > 0
    ? services.reduce((sum, s) => sum + s.performanceScore, 0) / services.length
    : 0;

  return {
    companyId,
    companyName,
    revenueCents: revenue,
    spendingCents: spending,
    profitCents: profit,
    profitMargin: Math.round(profitMargin * 100) / 100,
    serviceCount: services.length,
    activeContractCount: activeContracts.length,
    avgServicePerformance: Math.round(avgPerf * 100) / 100,
    healthStatus: assessHealth(profitMargin, services.length),
  };
}

/** Generate recommendations for a company */
function generateRecommendations(perf: CompanyPerformance): OptimizationRecommendation[] {
  const recs: OptimizationRecommendation[] = [];

  // Critical company → shutdown
  if (perf.healthStatus === "critical" && perf.serviceCount === 0) {
    recs.push({
      id: `rec_${nextRecId++}`,
      companyId: perf.companyId,
      companyName: perf.companyName,
      action: "shutdown_company",
      reason: `Company "${perf.companyName}" has no services and is operating at a loss`,
      expectedImpactCents: Math.abs(perf.profitCents),
      priority: "critical",
      createdAt: new Date().toISOString(),
    });
  }

  // Struggling company → decrease prices to attract demand
  if (perf.healthStatus === "struggling" && perf.activeContractCount === 0) {
    recs.push({
      id: `rec_${nextRecId++}`,
      companyId: perf.companyId,
      companyName: perf.companyName,
      action: "decrease_prices",
      reason: `Company "${perf.companyName}" has no active contracts; lowering prices may attract consumers`,
      expectedImpactCents: 50,
      priority: "high",
      createdAt: new Date().toISOString(),
    });
  }

  // Thriving company → expand
  if (perf.healthStatus === "thriving" && perf.profitCents > 100) {
    recs.push({
      id: `rec_${nextRecId++}`,
      companyId: perf.companyId,
      companyName: perf.companyName,
      action: "expand_company",
      reason: `Company "${perf.companyName}" is thriving (margin: ${(perf.profitMargin * 100).toFixed(0)}%); consider adding services`,
      expectedImpactCents: perf.profitCents,
      priority: "medium",
      createdAt: new Date().toISOString(),
    });
  }

  // High-performing company with few services → add service
  if (perf.avgServicePerformance > 0.8 && perf.serviceCount < 3) {
    recs.push({
      id: `rec_${nextRecId++}`,
      companyId: perf.companyId,
      companyName: perf.companyName,
      action: "add_service",
      reason: `Company "${perf.companyName}" has high performance (${perf.avgServicePerformance}) but only ${perf.serviceCount} service(s)`,
      expectedImpactCents: 100,
      priority: "medium",
      createdAt: new Date().toISOString(),
    });
  }

  // Profitable with low utilization → increase prices
  if (perf.healthStatus === "profitable" && perf.activeContractCount > 2) {
    recs.push({
      id: `rec_${nextRecId++}`,
      companyId: perf.companyId,
      companyName: perf.companyName,
      action: "increase_prices",
      reason: `Company "${perf.companyName}" is profitable with high demand (${perf.activeContractCount} contracts)`,
      expectedImpactCents: Math.round(perf.revenueCents * 0.1),
      priority: "low",
      createdAt: new Date().toISOString(),
    });
  }

  return recs;
}

/** Full ecosystem analysis */
export async function analyzeEcosystem(db: Db): Promise<EcosystemAnalysis> {
  // Get all active companies
  const allCompanies = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(eq(companies.status, "active"));

  const performances: CompanyPerformance[] = [];
  const allRecommendations: OptimizationRecommendation[] = [];
  let totalRevenue = 0;
  let totalSpending = 0;

  for (const company of allCompanies) {
    const perf = analyzeCompanyPerformance(company.id, company.name);
    performances.push(perf);
    totalRevenue += perf.revenueCents;
    totalSpending += perf.spendingCents;

    const recs = generateRecommendations(perf);
    allRecommendations.push(...recs);
  }

  // Store recommendations
  recommendationHistory.push(...allRecommendations);

  const netProfit = totalRevenue - totalSpending;
  const totalActivity = totalRevenue + totalSpending;
  const efficiency = totalActivity > 0 ? Math.max(0, netProfit / totalActivity) : 0;

  const analysis: EcosystemAnalysis = {
    totalCompanies: allCompanies.length,
    totalRevenueCents: totalRevenue,
    totalSpendingCents: totalSpending,
    netProfitCents: netProfit,
    ecosystemEfficiency: Math.round(efficiency * 100) / 100,
    companyPerformances: performances,
    recommendations: allRecommendations,
    analyzedAt: new Date().toISOString(),
  };

  logger.info({
    companies: allCompanies.length,
    revenue: totalRevenue,
    spending: totalSpending,
    recommendations: allRecommendations.length,
  }, "Ecosystem analysis completed");

  await publishEvent("ai.economy.ecosystem.analyzed", {
    totalCompanies: allCompanies.length,
    netProfitCents: netProfit,
    recommendationCount: allRecommendations.length,
  });

  return analysis;
}

/** Get recommendation history */
export function getRecommendations(): OptimizationRecommendation[] {
  return [...recommendationHistory];
}

/** Get recommendations by priority */
export function getRecommendationsByPriority(
  priority: "critical" | "high" | "medium" | "low",
): OptimizationRecommendation[] {
  return recommendationHistory.filter((r) => r.priority === priority);
}

/** Clear optimizer data (for testing) */
export function clearOptimizerData(): void {
  recommendationHistory.length = 0;
  nextRecId = 1;
}
