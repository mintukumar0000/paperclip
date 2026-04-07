// ---------------------------------------------------------------------------
// Contract Manager — Creates and tracks service agreements between companies
// ---------------------------------------------------------------------------

import { publishEvent } from "../../events/eventPublisher.js";
import { getService, updateServiceLoad, type ServiceListing } from "./serviceRegistry.js";
import { recordDemand } from "./pricingEngine.js";
import { getAutonomyLimits } from "../governance/autonomyLimits.js";
import pino from "pino";

const logger = pino({ name: "contract-manager" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContractStatus = "draft" | "active" | "paused" | "completed" | "cancelled" | "breached";

export interface ServiceContract {
  id: string;
  providerCompanyId: string;
  providerCompanyName: string;
  consumerCompanyId: string;
  consumerCompanyName: string;
  serviceId: string;
  serviceName: string;
  category: string;
  // Terms
  pricePerRequestCents: number;
  maxRequestsPerDay: number;
  maxTotalRequests: number;
  durationDays: number;
  // Tracking
  totalRequests: number;
  totalSpentCents: number;
  status: ContractStatus;
  // Performance
  avgResponseTimeMs: number;
  successRate: number; // 0.0 – 1.0
  // Timestamps
  createdAt: string;
  activatedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
}

export interface ContractCreationInput {
  providerCompanyId: string;
  providerCompanyName: string;
  consumerCompanyId: string;
  consumerCompanyName: string;
  serviceId: string;
  serviceName: string;
  category: string;
  pricePerRequestCents: number;
  maxRequestsPerDay?: number;
  maxTotalRequests?: number;
  durationDays?: number;
}

export interface ContractExecution {
  contractId: string;
  requestId: string;
  success: boolean;
  responseTimeMs: number;
  costCents: number;
  executedAt: string;
}

export interface ContractSummary {
  totalContracts: number;
  activeContracts: number;
  totalTransactionsCents: number;
  totalExecutions: number;
  averageContractValue: number;
}

// ---------------------------------------------------------------------------
// In-memory contract store
// ---------------------------------------------------------------------------

const contractStore = new Map<string, ServiceContract>();
const executionLog: ContractExecution[] = [];
let nextContractId = 1;
let nextExecId = 1;

// ---------------------------------------------------------------------------
// Contract operations
// ---------------------------------------------------------------------------

/** Create a new service contract */
export async function createContract(
  input: ContractCreationInput,
): Promise<ServiceContract> {
  // Validate no self-contracting
  if (input.providerCompanyId === input.consumerCompanyId) {
    throw new Error("Company cannot contract with itself");
  }

  const now = new Date();
  const durationDays = input.durationDays ?? 30;
  const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

  const contract: ServiceContract = {
    id: `contract_${nextContractId++}`,
    providerCompanyId: input.providerCompanyId,
    providerCompanyName: input.providerCompanyName,
    consumerCompanyId: input.consumerCompanyId,
    consumerCompanyName: input.consumerCompanyName,
    serviceId: input.serviceId,
    serviceName: input.serviceName,
    category: input.category,
    pricePerRequestCents: input.pricePerRequestCents,
    maxRequestsPerDay: input.maxRequestsPerDay ?? 1000,
    maxTotalRequests: input.maxTotalRequests ?? 30000,
    durationDays,
    totalRequests: 0,
    totalSpentCents: 0,
    status: "active",
    avgResponseTimeMs: 0,
    successRate: 1.0,
    createdAt: now.toISOString(),
    activatedAt: now.toISOString(),
    completedAt: null,
    expiresAt: expiresAt.toISOString(),
  };

  contractStore.set(contract.id, contract);

  logger.info({
    contractId: contract.id,
    provider: input.providerCompanyName,
    consumer: input.consumerCompanyName,
    service: input.serviceName,
  }, "Contract created");

  await publishEvent("ai.economy.contract.created", {
    contractId: contract.id,
    providerCompanyId: input.providerCompanyId,
    consumerCompanyId: input.consumerCompanyId,
    serviceId: input.serviceId,
    pricePerRequestCents: input.pricePerRequestCents,
  });

  return contract;
}

/** Execute a service call under a contract */
export async function executeContract(
  contractId: string,
  responseTimeMs: number,
  success: boolean,
): Promise<ContractExecution> {
  const contract = contractStore.get(contractId);
  if (!contract) {
    throw new Error(`Contract ${contractId} not found`);
  }
  if (contract.status !== "active") {
    throw new Error(`Contract ${contractId} is not active (status: ${contract.status})`);
  }

  // Check request limits
  if (contract.totalRequests >= contract.maxTotalRequests) {
    contract.status = "completed";
    contract.completedAt = new Date().toISOString();
    throw new Error(`Contract ${contractId} has reached max total requests`);
  }

  const costCents = contract.pricePerRequestCents;

  // Enforce daily service call limit from global autonomy limits
  const dailyCalls = getDailyServiceCalls(contract.consumerCompanyId);
  const maxDaily = getAutonomyLimits().maxServiceCallsPerDay;
  if (dailyCalls >= maxDaily) {
    throw new Error(`Company ${contract.consumerCompanyId} has reached daily service call limit (${dailyCalls}/${maxDaily})`);
  }

  // Enforce max transaction value
  const maxTxValue = getAutonomyLimits().maxTransactionValueCents;
  if (costCents > maxTxValue) {
    throw new Error(`Transaction value ($${(costCents / 100).toFixed(2)}) exceeds limit ($${(maxTxValue / 100).toFixed(2)})`);
  }

  const execution: ContractExecution = {
    contractId,
    requestId: `exec_${nextExecId++}`,
    success,
    responseTimeMs,
    costCents,
    executedAt: new Date().toISOString(),
  };

  // Update contract tracking
  contract.totalRequests++;
  contract.totalSpentCents += costCents;

  // Update rolling performance
  const prevTotal = contract.totalRequests - 1;
  contract.avgResponseTimeMs = prevTotal > 0
    ? (contract.avgResponseTimeMs * prevTotal + responseTimeMs) / contract.totalRequests
    : responseTimeMs;

  const successNum = success ? 1 : 0;
  contract.successRate = prevTotal > 0
    ? (contract.successRate * prevTotal + successNum) / contract.totalRequests
    : successNum;

  // Update service load on the provider
  const loadFraction = contract.totalRequests / contract.maxTotalRequests;
  updateServiceLoad(contract.serviceId, Math.min(1, loadFraction));

  // Record demand for pricing engine
  recordDemand(contract.serviceId);

  executionLog.push(execution);

  // Auto-complete if max requests reached
  if (contract.totalRequests >= contract.maxTotalRequests) {
    contract.status = "completed";
    contract.completedAt = new Date().toISOString();
    logger.info({ contractId }, "Contract completed (max requests reached)");
  }

  await publishEvent("ai.economy.contract.executed", {
    contractId,
    providerCompanyId: contract.providerCompanyId,
    consumerCompanyId: contract.consumerCompanyId,
    costCents,
    success,
  });

  return execution;
}

/** Get a contract by ID */
export function getContract(contractId: string): ServiceContract | undefined {
  return contractStore.get(contractId);
}

/** List contracts by company (as provider, consumer, or both) */
export function listContractsByCompany(
  companyId: string,
  role?: "provider" | "consumer",
): ServiceContract[] {
  return Array.from(contractStore.values()).filter((c) => {
    if (role === "provider") return c.providerCompanyId === companyId;
    if (role === "consumer") return c.consumerCompanyId === companyId;
    return c.providerCompanyId === companyId || c.consumerCompanyId === companyId;
  });
}

/** List active contracts */
export function listActiveContracts(): ServiceContract[] {
  return Array.from(contractStore.values()).filter((c) => c.status === "active");
}

/** Cancel a contract */
export async function cancelContract(contractId: string, reason?: string): Promise<boolean> {
  const contract = contractStore.get(contractId);
  if (!contract || contract.status !== "active") return false;

  contract.status = "cancelled";
  contract.completedAt = new Date().toISOString();

  logger.info({ contractId, reason }, "Contract cancelled");

  await publishEvent("ai.economy.contract.cancelled", {
    contractId,
    providerCompanyId: contract.providerCompanyId,
    consumerCompanyId: contract.consumerCompanyId,
    reason,
  });

  return true;
}

/** Get execution log for a contract */
export function getContractExecutions(contractId: string): ContractExecution[] {
  return executionLog.filter((e) => e.contractId === contractId);
}

/** Get contract summary (ecosystem-wide) */
export function getContractSummary(): ContractSummary {
  const all = Array.from(contractStore.values());
  const active = all.filter((c) => c.status === "active");
  const totalCents = all.reduce((sum, c) => sum + c.totalSpentCents, 0);
  const totalExec = all.reduce((sum, c) => sum + c.totalRequests, 0);

  return {
    totalContracts: all.length,
    activeContracts: active.length,
    totalTransactionsCents: totalCents,
    totalExecutions: totalExec,
    averageContractValue: all.length > 0 ? Math.round(totalCents / all.length) : 0,
  };
}

/** Get revenue for a company (as provider) */
export function getCompanyRevenue(companyId: string): number {
  return Array.from(contractStore.values())
    .filter((c) => c.providerCompanyId === companyId)
    .reduce((sum, c) => sum + c.totalSpentCents, 0);
}

/** Get spending for a company (as consumer) */
export function getCompanySpending(companyId: string): number {
  return Array.from(contractStore.values())
    .filter((c) => c.consumerCompanyId === companyId)
    .reduce((sum, c) => sum + c.totalSpentCents, 0);
}

/** Get the number of service calls made by a company today */
function getDailyServiceCalls(companyId: string): number {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const cutoff = dayStart.toISOString();

  return executionLog.filter((e) => {
    if (e.executedAt < cutoff) return false;
    const contract = contractStore.get(e.contractId);
    return contract?.consumerCompanyId === companyId;
  }).length;
}

/** Clear all contract data (for testing) */
export function clearContracts(): void {
  contractStore.clear();
  executionLog.length = 0;
  nextContractId = 1;
  nextExecId = 1;
}
