// ---------------------------------------------------------------------------
// Universe Generator — Creates Parallel Hypothetical Ecosystems
// ---------------------------------------------------------------------------
// Each "universe" is a complete simulation with a unique set of
// randomly sampled variables. The generator creates N universes
// from a scenario's variable definitions.
// ---------------------------------------------------------------------------

import {
  generateVariations,
  type VariableDefinition,
  type VariableSet,
} from "./scenarioVariations.js";
import {
  runScenario,
  type ScenarioConfig,
  type ScenarioType,
} from "../scenarioRunner.js";
import {
  createCompanyLaunchScenario,
  createHiringScenario,
  createPricingScenario,
} from "../scenarioRunner.js";
import type { SimMetrics } from "../simulationEnvironment.js";
import pino from "pino";

const logger = pino({ name: "universe-generator" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UniverseConfig {
  index: number;
  variables: VariableSet;
  scenarioType: ScenarioType;
  strategyName: string;
  simulatedDays: number;
}

export interface UniverseResult {
  index: number;
  variables: VariableSet;
  metrics: SimMetrics;
  simulatedDays: number;
  succeeded: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Universe Generation
// ---------------------------------------------------------------------------

/**
 * Generate universe configurations by sampling variable space.
 */
export function generateUniverses(
  scenarioType: ScenarioType,
  strategyName: string,
  variables: VariableDefinition[],
  count: number,
  simulatedDays: number,
): UniverseConfig[] {
  const variations = generateVariations(variables, count);

  return variations.map((vars, index) => ({
    index,
    variables: vars,
    scenarioType,
    strategyName,
    simulatedDays,
  }));
}

/**
 * Execute a single universe — run its scenario and return metrics.
 */
export function executeUniverse(config: UniverseConfig): UniverseResult {
  try {
    const scenarioConfig = buildUniverseScenario(config);
    const result = runScenario(scenarioConfig);

    return {
      index: config.index,
      variables: config.variables,
      metrics: result.metrics,
      simulatedDays: config.simulatedDays,
      succeeded: true,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ universe: config.index, error: errorMsg }, "Universe execution failed");

    return {
      index: config.index,
      variables: config.variables,
      metrics: {
        totalRevenue: 0,
        totalCost: 0,
        totalProfit: 0,
        taskCompletion: 0,
        goalSuccessRate: 0,
        agentEfficiency: 0,
        customerGrowth: 0,
        failureRate: 1,
      },
      simulatedDays: config.simulatedDays,
      succeeded: false,
      error: errorMsg,
    };
  }
}

/**
 * Execute all universes sequentially.
 * For production use, this could be parallelized via worker pools.
 */
export function executeAllUniverses(configs: UniverseConfig[]): UniverseResult[] {
  const results: UniverseResult[] = [];

  for (const config of configs) {
    results.push(executeUniverse(config));
  }

  logger.info(
    {
      total: configs.length,
      succeeded: results.filter((r) => r.succeeded).length,
      failed: results.filter((r) => !r.succeeded).length,
    },
    "All universes executed",
  );

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildUniverseScenario(config: UniverseConfig): ScenarioConfig {
  const v = config.variables;

  switch (config.scenarioType) {
    case "company_launch":
      return createCompanyLaunchScenario(config.strategyName, {
        teamSize: Math.round(Number(v.teamSize ?? 5)),
        budgetCents: Math.round(Number(v.budgetCents ?? 50000)),
        pricing: String(v.pricing ?? "mid"),
        marketDemand: Number(v.marketDemand ?? 50),
        simulatedDays: config.simulatedDays,
      });

    case "hiring":
      return createHiringScenario(
        "sim_company",
        config.strategyName,
        Math.round(Number(v.currentAgents ?? 5)),
        Math.round(Number(v.additionalHires ?? 3)),
        {
          budgetCents: Math.round(Number(v.budgetCents ?? 80000)),
          simulatedDays: config.simulatedDays,
        },
      );

    case "pricing":
      return createPricingScenario(
        config.strategyName,
        (v.priceTier as "low" | "mid" | "premium") ?? "mid",
        {
          teamSize: Math.round(Number(v.teamSize ?? 5)),
          budgetCents: Math.round(Number(v.budgetCents ?? 50000)),
          simulatedDays: config.simulatedDays,
        },
      );

    default:
      return createCompanyLaunchScenario(config.strategyName, {
        teamSize: Math.round(Number(v.teamSize ?? 5)),
        budgetCents: Math.round(Number(v.budgetCents ?? 50000)),
        simulatedDays: config.simulatedDays,
      });
  }
}
