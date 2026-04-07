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
import { simulationRuns } from "./simulation_runs.js";

/**
 * Simulation universes — individual parallel worlds within a Monte Carlo run.
 * Each universe has unique variable assignments and produces its own metrics.
 */
export const simulationUniverses = pgTable(
  "simulation_universes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => simulationRuns.id),
    universeIndex: integer("universe_index").notNull(),
    status: text("status").notNull().default("pending"), // pending | running | completed | failed
    /** Variable values sampled for this universe */
    variables: jsonb("variables").$type<Record<string, number | string>>().notNull().default({}),
    /** Metrics produced by this universe's simulation */
    metrics: jsonb("metrics")
      .$type<{
        revenue: number;
        cost: number;
        profit: number;
        taskCompletion: number;
        goalSuccessRate: number;
        agentEfficiency: number;
        customerGrowth: number;
        failureRate: number;
        [key: string]: number;
      }>()
      .default({
        revenue: 0,
        cost: 0,
        profit: 0,
        taskCompletion: 0,
        goalSuccessRate: 0,
        agentEfficiency: 0,
        customerGrowth: 0,
        failureRate: 0,
      }),
    simulatedDays: integer("simulated_days").notNull().default(0),
    resultScore: real("result_score"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    runIdx: index("simulation_universes_run_idx").on(table.runId),
    statusIdx: index("simulation_universes_status_idx").on(table.status),
    scoreIdx: index("simulation_universes_score_idx").on(table.resultScore),
  }),
);
