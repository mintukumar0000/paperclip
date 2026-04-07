import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Governance rules — constitutional-level constraints that bound AI decision-making.
 * Rule types: economic, ethical, strategic, safety, operational.
 * Severity levels: blocking (hard stop), warning (advisory + logged), advisory (logged only).
 */
export const governanceRules = pgTable(
  "governance_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    ruleName: text("rule_name").notNull(),
    ruleType: text("rule_type").notNull(), // economic | ethical | strategic | safety | operational
    ruleDefinition: text("rule_definition").notNull(),
    severity: text("severity").notNull().default("warning"), // blocking | warning | advisory
    description: text("description"),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("governance_rules_company_idx").on(table.companyId),
    companyTypeIdx: index("governance_rules_company_type_idx").on(
      table.companyId,
      table.ruleType,
    ),
    activeIdx: index("governance_rules_active_idx").on(
      table.companyId,
      table.active,
    ),
  }),
);
