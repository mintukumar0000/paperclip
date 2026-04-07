import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const waitlistSignups = pgTable(
  "waitlist_signups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    name: text("name"),
    email: text("email").notNull(),
    source: text("source"),
    variantId: text("variant_id"),
    pageVersion: text("page_version"),
    monetizationSent: boolean("monetization_sent").notNull().default(false),
    monetizationSentAt: timestamp("monetization_sent_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailUniqueIdx: uniqueIndex("waitlist_signups_email_unique_idx").on(table.email),
    companyCreatedAtIdx: index("waitlist_signups_company_created_at_idx").on(table.companyId, table.createdAt),
    createdAtIdx: index("waitlist_signups_created_at_idx").on(table.createdAt),
  }),
);