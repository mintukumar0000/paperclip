import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Institutional knowledge — organizational memory that persists across agent lifetimes.
 * Categories: policy, procedure, lesson_learned, decision_record, best_practice.
 * Status: draft → approved → archived.
 */
export const institutionalKnowledge = pgTable(
  "institutional_knowledge",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    title: text("title").notNull(),
    category: text("category").notNull(), // policy | procedure | lesson_learned | decision_record | best_practice
    content: text("content").notNull(),
    source: text("source"), // who/what contributed this knowledge
    tags: jsonb("tags").$type<string[]>().default([]),
    status: text("status").notNull().default("draft"), // draft | approved | archived
    contributedBy: text("contributed_by"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("institutional_knowledge_company_idx").on(table.companyId),
    companyCategoryIdx: index("institutional_knowledge_company_category_idx").on(
      table.companyId,
      table.category,
    ),
    statusIdx: index("institutional_knowledge_status_idx").on(
      table.companyId,
      table.status,
    ),
  }),
);
