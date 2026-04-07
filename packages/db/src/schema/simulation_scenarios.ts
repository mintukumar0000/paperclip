import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Simulation scenarios — reusable scenario templates that define what to simulate.
 * Each scenario specifies variables, their ranges, and evaluation criteria.
 */
export const simulationScenarios = pgTable(
  "simulation_scenarios",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    name: text("name").notNull(),
    scenarioType: text("scenario_type").notNull(), // company_launch | hiring | pricing | product | marketing | expansion
    description: text("description"),
    /** Variable definitions with ranges for Monte Carlo sampling */
    variables: jsonb("variables")
      .$type<
        Array<{
          name: string;
          type: "numeric" | "categorical";
          min?: number;
          max?: number;
          options?: string[];
          default?: number | string;
        }>
      >()
      .notNull()
      .default([]),
    /** Metrics to evaluate */
    evaluationCriteria: jsonb("evaluation_criteria")
      .$type<
        Array<{
          metric: string;
          weight: number;
          direction: "maximize" | "minimize";
        }>
      >()
      .notNull()
      .default([]),
    simulatedDays: integer("simulated_days").notNull().default(90),
    defaultUniverses: integer("default_universes").notNull().default(100),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("simulation_scenarios_company_idx").on(table.companyId),
    typeIdx: index("simulation_scenarios_type_idx").on(table.scenarioType),
  }),
);
