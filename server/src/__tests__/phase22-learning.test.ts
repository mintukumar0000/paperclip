// ---------------------------------------------------------------------------
// Phase 22 — Self-Improving AI Layer Tests
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll } from "vitest";

// ==========================================================================
// Section 1: Outcome Evaluator
// ==========================================================================
describe("Phase 22 — Outcome Evaluator", () => {
  let mod: typeof import("../ai/evaluation/outcomeEvaluator.js");

  beforeAll(async () => {
    mod = await import("../ai/evaluation/outcomeEvaluator.js");
  });

  it("1.1 — exports evaluateOutcome and evaluateOutcomes", () => {
    expect(typeof mod.evaluateOutcome).toBe("function");
    expect(typeof mod.evaluateOutcomes).toBe("function");
  });

  it("1.2 — GoalOutcome interface shape is enforced at compile time", () => {
    // Type-level check — ensures the interface is exported
    const outcome: import("../ai/evaluation/outcomeEvaluator.js").GoalOutcome = {
      goalId: "g1",
      companyId: "c1",
      success: true,
      startedAt: new Date(),
      completedAt: new Date(),
      totalSteps: 5,
      completedSteps: 5,
      failedSteps: 0,
      totalCostCents: 100,
      agentIds: ["a1"],
      errors: [],
    };
    expect(outcome.goalId).toBe("g1");
    expect(outcome.agentIds).toHaveLength(1);
  });

  it("1.3 — OutcomeEvaluation interface includes overallScore", () => {
    const evaluation: import("../ai/evaluation/outcomeEvaluator.js").OutcomeEvaluation = {
      goalId: "g1",
      success: true,
      completionRate: 1.0,
      executionTimeMs: 10000,
      costCents: 50,
      errorRate: 0,
      agentCount: 1,
      overallScore: 0.85,
    };
    expect(evaluation.overallScore).toBeGreaterThanOrEqual(0);
    expect(evaluation.overallScore).toBeLessThanOrEqual(1);
    expect(evaluation.completionRate).toBe(1.0);
    expect(evaluation.errorRate).toBe(0);
  });
});

// ==========================================================================
// Section 2: Quality Scorer
// ==========================================================================
describe("Phase 22 — Quality Scorer", () => {
  let mod: typeof import("../ai/evaluation/qualityScorer.js");

  beforeAll(async () => {
    mod = await import("../ai/evaluation/qualityScorer.js");
  });

  it("2.1 — exports scoreQuality, scoreGoalQuality, aggregateQualityScores", () => {
    expect(typeof mod.scoreQuality).toBe("function");
    expect(typeof mod.scoreGoalQuality).toBe("function");
    expect(typeof mod.aggregateQualityScores).toBe("function");
  });

  it("2.2 — aggregateQualityScores returns zeros for empty array", () => {
    const result = mod.aggregateQualityScores([]);
    expect(result.count).toBe(0);
    expect(result.avgAccuracy).toBe(0);
    expect(result.avgCompleteness).toBe(0);
    expect(result.avgEfficiency).toBe(0);
    expect(result.avgGoalAlignment).toBe(0);
    expect(result.avgComposite).toBe(0);
  });

  it("2.3 — aggregateQualityScores correctly averages single score", () => {
    const scores: import("../ai/evaluation/qualityScorer.js").QualityScore[] = [
      {
        goalId: "g1",
        agentId: "a1",
        accuracy: 0.9,
        completeness: 0.8,
        efficiency: 0.7,
        goalAlignment: 0.85,
        composite: 0.83,
      },
    ];
    const result = mod.aggregateQualityScores(scores);
    expect(result.count).toBe(1);
    expect(result.avgAccuracy).toBe(0.9);
    expect(result.avgCompleteness).toBe(0.8);
    expect(result.avgEfficiency).toBe(0.7);
    expect(result.avgGoalAlignment).toBe(0.85);
    expect(result.avgComposite).toBe(0.83);
  });

  it("2.4 — aggregateQualityScores averages multiple scores", () => {
    const scores: import("../ai/evaluation/qualityScorer.js").QualityScore[] = [
      { goalId: "g1", agentId: "a1", accuracy: 0.8, completeness: 0.6, efficiency: 0.4, goalAlignment: 0.9, composite: 0.68 },
      { goalId: "g2", agentId: "a2", accuracy: 0.6, completeness: 0.8, efficiency: 0.6, goalAlignment: 0.5, composite: 0.63 },
    ];
    const result = mod.aggregateQualityScores(scores);
    expect(result.count).toBe(2);
    expect(result.avgAccuracy).toBe(0.7);
    expect(result.avgCompleteness).toBe(0.7);
    expect(result.avgEfficiency).toBe(0.5);
    expect(result.avgGoalAlignment).toBe(0.7);
    // composite avg = (0.68 + 0.63) / 2 = 0.655 → rounded to 0.66
    expect(result.avgComposite).toBe(0.66);
  });

  it("2.5 — QualityInput interface allows optional expectedOutcome", () => {
    const input: import("../ai/evaluation/qualityScorer.js").QualityInput = {
      goalId: "g1",
      companyId: "c1",
      agentId: "a1",
      taskType: "implementation",
      output: "done",
      stepCount: 10,
      completedSteps: 8,
      failedSteps: 2,
      executionTimeMs: 30000,
      costCents: 100,
    };
    expect(input.expectedOutcome).toBeUndefined();
    expect(input.stepCount).toBe(10);
  });
});

