import { pgTable, uuid, text, timestamp, jsonb, index, integer } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/** Workflow definitions and run history */
export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    description: text("description"),
    definition: jsonb("definition").notNull(), // DAG steps definition
    status: text("status").notNull().default("active"), // active | paused | archived
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("workflows_company_idx").on(table.companyId),
  }),
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id").notNull().references(() => workflows.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    status: text("status").notNull().default("running"), // running | completed | failed | cancelled
    currentStep: text("current_step"),
    stepsCompleted: jsonb("steps_completed").default("[]"),
    stepsFailed: jsonb("steps_failed").default("[]"),
    context: jsonb("context").default("{}"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    companyIdx: index("workflow_runs_company_idx").on(table.companyId),
    statusIdx: index("workflow_runs_status_idx").on(table.companyId, table.status),
  }),
);
