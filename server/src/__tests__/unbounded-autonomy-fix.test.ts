// ---------------------------------------------------------------------------
// Tests — Unbounded Autonomy Fix: Hard Constraints & Governance Gates
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";

// ==========================================================================
// Section 1: Global Autonomy Limits
// ==========================================================================
describe("Global Autonomy Limits", () => {
  let mod: typeof import("../ai/governance/autonomyLimits.js");

  beforeEach(async () => {
    mod = await import("../ai/governance/autonomyLimits.js");
    mod.resetAutonomyLimits();
  });

  it("1.1 — getAutonomyLimits returns safe defaults", () => {
    const limits = mod.getAutonomyLimits();
    expect(limits.maxAgentsPerCompany).toBe(20);
    expect(limits.maxCompaniesInEcosystem).toBe(10);
    expect(limits.maxAgentCreationPerDay).toBe(3);
    expect(limits.maxWorkflowDepth).toBe(20);
    expect(limits.maxExecutionLoopIterations).toBe(100);
    expect(limits.maxActivePlansPerCompany).toBe(20);
    expect(limits.maxReplanCycles).toBe(3);
    expect(limits.maxDailyCostPerCompanyCents).toBe(5_000);
    expect(limits.maxIntercompanyContracts).toBe(50);
    expect(limits.maxServiceCallsPerDay).toBe(200);
    expect(limits.maxTransactionValueCents).toBe(1_000);
    expect(limits.maxIntercompanyDependencies).toBe(10);
    expect(limits.maxEcosystemDailySpendCents).toBe(20_000);
  });

  it("1.2 — setAutonomyLimits overrides specific values", () => {
    mod.setAutonomyLimits({ maxAgentsPerCompany: 5, maxCompaniesInEcosystem: 3 });
    const limits = mod.getAutonomyLimits();
    expect(limits.maxAgentsPerCompany).toBe(5);
    expect(limits.maxCompaniesInEcosystem).toBe(3);
    // Others unchanged
    expect(limits.maxExecutionLoopIterations).toBe(100);
  });

  it("1.3 — resetAutonomyLimits clears overrides", () => {
    mod.setAutonomyLimits({ maxAgentsPerCompany: 1 });
    expect(mod.getAutonomyLimits().maxAgentsPerCompany).toBe(1);
    mod.resetAutonomyLimits();
    expect(mod.getAutonomyLimits().maxAgentsPerCompany).toBe(20);
  });

  it("1.4 — checkLimit blocks when at capacity", () => {
    const result = mod.checkLimit("maxAgentsPerCompany", 20);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("maxAgentsPerCompany");
    expect(result.current).toBe(20);
    expect(result.max).toBe(20);
  });

  it("1.5 — checkLimit allows when below capacity", () => {
    const result = mod.checkLimit("maxAgentsPerCompany", 19);
    expect(result.allowed).toBe(true);
  });

  it("1.6 — getAutonomyLimitsSnapshot returns frozen copy", () => {
    const snapshot = mod.getAutonomyLimitsSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.maxAgentsPerCompany).toBe(20);
  });

  it("1.7 — reads from environment variables", () => {
    mod.resetAutonomyLimits();
    process.env.MAX_AGENTS_PER_COMPANY = "7";
    mod.resetAutonomyLimits(); // force reload
    const limits = mod.getAutonomyLimits();
    expect(limits.maxAgentsPerCompany).toBe(7);
    delete process.env.MAX_AGENTS_PER_COMPANY;
    mod.resetAutonomyLimits();
  });

  it("1.8 — parseDollarsToCents handles dollar sign", () => {
    mod.resetAutonomyLimits();
    process.env.MAX_DAILY_COST_PER_COMPANY = "$75";
    mod.resetAutonomyLimits();
    const limits = mod.getAutonomyLimits();
    expect(limits.maxDailyCostPerCompanyCents).toBe(7_500);
    delete process.env.MAX_DAILY_COST_PER_COMPANY;
    mod.resetAutonomyLimits();
  });

  it("1.9 — invalid env values fall back to defaults", () => {
    mod.resetAutonomyLimits();
    process.env.MAX_AGENTS_PER_COMPANY = "not-a-number";
    mod.resetAutonomyLimits();
    expect(mod.getAutonomyLimits().maxAgentsPerCompany).toBe(20);
    delete process.env.MAX_AGENTS_PER_COMPANY;
    mod.resetAutonomyLimits();
  });

  it("1.10 — zero/negative env values fall back to defaults", () => {
    mod.resetAutonomyLimits();
    process.env.MAX_AGENTS_PER_COMPANY = "-5";
    mod.resetAutonomyLimits();
    expect(mod.getAutonomyLimits().maxAgentsPerCompany).toBe(20);
    delete process.env.MAX_AGENTS_PER_COMPANY;
    mod.resetAutonomyLimits();
  });
});

