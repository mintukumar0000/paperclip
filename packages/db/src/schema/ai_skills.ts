import {
  pgTable,
  uuid,
  text,
  real,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const aiSkills = pgTable(
  "ai_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),

    name: text("name").notNull(),
    category: text("category").notNull(), // traffic | conversion | pricing | email | strategy | ops
    pattern: text("pattern").notNull(),
    conditions: jsonb("conditions").$type<string[]>().notNull().default([]),
    expectedOutcome: text("expected_outcome"),

    confidence: real("confidence").notNull().default(0.5),
    usageCount: integer("usage_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),

    source: text("source"), // content | pricing | email | landing | behavior
    embedding: jsonb("embedding").$type<number[]>(),

    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCategoryIdx: index("ai_skills_company_category_idx").on(
      table.companyId,
      table.category,
    ),
    confidenceIdx: index("ai_skills_confidence_idx").on(table.confidence),
    companySourceIdx: index("ai_skills_company_source_idx").on(
      table.companyId,
      table.source,
    ),
  }),
);
