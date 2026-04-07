import pino from "pino";

const logger = pino({ name: "ai-action-guard" });

/** Actions that are never allowed through the AI tool pipeline */
const FORBIDDEN_ACTIONS = new Set([
  "delete_company",
  "drop_database",
  "delete_all_issues",
  "delete_all_agents",
  "reset_database",
  "destroy_workspace",
  "execute_raw_sql",
]);

/** Actions that require explicit approval before execution */
const APPROVAL_REQUIRED_ACTIONS = new Set([
  "delete_issue",
  "remove_agent",
  "modify_budget",
  "change_company_settings",
]);

/**
 * Guard against destructive or forbidden tool calls.
 * Throws if the action is forbidden.
 */
export function guardAction(action: string): void {
  if (FORBIDDEN_ACTIONS.has(action)) {
    logger.warn({ action }, "Forbidden action blocked by guard");
    throw new GuardedActionError(action, "forbidden");
  }

  if (APPROVAL_REQUIRED_ACTIONS.has(action)) {
    logger.info({ action }, "Action flagged as requiring approval");
    // For now, we log + allow; the approval gate can be wired into the
    // existing approval service in a follow-up integration.
  }
}

export class GuardedActionError extends Error {
  readonly action: string;
  readonly reason: "forbidden" | "approval_required";

  constructor(action: string, reason: "forbidden" | "approval_required") {
    super(`Action "${action}" is ${reason}`);
    this.name = "GuardedActionError";
    this.action = action;
    this.reason = reason;
  }
}

/** Check if an action is forbidden without throwing */
export function isActionForbidden(action: string): boolean {
  return FORBIDDEN_ACTIONS.has(action);
}

/** Check if an action requires approval */
export function isActionApprovalRequired(action: string): boolean {
  return APPROVAL_REQUIRED_ACTIONS.has(action);
}