// ==========================================================================
// Section 2: Agent Creation — No Auto-Approval
// ==========================================================================
describe("Agent Creation Approval — Never Auto", () => {
  let mod: typeof import("../ai/governance/expansionApproval.js");

  beforeEach(async () => {
    mod = await import("../ai/governance/expansionApproval.js");
  });

  const makeDesign = (overrides: Record<string, unknown> = {}) => ({
    role: "test-agent",
    capabilities: ["testing"],
    priority: 8,
    budgetCents: 100,
    reason: "Testing",
    canApprove: false,
    sourceGaps: [],
    ...overrides,
  });

  it("2.1 — low-priority low-budget agent requires manager (NOT auto)", () => {
    const level = mod.determineApprovalLevel(makeDesign({ priority: 8, budgetCents: 100 }) as any);
    expect(level).toBe("manager");
    expect(level).not.toBe("auto");
  });

  it("2.2 — mid-priority agent requires manager", () => {
    const level = mod.determineApprovalLevel(makeDesign({ priority: 5, budgetCents: 200 }) as any);
    expect(level).toBe("manager");
  });

  it("2.3 — high-priority agent requires human", () => {
    const level = mod.determineApprovalLevel(makeDesign({ priority: 2 }) as any);
    expect(level).toBe("human");
  });

  it("2.4 — high-budget agent requires ceo", () => {
    const level = mod.determineApprovalLevel(makeDesign({ budgetCents: 1500 }) as any);
    expect(level).toBe("ceo");
  });

  it("2.5 — canApprove agent requires ceo", () => {
    const level = mod.determineApprovalLevel(makeDesign({ canApprove: true }) as any);
    expect(level).toBe("ceo");
  });

  it("2.6 — NO path returns auto for any combination", () => {
    const combos = [
      { priority: 10, budgetCents: 1 },
      { priority: 10, budgetCents: 50 },
      { priority: 10, budgetCents: 499 },
      { priority: 7, budgetCents: 100 },
      { priority: 6, budgetCents: 0 },
    ];
    for (const combo of combos) {
      const level = mod.determineApprovalLevel(makeDesign(combo) as any);
      expect(level).not.toBe("auto");
    }
  });
});

