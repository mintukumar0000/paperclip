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
 * Simulation runs — tracks each simulation execution with its parameters and results.
 * A run may contain multiple scenarios (Monte Carlo) or a single scenario.
 */
export const simulationRuns = pgTable(
  "simulation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    runType: text("run_type").notNull(), // single | monte_carlo
    status: text("status").notNull().default("pending"), // pending | running | completed | failed | cancelled
    scenarioType: text("scenario_type").notNull(), // company_launch | hiring | pricing | product | marketing | expansion
    strategyName: text("strategy_name"),
    parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull().default({}),
    totalUniverses: integer("total_universes").notNull().default(1),
    completedUniverses: integer("completed_universes").notNull().default(0),
    resultScore: real("result_score"), // aggregate score after evaluation
    selectedStrategy: text("selected_strategy"), // which strategy was chosen
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("simulation_runs_company_idx").on(table.companyId),
    statusIdx: index("simulation_runs_status_idx").on(table.status),
    typeIdx: index("simulation_runs_type_idx").on(table.runType),
    scenarioIdx: index("simulation_runs_scenario_idx").on(table.scenarioType),
  }),
);