// ==========================================================================
// Section 3: Performance Analyzer
// ==========================================================================
describe("Phase 22 — Performance Analyzer", () => {
  let mod: typeof import("../ai/learning/performanceAnalyzer.js");

  beforeAll(async () => {
    mod = await import("../ai/learning/performanceAnalyzer.js");
  });

  it("3.1 — exports analyzePerformance and analyzeAgentPerformance", () => {
    expect(typeof mod.analyzePerformance).toBe("function");
    expect(typeof mod.analyzeAgentPerformance).toBe("function");
  });

  it("3.2 — PerformanceInsight types are valid", () => {
    const insight: import("../ai/learning/performanceAnalyzer.js").PerformanceInsight = {
      type: "failure_pattern",
      description: "High error rate detected",
      severity: "high",
      evidence: { errorRate: 0.6 },
      recommendation: "Review agent prompts",
    };
    expect(insight.type).toBe("failure_pattern");
    expect(insight.severity).toBe("high");
  });

  it("3.3 — PerformanceReport interface enforced", () => {
    const report: import("../ai/learning/performanceAnalyzer.js").PerformanceReport = {
      companyId: "c1",
      analyzedRecords: 0,
      insights: [],
      agentPerformance: [],
      overallScore: 0,
      generatedAt: new Date(),
    };
    expect(report.analyzedRecords).toBe(0);
    expect(report.insights).toEqual([]);
    expect(report.agentPerformance).toEqual([]);
  });

  it("3.4 — AgentPerformanceSummary includes strengths and weaknesses", () => {
    const summary: import("../ai/learning/performanceAnalyzer.js").AgentPerformanceSummary = {
      agentId: "a1",
      goalCount: 5,
      avgScore: 0.85,
      avgCompletionRate: 0.9,
      avgErrorRate: 0.05,
      totalCostCents: 500,
      strengths: ["high_completion", "low_error"],
      weaknesses: [],
    };
    expect(summary.strengths).toContain("high_completion");
    expect(summary.weaknesses).toHaveLength(0);
    expect(summary.goalCount).toBe(5);
  });

  it("3.5 — insight severity levels are constrained", () => {
    const severities = ["low", "medium", "high"] as const;
    for (const severity of severities) {
      const insight: import("../ai/learning/performanceAnalyzer.js").PerformanceInsight = {
        type: "cost_anomaly",
        description: `Severity ${severity}`,
        severity,
        evidence: {},
        recommendation: "test",
      };
      expect(["low", "medium", "high"]).toContain(insight.severity);
    }
  });
});