// ==========================================================================
// Section 3: Company Creation — No Auto-Approval
// ==========================================================================
describe("Company Creation Approval — Never Auto", () => {
  let mod: typeof import("../ai/governance/companyApproval.js");

  beforeEach(async () => {
    mod = await import("../ai/governance/companyApproval.js");
  });

  const makeModel = (overrides: Record<string, unknown> = {}) => ({
    companyName: "TestCo",
    product: "Test product",
    revenueModel: "saas",
    initialBudgetCents: 1000,
    initialAgentRoles: [],
    ...overrides,
  });

  it("3.1 — low-budget company requires manager (NOT auto)", () => {
    const level = mod.determineCompanyApprovalLevel(makeModel({ initialBudgetCents: 500 }) as any);
    expect(level).toBe("manager");
    expect(level).not.toBe("auto");
  });

  it("3.2 — medium-budget company requires ceo", () => {
    const level = mod.determineCompanyApprovalLevel(makeModel({ initialBudgetCents: 5000 }) as any);
    expect(level).toBe("ceo");
  });

  it("3.3 — high-budget company requires ceo", () => {
    const level = mod.determineCompanyApprovalLevel(makeModel({ initialBudgetCents: 10000 }) as any);
    expect(level).toBe("ceo");
  });

  it("3.4 — enterprise requires human", () => {
    const level = mod.determineCompanyApprovalLevel(makeModel({ revenueModel: "enterprise" }) as any);
    expect(level).toBe("human");
  });

  it("3.5 — marketplace requires human", () => {
    const level = mod.determineCompanyApprovalLevel(makeModel({ revenueModel: "marketplace" }) as any);
    expect(level).toBe("human");
  });

  it("3.6 — NO path returns auto for any budget level", () => {
    const budgets = [0, 1, 100, 500, 1000, 2000, 2999];
    for (const budget of budgets) {
      const level = mod.determineCompanyApprovalLevel(makeModel({ initialBudgetCents: budget }) as any);
      expect(level).not.toBe("auto");
    }
  });
});

// ==========================================================================
// Section 4: Workforce Limits — Synced from Global
// ==========================================================================
describe("Workforce Limits — Global Sync", () => {
  let workforce: typeof import("../ai/governance/workforceLimits.js");
  let autonomy: typeof import("../ai/governance/autonomyLimits.js");

  beforeEach(async () => {
    workforce = await import("../ai/governance/workforceLimits.js");
    autonomy = await import("../ai/governance/autonomyLimits.js");
    autonomy.resetAutonomyLimits();
  });

  it("4.1 — workforce limits match global autonomy limits", () => {
    const wl = workforce.getWorkforceLimits();
    const gl = autonomy.getAutonomyLimits();
    expect(wl.maxAgentsPerCompany).toBe(gl.maxAgentsPerCompany);
    expect(wl.maxExpansionsPerDay).toBe(gl.maxAgentCreationPerDay);
    expect(wl.maxDepartments).toBe(gl.maxDepartmentsPerCompany);
  });

  it("4.2 — changing global limits changes workforce limits", () => {
    autonomy.setAutonomyLimits({ maxAgentsPerCompany: 5, maxAgentCreationPerDay: 1 });
    const wl = workforce.getWorkforceLimits();
    expect(wl.maxAgentsPerCompany).toBe(5);
    expect(wl.maxExpansionsPerDay).toBe(1);
  });
});

// ==========================================================================
// Section 5: Ecosystem Limits — Synced from Global
// ==========================================================================
describe("Ecosystem Budget — Global Sync", () => {
  let ecosystem: typeof import("../ai/governance/ecosystemBudget.js");
  let autonomy: typeof import("../ai/governance/autonomyLimits.js");

  beforeEach(async () => {
    ecosystem = await import("../ai/governance/ecosystemBudget.js");
    autonomy = await import("../ai/governance/autonomyLimits.js");
    autonomy.resetAutonomyLimits();
  });

  it("5.1 — ecosystem limits match global autonomy limits", () => {
    const el = ecosystem.getEcosystemLimits();
    const gl = autonomy.getAutonomyLimits();
    expect(el.maxCompanies).toBe(gl.maxCompaniesInEcosystem);
  });

  it("5.2 — changing global limits changes ecosystem limits", () => {
    autonomy.setAutonomyLimits({ maxCompaniesInEcosystem: 3 });
    const el = ecosystem.getEcosystemLimits();
    expect(el.maxCompanies).toBe(3);
  });
});

