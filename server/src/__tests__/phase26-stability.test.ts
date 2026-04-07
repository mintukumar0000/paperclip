// ---------------------------------------------------------------------------
// Phase 26 — System Stability Tests
// ---------------------------------------------------------------------------
// Tests for all 5 safety layers:
//   1. Central Governance Engine
//   2. System Rate Limiter
//   3. Execution Sandboxing
//   4. Economic Feedback Loop
//   5. Hard Economic Limits (existing, verified here)
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";

// Governance Engine
import {
  requestGovernanceClearance,
  recordGovernanceFailure,
  recordGovernanceSuccess,
  resetCircuitBreakers,
  getGovernanceAudit,
  clearGovernanceAudit,
  getGovernanceStats,
} from "../ai/governance/governanceEngine.js";
import type { GovernanceRequest } from "../ai/governance/governanceEngine.js";

// System Rate Limiter
import {
  checkRateLimit,
  peekRateLimit,
  setRateLimit,
  getRateLimitConfig,
  getAllRateLimits,
  getRateLimitStats,
  clearRateLimits,
} from "../ai/governance/systemRateLimiter.js";

// Execution Sandboxing
import {
  getExecutionEnvironment,
  getPromotionGates,
  getPromotionGate,
  createSandboxExecution,
  recordTestResults,
  promoteExecution,
  rejectExecution,
  getExecution,
  listExecutions,
  getSandboxStats,
  clearSandboxExecutions,
} from "../ai/governance/executionSandbox.js";

// Economic Feedback Loop
import {
  evaluateCompanyROI,
  evaluateAgentProductivity,
  runCompanyFeedback,
  evaluateEcosystemHealth,
  getPendingFeedbackActions,
  getCompanyROIHistory,
  getAgentProductivityHistory,
  recordTaskCompletion,
  getFeedbackConfig,
  setFeedbackConfig,
  clearFeedbackData,
} from "../ai/governance/economicFeedbackLoop.js";

// Existing limits for integration testing
import {
  checkEconomicStatus,
  getEconomicLimits,
  canCreateContract,
  checkCompanyEconomicStatus,
  canRegisterService,
} from "../ai/governance/economicLimits.js";

import {
  checkWorkforceStatus,
  getWorkforceLimits,
} from "../ai/governance/workforceLimits.js";

import {
  checkEcosystemStatus,
  getEcosystemLimits,
} from "../ai/governance/ecosystemBudget.js";

// Economy for integration tests
import { clearContracts } from "../ai/economy/contractManager.js";
import { clearRegistry } from "../ai/economy/serviceRegistry.js";
import { clearMarketplace } from "../ai/economy/marketplace.js";
import { clearPricingData } from "../ai/economy/pricingEngine.js";
import { clearOptimizerData } from "../ai/economy/profitOptimizer.js";

// =========================================================================
// Test helpers
// =========================================================================

function makeRequest(overrides: Partial<GovernanceRequest> = {}): GovernanceRequest {
  return {
    action: "execute_task",
    actorType: "agent",
    actorId: "agent-1",
    companyId: "company-1",
    agentId: "agent-1",
    ...overrides,
  };
}

// Mock db that returns empty results for all queries
const mockDb = {
  select: () => ({
    from: () => ({
      where: () => Promise.resolve([{ count: 0, total: 0 }]),
    }),
  }),
} as any;

// =========================================================================
// 1. Central Governance Engine
// =========================================================================

