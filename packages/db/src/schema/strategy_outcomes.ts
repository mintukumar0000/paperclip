import {
  pgTable,
  uuid,
  text,
  real,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { simulationRuns } from "./simulation_runs.js";

/**
 * Strategy outcomes — aggregated statistical results for each strategy tested.
 * Produced by the Monte Carlo probability analyzer after all universes complete.
 */
export const strategyOutcomes = pgTable(
  "strategy_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => simulationRuns.id),
    strategyName: text("strategy_name").notNull(),
    /** Statistical summary */
    meanProfit: real("mean_profit").notNull().default(0),
    medianProfit: real("median_profit").notNull().default(0),
    variance: real("variance").notNull().default(0),
    standardDeviation: real("standard_deviation").notNull().default(0),
    successRate: real("success_rate").notNull().default(0), // 0-1
    failureRate: real("failure_rate").notNull().default(0), // 0-1
    meanRevenue: real("mean_revenue").notNull().default(0),
    meanCost: real("mean_cost").notNull().default(0),
    riskScore: real("risk_score").notNull().default(0), // 0-100
    confidenceLevel: real("confidence_level").notNull().default(0), // 0-1
    sampleSize: real("sample_size").notNull().default(0),
    selected: text("selected").notNull().default("false"), // "true" if this was chosen
    /** Full statistical breakdown */
    detailedStats: jsonb("detailed_stats").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    runIdx: index("strategy_outcomes_run_idx").on(table.runId),
    strategyIdx: index("strategy_outcomes_strategy_idx").on(table.strategyName),
    successIdx: index("strategy_outcomes_success_idx").on(table.successRate),
  }),
);