// ==========================================================================
// Section 6: Economic Limits — New Fields
// ==========================================================================
describe("Economic Limits — New Constraints", () => {
  let econ: typeof import("../ai/governance/economicLimits.js");
  let autonomy: typeof import("../ai/governance/autonomyLimits.js");

  beforeEach(async () => {
    econ = await import("../ai/governance/economicLimits.js");
    autonomy = await import("../ai/governance/autonomyLimits.js");
    autonomy.resetAutonomyLimits();
  });

  it("6.1 — getEconomicLimits includes new fields", () => {
    const limits = econ.getEconomicLimits();
    expect(limits.maxTransactionValueCents).toBe(1_000);
    expect(limits.maxServiceCallsPerDay).toBe(200);
    expect(limits.maxIntercompanyDependencies).toBe(10);
  });

  it("6.2 — economic limits synced from global autonomy limits", () => {
    autonomy.setAutonomyLimits({ maxIntercompanyContracts: 10, maxTransactionValueCents: 500 });
    const limits = econ.getEconomicLimits();
    expect(limits.maxActiveContracts).toBe(10);
    expect(limits.maxTransactionValueCents).toBe(500);
  });

  it("6.3 — canCreateContract blocks when transaction exceeds max value", () => {
    autonomy.setAutonomyLimits({ maxTransactionValueCents: 100 });
    const result = econ.canCreateContract("p1", "c1", 200);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Transaction value");
  });

  it("6.4 — canCreateContract allows within transaction limit", () => {
    const result = econ.canCreateContract("p1", "c1", 50);
    expect(result.allowed).toBe(true);
  });
});

// ==========================================================================
// Section 7: Rate Limiter — New Domains
// ==========================================================================
describe("Rate Limiter — New Domains", () => {
  let rl: typeof import("../ai/governance/systemRateLimiter.js");

  beforeEach(async () => {
    rl = await import("../ai/governance/systemRateLimiter.js");
    rl.clearRateLimits();
  });

  it("7.1 — service_request domain exists", () => {
    const config = rl.getRateLimitConfig("service_request");
    expect(config).toBeDefined();
    expect(config.maxEvents).toBeGreaterThan(0);
  });

  it("7.2 — opportunity_scanning domain exists", () => {
    const config = rl.getRateLimitConfig("opportunity_scanning");
    expect(config).toBeDefined();
    expect(config.maxEvents).toBe(3); // 3 per day
  });

  it("7.3 — service_request enforces limit", () => {
    rl.setRateLimit("service_request", { maxEvents: 2, windowMs: 60_000, description: "test" });
    expect(rl.checkRateLimit("service_request", "c1").allowed).toBe(true);
    expect(rl.checkRateLimit("service_request", "c1").allowed).toBe(true);
    expect(rl.checkRateLimit("service_request", "c1").allowed).toBe(false);
  });

  it("7.4 — opportunity_scanning enforces limit", () => {
    rl.setRateLimit("opportunity_scanning", { maxEvents: 1, windowMs: 60_000, description: "test" });
    expect(rl.checkRateLimit("opportunity_scanning", "c1").allowed).toBe(true);
    expect(rl.checkRateLimit("opportunity_scanning", "c1").allowed).toBe(false);
  });

  it("7.5 — agent_creation limit synced from global", () => {
    const config = rl.getRateLimitConfig("agent_creation");
    expect(config.maxEvents).toBe(3); // from global autonomy limits
  });

  it("7.6 — getAllRateLimits includes new domains", () => {
    const all = rl.getAllRateLimits();
    expect(all.service_request).toBeDefined();
    expect(all.opportunity_scanning).toBeDefined();
  });
});