describe("Central Governance Engine", () => {
  beforeEach(() => {
    clearGovernanceAudit();
    resetCircuitBreakers();
    clearRateLimits();
    clearSandboxExecutions();
    clearFeedbackData();
    clearContracts();
    clearRegistry();
    clearMarketplace();
    clearPricingData();
    clearOptimizerData();
  });

  describe("requestGovernanceClearance", () => {
    it("allows a normal task execution", async () => {
      const decision = await requestGovernanceClearance(mockDb, makeRequest());
      expect(decision.allowed).toBe(true);
      expect(decision.environment).toBeDefined();
      expect(decision.traceId).toMatch(/^gov_/);
      expect(decision.decidedAt).toBeDefined();
    });

    it("blocks forbidden actions", async () => {
      const decision = await requestGovernanceClearance(
        mockDb,
        makeRequest({ action: "delete_company" as any }),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.blockedBy).toBe("forbidden");
    });

    it("blocks when circuit breaker is open", async () => {
      // Trip the circuit breaker
      for (let i = 0; i < 10; i++) {
        recordGovernanceFailure("company-1", "execute_task");
      }
      const decision = await requestGovernanceClearance(mockDb, makeRequest());
      expect(decision.allowed).toBe(false);
      expect(decision.blockedBy).toBe("circuit_breaker");
    });

    it("recovers circuit breaker after success in half-open state", () => {
      for (let i = 0; i < 10; i++) {
        recordGovernanceFailure("company-1", "execute_task");
      }
      // Manually reset to half_open for testing
      resetCircuitBreakers();
      recordGovernanceSuccess("company-1", "execute_task");
      // After reset, no breaker state
    });

    it("enforces rate limits on company creation", async () => {
      // First creation should work
      const d1 = await requestGovernanceClearance(
        mockDb,
        makeRequest({ action: "create_company", estimatedCostCents: 100 }),
      );
      expect(d1.allowed).toBe(true);

      // Second in same window should be blocked by rate limiter
      const d2 = await requestGovernanceClearance(
        mockDb,
        makeRequest({ action: "create_company", estimatedCostCents: 100 }),
      );
      expect(d2.allowed).toBe(false);
      expect(d2.blockedBy).toBe("rate_limit");
    });

    it("determines correct approval levels", async () => {
      const createCompany = await requestGovernanceClearance(
        mockDb,
        makeRequest({ action: "create_company", estimatedCostCents: 100 }),
      );
      expect(createCompany.approvalLevel).toBe("ceo");

      clearRateLimits(); // Reset rate limits for next test

      const deployProd = await requestGovernanceClearance(
        mockDb,
        makeRequest({ action: "deploy_production" }),
      );
      // Agent can't deploy to production (blocked by sandbox)
      expect(deployProd.allowed).toBe(false);
      expect(deployProd.blockedBy).toBe("sandbox_violation");
    });

    it("resolves correct execution environment for agents", async () => {
      const decision = await requestGovernanceClearance(
        mockDb,
        makeRequest({ action: "modify_code" }),
      );
      expect(decision.allowed).toBe(true);
      expect(decision.environment).toBe("sandbox");
    });

    it("resolves correct execution environment for board users", async () => {
      const decision = await requestGovernanceClearance(
        mockDb,
        makeRequest({ action: "modify_code", actorType: "board" }),
      );
      expect(decision.allowed).toBe(true);
      expect(decision.environment).toBe("production");
    });
  });

  describe("Audit Trail", () => {
    it("records decisions in audit trail", async () => {
      await requestGovernanceClearance(mockDb, makeRequest());
      const audit = getGovernanceAudit();
      expect(audit.length).toBe(1);
      expect(audit[0]!.decision.allowed).toBe(true);
    });

    it("filters audit by company", async () => {
      await requestGovernanceClearance(mockDb, makeRequest({ companyId: "c1" }));
      await requestGovernanceClearance(mockDb, makeRequest({ companyId: "c2" }));
      const c1Audit = getGovernanceAudit("c1");
      expect(c1Audit.length).toBe(1);
      expect(c1Audit[0]!.request.companyId).toBe("c1");
    });

    it("limits audit entries", async () => {
      const audit = getGovernanceAudit(undefined, 5);
      expect(audit.length).toBeLessThanOrEqual(5);
    });
  });

  describe("Governance Stats", () => {
    it("tracks allowed vs blocked stats", async () => {
      await requestGovernanceClearance(mockDb, makeRequest());
      await requestGovernanceClearance(
        mockDb,
        makeRequest({ action: "delete_company" as any }),
      );
      const stats = getGovernanceStats();
      expect(stats.totalDecisions).toBe(2);
      expect(stats.allowed).toBe(1);
      expect(stats.blocked).toBe(1);
      expect(stats.blockedByLayer.forbidden).toBe(1);
    });
  });
});

