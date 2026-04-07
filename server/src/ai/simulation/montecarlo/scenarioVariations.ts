// ---------------------------------------------------------------------------
// Scenario Variations — Variable Randomization for Monte Carlo
// ---------------------------------------------------------------------------
// Generates randomized variable sets from defined ranges.
// Each variation represents a different possible future.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VariableDefinition {
  name: string;
  type: "numeric" | "categorical";
  min?: number;
  max?: number;
  options?: string[];
  default?: number | string;
}

export interface VariableSet {
  [key: string]: number | string;
}

// ---------------------------------------------------------------------------
// Random sampling
// ---------------------------------------------------------------------------

/**
 * Sample a single variable value from its definition range.
 */
export function sampleVariable(def: VariableDefinition): number | string {
  if (def.type === "categorical" && def.options && def.options.length > 0) {
    const idx = Math.floor(Math.random() * def.options.length);
    return def.options[idx];
  }

  if (def.type === "numeric") {
    const min = def.min ?? 0;
    const max = def.max ?? 100;
    return min + Math.random() * (max - min);
  }

  return def.default ?? 0;
}

/**
 * Generate a complete variable set by sampling all variables.
 */
export function sampleVariableSet(definitions: VariableDefinition[]): VariableSet {
  const result: VariableSet = {};
  for (const def of definitions) {
    result[def.name] = sampleVariable(def);
  }
  return result;
}

/**
 * Generate N unique variable sets for Monte Carlo simulation.
 * Each set represents one "universe" of variables.
 */
export function generateVariations(
  definitions: VariableDefinition[],
  count: number,
): VariableSet[] {
  const variations: VariableSet[] = [];

  for (let i = 0; i < count; i++) {
    variations.push(sampleVariableSet(definitions));
  }

  return variations;
}

// ---------------------------------------------------------------------------
// Common variable definitions for built-in scenarios
// ---------------------------------------------------------------------------

export const COMPANY_LAUNCH_VARIABLES: VariableDefinition[] = [
  { name: "teamSize", type: "numeric", min: 2, max: 15 },
  { name: "budgetCents", type: "numeric", min: 20000, max: 200000 },
  { name: "pricing", type: "categorical", options: ["low", "mid", "premium"] },
  { name: "marketDemand", type: "numeric", min: 10, max: 90 },
];

export const HIRING_VARIABLES: VariableDefinition[] = [
  { name: "additionalHires", type: "numeric", min: 1, max: 20 },
  { name: "budgetCents", type: "numeric", min: 30000, max: 150000 },
  { name: "currentAgents", type: "numeric", min: 3, max: 10 },
];

export const PRICING_VARIABLES: VariableDefinition[] = [
  { name: "teamSize", type: "numeric", min: 3, max: 10 },
  { name: "budgetCents", type: "numeric", min: 30000, max: 150000 },
  { name: "priceTier", type: "categorical", options: ["low", "mid", "premium"] },
];
