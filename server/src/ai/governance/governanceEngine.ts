// ---------------------------------------------------------------------------
// Central Governance Engine — single authority for all critical actions
// ---------------------------------------------------------------------------
// Every critical operation (create company, create agent, spend budget,
// launch product, modify code, execute task) passes through this engine.
// It enforces the full safety stack:
//   1. Action guard (forbidden actions)
//   2. Rate limiter (temporal throttling)
//   3. Economic limits (budget checks)
//   4. Approval gates (human/ceo/manager)
//   5. Execution sandbox (environment constraints)
//   6. Audit logging
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import pino from "pino";
import { isActionForbidden } from "../guards/actionGuard.js";
import { checkRateLimit, type RateLimitDomain } from "./systemRateLimiter.js";
import { canAfford } from "./agentBudget.js";
import { canCreateNewCompany } from "./ecosystemBudget.js";
import { canCreateAgent } from "./workforceLimits.js";
import { canCreateContract, canRegisterService } from "./economicLimits.js";
import { getExecutionEnvironment, type ExecutionEnvironment } from "./executionSandbox.js";
import { getApprovalLevel } from "./approvalGate.js";
import { eventBus } from "../../events/eventBus.js";
import type { EventName } from "../../events/eventTypes.js";

const logger = pino({ name: "governance-engine" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Categories of governed actions */
export type GovernedActionType =
  | "create_company"
  | "create_agent"
  | "create_department"
  | "spend_budget"
  | "create_contract"
  | "register_service"
  | "execute_task"
  | "launch_product"
  | "modify_code"
  | "deploy_production"
  | "expand_workforce"
  | "scan_opportunities"
  | "design_business";

/** Context provided when requesting governance clearance */
export interface GovernanceRequest {
  action: GovernedActionType;
  actorType: "agent" | "board" | "system";
  actorId: string;
  companyId: string;
  /** Optional agent making the request */
  agentId?: string;
  /** Estimated cost in cents */
  estimatedCostCents?: number;
  /** Additional context for governance decisions */
  metadata?: Record<string, unknown>;
}

/** Result from the governance engine */
export interface GovernanceDecision {
  allowed: boolean;
  /** Which layer blocked the action (if not allowed) */
  blockedBy?: "forbidden" | "rate_limit" | "economic_limit" | "approval_required" | "sandbox_violation" | "circuit_breaker";
  reason?: string;
  /** approval level required if action needs approval */
  approvalLevel?: "none" | "manager" | "ceo" | "human";
  /** The execution environment the action should run in */
  environment: ExecutionEnvironment;
  /** Governance trace ID for audit */
  traceId: string;
  /** Timestamp of the decision */
  decidedAt: string;
}

/** Circuit breaker state */
interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  state: "closed" | "open" | "half_open";
  openedAt?: number;
}

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

const circuitBreakers = new Map<string, CircuitBreakerState>();

const CIRCUIT_BREAKER_THRESHOLD = 10;      // failures before opening
const CIRCUIT_BREAKER_RESET_MS = 5 * 60_000; // 5 minutes to half-open

function getCircuitBreaker(key: string): CircuitBreakerState {
  let cb = circuitBreakers.get(key);
  if (!cb) {
    cb = { failures: 0, lastFailure: 0, state: "closed" };
    circuitBreakers.set(key, cb);
  }
  // Auto-transition from open → half_open after timeout
  if (cb.state === "open" && cb.openedAt && Date.now() - cb.openedAt > CIRCUIT_BREAKER_RESET_MS) {
    cb.state = "half_open";
  }
  return cb;
}

export function recordGovernanceFailure(companyId: string, action: GovernedActionType): void {
  const key = `${companyId}:${action}`;
  const cb = getCircuitBreaker(key);
  cb.failures++;
  cb.lastFailure = Date.now();
  if (cb.failures >= CIRCUIT_BREAKER_THRESHOLD && cb.state === "closed") {
    cb.state = "open";
    cb.openedAt = Date.now();
    logger.warn({ companyId, action, failures: cb.failures }, "Circuit breaker opened");
    eventBus.publish("governance.circuit_breaker.opened", { companyId, action, failures: cb.failures });
  }
}

export function recordGovernanceSuccess(companyId: string, action: GovernedActionType): void {
  const key = `${companyId}:${action}`;
  const cb = circuitBreakers.get(key);
  if (cb && cb.state === "half_open") {
    cb.state = "closed";
    cb.failures = 0;
    logger.info({ companyId, action }, "Circuit breaker closed after success");
  }
}

export function resetCircuitBreakers(): void {
  circuitBreakers.clear();
}

// ---------------------------------------------------------------------------
// Governance Decision Audit Trail
// ---------------------------------------------------------------------------

interface GovernanceAuditEntry {
  traceId: string;
  request: GovernanceRequest;
  decision: GovernanceDecision;
  timestamp: string;
}

const auditTrail: GovernanceAuditEntry[] = [];
const MAX_AUDIT_ENTRIES = 1000;

export function getGovernanceAudit(companyId?: string, limit = 50): GovernanceAuditEntry[] {
  const filtered = companyId
    ? auditTrail.filter((e) => e.request.companyId === companyId)
    : auditTrail;
  return filtered.slice(-limit);
}

export function clearGovernanceAudit(): void {
  auditTrail.length = 0;
}

// ---------------------------------------------------------------------------
// Main Governance Engine
// ---------------------------------------------------------------------------

let traceCounter = 0;

function generateTraceId(): string {
  traceCounter++;
  return `gov_${Date.now()}_${traceCounter}`;
}

/**
 * Central governance check. ALL critical actions must pass through here.
 *
 * Layers checked in order:
 * 1. Forbidden action check
 * 2. Circuit breaker check
 * 3. Rate limit check
 * 4. Economic/budget limit check
 * 5. Approval level determination
 * 6. Execution environment resolution
 */
export async function requestGovernanceClearance(
  db: Db,
  request: GovernanceRequest,
): Promise<GovernanceDecision> {
  const traceId = generateTraceId();
  const decidedAt = new Date().toISOString();
  const environment = getExecutionEnvironment(request.action, request.actorType);

  // Layer 1: Forbidden action guard
  if (isActionForbidden(request.action)) {
    return logAndReturn(request, {
      allowed: false,
      blockedBy: "forbidden",
      reason: `Action "${request.action}" is permanently forbidden`,
      environment,
      traceId,
      decidedAt,
    });
  }

  // Layer 2: Circuit breaker
  const cbKey = `${request.companyId}:${request.action}`;
  const cb = getCircuitBreaker(cbKey);
  if (cb.state === "open") {
    return logAndReturn(request, {
      allowed: false,
      blockedBy: "circuit_breaker",
      reason: `Circuit breaker open for ${request.action} in company ${request.companyId} (${cb.failures} failures). Resets in ${Math.max(0, Math.round((CIRCUIT_BREAKER_RESET_MS - (Date.now() - (cb.openedAt ?? 0))) / 1000))}s`,
      environment,
      traceId,
      decidedAt,
    });
  }

  // Layer 3: Rate limit check
  const rateLimitDomain = mapActionToRateDomain(request.action);
  if (rateLimitDomain) {
    const rlResult = checkRateLimit(
      rateLimitDomain,
      request.companyId,
      request.agentId,
    );
    if (!rlResult.allowed) {
      return logAndReturn(request, {
        allowed: false,
        blockedBy: "rate_limit",
        reason: rlResult.reason ?? `Rate limit exceeded for ${rateLimitDomain}`,
        environment,
        traceId,
        decidedAt,
      });
    }
  }

  // Layer 4: Economic / budget checks
  const econResult = await checkEconomicConstraints(db, request);
  if (!econResult.allowed) {
    return logAndReturn(request, {
      allowed: false,
      blockedBy: "economic_limit",
      reason: econResult.reason ?? "Economic limit exceeded",
      environment,
      traceId,
      decidedAt,
    });
  }

  // Layer 5: Approval determination
  const approvalLevel = determineApprovalLevel(request.action);

  // Layer 6: Environment constraint check
  if (environment === "blocked") {
    return logAndReturn(request, {
      allowed: false,
      blockedBy: "sandbox_violation",
      reason: `Action "${request.action}" is not allowed in any environment for actor type "${request.actorType}"`,
      environment,
      traceId,
      decidedAt,
    });
  }

  return logAndReturn(request, {
    allowed: true,
    approvalLevel,
    environment,
    traceId,
    decidedAt,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function logAndReturn(
  request: GovernanceRequest,
  decision: GovernanceDecision,
): GovernanceDecision {
  const entry: GovernanceAuditEntry = {
    traceId: decision.traceId,
    request,
    decision,
    timestamp: decision.decidedAt,
  };

  // Keep bounded audit trail
  if (auditTrail.length >= MAX_AUDIT_ENTRIES) {
    auditTrail.splice(0, auditTrail.length - MAX_AUDIT_ENTRIES + 100);
  }
  auditTrail.push(entry);

  if (!decision.allowed) {
    logger.warn(
      { traceId: decision.traceId, action: request.action, companyId: request.companyId, blockedBy: decision.blockedBy },
      `Governance BLOCKED: ${decision.reason}`,
    );
    eventBus.publish("governance.action.blocked", {
      traceId: decision.traceId,
      action: request.action,
      companyId: request.companyId,
      actorId: request.actorId,
      blockedBy: decision.blockedBy,
      reason: decision.reason,
    });
  } else {
    logger.debug(
      { traceId: decision.traceId, action: request.action, companyId: request.companyId, environment: decision.environment },
      "Governance ALLOWED",
    );
    eventBus.publish("governance.action.allowed", {
      traceId: decision.traceId,
      action: request.action,
      companyId: request.companyId,
      actorId: request.actorId,
      environment: decision.environment,
      approvalLevel: decision.approvalLevel,
    });
  }

  return decision;
}

function mapActionToRateDomain(action: GovernedActionType): RateLimitDomain | null {
  switch (action) {
    case "create_company":
      return "company_creation";
    case "create_agent":
    case "expand_workforce":
      return "agent_creation";
    case "execute_task":
      return "task_execution";
    case "spend_budget":
      return "budget_spend";
    case "create_contract":
    case "register_service":
      return "economic_transaction";
    case "scan_opportunities":
      return "opportunity_scanning";
    case "design_business":
      return "ecosystem_expansion";
    case "deploy_production":
    case "launch_product":
      return "deployment";
    default:
      return null;
  }
}

async function checkEconomicConstraints(
  db: Db,
  request: GovernanceRequest,
): Promise<{ allowed: boolean; reason?: string }> {
  switch (request.action) {
    case "create_company": {
      const result = await canCreateNewCompany(db, request.estimatedCostCents ?? 0);
      return result;
    }
    case "create_agent":
    case "expand_workforce": {
      const result = await canCreateAgent(db, request.companyId, request.estimatedCostCents ?? 0);
      return result;
    }
    case "spend_budget": {
      if (request.agentId && request.estimatedCostCents) {
        const affordable = await canAfford(db, request.agentId, request.estimatedCostCents);
        if (!affordable) {
          return { allowed: false, reason: "Agent cannot afford this operation" };
        }
      }
      return { allowed: true };
    }
    case "create_contract": {
      const meta = request.metadata ?? {};
      const providerCompanyId = (meta.providerCompanyId as string) ?? request.companyId;
      const consumerCompanyId = (meta.consumerCompanyId as string) ?? request.companyId;
      return canCreateContract(providerCompanyId, consumerCompanyId);
    }
    case "register_service": {
      return canRegisterService(request.companyId);
    }
    default:
      return { allowed: true };
  }
}

function determineApprovalLevel(action: GovernedActionType): "none" | "manager" | "ceo" | "human" {
  switch (action) {
    case "create_company":
      return "ceo";
    case "deploy_production":
    case "launch_product":
      return "human";
    case "create_agent":
    case "expand_workforce":
    case "modify_code":
      return "manager";
    case "spend_budget":
    case "execute_task":
    case "create_contract":
    case "register_service":
    case "create_department":
    case "scan_opportunities":
    case "design_business":
      return "none";
    default:
      return "none";
  }
}

// ---------------------------------------------------------------------------
// Governance Stats
// ---------------------------------------------------------------------------

export interface GovernanceStats {
  totalDecisions: number;
  allowed: number;
  blocked: number;
  blockedByLayer: Record<string, number>;
  circuitBreakers: { key: string; state: string; failures: number }[];
}

export function getGovernanceStats(): GovernanceStats {
  const allowed = auditTrail.filter((e) => e.decision.allowed).length;
  const blocked = auditTrail.filter((e) => !e.decision.allowed).length;

  const blockedByLayer: Record<string, number> = {};
  for (const entry of auditTrail) {
    if (!entry.decision.allowed && entry.decision.blockedBy) {
      blockedByLayer[entry.decision.blockedBy] = (blockedByLayer[entry.decision.blockedBy] ?? 0) + 1;
    }
  }

  const cbs: GovernanceStats["circuitBreakers"] = [];
  for (const [key, cb] of circuitBreakers.entries()) {
    cbs.push({ key, state: cb.state, failures: cb.failures });
  }

  return {
    totalDecisions: auditTrail.length,
    allowed,
    blocked,
    blockedByLayer,
    circuitBreakers: cbs,
  };
}
