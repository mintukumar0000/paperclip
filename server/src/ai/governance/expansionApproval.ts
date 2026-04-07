// ---------------------------------------------------------------------------
// Expansion Approval — approval gates for workforce expansion
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { expansionRequests } from "@paperclipai/db";
import { eq, and, desc } from "@paperclipai/db";
import type { AgentDesignSpec } from "../expansion/agentDesigner.js";
import type { CapabilityGap } from "../expansion/capabilityGapAnalyzer.js";
import { publishEvent } from "../../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "expansion-approval" });

export type ApprovalLevel = "auto" | "manager" | "ceo" | "human";
export type ExpansionStatus = "pending" | "approved" | "rejected" | "completed";

export interface ExpansionRequest {
  id: string;
  companyId: string;
  requestType: string;
  status: ExpansionStatus;
  approvalLevel: ApprovalLevel;
  requestedRole: string | null;
  reason: string;
  gapAnalysis: Record<string, unknown> | null;
  designSpec: Record<string, unknown> | null;
  resultAgentId: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
  rejectionReason: string | null;
  createdAt: Date;
}

/**
 * Determine the approval level required for creating a new agent.
 *
 * Rules (STRICT — no auto-approval for agent creation):
 *   - Anything that changes org structure:                   human
 *   - C-suite or high-priority (priority <= 3):              human
 *   - High budget (>= $10):                                  ceo
 *   - Mid-priority roles (priority 4-5):                     manager
 *   - Low-priority roles (priority >= 6):                    manager (minimum)
 *
 * Auto-approval is NEVER allowed for agent creation to prevent
 * unbounded autonomous expansion.
 */
export function determineApprovalLevel(
  design: AgentDesignSpec,
): ApprovalLevel {
  // New departments always require human approval
  if (design.canApprove) return "ceo";

  // High budget → CEO approval
  if (design.budgetCents >= 1000) return "ceo";

  // C-suite equivalent or high priority
  if (design.priority <= 3) return "human";

  // Mid-priority → manager approval
  if (design.priority <= 5) return "manager";

  // Low-priority → still requires manager approval (NEVER auto)
  return "manager";
}

/**
 * Submit an expansion request for approval.
 */
export async function submitExpansionRequest(
  db: Db,
  companyId: string,
  design: AgentDesignSpec,
  gap: CapabilityGap | null,
  requestedBy?: string,
): Promise<ExpansionRequest> {
  const approvalLevel = determineApprovalLevel(design);
  const status: ExpansionStatus = approvalLevel === "auto" ? "approved" : "pending";

  const [row] = await db
    .insert(expansionRequests)
    .values({
      companyId,
      requestType: "new_agent",
      status,
      approvalLevel,
      requestedRole: design.role,
      requestedCapabilities: design.capabilities.join(","),
      reason: design.reason,
      gapAnalysis: gap ? { ...gap } as Record<string, unknown> : null,
      designSpec: { ...design, sourceGaps: design.sourceGaps } as unknown as Record<string, unknown>,
      requestedBy: requestedBy ?? null,
    })
    .returning();

  const request: ExpansionRequest = {
    id: row.id,
    companyId: row.companyId,
    requestType: row.requestType,
    status: row.status as ExpansionStatus,
    approvalLevel: row.approvalLevel as ApprovalLevel,
    requestedRole: row.requestedRole,
    reason: row.reason,
    gapAnalysis: row.gapAnalysis,
    designSpec: row.designSpec,
    resultAgentId: row.resultAgentId,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt,
  };

  await publishEvent("ai.expansion.request.created", {
    companyId,
    requestId: row.id,
    role: design.role,
    approvalLevel,
    status,
  });

  logger.info(
    { companyId, requestId: row.id, role: design.role, approvalLevel, status },
    "Expansion request submitted",
  );

  return request;
}

/**
 * Approve an expansion request.
 */
export async function approveExpansion(
  db: Db,
  requestId: string,
  companyId: string,
  approvedBy?: string,
): Promise<boolean> {
  const [updated] = await db
    .update(expansionRequests)
    .set({ status: "approved", approvedBy: approvedBy ?? null, updatedAt: new Date() })
    .where(
      and(
        eq(expansionRequests.id, requestId),
        eq(expansionRequests.companyId, companyId),
        eq(expansionRequests.status, "pending"),
      ),
    )
    .returning();

  if (!updated) return false;

  await publishEvent("ai.expansion.request.approved", {
    companyId,
    requestId,
    role: updated.requestedRole,
    approvedBy,
  });

  return true;
}

/**
 * Reject an expansion request.
 */
export async function rejectExpansion(
  db: Db,
  requestId: string,
  companyId: string,
  rejectionReason: string,
  rejectedBy?: string,
): Promise<boolean> {
  const [updated] = await db
    .update(expansionRequests)
    .set({
      status: "rejected",
      rejectionReason,
      approvedBy: rejectedBy ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(expansionRequests.id, requestId),
        eq(expansionRequests.companyId, companyId),
        eq(expansionRequests.status, "pending"),
      ),
    )
    .returning();

  if (!updated) return false;

  await publishEvent("ai.expansion.request.rejected", {
    companyId,
    requestId,
    role: updated.requestedRole,
    rejectionReason,
  });

  return true;
}

/**
 * Mark expansion request as completed (agent created).
 */
export async function completeExpansion(
  db: Db,
  requestId: string,
  companyId: string,
  agentId: string,
): Promise<boolean> {
  const [updated] = await db
    .update(expansionRequests)
    .set({ status: "completed", resultAgentId: agentId, updatedAt: new Date() })
    .where(
      and(
        eq(expansionRequests.id, requestId),
        eq(expansionRequests.companyId, companyId),
        eq(expansionRequests.status, "approved"),
      ),
    )
    .returning();

  if (!updated) return false;

  await publishEvent("ai.expansion.request.completed", {
    companyId,
    requestId,
    agentId,
    role: updated.requestedRole,
  });

  return true;
}

/**
 * List pending expansion requests.
 */
export async function listPendingRequests(
  db: Db,
  companyId: string,
): Promise<ExpansionRequest[]> {
  const rows = await db
    .select()
    .from(expansionRequests)
    .where(
      and(
        eq(expansionRequests.companyId, companyId),
        eq(expansionRequests.status, "pending"),
      ),
    )
    .orderBy(desc(expansionRequests.createdAt));

  return rows.map(mapRow);
}

/**
 * List all expansion requests for a company.
 */
export async function listExpansionRequests(
  db: Db,
  companyId: string,
  status?: ExpansionStatus,
): Promise<ExpansionRequest[]> {
  const conditions = [eq(expansionRequests.companyId, companyId)];
  if (status) conditions.push(eq(expansionRequests.status, status));

  const rows = await db
    .select()
    .from(expansionRequests)
    .where(and(...conditions))
    .orderBy(desc(expansionRequests.createdAt))
    .limit(100);

  return rows.map(mapRow);
}

function mapRow(row: typeof expansionRequests.$inferSelect): ExpansionRequest {
  return {
    id: row.id,
    companyId: row.companyId,
    requestType: row.requestType,
    status: row.status as ExpansionStatus,
    approvalLevel: row.approvalLevel as ApprovalLevel,
    requestedRole: row.requestedRole,
    reason: row.reason,
    gapAnalysis: row.gapAnalysis,
    designSpec: row.designSpec,
    resultAgentId: row.resultAgentId,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt,
  };
}
