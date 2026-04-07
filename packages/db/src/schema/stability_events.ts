import {
  pgTable,
  uuid,
  text,
  real,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Stability events — recorded whenever the Stability Controller takes action.
 * Tracks freezes, throttles, warnings, and recovery events.
 */
export const stabilityEvents = pgTable(
  "stability_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id), // null = ecosystem-wide
    eventType: text("event_type").notNull(), // freeze | throttle | warn | recover | collapse_detected
    severity: text("severity").notNull().default("warning"), // info | warning | critical | emergency
    stabilityScore: real("stability_score"),
    trigger: text("trigger").notNull(), // what caused this event
    action: text("action").notNull(), // what the controller did
    details: jsonb("details").$type<Record<string, unknown>>().default({}),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("stability_events_company_idx").on(table.companyId),
    eventTypeIdx: index("stability_events_type_idx").on(table.eventType),
    severityIdx: index("stability_events_severity_idx").on(table.severity),
    createdIdx: index("stability_events_created_idx").on(table.createdAt),
  }),
);