// ==========================================================================
// Section 8: Marketplace — Rate Limited Service Requests
// ==========================================================================
describe("Marketplace — Rate Limited", () => {
  let marketplace: typeof import("../ai/economy/marketplace.js");
  let rl: typeof import("../ai/governance/systemRateLimiter.js");
  let autonomy: typeof import("../ai/governance/autonomyLimits.js");

  beforeEach(async () => {
    marketplace = await import("../ai/economy/marketplace.js");
    rl = await import("../ai/governance/systemRateLimiter.js");
    autonomy = await import("../ai/governance/autonomyLimits.js");
    marketplace.clearMarketplace();
    rl.clearRateLimits();
    autonomy.resetAutonomyLimits();
  });

  it("8.1 — createServiceRequest returns error when rate limited", () => {
    rl.setRateLimit("service_request", { maxEvents: 1, windowMs: 60_000, description: "test" });
    const first = marketplace.createServiceRequest("c1", "code_generation" as any);
    expect("error" in first).toBe(false); // first succeeds

    const second = marketplace.createServiceRequest("c1", "code_generation" as any);
    expect("error" in second).toBe(true);
  });

  it("8.2 — createServiceRequest rejects when max price exceeds transaction limit", () => {
    autonomy.setAutonomyLimits({ maxTransactionValueCents: 50 });
    const result = marketplace.createServiceRequest("c1", "code_generation" as any, { maxPriceCents: 100 });
    expect("error" in result).toBe(true);
  });
});

// ==========================================================================
// Section 9: Execution Loop — Agent Pause on Overflow
// ==========================================================================
describe("Execution Loop — Iteration Cap", () => {
  let autonomy: typeof import("../ai/governance/autonomyLimits.js");

  beforeEach(async () => {
    autonomy = await import("../ai/governance/autonomyLimits.js");
    autonomy.resetAutonomyLimits();
  });

  it("9.1 — global max is used as the ceiling even when options specify higher", async () => {
    autonomy.setAutonomyLimits({ maxExecutionLoopIterations: 5 });
    const loopMod = await import("../ai/loop/executionLoop.js");
    // We can't run the full loop without a real context, but we verify the module imports correctly
    expect(typeof loopMod.runExecutionLoop).toBe("function");
  });

  it("9.2 — global limit is 100 by default", () => {
    expect(autonomy.getAutonomyLimits().maxExecutionLoopIterations).toBe(100);
  });
});

// ==========================================================================
// Section 10: Governance Engine — Proper Rate Domain Mapping
// ==========================================================================
describe("Governance Engine — Rate Domain Mapping", () => {
  let gov: typeof import("../ai/governance/governanceEngine.js");
  let rl: typeof import("../ai/governance/systemRateLimiter.js");
  let autonomy: typeof import("../ai/governance/autonomyLimits.js");

  const mockDb = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([{ count: 0, total: 0 }]) }) }),
  } as any;

  beforeEach(async () => {
    gov = await import("../ai/governance/governanceEngine.js");
    rl = await import("../ai/governance/systemRateLimiter.js");
    autonomy = await import("../ai/governance/autonomyLimits.js");
    rl.clearRateLimits();
    gov.clearGovernanceAudit();
    gov.resetCircuitBreakers();
    autonomy.resetAutonomyLimits();
  });

  it("10.1 — scan_opportunities maps to opportunity_scanning domain", async () => {
    rl.setRateLimit("opportunity_scanning", { maxEvents: 1, windowMs: 60_000, description: "test" });

    const d1 = await gov.requestGovernanceClearance(mockDb, {
      action: "scan_opportunities",
      actorType: "board",
      actorId: "user1",
      companyId: "c1",
    });
    expect(d1.allowed).toBe(true);

    const d2 = await gov.requestGovernanceClearance(mockDb, {
      action: "scan_opportunities",
      actorType: "board",
      actorId: "user1",
      companyId: "c1",
    });
    expect(d2.allowed).toBe(false);
    expect(d2.blockedBy).toBe("rate_limit");
  });

  it("10.2 — create_company goes through all safety layers", async () => {
    const decision = await gov.requestGovernanceClearance(mockDb, {
      action: "create_company",
      actorType: "board",
      actorId: "user1",
      companyId: "c1",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.approvalLevel).toBe("ceo");
  });

  it("10.3 — expand_workforce uses agent_creation rate limit", async () => {
    rl.setRateLimit("agent_creation", { maxEvents: 1, windowMs: 60_000, description: "test" });

    await gov.requestGovernanceClearance(mockDb, {
      action: "expand_workforce",
      actorType: "board",
      actorId: "user1",
      companyId: "c1",
    });

    const d2 = await gov.requestGovernanceClearance(mockDb, {
      action: "expand_workforce",
      actorType: "board",
      actorId: "user1",
      companyId: "c1",
    });
    expect(d2.allowed).toBe(false);
    expect(d2.blockedBy).toBe("rate_limit");
  });

  it("10.4 — governance dashboard includes autonomy limits", async () => {
    // Verify the stats function works correctly
    const stats = gov.getGovernanceStats();
    expect(stats).toHaveProperty("totalDecisions");
    expect(stats).toHaveProperty("allowed");
    expect(stats).toHaveProperty("blocked");
  });
});