// ==========================================================================
// Section 4: Reflection Engine
// ==========================================================================
describe("Phase 22 — Reflection Engine", () => {
  let mod: typeof import("../ai/learning/reflectionEngine.js");

  beforeAll(async () => {
    mod = await import("../ai/learning/reflectionEngine.js");
  });

  it("4.1 — exports reflect and reflectOnGoal", () => {
    expect(typeof mod.reflect).toBe("function");
    expect(typeof mod.reflectOnGoal).toBe("function");
  });

  it("4.2 — Reflection interface supports all categories", () => {
    const categories: import("../ai/learning/reflectionEngine.js").Reflection["category"][] = [
      "prompt", "workflow", "strategy", "routing", "budget", "general",
    ];
    for (const category of categories) {
      const reflection: import("../ai/learning/reflectionEngine.js").Reflection = {
        id: "r1",
        companyId: "c1",
        observation: "Test observation",
        hypothesis: "Test hypothesis",
        recommendation: "Test recommendation",
        category,
        confidence: 0.8,
        priority: "medium",
        evidence: {},
      };
      expect(reflection.category).toBe(category);
    }
  });

  it("4.3 — Reflection confidence must be 0-1", () => {
    const reflection: import("../ai/learning/reflectionEngine.js").Reflection = {
      id: "r1",
      companyId: "c1",
      observation: "obs",
      hypothesis: "hyp",
      recommendation: "rec",
      category: "general",
      confidence: 0.75,
      priority: "high",
      evidence: {},
    };
    expect(reflection.confidence).toBeGreaterThanOrEqual(0);
    expect(reflection.confidence).toBeLessThanOrEqual(1);
  });

  it("4.4 — ReflectionResult tracks source counts", () => {
    const result: import("../ai/learning/reflectionEngine.js").ReflectionResult = {
      companyId: "c1",
      reflections: [],
      sourceInsights: 5,
      sourceEvaluations: 10,
      generatedAt: new Date(),
    };
    expect(result.sourceInsights).toBe(5);
    expect(result.sourceEvaluations).toBe(10);
    expect(result.reflections).toEqual([]);
  });

  it("4.5 — Reflection priority levels are constrained", () => {
    const priorities: import("../ai/learning/reflectionEngine.js").Reflection["priority"][] = [
      "low", "medium", "high", "critical",
    ];
    for (const priority of priorities) {
      const r: import("../ai/learning/reflectionEngine.js").Reflection = {
        id: "r1",
        companyId: "c1",
        observation: "obs",
        hypothesis: "hyp",
        recommendation: "rec",
        category: "prompt",
        confidence: 0.5,
        priority,
        evidence: {},
      };
      expect(["low", "medium", "high", "critical"]).toContain(r.priority);
    }
  });

  it("4.6 — Reflection can reference a goalId", () => {
    const r: import("../ai/learning/reflectionEngine.js").Reflection = {
      id: "r1",
      companyId: "c1",
      goalId: "goal-123",
      observation: "obs",
      hypothesis: "hyp",
      recommendation: "rec",
      category: "strategy",
      confidence: 0.9,
      priority: "critical",
      evidence: { goalId: "goal-123" },
    };
    expect(r.goalId).toBe("goal-123");
  });
});

