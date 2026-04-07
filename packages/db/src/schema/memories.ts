import { pgTable, uuid, text, timestamp, jsonb, index, integer } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/** Structured memory: experiments, decisions, company knowledge */
export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").references(() => agents.id),
    type: text("type").notNull(), // "experiment" | "decision" | "knowledge" | "observation"
    title: text("title").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata"),
    relevanceScore: integer("relevance_score").default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("memories_company_idx").on(table.companyId),
    typeIdx: index("memories_type_idx").on(table.companyId, table.type),
  }),
);