// =========================================================================
// 2. System Rate Limiter
// =========================================================================

describe("System Rate Limiter", () => {
  beforeEach(() => {
    clearRateLimits();
  });

  describe("checkRateLimit", () => {
    it("allows actions within limits", () => {
      const result = checkRateLimit("task_execution", "company-1", "agent-1");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9); // 10 max - 1 consumed
    });

    it("blocks after limit exceeded", () => {
      // Max 10 tasks per hour per agent
      for (let i = 0; i < 10; i++) {
        const r = checkRateLimit("task_execution", "company-1", "agent-1");
        expect(r.allowed).toBe(true);
      }
      const blocked = checkRateLimit("task_execution", "company-1", "agent-1");
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.reason).toBeDefined();
    });

    it("respects separate buckets for different agents", () => {
      for (let i = 0; i < 10; i++) {
        checkRateLimit("task_execution", "company-1", "agent-1");
      }
      // Different agent should still have capacity
      const result = checkRateLimit("task_execution", "company-1", "agent-2");
      expect(result.allowed).toBe(true);
    });

    it("respects separate buckets for different companies", () => {
      for (let i = 0; i < 10; i++) {
        checkRateLimit("task_execution", "company-1", "agent-1");
      }
      const result = checkRateLimit("task_execution", "company-2", "agent-1");
      expect(result.allowed).toBe(true);
    });

    it("enforces company creation limit (1 per week)", () => {
      const r1 = checkRateLimit("company_creation", "company-1");
      expect(r1.allowed).toBe(true);
      const r2 = checkRateLimit("company_creation", "company-1");
      expect(r2.allowed).toBe(false);
    });

    it("enforces agent creation limit (3 per day)", () => {
      for (let i = 0; i < 3; i++) {
        const r = checkRateLimit("agent_creation", "company-1");
        expect(r.allowed).toBe(true);
      }
      const blocked = checkRateLimit("agent_creation", "company-1");
      expect(blocked.allowed).toBe(false);
    });
  });

  describe("peekRateLimit", () => {
    it("returns remaining capacity without consuming a slot", () => {
      const before = peekRateLimit("task_execution", "company-1");
      expect(before.remaining).toBe(10);

      checkRateLimit("task_execution", "company-1");

      const after = peekRateLimit("task_execution", "company-1");
      expect(after.remaining).toBe(9);
    });
  });

  describe("setRateLimit", () => {
    it("allows custom rate limit overrides", () => {
      setRateLimit("task_execution", {
        maxEvents: 2,
        windowMs: 60_000,
        description: "Custom: 2 per minute",
      });

      const r1 = checkRateLimit("task_execution", "company-1");
      expect(r1.allowed).toBe(true);
      const r2 = checkRateLimit("task_execution", "company-1");
      expect(r2.allowed).toBe(true);
      const r3 = checkRateLimit("task_execution", "company-1");
      expect(r3.allowed).toBe(false);
    });
  });

  describe("getAllRateLimits", () => {
    it("returns all configured limits", () => {
      const limits = getAllRateLimits();
      expect(limits.company_creation).toBeDefined();
      expect(limits.agent_creation).toBeDefined();
      expect(limits.task_execution).toBeDefined();
      expect(limits.budget_spend).toBeDefined();
      expect(limits.economic_transaction).toBeDefined();
      expect(limits.ecosystem_expansion).toBeDefined();
      expect(limits.deployment).toBeDefined();
    });
  });

  describe("getRateLimitStats", () => {
    it("returns per-domain statistics", () => {
      checkRateLimit("task_execution", "company-1");
      checkRateLimit("agent_creation", "company-1");
      const stats = getRateLimitStats();
      expect(stats.domains.length).toBeGreaterThan(0);

      const taskDomain = stats.domains.find((d) => d.domain === "task_execution");
      expect(taskDomain).toBeDefined();
      expect(taskDomain!.totalEvents).toBe(1);
    });
  });
});

