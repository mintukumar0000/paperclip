import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Organizational playbooks — repeatable procedures that encode institutional expertise.
 * Steps are stored as a structured JSON array of action objects.
 * Playbooks can have trigger conditions for auto-loading.
 */
export const organizationalPlaybooks = pgTable(
  "organizational_playbooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    title: text("title").notNull(),
    description: text("description"),
    category: text("category").notNull(), // onboarding | incident | review | deployment | strategy
    steps: jsonb("steps")
      .$type<Array<{ order: number; action: string; details?: string }>>()
      .notNull()
      .default([]),
    triggerCondition: text("trigger_condition"), // optional auto-trigger description
    active: boolean("active").notNull().default(true),
    timesApplied: integer("times_applied").notNull().default(0),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("organizational_playbooks_company_idx").on(table.companyId),
    companyCategoryIdx: index("organizational_playbooks_company_category_idx").on(
      table.companyId,
      table.category,
    ),
    activeIdx: index("organizational_playbooks_active_idx").on(
      table.companyId,
      table.active,
    ),
  }),
);