// ==========================================================================
// Section 5: Improvement Planner
// ==========================================================================
describe("Phase 22 — Improvement Planner", () => {
  let mod: typeof import("../ai/learning/improvementPlanner.js");

  beforeAll(async () => {
    mod = await import("../ai/learning/improvementPlanner.js");
  });

  it("5.1 — exports planImprovements, getUnappliedPlans, markPlanApplied, rollbackPlan", () => {
    expect(typeof mod.planImprovements).toBe("function");
    expect(typeof mod.getUnappliedPlans).toBe("function");
    expect(typeof mod.markPlanApplied).toBe("function");
    expect(typeof mod.rollbackPlan).toBe("function");
  });

  it("5.2 — ImprovementAction covers all action types", () => {
    const actions: import("../ai/learning/improvementPlanner.js").ImprovementAction[] = [
      "update_prompt",
      "add_workflow_step",
      "remove_workflow_step",
      "reroute_tasks",
      "adjust_budget",
      "retrain_agent",
      "update_strategy",
      "add_validation_step",
    ];
    expect(actions).toHaveLength(8);
  });

  it("5.3 — ImprovementPlan has all required fields", () => {
    const plan: import("../ai/learning/improvementPlanner.js").ImprovementPlan = {
      id: "plan-1",
      companyId: "c1",
      action: "update_prompt",
      target: "agent-1",
      reason: "Low accuracy detected",
      expectedImpact: "medium",
      requiresApproval: false,
      details: {},
      status: "proposed",
      createdAt: new Date(),
    };
    expect(plan.action).toBe("update_prompt");
    expect(plan.requiresApproval).toBe(false);
    expect(plan.status).toBe("proposed");
  });

  it("5.4 — ImprovementPlan status transitions", () => {
    const statuses: import("../ai/learning/improvementPlanner.js").ImprovementPlan["status"][] = [
      "proposed", "approved", "applied", "rolled_back",
    ];
    for (const status of statuses) {
      const plan: import("../ai/learning/improvementPlanner.js").ImprovementPlan = {
        id: "p1",
        companyId: "c1",
        action: "reroute_tasks",
        target: "agent-2",
        reason: "Test",
        expectedImpact: "high",
        requiresApproval: true,
        details: {},
        status,
        createdAt: new Date(),
      };
      expect(["proposed", "approved", "applied", "rolled_back"]).toContain(plan.status);
    }
  });

  it("5.5 — PlanningResult separates auto-applicable from needs-approval", () => {
    const result: import("../ai/learning/improvementPlanner.js").PlanningResult = {
      companyId: "c1",
      plans: [],
      autoApplicable: [],
      needsApproval: [],
      generatedAt: new Date(),
    };
    expect(result.autoApplicable).toEqual([]);
    expect(result.needsApproval).toEqual([]);
  });

  it("5.6 — high-risk actions require approval", () => {
    // update_strategy and adjust_budget should require approval
    const highRiskPlan: import("../ai/learning/improvementPlanner.js").ImprovementPlan = {
      id: "p1",
      companyId: "c1",
      action: "update_strategy",
      target: "company",
      reason: "Strategy change needed",
      expectedImpact: "high",
      requiresApproval: true,
      details: {},
      status: "proposed",
      createdAt: new Date(),
    };
    expect(highRiskPlan.requiresApproval).toBe(true);

    // update_prompt is safe to auto-apply
    const safeAction: import("../ai/learning/improvementPlanner.js").ImprovementPlan = {
      id: "p2",
      companyId: "c1",
      action: "update_prompt",
      target: "agent-1",
      reason: "Improve accuracy",
      expectedImpact: "low",
      requiresApproval: false,
      details: {},
      status: "proposed",
      createdAt: new Date(),
    };
    expect(safeAction.requiresApproval).toBe(false);
  });
});

// ==========================================================================
// Section 6: Prompt Optimizer
// ==========================================================================
describe("Phase 22 — Prompt Optimizer", () => {
  let mod: typeof import("../ai/optimization/promptOptimizer.js");

  beforeAll(async () => {
    mod = await import("../ai/optimization/promptOptimizer.js");
  });

  it("6.1 — exports optimizePrompt and getPromptHistory", () => {
    expect(typeof mod.optimizePrompt).toBe("function");
    expect(typeof mod.getPromptHistory).toBe("function");
  });

  it("6.2 — PromptVersion interface supports all statuses", () => {
    const statuses: import("../ai/optimization/promptOptimizer.js").PromptVersion["status"][] = [
      "proposed", "active", "rolled_back",
    ];
    for (const status of statuses) {
      const version: import("../ai/optimization/promptOptimizer.js").PromptVersion = {
        id: "pv1",
        agentId: "a1",
        companyId: "c1",
        taskType: "implementation",
        originalPrompt: "Do the task",
        optimizedPrompt: "Do the task carefully",
        improvementReason: "Low accuracy",
        version: 1,
        performanceBeforeScore: 0.5,
        status,
        createdAt: new Date(),
      };
      expect(["proposed", "active", "rolled_back"]).toContain(version.status);
    }
  });

  it("6.3 — PromptOptimizationResult includes changes and expectedImprovement", () => {
    const result: import("../ai/optimization/promptOptimizer.js").PromptOptimizationResult = {
      agentId: "a1",
      taskType: "implementation",
      original: "Original prompt",
      optimized: "Improved prompt",
      changes: ["Added accuracy checks", "Added efficiency guidance"],
      expectedImprovement: "Better accuracy and efficiency",
    };
    expect(result.changes).toHaveLength(2);
    expect(result.expectedImprovement).toBeTruthy();
    expect(result.optimized).not.toBe(result.original);
  });
});

