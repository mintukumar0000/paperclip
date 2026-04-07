import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/** Agent-to-agent messages */
export const agentMessages = pgTable(
  "agent_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    fromAgentId: uuid("from_agent_id").notNull().references(() => agents.id),
    toAgentId: uuid("to_agent_id").notNull().references(() => agents.id),
    message: text("message").notNull(),
    status: text("status").notNull().default("sent"), // sent | read | acted_on
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("agent_messages_company_idx").on(table.companyId),
    toAgentIdx: index("agent_messages_to_agent_idx").on(table.toAgentId, table.status),
    fromAgentIdx: index("agent_messages_from_agent_idx").on(table.fromAgentId),
  }),
);
