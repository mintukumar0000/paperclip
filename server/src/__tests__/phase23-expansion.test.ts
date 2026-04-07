// ---------------------------------------------------------------------------
// Phase 23 — Autonomous Agent Creation & Organizational Expansion Tests
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll } from "vitest";

// ==========================================================================
// Section 1: Capability Gap Analyzer
// ==========================================================================
describe("Phase 23 — Capability Gap Analyzer", () => {
  let mod: typeof import("../ai/expansion/capabilityGapAnalyzer.js");

  beforeAll(async () => {
    mod = await import("../ai/expansion/capabilityGapAnalyzer.js");
  });

  it("1.1 — exports analyzeCapabilityGaps, canHandleTask, analyzeGoalGaps", () => {
    expect(typeof mod.analyzeCapabilityGaps).toBe("function");
    expect(typeof mod.canHandleTask).toBe("function");
    expect(typeof mod.analyzeGoalGaps).toBe("function");
  });

  it("1.2 — TASK_CAPABILITY_MAP covers standard task types", () => {
    expect(mod.TASK_CAPABILITY_MAP).toBeDefined();
    expect(mod.TASK_CAPABILITY_MAP["implementation"]).toBeDefined();
    expect(mod.TASK_CAPABILITY_MAP["testing"]).toBeDefined();
    expect(mod.TASK_CAPABILITY_MAP["marketing"]).toBeDefined();
    expect(mod.TASK_CAPABILITY_MAP["finance"]).toBeDefined();
  });

  it("1.3 — TASK_CAPABILITY_MAP has capabilities for 20+ task types", () => {
    expect(Object.keys(mod.TASK_CAPABILITY_MAP).length).toBeGreaterThanOrEqual(20);
  });

  it("1.4 — CapabilityGap interface shape is correct", () => {
    const gap: import("../ai/expansion/capabilityGapAnalyzer.js").CapabilityGap = {
      taskType: "localization",
      requiredCapabilities: ["i18n", "translation"],
      missingCapabilities: ["i18n", "translation"],
      availableAgents: 0,
      capableAgents: 0,
      severity: "critical",
      suggestedRole: "localization_specialist",
      description: "No agents can handle localization tasks",
    };
    expect(gap.severity).toBe("critical");
    expect(gap.missingCapabilities).toHaveLength(2);
  });

  it("1.5 — GapAnalysisResult interface shape is correct", () => {
    const result: import("../ai/expansion/capabilityGapAnalyzer.js").GapAnalysisResult = {
      companyId: "c1",
      gaps: [],
      totalCapabilities: 50,
      coveredCapabilities: 40,
      coverageRate: 0.8,
      analyzedAt: new Date().toISOString(),
    };
    expect(result.coverageRate).toBe(0.8);
    expect(result.gaps).toHaveLength(0);
  });
});

