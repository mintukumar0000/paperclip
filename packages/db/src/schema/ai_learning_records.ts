import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * AI learning records — stores insights, evaluations, and improvement history.
 * Core knowledge base for the self-improving AI layer (Phase 22).
 */
export const aiLearningRecords = pgTable(
  "ai_learning_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    goalId: text("goal_id"),
    agentId: uuid("agent_id"),
    recordType: text("record_type").notNull(), // evaluation | insight | improvement | optimization
    category: text("category").notNull(), // outcome | quality | performance | prompt | workflow | strategy
    summary: text("summary").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    scores: jsonb("scores").$type<Record<string, number>>(),
    recommendedChange: text("recommended_change"),
    applied: boolean("applied").notNull().default(false),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    rolledBack: boolean("rolled_back").notNull().default(false),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
    parentRecordId: uuid("parent_record_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyTypeIdx: index("ai_learning_company_type_idx").on(
      table.companyId,
      table.recordType,
    ),
    companyCategoryIdx: index("ai_learning_company_category_idx").on(
      table.companyId,
      table.category,
    ),
    goalIdx: index("ai_learning_goal_idx").on(table.goalId),
    appliedIdx: index("ai_learning_applied_idx").on(
      table.companyId,
      table.applied,
    ),
  }),
);
