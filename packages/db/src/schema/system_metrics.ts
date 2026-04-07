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
 * System metrics — normalized decision signals collected from runtime actions.
 * These metrics power the autonomous feedback + decision loop.
 */
export const systemMetrics = pgTable(
  "system_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    sourceType: text("source_type").notNull(), // task_execution | simulation_run | tool_action | strategy_outcome
    sourceId: text("source_id"),
    traffic: integer("traffic").notNull().default(0),
    conversions: integer("conversions").notNull().default(0),
    revenueCents: integer("revenue_cents").notNull().default(0),
    taskSuccessRate: real("task_success_rate").notNull().default(0), // 0..1
    costPerActionCents: real("cost_per_action_cents").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyRecordedIdx: index("system_metrics_company_recorded_idx").on(
      table.companyId,
      table.recordedAt,
    ),
    sourceIdx: index("system_metrics_source_idx").on(table.sourceType, table.recordedAt),
  }),
);
