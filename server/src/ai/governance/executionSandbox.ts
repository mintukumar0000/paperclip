// ---------------------------------------------------------------------------
// Execution Sandboxing — environment isolation for agent actions
// ---------------------------------------------------------------------------
// Agents must never directly modify production systems without verification.
// Execution flows through layers: sandbox → staging → production
//
// Flow:
//   agent writes code → sandbox tests → unit tests pass → staging →
//   human approval → production
//
// This module determines which environment an action should execute in
// and enforces promotion gates between environments.
// ---------------------------------------------------------------------------

import pino from "pino";
import { eventBus } from "../../events/eventBus.js";
import type { EventName } from "../../events/eventTypes.js";

const logger = pino({ name: "execution-sandbox" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecutionEnvironment = "sandbox" | "staging" | "production" | "blocked";

export type PromotionStatus = "pending" | "testing" | "passed" | "failed" | "promoted" | "rejected";

export interface SandboxExecution {
  id: string;
  companyId: string;
  agentId?: string;
  action: string;
  environment: ExecutionEnvironment;
  status: PromotionStatus;
  /** Test results from sandbox */
  testResults?: TestResult[];
  /** Who approved promotion (if applicable) */
  promotedBy?: string;
  /** Rejection reason */
  rejectionReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TestResult {
  name: string;
  passed: boolean;
  duration?: number;
  error?: string;
}

export interface PromotionGate {
  fromEnvironment: ExecutionEnvironment;
  toEnvironment: ExecutionEnvironment;
  requiresTests: boolean;
  requiresApproval: boolean;
  approvalLevel: "none" | "manager" | "ceo" | "human";
  minTestPassRate: number;
}

// ---------------------------------------------------------------------------
// Environment Resolution Rules
// ---------------------------------------------------------------------------

/** Actions that always start in sandbox */
const SANDBOX_ACTIONS = new Set([
  "modify_code",
  "execute_task",
  "design_business",
  "create_contract",
]);

/** Actions that go directly to staging (already reviewed concepts) */
const STAGING_ACTIONS = new Set([
  "create_agent",
  "create_department",
  "expand_workforce",
  "register_service",
  "scan_opportunities",
]);

/** Actions requiring production approval */
const PRODUCTION_ACTIONS = new Set([
  "deploy_production",
  "launch_product",
]);

/** Actions that bypass sandboxing (purely administrative) */
const BYPASS_ACTIONS = new Set([
  "spend_budget",
]);

/**
 * Determine the execution environment for a given action.
 */
export function getExecutionEnvironment(
  action: string,
  actorType: "agent" | "board" | "system",
): ExecutionEnvironment {
  // Board users can operate at higher trust levels
  if (actorType === "board") {
    if (PRODUCTION_ACTIONS.has(action)) return "staging"; // still needs staging
    return "production"; // board is trusted
  }

  // System actions bypass sandbox
  if (actorType === "system") {
    return "production";
  }

  // Agent actions go through sandboxing
  if (SANDBOX_ACTIONS.has(action)) return "sandbox";
  if (STAGING_ACTIONS.has(action)) return "staging";
  if (PRODUCTION_ACTIONS.has(action)) return "blocked"; // agents can't directly deploy
  if (BYPASS_ACTIONS.has(action)) return "production";

  // Default for agents: sandbox
  return "sandbox";
}

// ---------------------------------------------------------------------------
// Promotion Gates
// ---------------------------------------------------------------------------

const PROMOTION_GATES: PromotionGate[] = [
  {
    fromEnvironment: "sandbox",
    toEnvironment: "staging",
    requiresTests: true,
    requiresApproval: false,
    approvalLevel: "none",
    minTestPassRate: 0.8, // 80% tests must pass
  },
  {
    fromEnvironment: "staging",
    toEnvironment: "production",
    requiresTests: true,
    requiresApproval: true,
    approvalLevel: "human",
    minTestPassRate: 1.0, // 100% tests must pass
  },
];

export function getPromotionGates(): PromotionGate[] {
  return [...PROMOTION_GATES];
}

/**
 * Get the gate requirements for promoting from one environment to another.
 */
export function getPromotionGate(
  from: ExecutionEnvironment,
  to: ExecutionEnvironment,
): PromotionGate | undefined {
  return PROMOTION_GATES.find(
    (g) => g.fromEnvironment === from && g.toEnvironment === to,
  );
}

// ---------------------------------------------------------------------------
// Execution Tracking
// ---------------------------------------------------------------------------

const executions = new Map<string, SandboxExecution>();
let executionCounter = 0;

/**
 * Create a new sandboxed execution.
 */
export function createSandboxExecution(
  companyId: string,
  action: string,
  agentId?: string,
): SandboxExecution {
  executionCounter++;
  const id = `exec_${Date.now()}_${executionCounter}`;
  const environment = getExecutionEnvironment(action, agentId ? "agent" : "board");
  const now = new Date().toISOString();

  const execution: SandboxExecution = {
    id,
    companyId,
    agentId,
    action,
    environment,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  executions.set(id, execution);

  logger.info(
    { executionId: id, companyId, action, environment },
    "Sandbox execution created",
  );

  eventBus.publish("governance.sandbox.created",
    { executionId: id, companyId, action, environment },
  );

  return execution;
}

/**
 * Record test results for a sandboxed execution.
 */
export function recordTestResults(
  executionId: string,
  results: TestResult[],
): SandboxExecution | undefined {
  const execution = executions.get(executionId);
  if (!execution) return undefined;

  execution.testResults = results;
  execution.status = "testing";
  execution.updatedAt = new Date().toISOString();

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const passRate = total > 0 ? passed / total : 0;

  // Check if tests meet the promotion threshold
  const gate = getPromotionGate(execution.environment, getNextEnvironment(execution.environment));
  const threshold = gate?.minTestPassRate ?? 0.8; // default 80% if no gate
  if (passRate >= threshold) {
    execution.status = "passed";
    logger.info(
      { executionId, passRate, threshold },
      "Sandbox tests passed",
    );
  } else {
    execution.status = "failed";
    logger.warn(
      { executionId, passRate, threshold },
      "Sandbox tests failed",
    );
  }

  eventBus.publish("governance.sandbox.tested", {
    executionId,
    passed,
    total,
    passRate,
    status: execution.status,
  });

  return execution;
}

/**
 * Promote an execution to the next environment.
 */
export function promoteExecution(
  executionId: string,
  promotedBy?: string,
): { success: boolean; execution?: SandboxExecution; reason?: string } {
  const execution = executions.get(executionId);
  if (!execution) {
    return { success: false, reason: "Execution not found" };
  }

  if (execution.status !== "passed") {
    return { success: false, reason: `Cannot promote execution in "${execution.status}" status. Must pass tests first.` };
  }

  const nextEnv = getNextEnvironment(execution.environment);
  const gate = getPromotionGate(execution.environment, nextEnv);

  if (gate?.requiresApproval && !promotedBy) {
    return { success: false, reason: `Promotion from ${execution.environment} to ${nextEnv} requires approval` };
  }

  // Check test pass rate meets threshold
  if (gate?.requiresTests && execution.testResults) {
    const passed = execution.testResults.filter((r) => r.passed).length;
    const total = execution.testResults.length;
    const passRate = total > 0 ? passed / total : 0;
    if (passRate < gate.minTestPassRate) {
      return { success: false, reason: `Test pass rate (${(passRate * 100).toFixed(0)}%) below threshold (${(gate.minTestPassRate * 100).toFixed(0)}%)` };
    }
  }

  execution.environment = nextEnv;
  execution.status = "promoted";
  execution.promotedBy = promotedBy;
  execution.updatedAt = new Date().toISOString();

  logger.info(
    { executionId, newEnvironment: nextEnv, promotedBy },
    "Execution promoted",
  );

  eventBus.publish("governance.sandbox.promoted", {
    executionId,
    newEnvironment: nextEnv,
    promotedBy,
  });

  return { success: true, execution };
}

/**
 * Reject an execution (prevent promotion).
 */
export function rejectExecution(
  executionId: string,
  rejectedBy: string,
  reason: string,
): { success: boolean; reason?: string } {
  const execution = executions.get(executionId);
  if (!execution) {
    return { success: false, reason: "Execution not found" };
  }

  execution.status = "rejected";
  execution.rejectionReason = reason;
  execution.updatedAt = new Date().toISOString();

  logger.info(
    { executionId, rejectedBy, reason },
    "Execution rejected",
  );

  eventBus.publish("governance.sandbox.rejected",
    { executionId, rejectedBy, reason },
  );

  return { success: true };
}

/**
 * Get execution by ID.
 */
export function getExecution(executionId: string): SandboxExecution | undefined {
  return executions.get(executionId);
}

/**
 * List executions by company.
 */
export function listExecutions(companyId?: string): SandboxExecution[] {
  const all = Array.from(executions.values());
  if (companyId) {
    return all.filter((e) => e.companyId === companyId);
  }
  return all;
}

/**
 * Get sandbox statistics.
 */
export function getSandboxStats(): {
  total: number;
  byStatus: Record<PromotionStatus, number>;
  byEnvironment: Record<ExecutionEnvironment, number>;
} {
  const byStatus: Record<PromotionStatus, number> = {
    pending: 0,
    testing: 0,
    passed: 0,
    failed: 0,
    promoted: 0,
    rejected: 0,
  };
  const byEnvironment: Record<ExecutionEnvironment, number> = {
    sandbox: 0,
    staging: 0,
    production: 0,
    blocked: 0,
  };

  for (const exec of executions.values()) {
    byStatus[exec.status]++;
    byEnvironment[exec.environment]++;
  }

  return { total: executions.size, byStatus, byEnvironment };
}

/**
 * Clear all executions (for testing).
 */
export function clearSandboxExecutions(): void {
  executions.clear();
  executionCounter = 0;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function getNextEnvironment(current: ExecutionEnvironment): ExecutionEnvironment {
  switch (current) {
    case "sandbox":
      return "staging";
    case "staging":
      return "production";
    default:
      return current;
  }
}
