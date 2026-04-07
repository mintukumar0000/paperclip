import { pgTable, uuid, text, timestamp, jsonb, index, integer } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/** Autonomous execution plans created by the goal planner */
export const agentPlans = pgTable(
  "agent_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    issueId: uuid("issue_id"),
    goal: text("goal").notNull(),
    status: text("status").notNull().default("planning"), // planning | active | completed | failed | cancelled
    graphJson: jsonb("graph_json").notNull().default("{}"), // task DAG with steps and dependencies
    episodicJson: jsonb("episodic_json").default("[]"), // episodic memory entries for this plan
    currentStep: text("current_step"),
    stepsCompleted: integer("steps_completed").notNull().default(0),
    stepsTotal: integer("steps_total").notNull().default(0),
    maxIterations: integer("max_iterations").notNull().default(25),
    iterationsUsed: integer("iterations_used").notNull().default(0),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    companyIdx: index("agent_plans_company_idx").on(table.companyId),
    agentIdx: index("agent_plans_agent_idx").on(table.agentId),
    statusIdx: index("agent_plans_status_idx").on(table.companyId, table.status),
  }),
);
