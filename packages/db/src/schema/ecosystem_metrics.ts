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
 * Ecosystem metrics — periodic snapshots of global ecosystem health indicators.
 * Used by the Ecosystem Stability Controller to detect instability.
 */
export const ecosystemMetrics = pgTable(
  "ecosystem_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    companyCount: integer("company_count").notNull().default(0),
    agentCount: integer("agent_count").notNull().default(0),
    goalCount: integer("goal_count").notNull().default(0),
    activeGoalCount: integer("active_goal_count").notNull().default(0),
    taskBacklog: integer("task_backlog").notNull().default(0),
    agentUtilization: real("agent_utilization").notNull().default(0), // 0-100%
    goalGrowthRate: real("goal_growth_rate").notNull().default(0), // goals/day
    revenueGrowthRate: real("revenue_growth_rate").notNull().default(0),
    systemLoad: real("system_load").notNull().default(0), // 0-100%
    stabilityScore: real("stability_score").notNull().default(100), // 0-100
    expansionPressure: real("expansion_pressure").notNull().default(0), // 0-100
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("ecosystem_metrics_company_idx").on(table.companyId),
    snapshotIdx: index("ecosystem_metrics_snapshot_idx").on(table.snapshotAt),
    stabilityIdx: index("ecosystem_metrics_stability_idx").on(
      table.companyId,
      table.stabilityScore,
    ),
  }),
);