// ==========================================================================
// Section 2: Agent Designer
// ==========================================================================
describe("Phase 23 — Agent Designer", () => {
  let mod: typeof import("../ai/expansion/agentDesigner.js");

  beforeAll(async () => {
    mod = await import("../ai/expansion/agentDesigner.js");
  });

  it("2.1 — exports designAgents and designFromGap", () => {
    expect(typeof mod.designAgents).toBe("function");
    expect(typeof mod.designFromGap).toBe("function");
  });

  it("2.2 — ROLE_TEMPLATES has pre-built templates", () => {
    expect(mod.ROLE_TEMPLATES).toBeDefined();
    expect(Object.keys(mod.ROLE_TEMPLATES).length).toBeGreaterThan(0);
  });

  it("2.3 — designFromGap generates a spec from a capability gap", () => {
    const gap: import("../ai/expansion/capabilityGapAnalyzer.js").CapabilityGap = {
      taskType: "localization",
      requiredCapabilities: ["i18n", "translation"],
      missingCapabilities: ["translation"],
      availableAgents: 5,
      capableAgents: 0,
      severity: "high",
      suggestedRole: "localization_specialist",
      description: "No agents for localization",
    };
    const design = mod.designFromGap(gap);
    expect(design.role).toBe("localization_specialist");
    expect(design.capabilities).toContain("translation");
    expect(design.sourceGaps).toContain("localization");
    expect(design.reason).toBeTruthy();
  });

  it("2.4 — AgentDesignSpec interface is valid", () => {
    const spec: import("../ai/expansion/agentDesigner.js").AgentDesignSpec = {
      role: "test_role",
      title: "Test Agent",
      capabilities: ["testing"],
      taskTypes: ["testing"],
      canDelegate: false,
      canApprove: false,
      priority: 7,
      department: "Engineering",
      reportsTo: "cto",
      budgetCents: 500,
      reason: "Testing needed",
      sourceGaps: ["testing"],
    };
    expect(spec.priority).toBe(7);
    expect(spec.department).toBe("Engineering");
  });

  it("2.5 — ROLE_TEMPLATES includes key roles", () => {
    const keys = Object.keys(mod.ROLE_TEMPLATES);
    expect(keys).toContain("localization_specialist");
    expect(keys).toContain("security_engineer");
    expect(keys).toContain("data_analyst");
  });
});

// ==========================================================================
// Section 3: Department Planner
// ==========================================================================
describe("Phase 23 — Department Planner", () => {
  let mod: typeof import("../ai/expansion/departmentPlanner.js");

  beforeAll(async () => {
    mod = await import("../ai/expansion/departmentPlanner.js");
  });

  it("3.1 — exports getCompanyDepartments, planDepartments, createDepartment", () => {
    expect(typeof mod.getCompanyDepartments).toBe("function");
    expect(typeof mod.planDepartments).toBe("function");
    expect(typeof mod.createDepartment).toBe("function");
  });

  it("3.2 — DEFAULT_DEPARTMENTS has standard departments", () => {
    expect(mod.DEFAULT_DEPARTMENTS).toBeDefined();
    const names = Object.keys(mod.DEFAULT_DEPARTMENTS);
    expect(names.length).toBeGreaterThanOrEqual(5);
    expect(names).toContain("Executive");
    expect(names).toContain("Engineering");
    expect(names).toContain("Marketing");
    expect(names).toContain("Finance");
    expect(names).toContain("Product");
  });

  it("3.3 — DEFAULT_DEPARTMENTS entries have all required fields", () => {
    for (const [name, dept] of Object.entries(mod.DEFAULT_DEPARTMENTS)) {
      expect(name).toBeTruthy();
      expect(dept.description).toBeTruthy();
      expect(dept.headRole).toBeTruthy();
      expect(dept.capabilities).toBeDefined();
      expect(dept.capabilities.length).toBeGreaterThan(0);
    }
  });

  it("3.4 — DepartmentPlan interface shape is correct", () => {
    const plan: import("../ai/expansion/departmentPlanner.js").DepartmentPlan = {
      companyId: "c1",
      existingDepartments: [],
      proposedDepartments: [],
      agentAssignments: [],
      plannedAt: new Date().toISOString(),
    };
    expect(plan.existingDepartments).toHaveLength(0);
    expect(plan.companyId).toBe("c1");
  });
});