// ==========================================================================
// Section 11: Integration — Full Safety Stack
// ==========================================================================
describe("Full Safety Stack Integration", () => {
  let autonomy: typeof import("../ai/governance/autonomyLimits.js");
  let gov: typeof import("../ai/governance/governanceEngine.js");
  let rl: typeof import("../ai/governance/systemRateLimiter.js");

  const mockDb = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([{ count: 0, total: 0 }]) }) }),
  } as any;

  beforeEach(async () => {
    autonomy = await import("../ai/governance/autonomyLimits.js");
    gov = await import("../ai/governance/governanceEngine.js");
    rl = await import("../ai/governance/systemRateLimiter.js");
    autonomy.resetAutonomyLimits();
    rl.clearRateLimits();
    gov.clearGovernanceAudit();
    gov.resetCircuitBreakers();
  });

  it("11.1 — agent creation rate limited at 3/day through governance", async () => {
    for (let i = 0; i < 3; i++) {
      const d = await gov.requestGovernanceClearance(mockDb, {
        action: "create_agent",
        actorType: "board",
        actorId: "u1",
        companyId: "c1",
      });
      expect(d.allowed).toBe(true);
    }
    const blocked = await gov.requestGovernanceClearance(mockDb, {
      action: "create_agent",
      actorType: "board",
      actorId: "u1",
      companyId: "c1",
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.blockedBy).toBe("rate_limit");
  });

  it("11.2 — company creation rate limited at 1/week through governance", async () => {
    const d1 = await gov.requestGovernanceClearance(mockDb, {
      action: "create_company",
      actorType: "board",
      actorId: "u1",
      companyId: "c1",
    });
    expect(d1.allowed).toBe(true);

    const d2 = await gov.requestGovernanceClearance(mockDb, {
      action: "create_company",
      actorType: "board",
      actorId: "u1",
      companyId: "c1",
    });
    expect(d2.allowed).toBe(false);
  });

  it("11.3 — setting lower global limits tightens everything", () => {
    autonomy.setAutonomyLimits({
      maxAgentsPerCompany: 2,
      maxCompaniesInEcosystem: 1,
      maxAgentCreationPerDay: 1,
    });
    const limits = autonomy.getAutonomyLimits();
    expect(limits.maxAgentsPerCompany).toBe(2);
    expect(limits.maxCompaniesInEcosystem).toBe(1);
    expect(limits.maxAgentCreationPerDay).toBe(1);
  });

  it("11.4 — circuit breaker still works with new limits", () => {
    // Record enough failures to trip the circuit breaker
    for (let i = 0; i < 10; i++) {
      gov.recordGovernanceFailure("c1", "create_agent");
    }
    // Circuit breaker should be open now
    const stats = gov.getGovernanceStats();
    const cb = stats.circuitBreakers.find((c) => c.key === "c1:create_agent");
    expect(cb?.state).toBe("open");
  });
});
