// ---------------------------------------------------------------------------
// Phase 21 — Multi-Agent Collaboration System Tests
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll } from "vitest";

// ==========================================================================
// Section 1: Role Registry
// ==========================================================================
describe("Phase 21 — Role Registry", () => {
  let roleRegistry: typeof import("../ai/agents/roleRegistry.js");

  beforeAll(async () => {
    roleRegistry = await import("../ai/agents/roleRegistry.js");
  });

  it("1.1 — getRoleDefinition returns CEO role", () => {
    const def = roleRegistry.getRoleDefinition("ceo");
    expect(def.role).toBe("ceo");
    expect(def.title).toBe("Chief Executive Officer");
    expect(def.canDelegate).toBe(true);
    expect(def.canApprove).toBe(true);
    expect(def.priority).toBe(1);
  });

  it("1.2 — getRoleDefinition returns engineer role", () => {
    const def = roleRegistry.getRoleDefinition("engineer");
    expect(def.role).toBe("engineer");
    expect(def.capabilities).toContain("coding");
    expect(def.taskTypes).toContain("implementation");
    expect(def.canDelegate).toBe(false);
  });

  it("1.3 — getAllRoles returns all role definitions", () => {
    const roles = roleRegistry.getAllRoles();
    expect(roles.length).toBeGreaterThanOrEqual(11);
    const roleNames = roles.map((r) => r.role);
    expect(roleNames).toContain("ceo");
    expect(roleNames).toContain("engineer");
    expect(roleNames).toContain("general");
  });

  it("1.4 — canRoleHandleTask matches engineer->implementation", () => {
    expect(roleRegistry.canRoleHandleTask("engineer", "implementation")).toBe(true);
    expect(roleRegistry.canRoleHandleTask("engineer", "marketing")).toBe(false);
  });

  it("1.5 — findBestRoleForTask returns correct role", () => {
    expect(roleRegistry.findBestRoleForTask("implementation")).toBe("engineer");
    expect(roleRegistry.findBestRoleForTask("marketing")).toBe("cmo");
    expect(roleRegistry.findBestRoleForTask("unknown_type")).toBe("general");
  });

  it("1.6 — roleHasCapability checks capabilities", () => {
    expect(roleRegistry.roleHasCapability("ceo", "strategic_planning")).toBe(true);
    expect(roleRegistry.roleHasCapability("engineer", "strategic_planning")).toBe(false);
    expect(roleRegistry.roleHasCapability("engineer", "coding")).toBe(true);
  });

  it("1.7 — unknown role falls back to general", () => {
    const def = roleRegistry.getRoleDefinition("unknown_role");
    expect(def.role).toBe("general");
    expect(def.priority).toBe(10);
  });

  it("1.8 — CTO role has technical capabilities", () => {
    const def = roleRegistry.getRoleDefinition("cto");
    expect(def.capabilities).toContain("technical_architecture");
    expect(def.capabilities).toContain("code_review");
    expect(def.canDelegate).toBe(true);
  });

  it("1.9 — CMO role handles marketing tasks", () => {
    const def = roleRegistry.getRoleDefinition("cmo");
    expect(def.taskTypes).toContain("marketing");
    expect(def.taskTypes).toContain("campaigns");
  });

  it("1.10 — PM role can delegate but not approve", () => {
    const def = roleRegistry.getRoleDefinition("pm");
    expect(def.canDelegate).toBe(true);
    expect(def.canApprove).toBe(false);
    expect(def.priority).toBe(3);
  });

  it("1.11 — QA role has testing capabilities", () => {
    const def = roleRegistry.getRoleDefinition("qa");
    expect(def.taskTypes).toContain("testing");
    expect(def.taskTypes).toContain("qa");
    expect(def.capabilities).toContain("quality_assurance");
  });

  it("1.12 — DevOps role handles deployment", () => {
    const def = roleRegistry.getRoleDefinition("devops");
    expect(def.taskTypes).toContain("deployment");
    expect(def.taskTypes).toContain("infrastructure");
  });
});

