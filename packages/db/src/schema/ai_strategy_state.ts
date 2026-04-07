import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const aiStrategyState = pgTable(
  "ai_strategy_state",
  {
    companyId: uuid("company_id")
      .primaryKey()
      .references(() => companies.id),

    currentStrategy: text("current_strategy").notNull().default(""),
    beliefs: jsonb("beliefs").$type<string[]>().notNull().default([]),
    hypotheses: jsonb("hypotheses").$type<string[]>().notNull().default([]),
    activeExperiments: jsonb("active_experiments").$type<string[]>().notNull().default([]),

    lastMetricsSnapshot: jsonb("last_metrics_snapshot").$type<Record<string, unknown>>(),

    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);
