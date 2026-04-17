import {
  pgTable,
  uuid,
  text,
  real,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const systemDecisions = pgTable(
  "system_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    source: text("source").notNull(),
    actionType: text("action_type").notNull(),
    actionKey: text("action_key").notNull(),
    reason: text("reason").notNull(),
    metricName: text("metric_name"),
    metricValue: real("metric_value"),
    thresholdValue: real("threshold_value"),
    actionPayload: jsonb("action_payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("pending"),
    overrideNote: text("override_note"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedBy: text("rejected_by"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("system_decisions_company_created_idx").on(table.companyId, table.createdAt),
    companyStatusIdx: index("system_decisions_company_status_idx").on(table.companyId, table.status),
    companyActionIdx: index("system_decisions_company_action_idx").on(table.companyId, table.actionKey),
  }),
);
