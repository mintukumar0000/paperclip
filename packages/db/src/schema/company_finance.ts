import { pgTable, uuid, integer, timestamp } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companyFinance = pgTable("company_finance", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id),
  revenueCents: integer("revenue_cents").notNull().default(0),
  creditsCents: integer("credits_cents").notNull().default(0),
  spentCents: integer("spent_cents").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