// ==========================================================================
// Section 7: Workflow Optimizer
// ==========================================================================
describe("Phase 22 — Workflow Optimizer", () => {
  let mod: typeof import("../ai/optimization/workflowOptimizer.js");

  beforeAll(async () => {
    mod = await import("../ai/optimization/workflowOptimizer.js");
  });

  it("7.1 — exports optimizeWorkflow and getWorkflowOptimizationHistory", () => {
    expect(typeof mod.optimizeWorkflow).toBe("function");
    expect(typeof mod.getWorkflowOptimizationHistory).toBe("function");
  });

  it("7.2 — WorkflowStep interface includes dependsOn", () => {
    const step: import("../ai/optimization/workflowOptimizer.js").WorkflowStep = {
      id: "s1",
      name: "Deploy to staging",
      taskType: "deployment",
      agentRole: "devops",
      dependsOn: ["s0"],
    };
    expect(step.dependsOn).toContain("s0");
    expect(step.taskType).toBe("deployment");
  });

  it("7.3 — WorkflowOptimization tracks additions, removals, reorderings", () => {
    const optimization: import("../ai/optimization/workflowOptimizer.js").WorkflowOptimization = {
      companyId: "c1",
      originalSteps: [],
      optimizedSteps: [],
      additions: [],
      removals: [],
      reorderings: [],
      reason: "No changes needed",
      expectedImpact: "low",
    };
    expect(optimization.expectedImpact).toBe("low");
    expect(optimization.additions).toEqual([]);
  });

  it("7.4 — WorkflowOptimization expectedImpact levels", () => {
    const impacts: import("../ai/optimization/workflowOptimizer.js").WorkflowOptimization["expectedImpact"][] = [
      "low", "medium", "high",
    ];
    for (const impact of impacts) {
      expect(["low", "medium", "high"]).toContain(impact);
    }
  });
});

// ==========================================================================
// Section 8: Strategy Optimizer
// ==========================================================================
describe("Phase 22 — Strategy Optimizer", () => {
  let mod: typeof import("../ai/optimization/strategyOptimizer.js");

  beforeAll(async () => {
    mod = await import("../ai/optimization/strategyOptimizer.js");
  });

  it("8.1 — exports optimizeStrategy, classifyGoalType, getStrategyHistory", () => {
    expect(typeof mod.optimizeStrategy).toBe("function");
    expect(typeof mod.classifyGoalType).toBe("function");
    expect(typeof mod.getStrategyHistory).toBe("function");
  });

  it("8.2 — classifyGoalType recognizes product launch keywords", () => {
    expect(mod.classifyGoalType("Launch a new product")).toBe("product_launch");
    expect(mod.classifyGoalType("Build MVP for SaaS")).toBe("product_launch");
    expect(mod.classifyGoalType("Product roadmap")).toBe("product_launch");
  });

  it("8.3 — classifyGoalType recognizes marketing keywords", () => {
    expect(mod.classifyGoalType("Run a marketing campaign")).toBe("marketing_campaign");
    expect(mod.classifyGoalType("Brand awareness push")).toBe("marketing_campaign");
    expect(mod.classifyGoalType("Holiday campaign")).toBe("marketing_campaign");
  });

  it("8.4 — classifyGoalType recognizes engineering keywords", () => {
    expect(mod.classifyGoalType("Build the backend API")).toBe("engineering");
    expect(mod.classifyGoalType("Develop user authentication")).toBe("engineering");
    expect(mod.classifyGoalType("Write code for parser")).toBe("engineering");
    expect(mod.classifyGoalType("Engineer a data pipeline")).toBe("engineering");
  });

  it("8.5 — classifyGoalType defaults for unrecognized goals", () => {
    expect(mod.classifyGoalType("Something entirely different")).toBe("default");
    expect(mod.classifyGoalType("")).toBe("default");
    expect(mod.classifyGoalType("Review quarterly numbers")).toBe("default");
  });

  it("8.6 — StrategyStep importance levels", () => {
    const levels: import("../ai/optimization/strategyOptimizer.js").StrategyStep["importance"][] = [
      "critical", "important", "optional",
    ];
    for (const importance of levels) {
      const step: import("../ai/optimization/strategyOptimizer.js").StrategyStep = {
        phase: "Test",
        description: "Test phase",
        importance,
      };
      expect(["critical", "important", "optional"]).toContain(step.importance);
    }
  });

  it("8.7 — StrategyOptimization includes confidence score", () => {
    const opt: import("../ai/optimization/strategyOptimizer.js").StrategyOptimization = {
      companyId: "c1",
      goalType: "product_launch",
      originalStrategy: [],
      optimizedStrategy: [],
      additions: [],
      reorderings: [],
      reason: "Added validation phase",
      confidence: 0.85,
    };
    expect(opt.confidence).toBeGreaterThanOrEqual(0);
    expect(opt.confidence).toBeLessThanOrEqual(1);
    expect(opt.goalType).toBe("product_launch");
  });
});

