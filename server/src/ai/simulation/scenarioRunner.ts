// ---------------------------------------------------------------------------
// Scenario Runner — Defines and Executes Simulation Scenarios
// ---------------------------------------------------------------------------
// Creates scenario configurations for different strategic tests:
//   - Company launch, hiring decisions, pricing strategy
//   - Product roadmaps, marketing campaigns, market expansion
// ---------------------------------------------------------------------------

import {
  createSimulationEnvironment,
  simulateDay,
  extractMetrics,
  type SimEnvironmentSeed,
  type SimMetrics,
  type SimMarket,
  type SimulationEnvironment,
} from "./simulationEnvironment.js";
import pino from "pino";

const logger = pino({ name: "scenario-runner" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScenarioType =
  | "company_launch"
  | "hiring"
  | "pricing"
  | "product"
  | "marketing"
  | "expansion";

export interface ScenarioConfig {
  type: ScenarioType;
  name: string;
  description?: string;
  /** Number of simulated days to run */
  simulatedDays: number;
  /** Variable overrides for this particular strategy variant */
  variables: Record<string, number | string>;
  /** Seed data for the environment */
  seed: SimEnvironmentSeed;
}

export interface ScenarioResult {
  scenarioName: string;
  scenarioType: ScenarioType;
  variables: Record<string, number | string>;
  simulatedDays: number;
  metrics: SimMetrics;
  eventCount: number;
  finalCompanyStatus: Array<{ id: string; name: string; status: string; revenue: number; cost: number }>;
}

// ---------------------------------------------------------------------------
// Scenario Templates
// ---------------------------------------------------------------------------

/**
 * Generate a company launch scenario with variable overrides.
 */
export function createCompanyLaunchScenario(
  companyName: string,
  variables: {
    teamSize?: number;
    budgetCents?: number;
    pricing?: string;
    marketDemand?: number;
    simulatedDays?: number;
  } = {},
): ScenarioConfig {
  const teamSize = variables.teamSize ?? 5;
  const budgetCents = variables.budgetCents ?? 50000;
  const marketDemand = variables.marketDemand ?? 50;

  const agents = Array.from({ length: teamSize }, (_, i) => ({
    id: `sim_agent_${i}`,
    companyId: "sim_company_1",
    role: i === 0 ? "lead" : "engineer",
    costPerDayCents: i === 0 ? 500 : 300,
    efficiency: 0.6 + Math.random() * 0.3,
  }));

  return {
    type: "company_launch",
    name: `Launch: ${companyName}`,
    description: `Simulate launching ${companyName} with ${teamSize} agents`,
    simulatedDays: variables.simulatedDays ?? 90,
    variables: { teamSize, budgetCents, pricing: variables.pricing ?? "mid", marketDemand },
    seed: {
      companies: [
        { id: "sim_company_1", name: companyName, budgetCents, initialTasks: teamSize * 10 },
      ],
      agents,
      goals: [
        { id: "sim_goal_1", companyId: "sim_company_1", title: "Launch MVP" },
        { id: "sim_goal_2", companyId: "sim_company_1", title: "Acquire first customers" },
        { id: "sim_goal_3", companyId: "sim_company_1", title: "Reach profitability" },
      ],
      market: {
        demandLevel: marketDemand,
        competitionLevel: 30,
        growthRate: 5,
        volatility: 20,
      },
    },
  };
}

/**
 * Generate a hiring decision scenario.
 */
export function createHiringScenario(
  companyId: string,
  companyName: string,
  currentAgents: number,
  additionalHires: number,
  variables: {
    budgetCents?: number;
    simulatedDays?: number;
  } = {},
): ScenarioConfig {
  const budgetCents = variables.budgetCents ?? 80000;
  const totalTeam = currentAgents + additionalHires;

  const agents = Array.from({ length: totalTeam }, (_, i) => ({
    id: `sim_agent_${i}`,
    companyId: "sim_company_1",
    role: i < currentAgents ? "existing" : "new_hire",
    costPerDayCents: 350,
    efficiency: i < currentAgents ? 0.75 : 0.5, // new hires less efficient initially
  }));

  return {
    type: "hiring",
    name: `Hiring: +${additionalHires} for ${companyName}`,
    simulatedDays: variables.simulatedDays ?? 90,
    variables: { currentAgents, additionalHires, totalTeam, budgetCents },
    seed: {
      companies: [
        { id: "sim_company_1", name: companyName, budgetCents, initialTasks: totalTeam * 8 },
      ],
      agents,
      goals: [
        { id: "sim_goal_1", companyId: "sim_company_1", title: "Scale operations" },
        { id: "sim_goal_2", companyId: "sim_company_1", title: "Increase output" },
      ],
    },
  };
}

/**
 * Generate a pricing strategy scenario.
 */
export function createPricingScenario(
  companyName: string,
  priceTier: "low" | "mid" | "premium",
  variables: {
    teamSize?: number;
    budgetCents?: number;
    simulatedDays?: number;
  } = {},
): ScenarioConfig {
  const priceMultiplier = priceTier === "low" ? 0.5 : priceTier === "mid" ? 1.0 : 2.0;
  const demandAdjust = priceTier === "low" ? 70 : priceTier === "mid" ? 50 : 30;
  const teamSize = variables.teamSize ?? 5;

  const agents = Array.from({ length: teamSize }, (_, i) => ({
    id: `sim_agent_${i}`,
    companyId: "sim_company_1",
    role: "engineer",
    costPerDayCents: 300,
  }));

  return {
    type: "pricing",
    name: `Pricing: ${priceTier} for ${companyName}`,
    simulatedDays: variables.simulatedDays ?? 180,
    variables: { priceTier, priceMultiplier, teamSize },
    seed: {
      companies: [
        {
          id: "sim_company_1",
          name: companyName,
          budgetCents: Math.floor((variables.budgetCents ?? 50000) * priceMultiplier),
          initialTasks: teamSize * 12,
        },
      ],
      agents,
      goals: [
        { id: "sim_goal_1", companyId: "sim_company_1", title: "Product-market fit" },
        { id: "sim_goal_2", companyId: "sim_company_1", title: "Revenue growth" },
      ],
      market: {
        demandLevel: demandAdjust,
        competitionLevel: 40,
        growthRate: 8,
        volatility: 25,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Execute a single scenario — runs the simulation for N days
 * and returns the final metrics.
 */
export function runScenario(config: ScenarioConfig): ScenarioResult {
  const env = createSimulationEnvironment(config.seed);

  for (let day = 0; day < config.simulatedDays; day++) {
    simulateDay(env);
  }

  const metrics = extractMetrics(env);
  const finalCompanyStatus = [...env.companies.values()].map((co) => ({
    id: co.id,
    name: co.name,
    status: co.status,
    revenue: co.revenueCents,
    cost: co.spentCents,
  }));

  logger.info(
    { scenario: config.name, days: config.simulatedDays, profit: metrics.totalProfit },
    "Scenario completed",
  );

  return {
    scenarioName: config.name,
    scenarioType: config.type,
    variables: config.variables,
    simulatedDays: config.simulatedDays,
    metrics,
    eventCount: env.eventLog.length,
    finalCompanyStatus,
  };
}
