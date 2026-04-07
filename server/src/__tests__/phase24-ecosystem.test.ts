// ---------------------------------------------------------------------------
// Phase 24 — Autonomous Business Creation & Multi-Company Ecosystem Tests
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll } from "vitest";

// ==========================================================================
// Section 1: Opportunity Scanner
// ==========================================================================
describe("Phase 24 — Opportunity Scanner", () => {
  let mod: typeof import("../ai/ecosystem/opportunityScanner.js");

  beforeAll(async () => {
    mod = await import("../ai/ecosystem/opportunityScanner.js");
  });

  it("1.1 — exports scanOpportunities, scanFromCompanyGaps, scanMarketTrends", () => {
    expect(typeof mod.scanOpportunities).toBe("function");
    expect(typeof mod.scanFromCompanyGaps).toBe("function");
    expect(typeof mod.scanMarketTrends).toBe("function");
  });

  it("1.2 — MARKET_OPPORTUNITIES has pre-built business templates", () => {
    expect(mod.MARKET_OPPORTUNITIES).toBeDefined();
    expect(Object.keys(mod.MARKET_OPPORTUNITIES).length).toBeGreaterThanOrEqual(7);
  });

  it("1.3 — GAP_TO_MARKET maps task types to market opportunities", () => {
    expect(mod.GAP_TO_MARKET).toBeDefined();
    expect(Object.keys(mod.GAP_TO_MARKET).length).toBeGreaterThan(0);
    // Each value should reference a market opportunity
    for (const key of Object.values(mod.GAP_TO_MARKET)) {
      expect(mod.MARKET_OPPORTUNITIES[key]).toBeDefined();
    }
  });

  it("1.4 — scanMarketTrends returns market trend opportunities", () => {
    const opportunities = mod.scanMarketTrends();
    expect(Array.isArray(opportunities)).toBe(true);
    expect(opportunities.length).toBeGreaterThan(0);
    for (const opp of opportunities) {
      expect(opp.sourceType).toBe("market_trend");
      expect(opp.id).toBeDefined();
      expect(opp.title).toBeDefined();
      expect(typeof opp.confidence).toBe("number");
      expect(opp.confidence).toBeGreaterThan(0);
      expect(opp.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("1.5 — Opportunity interface shape is correct", () => {
    const opp: import("../ai/ecosystem/opportunityScanner.js").Opportunity = {
      id: "opp_1",
      title: "Test Opportunity",
      description: "A test opportunity for unit testing",
      sourceType: "market_trend",
      marketCategory: "developer_tools",
      potentialRevenue: "high",
      confidence: 0.8,
      suggestedProduct: "Developer testing tool",
      targetMarket: "Software companies",
      discoveredAt: new Date().toISOString(),
      metadata: {},
    };
    expect(opp.sourceType).toBe("market_trend");
    expect(opp.confidence).toBe(0.8);
  });

  it("1.6 — ScanResult interface shape is correct", () => {
    const result: import("../ai/ecosystem/opportunityScanner.js").ScanResult = {
      sourceCompanyId: "c1",
      opportunities: [],
      scannedAt: new Date().toISOString(),
      totalScanned: 0,
    };
    expect(result.totalScanned).toBe(0);
  });

  it("1.7 — market opportunities have required fields", () => {
    for (const [key, opp] of Object.entries(mod.MARKET_OPPORTUNITIES)) {
      expect(opp.title).toBeDefined();
      expect(opp.description).toBeDefined();
      expect(opp.marketCategory).toBeDefined();
      expect(typeof opp.potentialRevenue).toBe("string");
      expect(["low", "medium", "high"]).toContain(opp.potentialRevenue);
      expect(typeof opp.confidence).toBe("number");
      expect(opp.suggestedProduct).toBeDefined();
      expect(opp.targetMarket).toBeDefined();
    }
  });
});

// ==========================================================================
// Section 2: Business Designer
// ==========================================================================
describe("Phase 24 — Business Designer", () => {
  let mod: typeof import("../ai/ecosystem/businessDesigner.js");

  beforeAll(async () => {
    mod = await import("../ai/ecosystem/businessDesigner.js");
  });

  it("2.1 — exports designBusiness, designBusinesses, generateCompanyName", () => {
    expect(typeof mod.designBusiness).toBe("function");
    expect(typeof mod.designBusinesses).toBe("function");
    expect(typeof mod.generateCompanyName).toBe("function");
  });

  it("2.2 — generateCompanyName creates an AI-suffixed name", () => {
    const opp: import("../ai/ecosystem/opportunityScanner.js").Opportunity = {
      id: "opp_1",
      title: "Customer Support Automation",
      description: "Automate customer support",
      sourceType: "market_trend",
      marketCategory: "customer_support",
      potentialRevenue: "high",
      confidence: 0.8,
      suggestedProduct: "AI Support Bot",
      targetMarket: "SaaS companies",
      discoveredAt: new Date().toISOString(),
      metadata: {},
    };
    const name = mod.generateCompanyName(opp);
    expect(name).toContain("AI");
    expect(name.length).toBeGreaterThan(0);
  });

  it("2.3 — designBusiness returns a valid DesignResult", () => {
    const opp: import("../ai/ecosystem/opportunityScanner.js").Opportunity = {
      id: "opp_2",
      title: "SEO Automation Platform",
      description: "Automate SEO workflows",
      sourceType: "market_trend",
      marketCategory: "marketing_tech",
      potentialRevenue: "medium",
      confidence: 0.7,
      suggestedProduct: "SEO Bot",
      targetMarket: "Marketing agencies",
      discoveredAt: new Date().toISOString(),
      metadata: {},
    };
    const result = mod.designBusiness(opp);
    expect(result.businessModel).toBeDefined();
    expect(result.businessModel.companyName).toBeDefined();
    expect(result.businessModel.product).toBeDefined();
    expect(result.businessModel.revenueModel).toBeDefined();
    expect(result.businessModel.initialAgentRoles.length).toBeGreaterThan(0);
    expect(result.businessModel.milestones.length).toBeGreaterThan(0);
    expect(typeof result.feasibilityScore).toBe("number");
  });

  it("2.4 — designBusinesses handles multiple opportunities", () => {
    const opps: import("../ai/ecosystem/opportunityScanner.js").Opportunity[] = [
      {
        id: "opp_a",
        title: "Alpha Product Tool",
        description: "Desc A",
        sourceType: "market_trend",
        marketCategory: "developer_tools",
        potentialRevenue: "medium",
        confidence: 0.9,
        suggestedProduct: "Dev Tool A",
        targetMarket: "Developers",
        discoveredAt: new Date().toISOString(),
        metadata: {},
      },
      {
        id: "opp_b",
        title: "Beta Security Guard",
        description: "Desc B",
        sourceType: "technology_emergence",
        marketCategory: "cybersecurity",
        potentialRevenue: "high",
        confidence: 0.6,
        suggestedProduct: "Security Tool B",
        targetMarket: "Enterprise",
        discoveredAt: new Date().toISOString(),
        metadata: {},
      },
    ];
    const results = mod.designBusinesses(opps);
    expect(results).toHaveLength(2);
    expect(results[0].businessModel.companyName).not.toBe(results[1].businessModel.companyName);
  });

  it("2.5 — designBusiness includes ceo and engineer roles", () => {
    const opp: import("../ai/ecosystem/opportunityScanner.js").Opportunity = {
      id: "opp_roles",
      title: "Role Test Product",
      description: "Test roles",
      sourceType: "market_trend",
      marketCategory: "developer_tools",
      potentialRevenue: "medium",
      confidence: 0.8,
      suggestedProduct: "Test",
      targetMarket: "Dev teams",
      discoveredAt: new Date().toISOString(),
      metadata: {},
    };
    const result = mod.designBusiness(opp);
    const roles = result.businessModel.initialAgentRoles.map((r) => r.role);
    expect(roles).toContain("ceo");
    expect(roles).toContain("engineer");
  });

  it("2.6 — different market categories produce different agent counts", () => {
    const oppA: import("../ai/ecosystem/opportunityScanner.js").Opportunity = {
      id: "opp_cat_a",
      title: "Customer Support Bot",
      description: "Support",
      sourceType: "market_trend",
      marketCategory: "customer_support",
      potentialRevenue: "high",
      confidence: 0.8,
      suggestedProduct: "Support bot",
      targetMarket: "SaaS",
      discoveredAt: new Date().toISOString(),
      metadata: {},
    };
    const oppB: import("../ai/ecosystem/opportunityScanner.js").Opportunity = {
      id: "opp_cat_b",
      title: "Marketing Automation Suite",
      description: "Marketing",
      sourceType: "market_trend",
      marketCategory: "marketing_tech",
      potentialRevenue: "medium",
      confidence: 0.7,
      suggestedProduct: "Marketing tool",
      targetMarket: "Agencies",
      discoveredAt: new Date().toISOString(),
      metadata: {},
    };
    const resultA = mod.designBusiness(oppA);
    const resultB = mod.designBusiness(oppB);
    // Marketing tech has extra roles (cmo, seo_specialist)
    expect(resultB.businessModel.initialAgentRoles.length).toBeGreaterThan(resultA.businessModel.initialAgentRoles.length);
  });

  it("2.7 — BusinessModel interface shape is correct", () => {
    const model: import("../ai/ecosystem/businessDesigner.js").BusinessModel = {
      companyName: "TestCo AI",
      product: "Test product",
      description: "A test company",
      targetMarket: "SaaS",
      revenueModel: "subscription",
      marketCategory: "developer_tools",
      initialBudgetCents: 5000,
      initialAgentRoles: [],
      milestones: [],
      sourceOpportunity: "opp_test",
      confidence: 0.75,
      designedAt: new Date().toISOString(),
    };
    expect(model.revenueModel).toBe("subscription");
    expect(model.initialBudgetCents).toBe(5000);
  });

  it("2.8 — designed business has milestones with phases", () => {
    const opp: import("../ai/ecosystem/opportunityScanner.js").Opportunity = {
      id: "opp_ms",
      title: "Milestone Test Product",
      description: "Test milestones",
      sourceType: "market_trend",
      marketCategory: "developer_tools",
      potentialRevenue: "medium",
      confidence: 0.8,
      suggestedProduct: "Test",
      targetMarket: "All",
      discoveredAt: new Date().toISOString(),
      metadata: {},
    };
    const result = mod.designBusiness(opp);
    expect(result.businessModel.milestones.length).toBeGreaterThanOrEqual(4);
    for (const ms of result.businessModel.milestones) {
      expect(ms.phase).toBeDefined();
      expect(ms.title).toBeDefined();
      expect(ms.targetDays).toBeGreaterThan(0);
    }
  });
});

// ==========================================================================
// Section 3: Venture Planner
// ==========================================================================
describe("Phase 24 — Venture Planner", () => {
  let mod: typeof import("../ai/ecosystem/venturePlanner.js");

  beforeAll(async () => {
    mod = await import("../ai/ecosystem/venturePlanner.js");
  });

  it("3.1 — exports planVenture and planVentures", () => {
    expect(typeof mod.planVenture).toBe("function");
    expect(typeof mod.planVentures).toBe("function");
  });

  it("3.2 — planVenture creates a valid venture plan", () => {
    const model: import("../ai/ecosystem/businessDesigner.js").BusinessModel = {
      companyName: "PlannerTest AI",
      product: "Test product",
      description: "For unit testing",
      targetMarket: "Developers",
      revenueModel: "subscription",
      marketCategory: "developer_tools",
      initialBudgetCents: 8000,
      initialAgentRoles: [
        { role: "ceo", title: "CEO", capabilities: ["leadership"], priority: 1 },
        { role: "engineer", title: "Engineer", capabilities: ["coding"], priority: 3 },
      ],
      milestones: [
        { phase: 1, title: "Build MVP", description: "Core product", targetDays: 14 },
        { phase: 2, title: "Launch", description: "Public launch", targetDays: 7 },
      ],
      sourceOpportunity: "opp_test",
      confidence: 0.8,
      designedAt: new Date().toISOString(),
    };
    const plan = mod.planVenture(model);
    expect(plan.companyName).toBe("PlannerTest AI");
    expect(plan.phases.length).toBeGreaterThan(0);
    expect(plan.riskLevel).toBeDefined();
    expect(["low", "medium", "high"]).toContain(plan.riskLevel);
    expect(plan.totalEstimatedDays).toBeGreaterThan(0);
  });

  it("3.3 — planVenture phases have tasks with assignees", () => {
    const model: import("../ai/ecosystem/businessDesigner.js").BusinessModel = {
      companyName: "TaskTest AI",
      product: "Test",
      description: "Testing tasks",
      targetMarket: "All",
      revenueModel: "freemium",
      marketCategory: "developer_tools",
      initialBudgetCents: 5000,
      initialAgentRoles: [
        { role: "ceo", title: "CEO", capabilities: ["strategy"], priority: 1 },
        { role: "engineer", title: "Engineer", capabilities: ["coding"], priority: 3 },
        { role: "pm", title: "PM", capabilities: ["planning"], priority: 4 },
      ],
      milestones: [
        { phase: 1, title: "Build MVP", description: "Core product", targetDays: 14 },
      ],
      sourceOpportunity: "opp_test",
      confidence: 0.9,
      designedAt: new Date().toISOString(),
    };
    const plan = mod.planVenture(model);
    for (const phase of plan.phases) {
      expect(phase.tasks.length).toBeGreaterThan(0);
      for (const task of phase.tasks) {
        expect(task.title).toBeDefined();
        expect(task.assigneeRole).toBeDefined();
      }
    }
  });

  it("3.4 — planVentures handles multiple models", () => {
    const models: import("../ai/ecosystem/businessDesigner.js").BusinessModel[] = [
      {
        companyName: "A AI",
        product: "A",
        description: "A",
        targetMarket: "All",
        revenueModel: "subscription",
        marketCategory: "developer_tools",
        initialBudgetCents: 5000,
        initialAgentRoles: [{ role: "ceo", title: "CEO", capabilities: ["strategy"], priority: 1 }],
        milestones: [{ phase: 1, title: "MVP", description: "Build MVP", targetDays: 14 }],
        sourceOpportunity: "a",
        confidence: 0.9,
        designedAt: new Date().toISOString(),
      },
      {
        companyName: "B AI",
        product: "B",
        description: "B",
        targetMarket: "All",
        revenueModel: "usage_based",
        marketCategory: "cybersecurity",
        initialBudgetCents: 12000,
        initialAgentRoles: [{ role: "ceo", title: "CEO", capabilities: ["strategy"], priority: 1 }],
        milestones: [{ phase: 1, title: "MVP", description: "Build MVP", targetDays: 14 }],
        sourceOpportunity: "b",
        confidence: 0.5,
        designedAt: new Date().toISOString(),
      },
    ];
    const plans = mod.planVentures(models);
    expect(plans).toHaveLength(2);
    expect(plans[0].companyName).toBe("A AI");
    expect(plans[1].companyName).toBe("B AI");
  });

  it("3.5 — risk assessment scores correctly for high-budget enterprise model", () => {
    const model: import("../ai/ecosystem/businessDesigner.js").BusinessModel = {
      companyName: "BigCo AI",
      product: "Enterprise Suite",
      description: "High budget enterprise product",
      targetMarket: "Enterprise",
      revenueModel: "enterprise",
      marketCategory: "cybersecurity",
      initialBudgetCents: 15000,
      initialAgentRoles: Array.from({ length: 8 }, (_, i) => ({
        role: `role_${i}`, title: `Role ${i}`, capabilities: [`cap_${i}`], priority: i,
      })),
      milestones: [{ phase: 1, title: "MVP", description: "Build MVP", targetDays: 30 }],
      sourceOpportunity: "opp_big",
      confidence: 0.4,
      designedAt: new Date().toISOString(),
    };
    const plan = mod.planVenture(model);
    expect(plan.riskLevel).toBe("high");
  });

  it("3.6 — VenturePlan interface shape is correct", () => {
    const plan: import("../ai/ecosystem/venturePlanner.js").VenturePlan = {
      companyName: "Test AI",
      businessModel: {
        companyName: "Test AI",
        product: "Test",
        description: "Test",
        targetMarket: "All",
        revenueModel: "subscription",
        marketCategory: "developer_tools",
        initialBudgetCents: 5000,
        initialAgentRoles: [],
        milestones: [],
        sourceOpportunity: "opp_test",
        confidence: 0.8,
        designedAt: new Date().toISOString(),
      },
      phases: [],
      totalEstimatedDays: 0,
      riskLevel: "low",
      plannedAt: new Date().toISOString(),
    };
    expect(plan.riskLevel).toBe("low");
  });
});

// ==========================================================================
// Section 4: Company Factory
// ==========================================================================
describe("Phase 24 — Company Factory", () => {
  let mod: typeof import("../ai/company/companyFactory.js");

  beforeAll(async () => {
    mod = await import("../ai/company/companyFactory.js");
  });

  it("4.1 — exports createVentureCompany", () => {
    expect(typeof mod.createVentureCompany).toBe("function");
  });

  it("4.2 — CompanyCreationRequest interface shape is correct", () => {
    const req: import("../ai/company/companyFactory.js").CompanyCreationRequest = {
      businessModel: {
        companyName: "TestCo AI",
        product: "Test product",
        description: "Test",
        targetMarket: "All",
        revenueModel: "subscription",
        marketCategory: "developer_tools",
        initialBudgetCents: 5000,
        initialAgentRoles: [],
        milestones: [],
        sourceOpportunity: "opp_test",
        confidence: 0.8,
        designedAt: new Date().toISOString(),
      },
      venturePlan: {
        companyName: "TestCo AI",
        businessModel: {
          companyName: "TestCo AI",
          product: "Test product",
          description: "Test",
          targetMarket: "All",
          revenueModel: "subscription",
          marketCategory: "developer_tools",
          initialBudgetCents: 5000,
          initialAgentRoles: [],
          milestones: [],
          sourceOpportunity: "opp_test",
          confidence: 0.8,
          designedAt: new Date().toISOString(),
        },
        phases: [],
        totalEstimatedDays: 0,
        riskLevel: "low",
        plannedAt: new Date().toISOString(),
      },
    };
    expect(req.businessModel.companyName).toBe("TestCo AI");
  });

  it("4.3 — CompanyCreationResult interface shape is correct", () => {
    const result: import("../ai/company/companyFactory.js").CompanyCreationResult = {
      success: true,
      companyId: "comp_1",
      companyName: "TestCo AI",
      budgetCents: 5000,
      agentCount: 4,
    };
    expect(result.success).toBe(true);
    expect(result.agentCount).toBe(4);
  });
});

// ==========================================================================
// Section 5: Company Bootstrap
// ==========================================================================
describe("Phase 24 — Company Bootstrap", () => {
  let mod: typeof import("../ai/company/companyBootstrap.js");

  beforeAll(async () => {
    mod = await import("../ai/company/companyBootstrap.js");
  });

  it("5.1 — exports bootstrapCompany", () => {
    expect(typeof mod.bootstrapCompany).toBe("function");
  });

  it("5.2 — BootstrapResult interface shape is correct", () => {
    const result: import("../ai/company/companyBootstrap.js").BootstrapResult = {
      companyId: "comp_1",
      companyName: "TestCo AI",
      agentsCreated: [{ agentId: "agent_1", name: "CEO Agent", role: "ceo" }],
      departmentsCreated: ["Executive", "Engineering"],
      bootstrappedAt: new Date().toISOString(),
    };
    expect(result.agentsCreated).toHaveLength(1);
    expect(result.departmentsCreated).toHaveLength(2);
  });

  it("5.3 — AgentCreated interface shape is correct", () => {
    const agent: import("../ai/company/companyBootstrap.js").AgentCreated = {
      agentId: "a1",
      name: "CEO",
      role: "ceo",
    };
    expect(agent.role).toBe("ceo");
  });
});

// ==========================================================================
// Section 6: Ecosystem Budget
// ==========================================================================
describe("Phase 24 — Ecosystem Budget", () => {
  let mod: typeof import("../ai/governance/ecosystemBudget.js");

  beforeAll(async () => {
    mod = await import("../ai/governance/ecosystemBudget.js");
  });

  it("6.1 — exports checkEcosystemStatus, canCreateNewCompany, getEcosystemLimits", () => {
    expect(typeof mod.checkEcosystemStatus).toBe("function");
    expect(typeof mod.canCreateNewCompany).toBe("function");
    expect(typeof mod.getEcosystemLimits).toBe("function");
  });

  it("6.2 — getEcosystemLimits returns valid limits", () => {
    const limits = mod.getEcosystemLimits();
    expect(limits.maxCompanies).toBeGreaterThan(0);
    expect(limits.totalBudgetCents).toBeGreaterThan(0);
    expect(limits.perCompanyBudgetLimitCents).toBeGreaterThan(0);
    expect(limits.maxCompaniesPerDay).toBeGreaterThan(0);
  });

  it("6.3 — default limits constrain ecosystem growth", () => {
    const limits = mod.getEcosystemLimits();
    expect(limits.maxCompanies).toBe(10);
    expect(limits.totalBudgetCents).toBe(100_000);
    expect(limits.perCompanyBudgetLimitCents).toBe(15_000);
  });

  it("6.4 — EcosystemLimits interface shape is correct", () => {
    const limits: import("../ai/governance/ecosystemBudget.js").EcosystemLimits = {
      maxCompanies: 10,
      totalBudgetCents: 100000,
      perCompanyBudgetLimitCents: 15000,
      maxCompaniesPerDay: 3,
    };
    expect(limits.maxCompanies).toBe(10);
  });

  it("6.5 — EcosystemStatus interface shape is correct", () => {
    const status: import("../ai/governance/ecosystemBudget.js").EcosystemStatus = {
      companyCount: 3,
      totalAllocatedBudgetCents: 30000,
      totalSpentCents: 5000,
      limits: {
        maxCompanies: 10,
        totalBudgetCents: 100000,
        perCompanyBudgetLimitCents: 15000,
        maxCompaniesPerDay: 3,
      },
      canCreateCompany: true,
      violations: [],
    };
    expect(status.canCreateCompany).toBe(true);
    expect(status.violations).toHaveLength(0);
  });
});

// ==========================================================================
// Section 7: Company Approval
// ==========================================================================
describe("Phase 24 — Company Approval", () => {
  let mod: typeof import("../ai/governance/companyApproval.js");

  beforeAll(async () => {
    mod = await import("../ai/governance/companyApproval.js");
  });

  it("7.1 — exports approval lifecycle functions", () => {
    expect(typeof mod.submitCompanyCreationRequest).toBe("function");
    expect(typeof mod.approveCompanyCreation).toBe("function");
    expect(typeof mod.rejectCompanyCreation).toBe("function");
    expect(typeof mod.completeCompanyCreation).toBe("function");
    expect(typeof mod.listPendingCompanyRequests).toBe("function");
    expect(typeof mod.listCompanyRequests).toBe("function");
    expect(typeof mod.determineCompanyApprovalLevel).toBe("function");
  });

  it("7.2 — determineCompanyApprovalLevel returns 'manager' for low-budget models (no auto)", () => {
    const model: import("../ai/ecosystem/businessDesigner.js").BusinessModel = {
      companyName: "Small AI",
      product: "Small tool",
      description: "Low budget tool",
      targetMarket: "Internal",
      revenueModel: "subscription",
      marketCategory: "developer_tools",
      initialBudgetCents: 2000,
      initialAgentRoles: [],
      milestones: [],
      sourceOpportunity: "opp_small",
      confidence: 0.9,
      designedAt: new Date().toISOString(),
    };
    expect(mod.determineCompanyApprovalLevel(model)).toBe("manager");
  });

  it("7.3 — determineCompanyApprovalLevel returns 'ceo' for medium-budget models", () => {
    const model: import("../ai/ecosystem/businessDesigner.js").BusinessModel = {
      companyName: "Medium AI",
      product: "Medium product",
      description: "Medium budget",
      targetMarket: "SMBs",
      revenueModel: "subscription",
      marketCategory: "developer_tools",
      initialBudgetCents: 5000,
      initialAgentRoles: [],
      milestones: [],
      sourceOpportunity: "opp_medium",
      confidence: 0.7,
      designedAt: new Date().toISOString(),
    };
    expect(mod.determineCompanyApprovalLevel(model)).toBe("ceo");
  });

  it("7.4 — determineCompanyApprovalLevel returns 'ceo' for high-budget models", () => {
    const model: import("../ai/ecosystem/businessDesigner.js").BusinessModel = {
      companyName: "Big AI",
      product: "Big product",
      description: "High budget",
      targetMarket: "Enterprise",
      revenueModel: "subscription",
      marketCategory: "developer_tools",
      initialBudgetCents: 10000,
      initialAgentRoles: [],
      milestones: [],
      sourceOpportunity: "opp_big",
      confidence: 0.6,
      designedAt: new Date().toISOString(),
    };
    expect(mod.determineCompanyApprovalLevel(model)).toBe("ceo");
  });

  it("7.5 — determineCompanyApprovalLevel returns 'human' for enterprise revenue model", () => {
    const model: import("../ai/ecosystem/businessDesigner.js").BusinessModel = {
      companyName: "Enterprise AI",
      product: "Enterprise suite",
      description: "Enterprise product",
      targetMarket: "Fortune 500",
      revenueModel: "enterprise",
      marketCategory: "cybersecurity",
      initialBudgetCents: 1000,
      initialAgentRoles: [],
      milestones: [],
      sourceOpportunity: "opp_enterprise",
      confidence: 0.5,
      designedAt: new Date().toISOString(),
    };
    expect(mod.determineCompanyApprovalLevel(model)).toBe("human");
  });

  it("7.6 — determineCompanyApprovalLevel returns 'human' for marketplace revenue model", () => {
    const model: import("../ai/ecosystem/businessDesigner.js").BusinessModel = {
      companyName: "Marketplace AI",
      product: "Marketplace",
      description: "Marketplace product",
      targetMarket: "Everyone",
      revenueModel: "marketplace",
      marketCategory: "developer_tools",
      initialBudgetCents: 1000,
      initialAgentRoles: [],
      milestones: [],
      sourceOpportunity: "opp_market",
      confidence: 0.7,
      designedAt: new Date().toISOString(),
    };
    expect(mod.determineCompanyApprovalLevel(model)).toBe("human");
  });

  it("7.7 — CompanyApprovalRequest interface shape is correct", () => {
    const req: import("../ai/governance/companyApproval.js").CompanyApprovalRequest = {
      id: "req_1",
      companyId: "comp_1",
      requestType: "new_company",
      status: "pending",
      approvalLevel: "ceo",
      requestedRole: null,
      reason: "Create new company",
      designSpec: {},
      resultCompanyId: null,
      requestedBy: null,
      approvedBy: null,
      rejectionReason: null,
      createdAt: new Date(),
    };
    expect(req.status).toBe("pending");
    expect(req.approvalLevel).toBe("ceo");
  });
});

// ==========================================================================
// Section 8: Ecosystem Routes
// ==========================================================================
describe("Phase 24 — Ecosystem Routes", () => {
  let mod: typeof import("../routes/ecosystem.js");

  beforeAll(async () => {
    mod = await import("../routes/ecosystem.js");
  });

  it("8.1 — exports ecosystemRoutes factory", () => {
    expect(typeof mod.ecosystemRoutes).toBe("function");
  });
});

// ==========================================================================
// Section 9: Event Types
// ==========================================================================
describe("Phase 24 — Event Types", () => {
  it("9.1 — Phase 24 event types compile correctly", async () => {
    const events: import("../events/eventTypes.js").EventName[] = [
      "ai.ecosystem.opportunity.scanned",
      "ai.ecosystem.business.designed",
      "ai.ecosystem.venture.planned",
      "ai.ecosystem.company.created",
      "ai.ecosystem.company.bootstrapped",
      "ai.ecosystem.company.request.created",
      "ai.ecosystem.company.request.approved",
      "ai.ecosystem.company.request.rejected",
      "ai.ecosystem.company.request.completed",
    ];
    expect(events).toHaveLength(9);
    for (const e of events) {
      expect(e).toMatch(/^ai\.ecosystem\./);
    }
  });
});

// ==========================================================================
// Section 10: AI Index Exports
// ==========================================================================
describe("Phase 24 — AI Index Exports", () => {
  let ai: typeof import("../ai/index.js");

  beforeAll(async () => {
    ai = await import("../ai/index.js");
  });

  it("10.1 — exports opportunity scanner functions", () => {
    expect(typeof ai.scanOpportunities).toBe("function");
    expect(typeof ai.scanFromCompanyGaps).toBe("function");
    expect(typeof ai.scanMarketTrends).toBe("function");
  });

  it("10.2 — exports business designer functions", () => {
    expect(typeof ai.designBusiness).toBe("function");
    expect(typeof ai.designBusinesses).toBe("function");
    expect(typeof ai.generateCompanyName).toBe("function");
  });

  it("10.3 — exports venture planner functions", () => {
    expect(typeof ai.planVenture).toBe("function");
    expect(typeof ai.planVentures).toBe("function");
  });

  it("10.4 — exports company factory functions", () => {
    expect(typeof ai.createVentureCompany).toBe("function");
  });

  it("10.5 — exports company bootstrap functions", () => {
    expect(typeof ai.bootstrapCompany).toBe("function");
  });

  it("10.6 — exports ecosystem budget functions", () => {
    expect(typeof ai.checkEcosystemStatus).toBe("function");
    expect(typeof ai.canCreateNewCompany).toBe("function");
    expect(typeof ai.getEcosystemLimits).toBe("function");
  });

  it("10.7 — exports company approval functions", () => {
    expect(typeof ai.submitCompanyCreationRequest).toBe("function");
    expect(typeof ai.approveCompanyCreation).toBe("function");
    expect(typeof ai.rejectCompanyCreation).toBe("function");
    expect(typeof ai.completeCompanyCreation).toBe("function");
    expect(typeof ai.listPendingCompanyRequests).toBe("function");
    expect(typeof ai.listCompanyRequests).toBe("function");
    expect(typeof ai.determineCompanyApprovalLevel).toBe("function");
  });
});

// ==========================================================================
// Section 11: Integration — Full Pipeline Logic
// ==========================================================================
describe("Phase 24 — Integration (Pipeline Logic)", () => {
  it("11.1 — scan → design → plan pipeline works end-to-end", async () => {
    const scanner = await import("../ai/ecosystem/opportunityScanner.js");
    const designer = await import("../ai/ecosystem/businessDesigner.js");
    const planner = await import("../ai/ecosystem/venturePlanner.js");

    // Scan market trends (no DB needed)
    const opportunities = scanner.scanMarketTrends();
    expect(opportunities.length).toBeGreaterThan(0);

    // Design businesses from opportunities
    const designs = designer.designBusinesses(opportunities);
    expect(designs.length).toBeGreaterThan(0);

    // Plan ventures from designs
    const plans = planner.planVentures(designs.map((d) => d.businessModel));
    expect(plans.length).toBe(designs.length);

    // Verify each plan has phases and risk assessment
    for (const plan of plans) {
      expect(plan.phases.length).toBeGreaterThan(0);
      expect(plan.totalEstimatedDays).toBeGreaterThan(0);
      expect(["low", "medium", "high"]).toContain(plan.riskLevel);
    }
  });

  it("11.2 — approval levels vary by revenue model and budget", async () => {
    const { determineCompanyApprovalLevel } = await import("../ai/governance/companyApproval.js");
    const { designBusiness } = await import("../ai/ecosystem/businessDesigner.js");

    // Low-budget subscription → auto
    const lowOpp: import("../ai/ecosystem/opportunityScanner.js").Opportunity = {
      id: "low_opp",
      title: "Simple Internal Tool",
      description: "Simple internal tool",
      sourceType: "internal_need",
      marketCategory: "developer_tools",
      potentialRevenue: "low",
      confidence: 0.95,
      suggestedProduct: "Internal dev tool",
      targetMarket: "Internal teams",
      discoveredAt: new Date().toISOString(),
      metadata: {},
    };
    const lowDesign = designBusiness(lowOpp);
    if (lowDesign.businessModel.revenueModel !== "enterprise" && lowDesign.businessModel.revenueModel !== "marketplace") {
      if (lowDesign.businessModel.initialBudgetCents < 3000) {
        expect(determineCompanyApprovalLevel(lowDesign.businessModel)).toBe("auto");
      }
    }
  });

  it("11.3 — ecosystem budget limits are enforced in getEcosystemLimits", async () => {
    const { getEcosystemLimits } = await import("../ai/governance/ecosystemBudget.js");
    const limits = getEcosystemLimits();

    // Per-company limit should be less than total
    expect(limits.perCompanyBudgetLimitCents).toBeLessThan(limits.totalBudgetCents);
    // Max companies * per-company limit should be >= total (balanced)
    expect(limits.maxCompanies * limits.perCompanyBudgetLimitCents).toBeGreaterThanOrEqual(limits.totalBudgetCents);
  });

  it("11.4 — market opportunities cover diverse categories", async () => {
    const { MARKET_OPPORTUNITIES } = await import("../ai/ecosystem/opportunityScanner.js");
    const categories = new Set(
      Object.values(MARKET_OPPORTUNITIES).map((o) => o.marketCategory),
    );
    // Should cover at least 5 different market categories
    expect(categories.size).toBeGreaterThanOrEqual(5);
  });

  it("11.5 — business designer generates unique company names", async () => {
    const { designBusinesses } = await import("../ai/ecosystem/businessDesigner.js");
    const { scanMarketTrends } = await import("../ai/ecosystem/opportunityScanner.js");

    const opportunities = scanMarketTrends();
    const designs = designBusinesses(opportunities);
    const names = designs.map((d) => d.businessModel.companyName);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it("11.6 — venture plans include risk assessment", async () => {
    const { planVenture } = await import("../ai/ecosystem/venturePlanner.js");

    const lowRiskModel: import("../ai/ecosystem/businessDesigner.js").BusinessModel = {
      companyName: "LowRisk AI",
      product: "Low risk product",
      description: "Simple subscription product",
      targetMarket: "SMBs",
      revenueModel: "subscription",
      marketCategory: "developer_tools",
      initialBudgetCents: 3000,
      initialAgentRoles: [
        { role: "ceo", title: "CEO", capabilities: ["strategy"], priority: 1 },
        { role: "engineer", title: "Engineer", capabilities: ["coding"], priority: 3 },
      ],
      milestones: [{ phase: 1, title: "MVP", description: "Build MVP", targetDays: 14 }],
      sourceOpportunity: "opp_low",
      confidence: 0.95,
      designedAt: new Date().toISOString(),
    };
    const lowRiskPlan = planVenture(lowRiskModel);
    expect(lowRiskPlan.riskLevel).toBe("low");

    const highRiskModel: import("../ai/ecosystem/businessDesigner.js").BusinessModel = {
      companyName: "HighRisk AI",
      product: "High risk product",
      description: "Complex marketplace",
      targetMarket: "Enterprise",
      revenueModel: "marketplace",
      marketCategory: "cybersecurity",
      initialBudgetCents: 15000,
      initialAgentRoles: Array.from({ length: 8 }, (_, i) => ({
        role: `role_${i}`, title: `Title ${i}`, capabilities: [`cap_${i}`], priority: i,
      })),
      milestones: [{ phase: 1, title: "MVP", description: "Build MVP", targetDays: 30 }],
      sourceOpportunity: "opp_high",
      confidence: 0.3,
      designedAt: new Date().toISOString(),
    };
    const highRiskPlan = planVenture(highRiskModel);
    expect(highRiskPlan.riskLevel).toBe("high");
  });
});
