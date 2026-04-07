// ---------------------------------------------------------------------------
// Economic Limits — Guard rails preventing runaway AI economic activity
// ---------------------------------------------------------------------------

import {
  getContractSummary,
  listActiveContracts,
  getCompanySpending,
  getCompanyRevenue,
} from "../economy/contractManager.js";
import { getRegistryStats, listActiveServices } from "../economy/serviceRegistry.js";
import { getAutonomyLimits } from "./autonomyLimits.js";
import pino from "pino";

const logger = pino({ name: "economic-limits" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EconomicLimits {
  maxActiveContracts: number;
  maxDailyTransactionsCents: number;
  maxEcosystemBudgetCents: number;
  maxCompanyLossCents: number;
  maxServicesPerCompany: number;
  maxContractsPerCompany: number;
  maxTransactionValueCents: number;
  maxServiceCallsPerDay: number;
  maxIntercompanyDependencies: number;
}

export interface EconomicStatus {
  limits: EconomicLimits;
  currentActiveContracts: number;
  currentTotalTransactionsCents: number;
  currentActiveServices: number;
  violations: string[];
  isWithinLimits: boolean;
}

export interface CompanyEconomicStatus {
  companyId: string;
  revenueCents: number;
  spendingCents: number;
  netCents: number;
  serviceCount: number;
  contractCount: number;
  violations: string[];
  isWithinLimits: boolean;
}

// ---------------------------------------------------------------------------
// Default limits
// ---------------------------------------------------------------------------

/** Get current economic limits — synced from global autonomy limits */
export function getEconomicLimits(): EconomicLimits {
  const global = getAutonomyLimits();
  return {
    maxActiveContracts: global.maxIntercompanyContracts,
    maxDailyTransactionsCents: global.maxDailyCostPerCompanyCents * 10, // ecosystem-wide
    maxEcosystemBudgetCents: global.maxEcosystemDailySpendCents * 30, // monthly
    maxCompanyLossCents: global.maxDailyCostPerCompanyCents * 2, // 2x daily as max loss
    maxServicesPerCompany: 10,
    maxContractsPerCompany: 20,
    maxTransactionValueCents: global.maxTransactionValueCents,
    maxServiceCallsPerDay: global.maxServiceCallsPerDay,
    maxIntercompanyDependencies: global.maxIntercompanyDependencies,
  };
}

/** Check ecosystem-wide economic status */
export function checkEconomicStatus(): EconomicStatus {
  const limits = getEconomicLimits();
  const contractSummary = getContractSummary();
  const registryStats = getRegistryStats();
  const violations: string[] = [];

  if (contractSummary.activeContracts >= limits.maxActiveContracts) {
    violations.push(
      `Active contracts limit reached (${contractSummary.activeContracts}/${limits.maxActiveContracts})`,
    );
  }

  if (contractSummary.totalTransactionsCents >= limits.maxEcosystemBudgetCents) {
    violations.push(
      `Ecosystem budget limit reached ($${(contractSummary.totalTransactionsCents / 100).toFixed(2)}/$${(limits.maxEcosystemBudgetCents / 100).toFixed(2)})`,
    );
  }

  return {
    limits,
    currentActiveContracts: contractSummary.activeContracts,
    currentTotalTransactionsCents: contractSummary.totalTransactionsCents,
    currentActiveServices: registryStats.activeServices,
    violations,
    isWithinLimits: violations.length === 0,
  };
}

/** Check if a new contract can be created */
export function canCreateContract(
  providerCompanyId: string,
  consumerCompanyId: string,
  transactionValueCents?: number,
): { allowed: boolean; reason?: string } {
  const limits = getEconomicLimits();
  const summary = getContractSummary();

  // Ecosystem-wide active contract limit
  if (summary.activeContracts >= limits.maxActiveContracts) {
    return { allowed: false, reason: `Ecosystem active contract limit reached (${limits.maxActiveContracts})` };
  }

  // Ecosystem total budget
  if (summary.totalTransactionsCents >= limits.maxEcosystemBudgetCents) {
    return { allowed: false, reason: `Ecosystem total budget exceeded ($${(limits.maxEcosystemBudgetCents / 100).toFixed(2)})` };
  }

  // Per-transaction value limit
  if (transactionValueCents && transactionValueCents > limits.maxTransactionValueCents) {
    return { allowed: false, reason: `Transaction value ($${(transactionValueCents / 100).toFixed(2)}) exceeds max ($${(limits.maxTransactionValueCents / 100).toFixed(2)})` };
  }

  // Per-company contract limit
  const providerContracts = listActiveContracts().filter(
    (c) => c.providerCompanyId === providerCompanyId,
  );
  if (providerContracts.length >= limits.maxContractsPerCompany) {
    return { allowed: false, reason: `Provider has reached contract limit (${limits.maxContractsPerCompany})` };
  }

  const consumerContracts = listActiveContracts().filter(
    (c) => c.consumerCompanyId === consumerCompanyId,
  );
  if (consumerContracts.length >= limits.maxContractsPerCompany) {
    return { allowed: false, reason: `Consumer has reached contract limit (${limits.maxContractsPerCompany})` };
  }

  // Max intercompany dependencies — count unique companies a consumer depends on
  const uniqueProviders = new Set(
    listActiveContracts()
      .filter((c) => c.consumerCompanyId === consumerCompanyId)
      .map((c) => c.providerCompanyId),
  );
  uniqueProviders.add(providerCompanyId); // include the new one
  if (uniqueProviders.size > limits.maxIntercompanyDependencies) {
    return { allowed: false, reason: `Consumer depends on too many companies (${uniqueProviders.size}/${limits.maxIntercompanyDependencies})` };
  }

  // Check company loss limit for consumer
  const consumerRevenue = getCompanyRevenue(consumerCompanyId);
  const consumerSpending = getCompanySpending(consumerCompanyId);
  const consumerNet = consumerRevenue - consumerSpending;
  if (consumerNet < -limits.maxCompanyLossCents) {
    return { allowed: false, reason: `Consumer company has exceeded max loss ($${(limits.maxCompanyLossCents / 100).toFixed(2)})` };
  }

  return { allowed: true };
}

/** Check economic status for a specific company */
export function checkCompanyEconomicStatus(companyId: string): CompanyEconomicStatus {
  const limits = getEconomicLimits();
  const revenue = getCompanyRevenue(companyId);
  const spending = getCompanySpending(companyId);
  const net = revenue - spending;
  const services = listActiveServices().filter((s) => s.companyId === companyId);
  const contracts = listActiveContracts().filter(
    (c) => c.providerCompanyId === companyId || c.consumerCompanyId === companyId,
  );

  const violations: string[] = [];

  if (net < -limits.maxCompanyLossCents) {
    violations.push(
      `Company loss exceeds limit ($${(Math.abs(net) / 100).toFixed(2)}/$${(limits.maxCompanyLossCents / 100).toFixed(2)})`,
    );
  }

  if (services.length >= limits.maxServicesPerCompany) {
    violations.push(
      `Service registration limit reached (${services.length}/${limits.maxServicesPerCompany})`,
    );
  }

  if (contracts.length >= limits.maxContractsPerCompany) {
    violations.push(
      `Contract limit reached (${contracts.length}/${limits.maxContractsPerCompany})`,
    );
  }

  return {
    companyId,
    revenueCents: revenue,
    spendingCents: spending,
    netCents: net,
    serviceCount: services.length,
    contractCount: contracts.length,
    violations,
    isWithinLimits: violations.length === 0,
  };
}

/** Can a company register a new service? */
export function canRegisterService(companyId: string): { allowed: boolean; reason?: string } {
  const limits = getEconomicLimits();
  const services = listActiveServices().filter((s) => s.companyId === companyId);

  if (services.length >= limits.maxServicesPerCompany) {
    return {
      allowed: false,
      reason: `Company has reached service limit (${limits.maxServicesPerCompany})`,
    };
  }

  return { allowed: true };
}