// ==========================================================================
// Section 4: Role Generator
// ==========================================================================
describe("Phase 23 — Role Generator", () => {
  let mod: typeof import("../ai/creation/roleGenerator.js");

  beforeAll(async () => {
    mod = await import("../ai/creation/roleGenerator.js");
  });

  it("4.1 — exports generateRole, generateRoles, validateRole, toRoleDefinition", () => {
    expect(typeof mod.generateRole).toBe("function");
    expect(typeof mod.generateRoles).toBe("function");
    expect(typeof mod.validateRole).toBe("function");
    expect(typeof mod.toRoleDefinition).toBe("function");
  });

  it("4.2 — generateRole creates a GeneratedRole from AgentDesignSpec", () => {
    const design: import("../ai/expansion/agentDesigner.js").AgentDesignSpec = {
      role: "security_engineer",
      title: "Security Engineer",
      capabilities: ["security_auditing", "penetration_testing"],
      taskTypes: ["security"],
      canDelegate: false,
      canApprove: false,
      priority: 5,
      department: "Engineering",
      reportsTo: "cto",
      budgetCents: 1000,
      reason: "Security gaps detected",
      sourceGaps: ["security"],
    };
    const role = mod.generateRole(design);
    expect(role.role).toBe("security_engineer");
    expect(role.title).toBe("Security Engineer");
    expect(role.capabilities).toContain("security_auditing");
    expect(role.department).toBe("Engineering");
    expect(role.budgetCents).toBe(1000);
    expect(role.generatedFrom).toBe("security");
  });

  it("4.3 — validateRole catches invalid roles", () => {
    const invalid = mod.generateRole({
      role: "", // too short
      title: "",
      capabilities: [],
      taskTypes: [],
      canDelegate: false,
      canApprove: false,
      priority: 15, // out of range
      department: "Test",
      reportsTo: "ceo",
      budgetCents: -100, // negative
      reason: "Test",
      sourceGaps: [],
    });
    const result = mod.validateRole(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("4.4 — validateRole passes for valid roles", () => {
    const valid = mod.generateRole({
      role: "tester",
      title: "QA Tester",
      capabilities: ["testing"],
      taskTypes: ["testing"],
      canDelegate: false,
      canApprove: false,
      priority: 6,
      department: "Engineering",
      reportsTo: "cto",
      budgetCents: 300,
      reason: "Testing needed",
      sourceGaps: ["testing"],
    });
    const result = mod.validateRole(valid);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("4.5 — toRoleDefinition strips expansion-specific fields", () => {
    const generated: import("../ai/creation/roleGenerator.js").GeneratedRole = {
      role: "tester" as any,
      title: "QA Tester",
      capabilities: ["testing"],
      taskTypes: ["testing"],
      canDelegate: false,
      canApprove: false,
      priority: 6,
      department: "Engineering",
      reportsTo: "cto",
      budgetCents: 300,
      generatedFrom: "testing",
    };
    const roleDef = mod.toRoleDefinition(generated);
    expect(roleDef.role).toBe("tester");
    expect(roleDef.title).toBe("QA Tester");
    expect((roleDef as any).department).toBeUndefined();
    expect((roleDef as any).budgetCents).toBeUndefined();
    expect((roleDef as any).generatedFrom).toBeUndefined();
  });

  it("4.6 — generateRoles handles multiple designs", () => {
    const designs: import("../ai/expansion/agentDesigner.js").AgentDesignSpec[] = [
      {
        role: "a",
        title: "Agent A",
        capabilities: ["cap_a"],
        taskTypes: ["type_a"],
        canDelegate: false,
        canApprove: false,
        priority: 5,
        department: "D",
        reportsTo: "ceo",
        budgetCents: 100,
        reason: "R",
        sourceGaps: ["g_a"],
      },
      {
        role: "bb",
        title: "Agent BB",
        capabilities: ["cap_b"],
        taskTypes: ["type_b"],
        canDelegate: true,
        canApprove: false,
        priority: 3,
        department: "D",
        reportsTo: "ceo",
        budgetCents: 200,
        reason: "R",
        sourceGaps: ["g_b"],
      },
    ];
    const roles = mod.generateRoles(designs);
    expect(roles).toHaveLength(2);
    expect(roles[0].role).toBe("a");
    expect(roles[1].role).toBe("bb");
  });
});

// ==========================================================================
// Section 5: Agent Factory
// ==========================================================================
describe("Phase 23 — Agent Factory", () => {
  let mod: typeof import("../ai/creation/agentFactory.js");

  beforeAll(async () => {
    mod = await import("../ai/creation/agentFactory.js");
  });

  it("5.1 — exports createAgent and createAgents", () => {
    expect(typeof mod.createAgent).toBe("function");
    expect(typeof mod.createAgents).toBe("function");
  });

  it("5.2 — AgentCreationRequest interface shape", () => {
    const req: import("../ai/creation/agentFactory.js").AgentCreationRequest = {
      companyId: "c1",
      design: {
        role: "tester",
        title: "Tester",
        capabilities: ["testing"],
        taskTypes: ["testing"],
        canDelegate: false,
        canApprove: false,
        priority: 6,
        department: "Engineering",
        reportsTo: "cto",
        budgetCents: 300,
        reason: "Testing",
        sourceGaps: ["testing"],
      },
      requestedBy: "agent-123",
      expansionRequestId: "req-456",
    };
    expect(req.companyId).toBe("c1");
    expect(req.design.role).toBe("tester");
  });

  it("5.3 — AgentCreationResult interface shape", () => {
    const result: import("../ai/creation/agentFactory.js").AgentCreationResult = {
      success: true,
      agentId: "new-agent-id",
      agentName: "Tester",
      role: "tester",
      department: "Engineering",
      budgetCents: 300,
    };
    expect(result.success).toBe(true);
    expect(result.agentId).toBe("new-agent-id");
  });
});

// ==========================================================================
// Section 6: Expansion Approval
// ==========================================================================
describe("Phase 23 — Expansion Approval", () => {
  let mod: typeof import("../ai/governance/expansionApproval.js");

  beforeAll(async () => {
    mod = await import("../ai/governance/expansionApproval.js");
  });

  it("6.1 — exports approval functions", () => {
    expect(typeof mod.submitExpansionRequest).toBe("function");
    expect(typeof mod.approveExpansion).toBe("function");
    expect(typeof mod.rejectExpansion).toBe("function");
    expect(typeof mod.completeExpansion).toBe("function");
    expect(typeof mod.listPendingRequests).toBe("function");
    expect(typeof mod.listExpansionRequests).toBe("function");
    expect(typeof mod.determineApprovalLevel).toBe("function");
  });

  it("6.2 — determineApprovalLevel returns manager for low-priority low-budget (no auto)", () => {
    const level = mod.determineApprovalLevel({
      role: "content_writer",
      title: "Content Writer",
      capabilities: ["writing"],
      taskTypes: ["content"],
      canDelegate: false,
      canApprove: false,
      priority: 7,
      department: "Marketing",
      reportsTo: "cmo",
      budgetCents: 300,
      reason: "Content gap",
      sourceGaps: ["content"],
    });
    expect(level).toBe("manager");
  });

  it("6.3 — determineApprovalLevel returns ceo for high-budget", () => {
    const level = mod.determineApprovalLevel({
      role: "data_analyst",
      title: "Data Analyst",
      capabilities: ["data_analysis"],
      taskTypes: ["data_analysis"],
      canDelegate: false,
      canApprove: false,
      priority: 5,
      department: "Engineering",
      reportsTo: "cto",
      budgetCents: 1500, // high
      reason: "Data gap",
      sourceGaps: ["data_analysis"],
    });
    expect(level).toBe("ceo");
  });

  it("6.4 — determineApprovalLevel returns ceo for agents that can approve", () => {
    const level = mod.determineApprovalLevel({
      role: "vp_eng",
      title: "VP Engineering",
      capabilities: ["leadership"],
      taskTypes: ["oversight"],
      canDelegate: true,
      canApprove: true, // can approve → CEO required
      priority: 2,
      department: "Engineering",
      reportsTo: "cto",
      budgetCents: 500,
      reason: "Leadership gap",
      sourceGaps: ["oversight"],
    });
    expect(level).toBe("ceo");
  });

  it("6.5 — determineApprovalLevel returns human for top-priority roles", () => {
    const level = mod.determineApprovalLevel({
      role: "chief_scientist",
      title: "Chief Scientist",
      capabilities: ["research"],
      taskTypes: ["strategy"],
      canDelegate: false,
      canApprove: false,
      priority: 2, // high priority
      department: "Executive",
      reportsTo: "ceo",
      budgetCents: 200,
      reason: "Strategy gap",
      sourceGaps: ["strategy"],
    });
    expect(level).toBe("human");
  });

  it("6.6 — determineApprovalLevel returns manager for mid-priority", () => {
    const level = mod.determineApprovalLevel({
      role: "qa_lead",
      title: "QA Lead",
      capabilities: ["testing"],
      taskTypes: ["testing"],
      canDelegate: false,
      canApprove: false,
      priority: 5,
      department: "Engineering",
      reportsTo: "cto",
      budgetCents: 400,
      reason: "QA gap",
      sourceGaps: ["testing"],
    });
    expect(level).toBe("manager");
  });
});

// ==========================================================================
// Section 7: Workforce Limits
// ==========================================================================
describe("Phase 23 — Workforce Limits", () => {
  let mod: typeof import("../ai/governance/workforceLimits.js");

  beforeAll(async () => {
    mod = await import("../ai/governance/workforceLimits.js");
  });

  it("7.1 — exports workforce limit functions", () => {
    expect(typeof mod.checkWorkforceStatus).toBe("function");
    expect(typeof mod.canCreateAgent).toBe("function");
    expect(typeof mod.canCreateDepartment).toBe("function");
    expect(typeof mod.getWorkforceLimits).toBe("function");
  });

  it("7.2 — getWorkforceLimits returns default limits", () => {
    const limits = mod.getWorkforceLimits();
    expect(limits.maxAgentsPerCompany).toBe(20);
    expect(limits.maxDepartments).toBe(8);
    expect(limits.maxMonthlyBudgetCents).toBe(20_000);
    expect(limits.maxAgentsPerDepartment).toBe(8);
    expect(limits.maxExpansionsPerDay).toBe(3);
  });

  it("7.3 — WorkforceLimits interface shape is correct", () => {
    const limits: import("../ai/governance/workforceLimits.js").WorkforceLimits = {
      maxAgentsPerCompany: 10,
      maxDepartments: 5,
      maxMonthlyBudgetCents: 10000,
      maxAgentsPerDepartment: 4,
      maxExpansionsPerDay: 3,
    };
    expect(limits.maxAgentsPerCompany).toBe(10);
  });

  it("7.4 — WorkforceStatus interface shape is correct", () => {
    const status: import("../ai/governance/workforceLimits.js").WorkforceStatus = {
      companyId: "c1",
      agentCount: 5,
      departmentCount: 2,
      totalMonthlyBudgetCents: 5000,
      limits: mod.getWorkforceLimits(),
      canExpand: true,
      violations: [],
    };
    expect(status.canExpand).toBe(true);
    expect(status.violations).toHaveLength(0);
  });
});

// ==========================================================================
// Section 8: Expansion Routes
// ==========================================================================
describe("Phase 23 — Expansion Routes", () => {
  let mod: typeof import("../routes/expansion.js");

  beforeAll(async () => {
    mod = await import("../routes/expansion.js");
  });

  it("8.1 — exports expansionRoutes factory function", () => {
    expect(typeof mod.expansionRoutes).toBe("function");
  });
});

// ==========================================================================
// Section 9: Event Types
// ==========================================================================
describe("Phase 23 — Event Types", () => {
  it("9.1 — Phase 23 event types are valid strings", () => {
    const events: import("../events/eventTypes.js").EventName[] = [
      "ai.expansion.department.created",
      "ai.expansion.request.created",
      "ai.expansion.request.approved",
      "ai.expansion.request.rejected",
      "ai.expansion.request.completed",
      "ai.agent.created",
    ];
    expect(events).toHaveLength(6);
    for (const evt of events) {
      expect(evt).toBeTruthy();
      expect(typeof evt).toBe("string");
    }
  });
});

// ==========================================================================
// Section 10: AI Index Exports
// ==========================================================================
describe("Phase 23 — AI Index Exports", () => {
  let ai: typeof import("../ai/index.js");

  beforeAll(async () => {
    ai = await import("../ai/index.js");
  });

  it("10.1 — re-exports capability gap analyzer", () => {
    expect(typeof ai.analyzeCapabilityGaps).toBe("function");
    expect(typeof ai.canHandleTask).toBe("function");
    expect(typeof ai.analyzeGoalGaps).toBe("function");
  });

  it("10.2 — re-exports agent designer", () => {
    expect(typeof ai.designAgents).toBe("function");
    expect(typeof ai.designFromGap).toBe("function");
  });

  it("10.3 — re-exports department planner", () => {
    expect(typeof ai.getCompanyDepartments).toBe("function");
    expect(typeof ai.planDepartments).toBe("function");
    expect(typeof ai.createDepartment).toBe("function");
  });

  it("10.4 — re-exports role generator", () => {
    expect(typeof ai.generateRole).toBe("function");
    expect(typeof ai.generateRoles).toBe("function");
    expect(typeof ai.validateRole).toBe("function");
    expect(typeof ai.toRoleDefinition).toBe("function");
  });

  it("10.5 — re-exports agent factory", () => {
    expect(typeof ai.createExpansionAgent).toBe("function");
    expect(typeof ai.createExpansionAgents).toBe("function");
  });

  it("10.6 — re-exports expansion approval", () => {
    expect(typeof ai.submitExpansionRequest).toBe("function");
    expect(typeof ai.approveExpansion).toBe("function");
    expect(typeof ai.rejectExpansion).toBe("function");
    expect(typeof ai.completeExpansion).toBe("function");
    expect(typeof ai.listPendingRequests).toBe("function");
    expect(typeof ai.listExpansionRequests).toBe("function");
    expect(typeof ai.determineApprovalLevel).toBe("function");
  });

  it("10.7 — re-exports workforce limits", () => {
    expect(typeof ai.checkWorkforceStatus).toBe("function");
    expect(typeof ai.canCreateExpansionAgent).toBe("function");
    expect(typeof ai.canCreateDepartment).toBe("function");
    expect(typeof ai.getWorkforceLimits).toBe("function");
  });
});

// ==========================================================================
// Section 11: Integration — Full Gap → Design → Role → Validate Pipeline
// ==========================================================================
describe("Phase 23 — Gap-to-Role Pipeline", () => {
  let gapMod: typeof import("../ai/expansion/capabilityGapAnalyzer.js");
  let designMod: typeof import("../ai/expansion/agentDesigner.js");
  let roleMod: typeof import("../ai/creation/roleGenerator.js");

  beforeAll(async () => {
    gapMod = await import("../ai/expansion/capabilityGapAnalyzer.js");
    designMod = await import("../ai/expansion/agentDesigner.js");
    roleMod = await import("../ai/creation/roleGenerator.js");
  });

  it("11.1 — designs a valid role from a capability gap", () => {
    const gap: import("../ai/expansion/capabilityGapAnalyzer.js").CapabilityGap = {
      taskType: "security",
      requiredCapabilities: ["security_auditing", "penetration_testing", "vulnerability_scanning"],
      missingCapabilities: ["penetration_testing", "vulnerability_scanning"],
      availableAgents: 10,
      capableAgents: 0,
      severity: "critical",
      suggestedRole: "security_engineer",
      description: "No security engineers available",
    };

    const design = designMod.designFromGap(gap);
    expect(design.role).toBeTruthy();
    expect(design.capabilities).toContain("penetration_testing");

    const role = roleMod.generateRole(design);
    const validation = roleMod.validateRole(role);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
    expect(role.department).toBeTruthy();
    expect(role.reportsTo).toBeTruthy();
  });

  it("11.2 — template-based design produces valid roles", () => {
    // Use a known template role
    const gap: import("../ai/expansion/capabilityGapAnalyzer.js").CapabilityGap = {
      taskType: "data_analysis",
      requiredCapabilities: ["data_analysis", "statistical_modeling", "data_visualization"],
      missingCapabilities: ["statistical_modeling"],
      availableAgents: 8,
      capableAgents: 0,
      severity: "high",
      suggestedRole: "data_analyst",
      description: "No data analysts",
    };

    const design = designMod.designFromGap(gap);
    const role = roleMod.generateRole(design);
    const validation = roleMod.validateRole(role);
    expect(validation.valid).toBe(true);
  });

  it("11.3 — toRoleDefinition strips metadata from GeneratedRole", () => {
    const gap: import("../ai/expansion/capabilityGapAnalyzer.js").CapabilityGap = {
      taskType: "compliance",
      requiredCapabilities: ["compliance"],
      missingCapabilities: ["compliance"],
      availableAgents: 5,
      capableAgents: 0,
      severity: "high",
      suggestedRole: "compliance_officer",
      description: "No compliance",
    };
    const design = designMod.designFromGap(gap);
    const generated = roleMod.generateRole(design);
    const roleDef = roleMod.toRoleDefinition(generated);

    // Should have core fields
    expect(roleDef.role).toBeTruthy();
    expect(roleDef.title).toBeTruthy();
    expect(roleDef.capabilities.length).toBeGreaterThan(0);
    expect(roleDef.taskTypes.length).toBeGreaterThan(0);

    // Should NOT have expansion-specific fields
    expect((roleDef as any).department).toBeUndefined();
    expect((roleDef as any).budgetCents).toBeUndefined();
    expect((roleDef as any).generatedFrom).toBeUndefined();
  });
});

// ==========================================================================
// Section 12: Integration — Approval Level Determination
// ==========================================================================
describe("Phase 23 — Approval Matrix", () => {
  let mod: typeof import("../ai/governance/expansionApproval.js");

  beforeAll(async () => {
    mod = await import("../ai/governance/expansionApproval.js");
  });

  it("12.1 — manager approval for low-risk, low-budget roles (no auto)", () => {
    expect(
      mod.determineApprovalLevel({
        role: "seo_specialist",
        title: "SEO Specialist",
        capabilities: ["seo"],
        taskTypes: ["seo"],
        canDelegate: false,
        canApprove: false,
        priority: 8,
        department: "Marketing",
        reportsTo: "cmo",
        budgetCents: 200,
        reason: "SEO gap",
        sourceGaps: ["seo"],
      }),
    ).toBe("manager");
  });

  it("12.2 — manager approval for mid-tier roles", () => {
    expect(
      mod.determineApprovalLevel({
        role: "backend_engineer",
        title: "Backend Engineer",
        capabilities: ["backend"],
        taskTypes: ["implementation"],
        canDelegate: false,
        canApprove: false,
        priority: 4,
        department: "Engineering",
        reportsTo: "cto",
        budgetCents: 600,
        reason: "Backend gap",
        sourceGaps: ["implementation"],
      }),
    ).toBe("manager");
  });

  it("12.3 — ceo approval for high-budget expansions", () => {
    expect(
      mod.determineApprovalLevel({
        role: "ml_engineer",
        title: "ML Engineer",
        capabilities: ["machine_learning"],
        taskTypes: ["data_analysis"],
        canDelegate: false,
        canApprove: false,
        priority: 4,
        department: "Engineering",
        reportsTo: "cto",
        budgetCents: 2000,
        reason: "ML gap",
        sourceGaps: ["data_analysis"],
      }),
    ).toBe("ceo");
  });

  it("12.4 — human approval for top-priority strategic roles", () => {
    expect(
      mod.determineApprovalLevel({
        role: "chief_of_staff",
        title: "Chief of Staff",
        capabilities: ["strategy", "oversight"],
        taskTypes: ["strategy"],
        canDelegate: false,
        canApprove: false,
        priority: 1,
        department: "Executive",
        reportsTo: "ceo",
        budgetCents: 100,
        reason: "Strategy gap",
        sourceGaps: ["strategy"],
      }),
    ).toBe("human");
  });
});