// ==========================================================================
// Section 2: Agent Profiles
// ==========================================================================
describe("Phase 21 — Agent Profiles", () => {
  let agentProfiles: typeof import("../ai/agents/agentProfiles.js");

  beforeAll(async () => {
    agentProfiles = await import("../ai/agents/agentProfiles.js");
  });

  it("2.1 — buildAgentProfile creates profile from agent row", () => {
    const mockAgent = {
      id: "agent-1",
      companyId: "company-1",
      name: "Test CEO",
      role: "ceo",
      title: "CEO Agent",
      icon: "brain",
      status: "active",
      reportsTo: null,
      capabilities: "custom_skill,special_analysis",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 10000,
      spentMonthlyCents: 3000,
      permissions: {},
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any;

    const profile = agentProfiles.buildAgentProfile(mockAgent);
    expect(profile.id).toBe("agent-1");
    expect(profile.role).toBe("ceo");
    expect(profile.canDelegate).toBe(true);
    expect(profile.canApprove).toBe(true);
    // Should merge role capabilities with DB capabilities
    expect(profile.capabilities).toContain("strategic_planning");
    expect(profile.capabilities).toContain("custom_skill");
    expect(profile.capabilities).toContain("special_analysis");
  });

  it("2.2 — buildAgentProfile handles null capabilities", () => {
    const mockAgent = {
      id: "agent-2",
      companyId: "company-1",
      name: "Test Engineer",
      role: "engineer",
      title: null,
      icon: null,
      status: "active",
      reportsTo: "agent-1",
      capabilities: null,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 5000,
      spentMonthlyCents: 1000,
      permissions: {},
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any;

    const profile = agentProfiles.buildAgentProfile(mockAgent);
    expect(profile.role).toBe("engineer");
    expect(profile.capabilities).toContain("coding");
    expect(profile.taskTypes).toContain("implementation");
    expect(profile.budgetMonthlyCents).toBe(5000);
  });

  it("2.3 — buildAgentProfile uses role definition", () => {
    const mockAgent = {
      id: "agent-3",
      companyId: "company-1",
      name: "Test QA",
      role: "qa",
      title: null,
      icon: null,
      status: "active",
      reportsTo: null,
      capabilities: "",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any;

    const profile = agentProfiles.buildAgentProfile(mockAgent);
    expect(profile.roleDefinition.role).toBe("qa");
    expect(profile.taskTypes).toContain("testing");
  });
});

// ==========================================================================
// Section 3: Agent Router
// ==========================================================================
describe("Phase 21 — Agent Router", () => {
  // Test the scoring logic indirectly via type matching
  it("3.1 — module exports are available", async () => {
    const mod = await import("../ai/coordination/agentRouter.js");
    expect(typeof mod.routeTask).toBe("function");
    expect(typeof mod.routeToAll).toBe("function");
    expect(typeof mod.getHierarchy).toBe("function");
  });
});

// ==========================================================================
// Section 4: Dependency Resolver
// ==========================================================================
describe("Phase 21 — Dependency Resolver", () => {
  let depResolver: typeof import("../ai/collaboration/dependencyResolver.js");
  let taskGraphMod: typeof import("../ai/planning/taskGraph.js");

  beforeAll(async () => {
    depResolver = await import("../ai/collaboration/dependencyResolver.js");
    taskGraphMod = await import("../ai/planning/taskGraph.js");
  });

  it("4.1 — validates valid linear graph", () => {
    let graph = taskGraphMod.createTaskGraph("test");
    graph = taskGraphMod.addStep(graph, {
      id: "step-1", name: "First", description: "Do first",
      dependsOn: [], maxRetries: 2,
    });
    graph = taskGraphMod.addStep(graph, {
      id: "step-2", name: "Second", description: "Do second",
      dependsOn: ["step-1"], maxRetries: 2,
    });

    const issues = depResolver.validateDependencies(graph);
    expect(issues).toHaveLength(0);
  });

  it("4.2 — detects self-dependency", () => {
    let graph = taskGraphMod.createTaskGraph("test");
    graph = taskGraphMod.addStep(graph, {
      id: "step-1", name: "Self", description: "Depends on itself",
      dependsOn: ["step-1"], maxRetries: 2,
    });

    const issues = depResolver.validateDependencies(graph);
    expect(issues.some((i) => i.type === "self_dep")).toBe(true);
  });

  it("4.3 — detects missing dependency", () => {
    let graph = taskGraphMod.createTaskGraph("test");
    graph = taskGraphMod.addStep(graph, {
      id: "step-1", name: "Missing dep", description: "Has missing dep",
      dependsOn: ["nonexistent"], maxRetries: 2,
    });

    const issues = depResolver.validateDependencies(graph);
    expect(issues.some((i) => i.type === "missing_dep")).toBe(true);
  });

  it("4.4 — topological sort of linear chain", () => {
    let graph = taskGraphMod.createTaskGraph("test");
    graph = taskGraphMod.addStep(graph, {
      id: "a", name: "A", description: "First", dependsOn: [], maxRetries: 1,
    });
    graph = taskGraphMod.addStep(graph, {
      id: "b", name: "B", description: "Second", dependsOn: ["a"], maxRetries: 1,
    });
    graph = taskGraphMod.addStep(graph, {
      id: "c", name: "C", description: "Third", dependsOn: ["b"], maxRetries: 1,
    });

    const sorted = depResolver.topologicalSort(graph);
    expect(sorted).not.toBeNull();
    expect(sorted!.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("4.5 — topological sort of parallel branches", () => {
    let graph = taskGraphMod.createTaskGraph("test");
    graph = taskGraphMod.addStep(graph, {
      id: "root", name: "Root", description: "Start", dependsOn: [], maxRetries: 1,
    });
    graph = taskGraphMod.addStep(graph, {
      id: "left", name: "Left", description: "Left branch", dependsOn: ["root"], maxRetries: 1,
    });
    graph = taskGraphMod.addStep(graph, {
      id: "right", name: "Right", description: "Right branch", dependsOn: ["root"], maxRetries: 1,
    });
    graph = taskGraphMod.addStep(graph, {
      id: "join", name: "Join", description: "Merge", dependsOn: ["left", "right"], maxRetries: 1,
    });

    const sorted = depResolver.topologicalSort(graph);
    expect(sorted).not.toBeNull();
    // root must come first, join must come last
    expect(sorted![0].id).toBe("root");
    expect(sorted![3].id).toBe("join");
  });

  it("4.6 — getMaxParallelism for diamond graph", () => {
    let graph = taskGraphMod.createTaskGraph("test");
    graph = taskGraphMod.addStep(graph, {
      id: "root", name: "Root", description: "Start", dependsOn: [], maxRetries: 1,
    });
    graph = taskGraphMod.addStep(graph, {
      id: "a", name: "A", description: "Branch A", dependsOn: ["root"], maxRetries: 1,
    });
    graph = taskGraphMod.addStep(graph, {
      id: "b", name: "B", description: "Branch B", dependsOn: ["root"], maxRetries: 1,
    });
    graph = taskGraphMod.addStep(graph, {
      id: "c", name: "C", description: "Branch C", dependsOn: ["root"], maxRetries: 1,
    });
    graph = taskGraphMod.addStep(graph, {
      id: "end", name: "End", description: "Merge", dependsOn: ["a", "b", "c"], maxRetries: 1,
    });

    expect(depResolver.getMaxParallelism(graph)).toBe(3);
  });

  it("4.7 — getExecutionLevels groups correctly", () => {
    let graph = taskGraphMod.createTaskGraph("test");
    graph = taskGraphMod.addStep(graph, {
      id: "a", name: "A", description: "Level 0", dependsOn: [], maxRetries: 1,
    });
    graph = taskGraphMod.addStep(graph, {
      id: "b", name: "B", description: "Level 0", dependsOn: [], maxRetries: 1,
    });
    graph = taskGraphMod.addStep(graph, {
      id: "c", name: "C", description: "Level 1", dependsOn: ["a"], maxRetries: 1,
    });
    graph = taskGraphMod.addStep(graph, {
      id: "d", name: "D", description: "Level 1", dependsOn: ["b"], maxRetries: 1,
    });

    const levels = depResolver.getExecutionLevels(graph);
    expect(levels).toHaveLength(2);
    expect(levels[0].map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(levels[1].map((s) => s.id).sort()).toEqual(["c", "d"]);
  });

  it("4.8 — empty graph has no issues", () => {
    const graph = taskGraphMod.createTaskGraph("empty");
    const issues = depResolver.validateDependencies(graph);
    expect(issues).toHaveLength(0);
  });
});

// ==========================================================================
// Section 5: Collaboration Planner — Goal Classification
// ==========================================================================
describe("Phase 21 — Collaboration Planner (Goal Classification)", () => {
  let collab: typeof import("../ai/collaboration/collaborationPlanner.js");

  beforeAll(async () => {
    collab = await import("../ai/collaboration/collaborationPlanner.js");
  });

  it("5.1 — classifies engineering goal", () => {
    const types = collab.classifyGoalTasks("Build a new API endpoint for user management");
    expect(types).toContain("engineering");
  });

  it("5.2 — classifies marketing goal", () => {
    const types = collab.classifyGoalTasks("Create a marketing campaign for product launch");
    expect(types).toContain("marketing");
  });

  it("5.3 — classifies design goal", () => {
    const types = collab.classifyGoalTasks("Design a new UI wireframe for the dashboard");
    expect(types).toContain("design");
  });

  it("5.4 — classifies multi-type goal", () => {
    const types = collab.classifyGoalTasks("Build and deploy the feature with tests");
    expect(types).toContain("engineering");
    expect(types).toContain("deployment");
    expect(types).toContain("testing");
  });

  it("5.5 — classifies unknown goal as general", () => {
    const types = collab.classifyGoalTasks("Do something completely unrelated");
    expect(types).toContain("general");
  });

  it("5.6 — classifies research goal", () => {
    const types = collab.classifyGoalTasks("Research and analyze the competitive landscape");
    expect(types).toContain("research");
  });

  it("5.7 — classifies financial goal", () => {
    const types = collab.classifyGoalTasks("Prepare the monthly budget and cost analysis");
    expect(types).toContain("finance");
  });

  it("5.8 — classification is case-insensitive", () => {
    const types = collab.classifyGoalTasks("DEPLOY the SERVICE to PRODUCTION");
    expect(types).toContain("deployment");
  });
});

// ==========================================================================
// Section 6: Approval Gate
// ==========================================================================
describe("Phase 21 — Approval Gate", () => {
  let gate: typeof import("../ai/governance/approvalGate.js");

  beforeAll(async () => {
    gate = await import("../ai/governance/approvalGate.js");
  });

  it("6.1 — getApprovalLevel returns 'forbidden' for forbidden actions", () => {
    expect(gate.getApprovalLevel("delete_company")).toBe("forbidden");
    expect(gate.getApprovalLevel("drop_database")).toBe("forbidden");
  });

  it("6.2 — getApprovalLevel returns 'ceo' for CEO-level actions", () => {
    expect(gate.getApprovalLevel("hire_agent")).toBe("ceo");
    expect(gate.getApprovalLevel("change_company_strategy")).toBe("ceo");
  });

  it("6.3 — getApprovalLevel returns 'manager' for manager actions", () => {
    expect(gate.getApprovalLevel("deploy_to_production")).toBe("manager");
    expect(gate.getApprovalLevel("mass_email")).toBe("manager");
    expect(gate.getApprovalLevel("delete_issue")).toBe("manager");
  });

  it("6.4 — getApprovalLevel returns 'none' for regular actions", () => {
    expect(gate.getApprovalLevel("create_issue")).toBe("none");
    expect(gate.getApprovalLevel("update_issue")).toBe("none");
    expect(gate.getApprovalLevel("send_message")).toBe("none");
  });

  it("6.5 — listPendingApprovals returns empty initially", () => {
    const pending = gate.listPendingApprovals("test-company-id");
    expect(pending).toHaveLength(0);
  });

  it("6.6 — getApproval returns undefined for non-existent", () => {
    expect(gate.getApproval("non-existent-id")).toBeUndefined();
  });
});

// ==========================================================================
// Section 7: Agent Budget
// ==========================================================================
describe("Phase 21 — Agent Budget (types)", () => {
  it("7.1 — budget module exports functions", async () => {
    const mod = await import("../ai/governance/agentBudget.js");
    expect(typeof mod.checkBudget).toBe("function");
    expect(typeof mod.recordSpending).toBe("function");
    expect(typeof mod.getCompanyBudgetSummary).toBe("function");
    expect(typeof mod.canAfford).toBe("function");
  });
});

// ==========================================================================
// Section 8: Task Delegator
// ==========================================================================
describe("Phase 21 — Task Delegator (types)", () => {
  it("8.1 — delegator module exports functions", async () => {
    const mod = await import("../ai/coordination/taskDelegator.js");
    expect(typeof mod.delegateTask).toBe("function");
    expect(typeof mod.canDelegateTaskType).toBe("function");
  });
});

// ==========================================================================
// Section 9: Agent Messenger
// ==========================================================================
describe("Phase 21 — Agent Messenger (types)", () => {
  it("9.1 — messenger module exports functions", async () => {
    const mod = await import("../ai/coordination/agentMessenger.js");
    expect(typeof mod.sendAgentMessage).toBe("function");
    expect(typeof mod.getUnreadMessages).toBe("function");
    expect(typeof mod.broadcastToCompany).toBe("function");
    expect(typeof mod.markMessageActedOn).toBe("function");
    expect(typeof mod.getConversation).toBe("function");
  });
});

// ==========================================================================
// Section 10: Event Types
// ==========================================================================
describe("Phase 21 — Event Types", () => {
  it("10.1 — collaboration event types exist", async () => {
    const mod = await import("../events/eventTypes.js");
    // Verify the type exports compile — we check that the module loads
    expect(mod).toBeDefined();
  });
});

// ==========================================================================
// Section 11: AI Index Exports
// ==========================================================================
describe("Phase 21 — AI Index Exports", () => {
  let ai: typeof import("../ai/index.js");

  beforeAll(async () => {
    ai = await import("../ai/index.js");
  });

  it("11.1 — role registry exports", () => {
    expect(typeof ai.getRoleDefinition).toBe("function");
    expect(typeof ai.getAllRoles).toBe("function");
    expect(typeof ai.canRoleHandleTask).toBe("function");
    expect(typeof ai.findBestRoleForTask).toBe("function");
    expect(typeof ai.roleHasCapability).toBe("function");
  });

  it("11.2 — agent profiles exports", () => {
    expect(typeof ai.buildAgentProfile).toBe("function");
    expect(typeof ai.loadCompanyProfiles).toBe("function");
    expect(typeof ai.findAgentsForTaskType).toBe("function");
    expect(typeof ai.findDelegator).toBe("function");
    expect(typeof ai.loadAgentProfile).toBe("function");
  });

  it("11.3 — coordination exports", () => {
    expect(typeof ai.delegateTask).toBe("function");
    expect(typeof ai.canDelegateTaskType).toBe("function");
    expect(typeof ai.sendAgentMessage).toBe("function");
    expect(typeof ai.getUnreadMessages).toBe("function");
    expect(typeof ai.broadcastToCompany).toBe("function");
    expect(typeof ai.markMessageActedOn).toBe("function");
    expect(typeof ai.getConversation).toBe("function");
    expect(typeof ai.routeTask).toBe("function");
    expect(typeof ai.routeToAll).toBe("function");
    expect(typeof ai.getHierarchy).toBe("function");
  });

  it("11.4 — collaboration exports", () => {
    expect(typeof ai.buildCollaborationPlan).toBe("function");
    expect(typeof ai.autoCollaborationPlan).toBe("function");
    expect(typeof ai.classifyGoalTasks).toBe("function");
    expect(typeof ai.validateDependencies).toBe("function");
    expect(typeof ai.topologicalSort).toBe("function");
    expect(typeof ai.getMaxParallelism).toBe("function");
    expect(typeof ai.getExecutionLevels).toBe("function");
  });

  it("11.5 — governance exports", () => {
    expect(typeof ai.checkBudget).toBe("function");
    expect(typeof ai.recordSpending).toBe("function");
    expect(typeof ai.getCompanyBudgetSummary).toBe("function");
    expect(typeof ai.canAfford).toBe("function");
    expect(typeof ai.checkApproval).toBe("function");
    expect(typeof ai.approveAction).toBe("function");
    expect(typeof ai.rejectAction).toBe("function");
    expect(typeof ai.listPendingApprovals).toBe("function");
    expect(typeof ai.getApproval).toBe("function");
    expect(typeof ai.getApprovalLevel).toBe("function");
  });
});

// ==========================================================================
// Section 12: Integration Architecture
// ==========================================================================
describe("Phase 21 — Integration Architecture", () => {
  it("12.1 — collaboration routes module exports function", async () => {
    const mod = await import("../routes/collaboration.js");
    expect(typeof mod.collaborationRoutes).toBe("function");
  });

  it("12.2 — routes index re-exports collaboration routes", async () => {
    const mod = await import("../routes/index.js");
    expect(typeof mod.collaborationRoutes).toBe("function");
  }, 15000);
});