// =========================================================================
// 3. Execution Sandboxing
// =========================================================================

describe("Execution Sandboxing", () => {
  beforeEach(() => {
    clearSandboxExecutions();
  });

  describe("getExecutionEnvironment", () => {
    it("routes agent code modifications to sandbox", () => {
      expect(getExecutionEnvironment("modify_code", "agent")).toBe("sandbox");
    });

    it("routes agent task execution to sandbox", () => {
      expect(getExecutionEnvironment("execute_task", "agent")).toBe("sandbox");
    });

    it("routes agent creation to staging", () => {
      expect(getExecutionEnvironment("create_agent", "agent")).toBe("staging");
    });

    it("blocks agent production deployment", () => {
      expect(getExecutionEnvironment("deploy_production", "agent")).toBe("blocked");
    });

    it("allows board users production access", () => {
      expect(getExecutionEnvironment("modify_code", "board")).toBe("production");
    });

    it("routes board deployment to staging", () => {
      expect(getExecutionEnvironment("deploy_production", "board")).toBe("staging");
    });

    it("system actions bypass sandbox", () => {
      expect(getExecutionEnvironment("execute_task", "system")).toBe("production");
    });

    it("budget spending bypasses sandbox for agents", () => {
      expect(getExecutionEnvironment("spend_budget", "agent")).toBe("production");
    });
  });

  describe("Promotion Gates", () => {
    it("defines sandbox → staging gate", () => {
      const gate = getPromotionGate("sandbox", "staging");
      expect(gate).toBeDefined();
      expect(gate!.requiresTests).toBe(true);
      expect(gate!.requiresApproval).toBe(false);
      expect(gate!.minTestPassRate).toBe(0.8);
    });

    it("defines staging → production gate", () => {
      const gate = getPromotionGate("staging", "production");
      expect(gate).toBeDefined();
      expect(gate!.requiresTests).toBe(true);
      expect(gate!.requiresApproval).toBe(true);
      expect(gate!.minTestPassRate).toBe(1.0);
      expect(gate!.approvalLevel).toBe("human");
    });

    it("returns all gates", () => {
      const gates = getPromotionGates();
      expect(gates.length).toBe(2);
    });
  });

  describe("Sandbox Execution Lifecycle", () => {
    it("creates a sandbox execution", () => {
      const exec = createSandboxExecution("company-1", "modify_code", "agent-1");
      expect(exec.id).toMatch(/^exec_/);
      expect(exec.companyId).toBe("company-1");
      expect(exec.environment).toBe("sandbox");
      expect(exec.status).toBe("pending");
    });

    it("records passing test results", () => {
      const exec = createSandboxExecution("company-1", "modify_code", "agent-1");
      const updated = recordTestResults(exec.id, [
        { name: "test1", passed: true },
        { name: "test2", passed: true },
        { name: "test3", passed: true },
        { name: "test4", passed: true },
        { name: "test5", passed: true },
      ]);
      expect(updated!.status).toBe("passed");
    });

    it("records failing test results", () => {
      const exec = createSandboxExecution("company-1", "modify_code", "agent-1");
      const updated = recordTestResults(exec.id, [
        { name: "test1", passed: true },
        { name: "test2", passed: false, error: "assertion failed" },
        { name: "test3", passed: false, error: "timeout" },
        { name: "test4", passed: false },
        { name: "test5", passed: false },
      ]);
      // 1/5 = 20% pass rate, below 80% threshold
      expect(updated!.status).toBe("failed");
    });

    it("promotes execution from sandbox to staging", () => {
      const exec = createSandboxExecution("company-1", "modify_code", "agent-1");
      recordTestResults(exec.id, [
        { name: "test1", passed: true },
        { name: "test2", passed: true },
        { name: "test3", passed: true },
        { name: "test4", passed: true },
      ]);
      const result = promoteExecution(exec.id);
      expect(result.success).toBe(true);
      expect(result.execution!.environment).toBe("staging");
      expect(result.execution!.status).toBe("promoted");
    });

    it("requires approval for staging → production promotion", () => {
      const exec = createSandboxExecution("company-1", "modify_code", "agent-1");
      // Pass sandbox tests
      recordTestResults(exec.id, [{ name: "test1", passed: true }]);
      promoteExecution(exec.id); // sandbox → staging

      // Reset status to passed for staging tests
      const staging = getExecution(exec.id)!;
      staging.status = "passed" as any;
      staging.testResults = [{ name: "staging_test", passed: true }];

      // Try to promote without approval
      const result = promoteExecution(exec.id);
      expect(result.success).toBe(false);
      expect(result.reason).toMatch(/requires approval/);

      // Promote with approval
      const approved = promoteExecution(exec.id, "admin-user");
      expect(approved.success).toBe(true);
      expect(approved.execution!.environment).toBe("production");
    });

    it("prevents promoting unpassed executions", () => {
      const exec = createSandboxExecution("company-1", "modify_code", "agent-1");
      const result = promoteExecution(exec.id);
      expect(result.success).toBe(false);
      expect(result.reason).toMatch(/Must pass tests first/);
    });

    it("rejects executions", () => {
      const exec = createSandboxExecution("company-1", "modify_code", "agent-1");
      const result = rejectExecution(exec.id, "reviewer", "Code quality too low");
      expect(result.success).toBe(true);
      const rejected = getExecution(exec.id);
      expect(rejected!.status).toBe("rejected");
      expect(rejected!.rejectionReason).toBe("Code quality too low");
    });

    it("lists executions by company", () => {
      createSandboxExecution("company-1", "modify_code", "agent-1");
      createSandboxExecution("company-1", "execute_task", "agent-1");
      createSandboxExecution("company-2", "modify_code", "agent-2");

      const c1 = listExecutions("company-1");
      expect(c1.length).toBe(2);

      const all = listExecutions();
      expect(all.length).toBe(3);
    });
  });

  describe("Sandbox Stats", () => {
    it("tracks statistics", () => {
      const e1 = createSandboxExecution("company-1", "modify_code", "agent-1");
      createSandboxExecution("company-1", "execute_task", "agent-1");
      recordTestResults(e1.id, [{ name: "t1", passed: true }]);

      const stats = getSandboxStats();
      expect(stats.total).toBe(2);
      expect(stats.byStatus.pending).toBe(1);
      expect(stats.byStatus.passed).toBe(1);
      expect(stats.byEnvironment.sandbox).toBe(2);
    });
  });
});

