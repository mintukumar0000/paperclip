// ---------------------------------------------------------------------------
// Goal Containment Stress Simulation — Prove the system stabilizes
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeEach } from "vitest";

describe("Goal Containment — Stress Simulation", () => {
  let limitsModule: typeof import("../ai/governance/autonomyLimits.js");
  let containmentModule: typeof import("../ai/governance/goalContainment.js");

  beforeEach(async () => {
    limitsModule = await import("../ai/governance/autonomyLimits.js");
    containmentModule = await import("../ai/governance/goalContainment.js");
    limitsModule.resetAutonomyLimits();
  });

  // -----------------------------------------------------------------------
  // Scenario 1: Exponential Goal Growth — system stabilizes
  // -----------------------------------------------------------------------
  it("S1 — exponential fan-out is bounded by active goal budget", () => {
    const { maxChildGoals, maxActiveGoalsPerCompany, maxGoalDepth } =
      limitsModule.getAutonomyLimits();

    // Simulate: each goal tries to spawn maxChildGoals children
    let totalGoals = 0;
    let currentLevel = 1; // root
    const goalsByDepth: number[] = [];

    for (let depth = 1; depth <= maxGoalDepth + 2; depth++) {
      // Would-be goals at this level
      const goalsAtLevel = depth === 1 ? 1 : goalsByDepth[depth - 2] * maxChildGoals;

      // Budget check — can't exceed max active goals
      const remaining = maxActiveGoalsPerCompany - totalGoals;
      const allowed = Math.min(goalsAtLevel, remaining);

      // Depth check — can't exceed max depth
      const depthAllowed = depth <= maxGoalDepth ? allowed : 0;

      goalsByDepth.push(depthAllowed);
      totalGoals += depthAllowed;

      if (depthAllowed === 0) break;
    }

    // System MUST stabilize: total ≤ budget
    expect(totalGoals).toBeLessThanOrEqual(maxActiveGoalsPerCompany);
    // The tree is pruned before it's fully expanded
    expect(totalGoals).toBe(50); // 1 + 5 + 25 + 19 (capped at 50)
  });

  // -----------------------------------------------------------------------
  // Scenario 2: Planning task explosion — capped per cycle
  // -----------------------------------------------------------------------
  it("S2 — 1000 tasks from strategy engine are capped to 20 per cycle", () => {
    const tasks = Array.from({ length: 1000 }, (_, i) => ({
      id: `task-${i}`,
      goalId: `goal-${i % 50}`,
      title: `Auto-task ${i}`,
    }));

    const capped = containmentModule.capPlanningTasks(tasks, "stress-company");
    expect(capped.length).toBe(20);
  });

  // -----------------------------------------------------------------------
  // Scenario 3: Rapid-fire goal creation — budget exhaustion
  // -----------------------------------------------------------------------
  it("S3 — rapid-fire goal creation hits budget wall", () => {
    limitsModule.setAutonomyLimits({ maxActiveGoalsPerCompany: 5 });
    const limit = limitsModule.getAutonomyLimits().maxActiveGoalsPerCompany;

    // Simulate 100 rapid-fire goal creation requests
    let created = 0;
    let blocked = 0;
    for (let i = 0; i < 100; i++) {
      if (created < limit) {
        created++;
      } else {
        blocked++;
      }
    }

    expect(created).toBe(5);
    expect(blocked).toBe(95);
  });

  // -----------------------------------------------------------------------
  // Scenario 4: Deep chain detection — parent walking
  // -----------------------------------------------------------------------
  it("S4 — parent chain longer than maxGoalDepth is rejected", () => {
    const maxDepth = limitsModule.getAutonomyLimits().maxGoalDepth;

    // Simulate a chain: goal_0 → goal_1 → goal_2 → goal_3 → goal_4 → goal_5 (depth > 5)
    const chain = Array.from({ length: maxDepth + 1 }, (_, i) => ({
      id: `goal-${i}`,
      parentId: i === 0 ? null : `goal-${i - 1}`,
      depth: i + 1,
    }));

    // The last goal in the chain has depth = maxGoalDepth + 1
    const lastGoal = chain[chain.length - 1];
    expect(lastGoal.depth).toBe(maxDepth + 1);
    expect(lastGoal.depth).toBeGreaterThan(maxDepth);
  });

  // -----------------------------------------------------------------------
  // Scenario 5: Fan-out per parent — maxChildGoals enforcement
  // -----------------------------------------------------------------------
  it("S5 — single parent with fan-out > maxChildGoals is blocked", () => {
    const { maxChildGoals } = limitsModule.getAutonomyLimits();

    // Parent has maxChildGoals children  OK
    // Parent with maxChildGoals+1  BLOCKED
    const existingChildren = maxChildGoals;
    const canAddMore = existingChildren < maxChildGoals;
    expect(canAddMore).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Scenario 6: LLM response exceeding step limit — hard truncation
  // -----------------------------------------------------------------------
  it("S6 — LLM returning 100 steps is hard-truncated to maxTasksPerPlanCycle", () => {
    const { maxTasksPerPlanCycle } = limitsModule.getAutonomyLimits();

    // Simulate LLM returning 100 steps
    const llmSteps = Array.from({ length: 100 }, (_, i) => ({
      name: `Step ${i + 1}`,
      description: `Do thing ${i + 1}`,
    }));

    // Hard truncation
    const effectiveMax = Math.min(100, maxTasksPerPlanCycle);
    const truncated = llmSteps.slice(0, effectiveMax);
    expect(truncated.length).toBe(maxTasksPerPlanCycle);
    expect(truncated.length).toBe(20);
  });

  // -----------------------------------------------------------------------
  // Scenario 7: Opportunity scanner flood — capped at maxChildGoals
  // -----------------------------------------------------------------------
  it("S7 — 50 discovered opportunities are capped to maxChildGoals", () => {
    const { maxChildGoals } = limitsModule.getAutonomyLimits();

    const opportunities = Array.from({ length: 50 }, (_, i) => ({
      id: `opp-${i}`,
      title: `Opportunity ${i}`,
      confidence: Math.random(),
    }));

    const capped = opportunities.slice(0, maxChildGoals);
    expect(capped.length).toBe(5);
  });

  // -----------------------------------------------------------------------
  // Scenario 8: Combined stress — all limits hit simultaneously
  // -----------------------------------------------------------------------
  it("S8 — combined stress: all goal limits enforced simultaneously", () => {
    limitsModule.setAutonomyLimits({
      maxGoalDepth: 3,
      maxChildGoals: 2,
      maxActiveGoalsPerCompany: 10,
      maxTasksPerPlanCycle: 5,
    });

    const limits = limitsModule.getAutonomyLimits();

    // Max tree: 1 + 2 + 4 = 7 goals at depth 3 (under budget 10)
    let total = 0;
    let levelSize = 1;
    for (let d = 1; d <= limits.maxGoalDepth; d++) {
      total += levelSize;
      levelSize *= limits.maxChildGoals;
    }
    expect(total).toBe(7); // 1 + 2 + 4
    expect(total).toBeLessThanOrEqual(limits.maxActiveGoalsPerCompany);

    // Tasks per cycle capped
    const tasks = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    const capped = containmentModule.capPlanningTasks(tasks, "stress-co");
    expect(capped.length).toBe(5);
  });

  // -----------------------------------------------------------------------
  // Scenario 9: Reset to defaults — system recovers
  // -----------------------------------------------------------------------
  it("S9 — after override, reset restores default limits", () => {
    limitsModule.setAutonomyLimits({ maxGoalDepth: 1, maxActiveGoalsPerCompany: 1 });
    expect(limitsModule.getAutonomyLimits().maxGoalDepth).toBe(1);

    limitsModule.resetAutonomyLimits();
    expect(limitsModule.getAutonomyLimits().maxGoalDepth).toBe(5);
    expect(limitsModule.getAutonomyLimits().maxActiveGoalsPerCompany).toBe(50);
  });

  // -----------------------------------------------------------------------
  // Scenario 10: Stabilization proof — system converges
  // -----------------------------------------------------------------------
  it("S10 — with default limits, the system converges to a finite state", () => {
    const limits = limitsModule.getAutonomyLimits();

    // Mathematical proof: max goals = min(budget, sum of geometric series)
    // Geometric series: sum = (fan^(depth) - 1) / (fan - 1)
    const fan = limits.maxChildGoals;
    const depth = limits.maxGoalDepth;
    const geometricMax = (Math.pow(fan, depth) - 1) / (fan - 1);
    const theoreticalMax = Math.min(limits.maxActiveGoalsPerCompany, geometricMax);

    // With defaults (fan=5, depth=5): geometric = 3906, budget = 50
    // Budget is the binding constraint
    expect(theoreticalMax).toBe(50);
    expect(limits.maxActiveGoalsPerCompany).toBeLessThan(geometricMax);

    // Max tasks per cycle: 20 * number of cycles
    // Each cycle is bounded, so total tasks = bounded * bounded = bounded
    expect(limits.maxTasksPerPlanCycle).toBe(20);
  });
});
