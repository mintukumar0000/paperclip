import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const cycleState = pgTable(
  "cycle_state",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id),
    loopKey: text("loop_key").notNull(),
    status: text("status").notNull().default("idle"),
    stage: text("stage"),
    currentAction: text("current_action"),
    decisionId: uuid("decision_id"),
    lastError: text("last_error"),
    lastRunStartedAt: timestamp("last_run_started_at", { withTimezone: true }),
    lastRunCompletedAt: timestamp("last_run_completed_at", { withTimezone: true }),
    lastRunDurationMs: integer("last_run_duration_ms"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.companyId, table.loopKey], name: "cycle_state_pk" }),
    companyStatusIdx: index("cycle_state_company_status_idx").on(table.companyId, table.status),
    companyUpdatedIdx: index("cycle_state_company_updated_idx").on(table.companyId, table.updatedAt),
  }),
);
