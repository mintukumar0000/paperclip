import { pgTable, uuid, text, timestamp, integer, jsonb, boolean, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const expansionRequests = pgTable(
  "expansion_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    requestType: text("request_type").notNull(), // 'new_agent' | 'new_department' | 'new_role'
    status: text("status").notNull().default("pending"), // 'pending' | 'approved' | 'rejected' | 'completed'
    approvalLevel: text("approval_level").notNull(), // 'auto' | 'manager' | 'ceo' | 'human'
    requestedRole: text("requested_role"),
    requestedCapabilities: text("requested_capabilities"), // comma-separated
    reason: text("reason").notNull(),
    gapAnalysis: jsonb("gap_analysis").$type<Record<string, unknown>>(),
    designSpec: jsonb("design_spec").$type<Record<string, unknown>>(),
    resultAgentId: uuid("result_agent_id"),
    resultDepartmentId: uuid("result_department_id"),
    requestedBy: uuid("requested_by"), // agent id that requested
    approvedBy: uuid("approved_by"),   // agent/user id that approved
    rejectionReason: text("rejection_reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("expansion_requests_company_idx").on(table.companyId),
    companyStatusIdx: index("expansion_requests_company_status_idx").on(table.companyId, table.status),
    companyTypeIdx: index("expansion_requests_company_type_idx").on(table.companyId, table.requestType),
  }),
);