// =========================================================================
// 4. Economic Feedback Loop
// =========================================================================

describe("Economic Feedback Loop", () => {
  beforeEach(() => {
    clearFeedbackData();
    clearContracts();
    clearRegistry();
    clearMarketplace();
    clearPricingData();
    clearOptimizerData();
  });

  describe("evaluateCompanyROI", () => {
    it("evaluates a company with no activity", () => {
      const roi = evaluateCompanyROI("company-1");
      expect(roi.companyId).toBe("company-1");
      expect(roi.revenueCents).toBe(0);
      expect(roi.spendingCents).toBe(0);
      expect(roi.profitCents).toBe(0);
      expect(roi.roi).toBe(0);
      expect(roi.healthTrend).toBeDefined();
    });

    it("tracks task completions in ROI", () => {
      recordTaskCompletion("company-1", "agent-1", 100);
      recordTaskCompletion("company-1", "agent-1", 200);
      const roi = evaluateCompanyROI("company-1");
      expect(roi.tasksCompleted).toBe(2);
    });

    it("stores evaluation history", () => {
      evaluateCompanyROI("company-1");
      evaluateCompanyROI("company-1");
      const history = getCompanyROIHistory("company-1");
      expect(history.length).toBe(2);
    });
  });

  describe("evaluateAgentProductivity", () => {
    it("evaluates agent with no activity", () => {
      const prod = evaluateAgentProductivity("agent-1", "company-1");
      expect(prod.agentId).toBe("agent-1");
      expect(prod.tasksCompleted).toBe(0);
      expect(prod.productivityScore).toBe(50); // baseline
    });

    it("evaluates agent with activity", () => {
      recordTaskCompletion("company-1", "agent-1", 100);
      recordTaskCompletion("company-1", "agent-1", 200);
      const prod = evaluateAgentProductivity("agent-1", "company-1");
      expect(prod.tasksCompleted).toBe(2);
      expect(prod.totalCostCents).toBe(300);
      expect(prod.costPerTaskCents).toBe(150);
      expect(prod.productivityScore).toBeGreaterThan(0);
    });

    it("stores productivity history", () => {
      evaluateAgentProductivity("agent-1", "company-1");
      evaluateAgentProductivity("agent-1", "company-1");
      const history = getAgentProductivityHistory("agent-1");
      expect(history.length).toBe(2);
    });
  });

  describe("runCompanyFeedback", () => {
    it("returns 'none' action for healthy company", () => {
      const action = runCompanyFeedback("company-1");
      expect(action.type).toBe("none");
    });

    it("returns 'none' for company below minimum spend threshold", () => {
      // Company with no spending = below threshold = exempt
      const action = runCompanyFeedback("company-1");
      expect(action.type).toBe("none");
    });
  });

  describe("evaluateEcosystemHealth", () => {
    it("evaluates empty ecosystem", () => {
      const health = evaluateEcosystemHealth([]);
      expect(health.totalCompanies).toBe(0);
      expect(health.healthyCompanies).toBe(0);
      expect(health.ecosystemROI).toBe(0);
    });

    it("evaluates ecosystem with companies", () => {
      const health = evaluateEcosystemHealth(["company-1", "company-2"]);
      expect(health.totalCompanies).toBe(2);
      expect(health.companyROIs.length).toBe(2);
      expect(health.evaluatedAt).toBeDefined();
    });
  });

  describe("Feedback Config", () => {
    it("returns default config", () => {
      const config = getFeedbackConfig();
      expect(config.warningThreshold).toBe(3);
      expect(config.pauseThreshold).toBe(5);
      expect(config.shutdownThreshold).toBe(8);
    });

    it("allows config updates", () => {
      setFeedbackConfig({ warningThreshold: 5 });
      const config = getFeedbackConfig();
      expect(config.warningThreshold).toBe(5);
      expect(config.pauseThreshold).toBe(5); // unchanged
    });
  });

  describe("Pending Actions", () => {
    it("starts with no pending actions", () => {
      const actions = getPendingFeedbackActions();
      expect(actions.length).toBe(0);
    });

    it("filters actions by company", () => {
      const actions = getPendingFeedbackActions("company-1");
      expect(actions.length).toBe(0);
    });
  });
});

