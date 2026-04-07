// ---------------------------------------------------------------------------
// Simulation Environment — Isolated Ecosystem Clone
// ---------------------------------------------------------------------------
// Creates a self-contained simulation world with in-memory state.
// No writes affect the real database. Each environment simulates:
//   - Companies with budgets
//   - Agents with skills and costs
//   - Goals and tasks
//   - Market conditions
//   - Economic interactions
// ---------------------------------------------------------------------------

import pino from "pino";

const logger = pino({ name: "sim-environment" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimCompany {
  id: string;
  name: string;
  budgetCents: number;
  spentCents: number;
  revenueCents: number;
  agentCount: number;
  goalCount: number;
  taskCount: number;
  completedTasks: number;
  status: "active" | "struggling" | "profitable" | "failed";
}

export interface SimAgent {
  id: string;
  companyId: string;
  role: string;
  costPerDayCents: number;
  efficiency: number;   // 0-1 (output quality)
  utilization: number;  // 0-1 (time spent on tasks)
  tasksCompleted: number;
}

export interface SimGoal {
  id: string;
  companyId: string;
  title: string;
  progress: number; // 0-1
  status: "active" | "completed" | "failed";
}

export interface SimMarket {
  demandLevel: number;     // 0-100
  competitionLevel: number; // 0-100
  growthRate: number;       // -50 to +50
  volatility: number;       // 0-100
}

export interface SimMetrics {
  totalRevenue: number;
  totalCost: number;
  totalProfit: number;
  taskCompletion: number;  // 0-1
  goalSuccessRate: number; // 0-1
  agentEfficiency: number; // 0-1
  customerGrowth: number;  // growth rate
  failureRate: number;     // 0-1
}

/**
 * The complete simulation environment state.
 * This is a pure in-memory structure — no database writes.
 */
export interface SimulationEnvironment {
  id: string;
  day: number;
  companies: Map<string, SimCompany>;
  agents: Map<string, SimAgent>;
  goals: Map<string, SimGoal>;
  market: SimMarket;
  metrics: SimMetrics;
  eventLog: SimEvent[];
}

export interface SimEvent {
  day: number;
  type: string;
  entityId: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Environment Creation
// ---------------------------------------------------------------------------

let envCounter = 0;

/**
 * Create a fresh simulation environment with initial conditions.
 */
export function createSimulationEnvironment(
  seed: SimEnvironmentSeed,
): SimulationEnvironment {
  envCounter++;
  const envId = `sim_env_${Date.now()}_${envCounter}`;

  const companies = new Map<string, SimCompany>();
  const agents = new Map<string, SimAgent>();
  const goals = new Map<string, SimGoal>();

  // Seed companies
  for (const co of seed.companies) {
    companies.set(co.id, {
      id: co.id,
      name: co.name,
      budgetCents: co.budgetCents,
      spentCents: 0,
      revenueCents: 0,
      agentCount: 0,
      goalCount: 0,
      taskCount: co.initialTasks ?? 0,
      completedTasks: 0,
      status: "active",
    });
  }

  // Seed agents
  for (const ag of seed.agents) {
    agents.set(ag.id, {
      id: ag.id,
      companyId: ag.companyId,
      role: ag.role,
      costPerDayCents: ag.costPerDayCents,
      efficiency: ag.efficiency ?? 0.7,
      utilization: 0,
      tasksCompleted: 0,
    });

    const co = companies.get(ag.companyId);
    if (co) co.agentCount++;
  }

  // Seed goals
  for (const g of seed.goals) {
    goals.set(g.id, {
      id: g.id,
      companyId: g.companyId,
      title: g.title,
      progress: 0,
      status: "active",
    });

    const co = companies.get(g.companyId);
    if (co) co.goalCount++;
  }

  return {
    id: envId,
    day: 0,
    companies,
    agents,
    goals,
    market: seed.market ?? {
      demandLevel: 50,
      competitionLevel: 30,
      growthRate: 5,
      volatility: 20,
    },
    metrics: {
      totalRevenue: 0,
      totalCost: 0,
      totalProfit: 0,
      taskCompletion: 0,
      goalSuccessRate: 0,
      agentEfficiency: 0,
      customerGrowth: 0,
      failureRate: 0,
    },
    eventLog: [],
  };
}

/** Seed data for creating a simulation environment */
export interface SimEnvironmentSeed {
  companies: Array<{
    id: string;
    name: string;
    budgetCents: number;
    initialTasks?: number;
  }>;
  agents: Array<{
    id: string;
    companyId: string;
    role: string;
    costPerDayCents: number;
    efficiency?: number;
  }>;
  goals: Array<{
    id: string;
    companyId: string;
    title: string;
  }>;
  market?: SimMarket;
}

// ---------------------------------------------------------------------------
// Day Simulation Steps
// ---------------------------------------------------------------------------

/**
 * Simulate one day in the environment.
 * Processes: agent work, market changes, revenue, costs, goal progress.
 */
export function simulateDay(env: SimulationEnvironment): void {
  env.day++;

  // 1. Agents execute daily work
  for (const [, agent] of env.agents) {
    const co = env.companies.get(agent.companyId);
    if (!co || co.status === "failed") continue;

    // Cost: agent's daily rate
    co.spentCents += agent.costPerDayCents;

    // Work: utilization determines how much output is produced
    const workOutput = agent.efficiency * (0.5 + Math.random() * 0.5);
    agent.utilization = Math.min(1, workOutput);

    // Task completion based on utilization
    if (co.taskCount > co.completedTasks && Math.random() < agent.utilization * 0.3) {
      co.completedTasks++;
      agent.tasksCompleted++;
    }
  }

  // 2. Market dynamics
  const marketShift = (Math.random() - 0.5) * env.market.volatility * 0.02;
  env.market.demandLevel = Math.max(0, Math.min(100, env.market.demandLevel + marketShift));
  env.market.growthRate += (Math.random() - 0.5) * 2;

  // 3. Revenue generation based on completed tasks and market demand
  for (const [, co] of env.companies) {
    if (co.status === "failed") continue;

    const completionRatio = co.taskCount > 0 ? co.completedTasks / co.taskCount : 0;
    const dailyRevenue = Math.floor(
      completionRatio * co.budgetCents * 0.02 * (env.market.demandLevel / 100),
    );
    co.revenueCents += dailyRevenue;

    // Check financial health
    if (co.spentCents > co.budgetCents * 2 && co.revenueCents < co.spentCents * 0.3) {
      co.status = "failed";
      env.eventLog.push({
        day: env.day,
        type: "company_failed",
        entityId: co.id,
        message: `${co.name} failed — spent ${co.spentCents} with only ${co.revenueCents} revenue`,
      });
    } else if (co.revenueCents > co.spentCents) {
      co.status = "profitable";
    } else if (co.spentCents > co.budgetCents * 0.8) {
      co.status = "struggling";
    }
  }

  // 4. Goal progress
  for (const [, goal] of env.goals) {
    if (goal.status !== "active") continue;
    const co = env.companies.get(goal.companyId);
    if (!co || co.status === "failed") {
      goal.status = "failed";
      continue;
    }

    // Progress based on agent output
    const coAgents = [...env.agents.values()].filter((a) => a.companyId === goal.companyId);
    const avgEfficiency = coAgents.length > 0
      ? coAgents.reduce((s, a) => s + a.utilization, 0) / coAgents.length
      : 0;

    goal.progress = Math.min(1, goal.progress + avgEfficiency * 0.015);
    if (goal.progress >= 1) {
      goal.status = "completed";
      env.eventLog.push({
        day: env.day,
        type: "goal_completed",
        entityId: goal.id,
        message: `Goal "${goal.title}" completed on day ${env.day}`,
      });
    }
  }

  // 5. Update aggregate metrics
  updateMetrics(env);
}

function updateMetrics(env: SimulationEnvironment): void {
  let totalRev = 0;
  let totalCost = 0;
  let totalTasks = 0;
  let completedTasks = 0;
  let activeGoals = 0;
  let completedGoals = 0;
  let failedGoals = 0;
  let totalUtil = 0;
  let agentCount = 0;
  let failedCompanies = 0;

  for (const [, co] of env.companies) {
    totalRev += co.revenueCents;
    totalCost += co.spentCents;
    totalTasks += co.taskCount;
    completedTasks += co.completedTasks;
    if (co.status === "failed") failedCompanies++;
  }

  for (const [, goal] of env.goals) {
    if (goal.status === "active") activeGoals++;
    else if (goal.status === "completed") completedGoals++;
    else failedGoals++;
  }

  for (const [, agent] of env.agents) {
    totalUtil += agent.utilization;
    agentCount++;
  }

  const totalGoals = activeGoals + completedGoals + failedGoals;

  env.metrics = {
    totalRevenue: totalRev,
    totalCost: totalCost,
    totalProfit: totalRev - totalCost,
    taskCompletion: totalTasks > 0 ? completedTasks / totalTasks : 0,
    goalSuccessRate: totalGoals > 0 ? completedGoals / totalGoals : 0,
    agentEfficiency: agentCount > 0 ? totalUtil / agentCount : 0,
    customerGrowth: env.market.growthRate,
    failureRate: env.companies.size > 0 ? failedCompanies / env.companies.size : 0,
  };
}

/**
 * Extract final metrics from a completed simulation environment.
 */
export function extractMetrics(env: SimulationEnvironment): SimMetrics {
  return { ...env.metrics };
}
