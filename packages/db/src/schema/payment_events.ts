import { pgTable, uuid, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const paymentEvents = pgTable(
  "payment_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    email: text("email"),
    amountCents: integer("amount_cents").notNull().default(0),
    currency: text("currency").notNull().default("usd"),
    provider: text("provider").notNull(),
    status: text("status").notNull().default("completed"),
    externalEventId: text("external_event_id"),
    sessionId: text("session_id"),
    source: text("source"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("payment_events_company_created_idx").on(table.companyId, table.createdAt),
    emailIdx: index("payment_events_email_idx").on(table.email),
    externalEventIdx: index("payment_events_external_event_idx").on(table.externalEventId),
  }),
);