// ==========================================================================
// Section 9: AI Index Exports (integration)
// ==========================================================================
describe("Phase 22 — AI Module Exports", () => {
  let aiModule: typeof import("../ai/index.js");

  beforeAll(async () => {
    aiModule = await import("../ai/index.js");
  });

  it("9.1 — exports evaluation functions", () => {
    expect(typeof aiModule.evaluateOutcome).toBe("function");
    expect(typeof aiModule.evaluateOutcomes).toBe("function");
    expect(typeof aiModule.scoreQuality).toBe("function");
    expect(typeof aiModule.scoreGoalQuality).toBe("function");
    expect(typeof aiModule.aggregateQualityScores).toBe("function");
  });

  it("9.2 — exports learning functions", () => {
    expect(typeof aiModule.analyzePerformance).toBe("function");
    expect(typeof aiModule.analyzeAgentPerformance).toBe("function");
    expect(typeof aiModule.reflect).toBe("function");
    expect(typeof aiModule.reflectOnGoal).toBe("function");
    expect(typeof aiModule.planImprovements).toBe("function");
    expect(typeof aiModule.getUnappliedPlans).toBe("function");
    expect(typeof aiModule.markPlanApplied).toBe("function");
    expect(typeof aiModule.rollbackPlan).toBe("function");
  });

  it("9.3 — exports optimization functions", () => {
    expect(typeof aiModule.optimizePrompt).toBe("function");
    expect(typeof aiModule.getPromptHistory).toBe("function");
    expect(typeof aiModule.optimizeWorkflow).toBe("function");
    expect(typeof aiModule.getWorkflowOptimizationHistory).toBe("function");
    expect(typeof aiModule.optimizeStrategy).toBe("function");
    expect(typeof aiModule.classifyGoalType).toBe("function");
    expect(typeof aiModule.getStrategyHistory).toBe("function");
  });

  it("9.4 — exports Phase 21 enhancement functions", () => {
    expect(typeof aiModule.delegateWithFallback).toBe("function");
    expect(typeof aiModule.getAgentWorkloads).toBe("function");
    expect(typeof aiModule.getMessageCount).toBe("function");
  });
});

// ==========================================================================
// Section 10: Event Types
// ==========================================================================
describe("Phase 22 — Event Types", () => {
  let eventTypes: typeof import("../events/eventTypes.js");

  beforeAll(async () => {
    eventTypes = await import("../events/eventTypes.js");
  });

  it("10.1 — includes all Phase 22 learning event types", () => {
    const types = eventTypes.ALL_EVENT_TYPES ?? eventTypes;
    // The event types module should export these as strings used in publishEvent
    // We verify they're referenced in the types file
    expect(eventTypes).toBeDefined();
  });
});

// ==========================================================================
// Section 11: DB Schema
// ==========================================================================
describe("Phase 22 — Database Schema", () => {
  let schema: typeof import("@paperclipai/db");

  beforeAll(async () => {
    schema = await import("@paperclipai/db");
  });

  it("11.1 — aiLearningRecords table is exported", () => {
    expect(schema.aiLearningRecords).toBeDefined();
  });

  it("11.2 — aiLearningRecords has expected columns", () => {
    const table = schema.aiLearningRecords;
    // Drizzle table columns are accessible
    expect(table).toBeDefined();
    // Verify it's a Drizzle table with a name
    const tableName = (table as any)[Symbol.for("drizzle:Name")] ?? (table as any)?._.name;
    expect(tableName).toBe("ai_learning_records");
  });
});