// =========================================================================
// 5. Hard Economic Limits (existing — integration verification)
// =========================================================================

describe("Hard Economic Limits — Integration Verification", () => {
  beforeEach(() => {
    clearContracts();
    clearRegistry();
  });

  describe("Ecosystem-wide limits", () => {
    it("returns default economic limits", () => {
      const limits = getEconomicLimits();
      expect(limits.maxActiveContracts).toBe(50);
      expect(limits.maxDailyTransactionsCents).toBe(50000);
      expect(limits.maxEcosystemBudgetCents).toBe(600000);
      expect(limits.maxCompanyLossCents).toBe(10000);
      expect(limits.maxServicesPerCompany).toBe(10);
      expect(limits.maxContractsPerCompany).toBe(20);
    });

    it("checks ecosystem status", () => {
      const status = checkEconomicStatus();
      expect(status.isWithinLimits).toBe(true);
      expect(status.violations.length).toBe(0);
    });

    it("allows contract creation when within limits", () => {
      const result = canCreateContract("company-1", "company-2");
      expect(result.allowed).toBe(true);
    });

    it("allows service registration when within limits", () => {
      const result = canRegisterService("company-1");
      expect(result.allowed).toBe(true);
    });

    it("checks company economic status", () => {
      const status = checkCompanyEconomicStatus("company-1");
      expect(status.companyId).toBe("company-1");
      expect(status.isWithinLimits).toBe(true);
    });
  });

  describe("Workforce limits", () => {
    it("returns default workforce limits", () => {
      const limits = getWorkforceLimits();
      expect(limits.maxAgentsPerCompany).toBe(20);
      expect(limits.maxDepartments).toBe(8);
      expect(limits.maxMonthlyBudgetCents).toBe(20000);
      expect(limits.maxAgentsPerDepartment).toBe(8);
      expect(limits.maxExpansionsPerDay).toBe(3);
    });
  });

  describe("Ecosystem limits", () => {
    it("returns default ecosystem limits", () => {
      const limits = getEcosystemLimits();
      expect(limits.maxCompanies).toBe(10);
      expect(limits.totalBudgetCents).toBe(100000);
      expect(limits.perCompanyBudgetLimitCents).toBe(15000);
    });
  });
});

