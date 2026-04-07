// ---------------------------------------------------------------------------
// Approval Gate — human approval enforcement for high-risk agent actions
// ---------------------------------------------------------------------------
//
// Extends the existing actionGuard with a proper approval workflow:
//   1. Agent requests to perform a guarded action
//   2. Gate checks if the action requires approval
//   3. If yes, creates an approval request and pauses the agent
//   4. Human approves/rejects via the Dashboard
//   5. On approval, the action is allowed to proceed
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "@paperclipai/db";
import { isActionForbidden, isActionApprovalRequired } from "../guards/actionGuard.js";
import { sendAgentMessage } from "../coordination/agentMessenger.js";
import { publishEvent } from "../../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "approval-gate" });

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalRequest {
  id: string;
  companyId: string;
  agentId: string;
  action: string;
  description: string;
  status: ApprovalStatus;
  requestedAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
  context?: Record<string, unknown>;
}

// In-memory pending approvals (production would use DB table)
const pendingApprovals = new Map<string, ApprovalRequest>();

/** Actions requiring manager-level approval */
const MANAGER_APPROVAL_ACTIONS = new Set([
  "deploy_to_production",
  "modify_infrastructure",
  "mass_email",
  "delete_database",
  "create_external_account",
  "large_purchase",
]);

/** Actions requiring CEO approval only */
const CEO_APPROVAL_ACTIONS = new Set([
  "hire_agent",
  "terminate_agent",
  "change_company_strategy",
  "modify_company_budget",
]);

/**
 * Check if an action is allowed to proceed.
 * Returns the approval status and blocks if needed.
 */
export async function checkApproval(
  db: Db,
  agentId: string,
  companyId: string,
  action: string,
  description: string,
  context?: Record<string, unknown>,
): Promise<{
  allowed: boolean;
  reason: string;
  approvalId?: string;
}> {
  // Hard block on forbidden actions
  if (isActionForbidden(action)) {
    return { allowed: false, reason: `Action "${action}" is forbidden` };
  }

  // Check if already approved
  const existing = findExistingApproval(agentId, action);
  if (existing) {
    if (existing.status === "approved") {
      // Consume the approval
      pendingApprovals.delete(existing.id);
      return { allowed: true, reason: "Previously approved" };
    }
    if (existing.status === "rejected") {
      pendingApprovals.delete(existing.id);
      return { allowed: false, reason: "Previously rejected" };
    }
    // Still pending
    return {
      allowed: false,
      reason: "Awaiting approval",
      approvalId: existing.id,
    };
  }

  // Check if approval is required
  const needsApproval =
    isActionApprovalRequired(action) ||
    MANAGER_APPROVAL_ACTIONS.has(action) ||
    CEO_APPROVAL_ACTIONS.has(action);

  if (!needsApproval) {
    return { allowed: true, reason: "No approval required" };
  }

  // Create approval request
  const approvalId = crypto.randomUUID();
  const request: ApprovalRequest = {
    id: approvalId,
    companyId,
    agentId,
    action,
    description,
    status: "pending",
    requestedAt: new Date(),
    context,
  };

  pendingApprovals.set(approvalId, request);

  // Set agent to pending_approval status
  await db
    .update(agents)
    .set({ status: "pending_approval", updatedAt: new Date() })
    .where(eq(agents.id, agentId));

  await publishEvent("approval.requested", {
    approvalId,
    companyId,
    agentId,
    action,
    description,
  });

  logger.info({ approvalId, agentId, action }, "Approval requested");

  return {
    allowed: false,
    reason: `Approval required for "${action}"`,
    approvalId,
  };
}

/**
 * Approve a pending request.
 */
export async function approveAction(
  db: Db,
  approvalId: string,
  approvedBy: string,
): Promise<{ success: boolean; reason: string }> {
  const request = pendingApprovals.get(approvalId);
  if (!request) {
    return { success: false, reason: "Approval request not found" };
  }
  if (request.status !== "pending") {
    return { success: false, reason: `Request is already ${request.status}` };
  }

  request.status = "approved";
  request.resolvedAt = new Date();
  request.resolvedBy = approvedBy;

  // Restore agent to active status
  await db
    .update(agents)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(agents.id, request.agentId));

  await publishEvent("approval.approved", {
    approvalId,
    companyId: request.companyId,
    agentId: request.agentId,
    action: request.action,
    approvedBy,
  });

  logger.info({ approvalId, action: request.action, approvedBy }, "Action approved");

  return { success: true, reason: "Approved" };
}

/**
 * Reject a pending request.
 */
export async function rejectAction(
  db: Db,
  approvalId: string,
  rejectedBy: string,
  reason?: string,
): Promise<{ success: boolean; reason: string }> {
  const request = pendingApprovals.get(approvalId);
  if (!request) {
    return { success: false, reason: "Approval request not found" };
  }
  if (request.status !== "pending") {
    return { success: false, reason: `Request is already ${request.status}` };
  }

  request.status = "rejected";
  request.resolvedAt = new Date();
  request.resolvedBy = rejectedBy;

  // Restore agent to active status (can try different approach)
  await db
    .update(agents)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(agents.id, request.agentId));

  await publishEvent("approval.rejected", {
    approvalId,
    companyId: request.companyId,
    agentId: request.agentId,
    action: request.action,
    rejectedBy,
    reason,
  });

  logger.info({ approvalId, action: request.action, rejectedBy }, "Action rejected");

  return { success: true, reason: reason ?? "Rejected" };
}

/**
 * List all pending approvals for a company.
 */
export function listPendingApprovals(companyId: string): ApprovalRequest[] {
  return Array.from(pendingApprovals.values()).filter(
    (r) => r.companyId === companyId && r.status === "pending",
  );
}

/**
 * Get a specific approval request by ID.
 */
export function getApproval(approvalId: string): ApprovalRequest | undefined {
  return pendingApprovals.get(approvalId);
}

/** Find existing pending approval for same agent+action */
function findExistingApproval(agentId: string, action: string): ApprovalRequest | undefined {
  for (const req of pendingApprovals.values()) {
    if (req.agentId === agentId && req.action === action && req.status === "pending") {
      return req;
    }
  }
  return undefined;
}

/**
 * Check what approval level is required for an action.
 */
export function getApprovalLevel(action: string): "none" | "manager" | "ceo" | "forbidden" {
  if (isActionForbidden(action)) return "forbidden";
  if (CEO_APPROVAL_ACTIONS.has(action)) return "ceo";
  if (MANAGER_APPROVAL_ACTIONS.has(action) || isActionApprovalRequired(action)) return "manager";
  return "none";
}
