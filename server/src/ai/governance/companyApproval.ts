// ---------------------------------------------------------------------------
// Company Approval — governance gates for autonomous company creation
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { expansionRequests } from "@paperclipai/db";
import { eq, and, desc } from "@paperclipai/db";
import type { BusinessModel } from "../ecosystem/businessDesigner.js";
import { publishEvent } from "../../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "company-approval" });

export type CompanyApprovalLevel = "auto" | "manager" | "ceo" | "human";
export type CompanyApprovalStatus = "pending" | "approved" | "rejected" | "completed";

export interface CompanyApprovalRequest {
  id: string;
  companyId: string; // the source/ecosystem company
  requestType: string;
  status: CompanyApprovalStatus;
  approvalLevel: CompanyApprovalLevel;
  requestedRole: string | null;
  reason: string;
  designSpec: Record<string, unknown> | null;
  resultCompanyId: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
  rejectionReason: string | null;
  createdAt: Date;
}

/**
 * Determine approval level for creating a new company.
 *
 * Rules (STRICT — no auto-approval for company creation):
 *   - Enterprise or marketplace:                             human
 *   - High budget (>= $80):                                  ceo
 *   - Medium budget (>= $30):                                ceo
 *   - Low budget (< $30):                                    manager (minimum)
 *
 * Auto-approval is NEVER allowed for company creation to prevent
 * unbounded ecosystem expansion.
 */
export function determineCompanyApprovalLevel(
  model: BusinessModel,
): CompanyApprovalLevel {
  // Enterprise or marketplace → human
  if (model.revenueModel === "enterprise" || model.revenueModel === "marketplace") {
    return "human";
  }

  // High budget → CEO
  if (model.initialBudgetCents >= 8000) {
    return "ceo";
  }

  // Medium budget → CEO
  if (model.initialBudgetCents >= 3000) {
    return "ceo";
  }

  // Low budget → still requires manager approval (NEVER auto)
  return "manager";
}

/**
 * Submit a company creation request.
 */
export async function submitCompanyCreationRequest(
  db: Db,
  sourceCompanyId: string,
  model: BusinessModel,
  requestedBy?: string,
): Promise<CompanyApprovalRequest> {
  const approvalLevel = determineCompanyApprovalLevel(model);
  const status: CompanyApprovalStatus = approvalLevel === "auto" ? "approved" : "pending";

  const [row] = await db
    .insert(expansionRequests)
    .values({
      companyId: sourceCompanyId,
      requestType: "new_company",
      status,
      approvalLevel,
      requestedRole: null,
      requestedCapabilities: model.initialAgentRoles.map((r) => r.role).join(","),
      reason: `Create new company: ${model.companyName} — ${model.product}`,
      gapAnalysis: null,
      designSpec: { ...model } as unknown as Record<string, unknown>,
      requestedBy: requestedBy ?? null,
    })
    .returning();

  const request: CompanyApprovalRequest = mapRow(row);

  await publishEvent("ai.ecosystem.company.request.created", {
    sourceCompanyId,
    requestId: row.id,
    companyName: model.companyName,
    approvalLevel,
    status,
  });

  logger.info(
    { sourceCompanyId, requestId: row.id, companyName: model.companyName, approvalLevel, status },
    "Company creation request submitted",
  );

  return request;
}

/**
 * Approve a company creation request.
 */
export async function approveCompanyCreation(
  db: Db,
  requestId: string,
  sourceCompanyId: string,
  approvedBy?: string,
): Promise<boolean> {
  const [updated] = await db
    .update(expansionRequests)
    .set({ status: "approved", approvedBy: approvedBy ?? null, updatedAt: new Date() })
    .where(
      and(
        eq(expansionRequests.id, requestId),
        eq(expansionRequests.companyId, sourceCompanyId),
        eq(expansionRequests.status, "pending"),
      ),
    )
    .returning();

  if (!updated) return false;

  await publishEvent("ai.ecosystem.company.request.approved", {
    sourceCompanyId,
    requestId,
    approvedBy,
  });

  return true;
}

/**
 * Reject a company creation request.
 */
export async function rejectCompanyCreation(
  db: Db,
  requestId: string,
  sourceCompanyId: string,
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
        eq(expansionRequests.companyId, sourceCompanyId),
        eq(expansionRequests.status, "pending"),
      ),
    )
    .returning();

  if (!updated) return false;

  await publishEvent("ai.ecosystem.company.request.rejected", {
    sourceCompanyId,
    requestId,
    rejectionReason,
  });

  return true;
}

/**
 * Mark a company creation request as completed.
 */
export async function completeCompanyCreation(
  db: Db,
  requestId: string,
  sourceCompanyId: string,
  newCompanyId: string,
): Promise<boolean> {
  const [updated] = await db
    .update(expansionRequests)
    .set({
      status: "completed",
      resultDepartmentId: null,
      resultAgentId: null,
      metadata: { resultCompanyId: newCompanyId },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(expansionRequests.id, requestId),
        eq(expansionRequests.companyId, sourceCompanyId),
        eq(expansionRequests.status, "approved"),
      ),
    )
    .returning();

  if (!updated) return false;

  await publishEvent("ai.ecosystem.company.request.completed", {
    sourceCompanyId,
    requestId,
    newCompanyId,
  });

  return true;
}

/**
 * List pending company creation requests.
 */
export async function listPendingCompanyRequests(
  db: Db,
  sourceCompanyId: string,
): Promise<CompanyApprovalRequest[]> {
  const rows = await db
    .select()
    .from(expansionRequests)
    .where(
      and(
        eq(expansionRequests.companyId, sourceCompanyId),
        eq(expansionRequests.requestType, "new_company"),
        eq(expansionRequests.status, "pending"),
      ),
    )
    .orderBy(desc(expansionRequests.createdAt));

  return rows.map(mapRow);
}

/**
 * List all company creation requests.
 */
export async function listCompanyRequests(
  db: Db,
  sourceCompanyId: string,
  status?: CompanyApprovalStatus,
): Promise<CompanyApprovalRequest[]> {
  const conditions = [
    eq(expansionRequests.companyId, sourceCompanyId),
    eq(expansionRequests.requestType, "new_company"),
  ];
  if (status) conditions.push(eq(expansionRequests.status, status));

  const rows = await db
    .select()
    .from(expansionRequests)
    .where(and(...conditions))
    .orderBy(desc(expansionRequests.createdAt))
    .limit(100);

  return rows.map(mapRow);
}

function mapRow(row: typeof expansionRequests.$inferSelect): CompanyApprovalRequest {
  return {
    id: row.id,
    companyId: row.companyId,
    requestType: row.requestType,
    status: row.status as CompanyApprovalStatus,
    approvalLevel: row.approvalLevel as CompanyApprovalLevel,
    requestedRole: row.requestedRole,
    reason: row.reason,
    designSpec: row.designSpec,
    resultCompanyId: (row.metadata as Record<string, unknown>)?.resultCompanyId as string ?? null,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt,
  };
}