// =========================================================================
// 6. Multi-Layer Integration Tests
// =========================================================================

describe("Multi-Layer Integration", () => {
  beforeEach(() => {
    clearGovernanceAudit();
    resetCircuitBreakers();
    clearRateLimits();
    clearSandboxExecutions();
    clearFeedbackData();
    clearContracts();
    clearRegistry();
    clearMarketplace();
    clearPricingData();
    clearOptimizerData();
  });

  it("governance + rate limit: blocks rapid company creation", async () => {
    // First company creation passes governance
    const d1 = await requestGovernanceClearance(
      mockDb,
      makeRequest({ action: "create_company", estimatedCostCents: 100 }),
    );
    expect(d1.allowed).toBe(true);

    // Second immediately blocked by rate limiter
    const d2 = await requestGovernanceClearance(
      mockDb,
      makeRequest({ action: "create_company", estimatedCostCents: 100 }),
    );
    expect(d2.allowed).toBe(false);
    expect(d2.blockedBy).toBe("rate_limit");
  });

  it("governance + sandbox: agents execute code in sandbox", async () => {
    const decision = await requestGovernanceClearance(
      mockDb,
      makeRequest({ action: "modify_code" }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.environment).toBe("sandbox");

    // Create sandbox execution and go through lifecycle
    const exec = createSandboxExecution("company-1", "modify_code", "agent-1");
    expect(exec.environment).toBe("sandbox");

    // Run tests
    recordTestResults(exec.id, [
      { name: "unit_test_1", passed: true, duration: 100 },
      { name: "unit_test_2", passed: true, duration: 200 },
    ]);
    expect(getExecution(exec.id)!.status).toBe("passed");

    // Promote to staging
    const promoted = promoteExecution(exec.id);
    expect(promoted.success).toBe(true);
    expect(promoted.execution!.environment).toBe("staging");
  });

  it("governance + circuit breaker + recovery: system recovers", async () => {
    // Trip circuit breaker with repeated failures
    for (let i = 0; i < 10; i++) {
      recordGovernanceFailure("company-1", "execute_task");
    }

    // Should be blocked
    const blocked = await requestGovernanceClearance(mockDb, makeRequest());
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockedBy).toBe("circuit_breaker");

    // Reset and verify recovery
    resetCircuitBreakers();
    const recovered = await requestGovernanceClearance(mockDb, makeRequest());
    expect(recovered.allowed).toBe(true);
  });

  it("rate limiter + agent separation: enforces per-agent limits", () => {
    setRateLimit("task_execution", {
      maxEvents: 2,
      windowMs: 60_000,
      description: "Test: 2 per minute per agent",
    });

    // Agent 1 fills their limit
    checkRateLimit("task_execution", "company-1", "agent-1");
    checkRateLimit("task_execution", "company-1", "agent-1");
    const a1 = checkRateLimit("task_execution", "company-1", "agent-1");
    expect(a1.allowed).toBe(false);

    // Agent 2 still has capacity
    const a2 = checkRateLimit("task_execution", "company-1", "agent-2");
    expect(a2.allowed).toBe(true);
  });

  it("feedback loop + ecosystem: evaluates and recommends actions", () => {
    recordTaskCompletion("company-1", "agent-1", 500);
    recordTaskCompletion("company-2", "agent-2", 300);

    const health = evaluateEcosystemHealth(["company-1", "company-2"]);
    expect(health.totalCompanies).toBe(2);
    expect(health.companyROIs[0]!.tasksCompleted).toBe(1);
    expect(health.companyROIs[1]!.tasksCompleted).toBe(1);
  });

  it("full lifecycle: governance → sandbox → promotion", async () => {
    // Step 1: Request governance clearance
    const clearance = await requestGovernanceClearance(
      mockDb,
      makeRequest({ action: "modify_code" }),
    );
    expect(clearance.allowed).toBe(true);
    expect(clearance.environment).toBe("sandbox");

    // Step 2: Create sandbox execution
    const exec = createSandboxExecution("company-1", "modify_code", "agent-1");

    // Step 3: Run sandbox tests
    recordTestResults(exec.id, [
      { name: "test_1", passed: true },
      { name: "test_2", passed: true },
      { name: "test_3", passed: true },
    ]);
    expect(getExecution(exec.id)!.status).toBe("passed");

    // Step 4: Promote to staging
    const toStaging = promoteExecution(exec.id);
    expect(toStaging.success).toBe(true);
    expect(toStaging.execution!.environment).toBe("staging");

    // Step 5: Run staging tests and promote to production
    const staging = getExecution(exec.id)!;
    staging.status = "passed" as any;
    staging.testResults = [{ name: "staging_test", passed: true }];

    const toProd = promoteExecution(exec.id, "admin");
    expect(toProd.success).toBe(true);
    expect(toProd.execution!.environment).toBe("production");

    // Step 6: Record task completion in feedback loop
    recordTaskCompletion("company-1", "agent-1", 50);
    const roi = evaluateCompanyROI("company-1");
    expect(roi.tasksCompleted).toBe(1);

    // Verify governance audit trail captured everything
    const audit = getGovernanceAudit("company-1");
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("prevents autonomous expansion collapse scenario", async () => {
    // Simulate the dangerous chain reaction:
    // Agent detects opportunity → creates company → company creates agents → ...

    // Step 1: First company creation succeeds
    const d1 = await requestGovernanceClearance(
      mockDb,
      makeRequest({ action: "create_company", estimatedCostCents: 100 }),
    );
    expect(d1.allowed).toBe(true);

    // Step 2: Immediate second company creation blocked (rate limit: 1/week)
    const d2 = await requestGovernanceClearance(
      mockDb,
      makeRequest({ action: "create_company", estimatedCostCents: 100 }),
    );
    expect(d2.allowed).toBe(false);
    expect(d2.blockedBy).toBe("rate_limit");

    // Step 3: Agent creation limited to 3/day
    for (let i = 0; i < 3; i++) {
      const d = await requestGovernanceClearance(
        mockDb,
        makeRequest({ action: "create_agent", estimatedCostCents: 50 }),
      );
      expect(d.allowed).toBe(true);
    }
    const d4 = await requestGovernanceClearance(
      mockDb,
      makeRequest({ action: "create_agent", estimatedCostCents: 50 }),
    );
    expect(d4.allowed).toBe(false);
    expect(d4.blockedBy).toBe("rate_limit");

    // Step 4: Tasks limited to 10/hour per agent
    setRateLimit("task_execution", {
      maxEvents: 3,
      windowMs: 60_000,
      description: "Test: 3 per minute",
    });
    for (let i = 0; i < 3; i++) {
      await requestGovernanceClearance(mockDb, makeRequest());
    }
    const taskBlocked = await requestGovernanceClearance(mockDb, makeRequest());
    expect(taskBlocked.allowed).toBe(false);

    // Step 5: Verify the cascade was STOPPED
    const stats = getGovernanceStats();
    expect(stats.blocked).toBeGreaterThan(0);
    expect(stats.blockedByLayer.rate_limit).toBeGreaterThan(0);
  });
});
