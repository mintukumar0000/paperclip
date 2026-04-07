// ---------------------------------------------------------------------------
// Governance Rule Enforcement Engine
// ---------------------------------------------------------------------------
// Evaluates constitutional governance rules before critical actions.
// Rules are stored in the governance_rules table with types:
//   economic, ethical, strategic, safety, operational
// Severity levels determine behavior:
//   blocking  — hard stop, action is denied
//   warning   — action proceeds but is logged as a warning
//   advisory  — informational only, logged for audit
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { eq, and } from "@paperclipai/db";
import { governanceRules } from "@paperclipai/db";
import pino from "pino";
import { eventBus } from "../../events/eventBus.js";

const logger = pino({ name: "rule-enforcement" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The kind of action being evaluated against rules */
export type RuleActionContext =
  | "company_expansion"
  | "agent_hiring"
  | "budget_allocation"
  | "goal_creation"
  | "department_creation"
  | "product_launch"
  | "service_registration";

/** Context provided when requesting rule evaluation */
export interface RuleEvaluationRequest {
  companyId: string;
  action: RuleActionContext;
  actorId: string;
  /** Key-value metadata the rule definitions can reference */
  context: Record<string, unknown>;
}

/** A single rule's evaluation result */
export interface RuleResult {
  ruleId: string;
  ruleName: string;
  ruleType: string;
  severity: string;
  matched: boolean;
  message: string;
}

/** Aggregate result from evaluating all applicable rules */
export interface RuleEvaluationDecision {
  allowed: boolean;
  blockedBy: RuleResult[];
  warnings: RuleResult[];
  advisories: RuleResult[];
  totalRulesEvaluated: number;
}

// ---------------------------------------------------------------------------
// Rule Matching
// ---------------------------------------------------------------------------

/**
 * Map an action to the relevant rule types that should be checked.
 * For example, "budget_allocation" checks economic rules;
 * "agent_hiring" checks economic + operational rules.
 */
function getRuleTypesForAction(action: RuleActionContext): string[] {
  switch (action) {
    case "company_expansion":
      return ["strategic", "economic", "safety"];
    case "agent_hiring":
      return ["economic", "operational", "safety"];
    case "budget_allocation":
      return ["economic", "safety"];
    case "goal_creation":
      return ["strategic", "ethical", "safety"];
    case "department_creation":
      return ["strategic", "operational"];
    case "product_launch":
      return ["strategic", "economic", "ethical"];
    case "service_registration":
      return ["economic", "operational"];
    default:
      return ["safety"]; // safety rules always apply
  }
}

/**
 * Evaluate a single rule's definition against the provided context.
 *
 * Rule definitions are plain-text constraints. We do keyword matching
 * on the context values to determine if the rule applies.
 * For example, a rule definition "budget must not exceed 10000" would
 * match if context.budgetCents > 10000.
 *
 * This is a simple first-pass evaluator. A more sophisticated version
 * could parse structured rule definitions (JSON conditions).
 */
function evaluateRuleDefinition(
  ruleDefinition: string,
  context: Record<string, unknown>,
): { matched: boolean; message: string } {
  const defLower = ruleDefinition.toLowerCase();

  // Check for budget/cost threshold rules
  const budgetMatch = defLower.match(/budget.*(?:not exceed|must not exceed|max|maximum|limit)\s*(\d+)/);
  if (budgetMatch) {
    const threshold = parseInt(budgetMatch[1], 10);
    const budgetValue = Number(context.budgetCents ?? context.estimatedCostCents ?? 0);
    if (budgetValue > threshold) {
      return { matched: true, message: `Budget ${budgetValue} exceeds rule limit of ${threshold}` };
    }
  }

  // Check for headcount/agent count rules
  const countMatch = defLower.match(/(?:agent|headcount|workforce).*(?:not exceed|max|maximum|limit)\s*(\d+)/);
  if (countMatch) {
    const threshold = parseInt(countMatch[1], 10);
    const count = Number(context.agentCount ?? context.headcount ?? 0);
    if (count > threshold) {
      return { matched: true, message: `Count ${count} exceeds rule limit of ${threshold}` };
    }
  }

  // Check for forbidden keyword rules (e.g. "must not involve weapons")
  const forbidMatch = defLower.match(/must not (?:involve|include|contain|use)\s+(.+)/);
  if (forbidMatch) {
    const forbidden = forbidMatch[1].trim();
    const contextStr = JSON.stringify(context).toLowerCase();
    if (contextStr.includes(forbidden)) {
      return { matched: true, message: `Context contains forbidden term: "${forbidden}"` };
    }
  }

  // Check for required approval rules
  if (defLower.includes("requires approval") || defLower.includes("must be approved")) {
    const hasApproval = Boolean(context.approved);
    if (!hasApproval) {
      return { matched: true, message: "Action requires approval but none was provided" };
    }
  }

  return { matched: false, message: "Rule does not apply to this context" };
}

// ---------------------------------------------------------------------------
// Core Engine
// ---------------------------------------------------------------------------

/**
 * Evaluate all active governance rules for a company against a proposed action.
 * Returns a decision indicating whether the action is allowed, with details
 * about any blocking rules, warnings, or advisories.
 */
export async function evaluateGovernanceRules(
  db: Db,
  request: RuleEvaluationRequest,
): Promise<RuleEvaluationDecision> {
  const ruleTypes = getRuleTypesForAction(request.action);

  // Fetch all active rules for this company
  const activeRules = await db
    .select()
    .from(governanceRules)
    .where(
      and(
        eq(governanceRules.companyId, request.companyId),
        eq(governanceRules.active, true),
      ),
    );

  // Filter to relevant rule types
  const applicableRules = activeRules.filter((r) =>
    ruleTypes.includes(r.ruleType),
  );

  const blockedBy: RuleResult[] = [];
  const warnings: RuleResult[] = [];
  const advisories: RuleResult[] = [];

  for (const rule of applicableRules) {
    const evaluation = evaluateRuleDefinition(rule.ruleDefinition, request.context);

    const result: RuleResult = {
      ruleId: rule.id,
      ruleName: rule.ruleName,
      ruleType: rule.ruleType,
      severity: rule.severity,
      matched: evaluation.matched,
      message: evaluation.message,
    };

    if (!evaluation.matched) continue;

    if (rule.severity === "blocking") {
      blockedBy.push(result);
    } else if (rule.severity === "warning") {
      warnings.push(result);
    } else {
      advisories.push(result);
    }
  }

  const allowed = blockedBy.length === 0;

  // Emit telemetry
  eventBus.publish("governance.rule.evaluated", {
    companyId: request.companyId,
    action: request.action,
    actorId: request.actorId,
    totalRulesEvaluated: applicableRules.length,
    blockedCount: blockedBy.length,
    warningCount: warnings.length,
    advisoryCount: advisories.length,
    allowed,
    timestamp: new Date().toISOString(),
  });

  if (!allowed) {
    eventBus.publish("governance.rule.blocked", {
      companyId: request.companyId,
      action: request.action,
      actorId: request.actorId,
      blockedBy: blockedBy.map((r) => ({ ruleId: r.ruleId, ruleName: r.ruleName, message: r.message })),
      timestamp: new Date().toISOString(),
    });
    logger.warn(
      { companyId: request.companyId, action: request.action, blockedBy: blockedBy.length },
      "Action blocked by governance rules",
    );
  }

  if (warnings.length > 0) {
    eventBus.publish("governance.rule.warned", {
      companyId: request.companyId,
      action: request.action,
      warnings: warnings.map((r) => ({ ruleId: r.ruleId, ruleName: r.ruleName, message: r.message })),
      timestamp: new Date().toISOString(),
    });
    logger.info(
      { companyId: request.companyId, action: request.action, warnings: warnings.length },
      "Action proceeding with governance warnings",
    );
  }

  return {
    allowed,
    blockedBy,
    warnings,
    advisories,
    totalRulesEvaluated: applicableRules.length,
  };
}
