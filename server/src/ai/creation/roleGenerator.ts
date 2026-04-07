// ---------------------------------------------------------------------------
// Role Generator — generates structured role definitions from design specs
// ---------------------------------------------------------------------------

import type { AgentDesignSpec } from "../expansion/agentDesigner.js";
import type { RoleDefinition } from "../agents/roleRegistry.js";
import pino from "pino";

const logger = pino({ name: "role-generator" });

export interface GeneratedRole extends RoleDefinition {
  department: string;
  reportsTo: string;
  budgetCents: number;
  generatedFrom: string; // source gap or request
}

/**
 * Generate a role definition from an agent design spec.
 */
export function generateRole(design: AgentDesignSpec): GeneratedRole {
  return {
    role: design.role as RoleDefinition["role"],
    title: design.title,
    capabilities: [...design.capabilities],
    taskTypes: [...design.taskTypes],
    canDelegate: design.canDelegate,
    canApprove: design.canApprove,
    priority: design.priority,
    department: design.department,
    reportsTo: design.reportsTo,
    budgetCents: design.budgetCents,
    generatedFrom: design.sourceGaps.join(","),
  };
}

/**
 * Generate multiple roles from design specs.
 */
export function generateRoles(designs: AgentDesignSpec[]): GeneratedRole[] {
  const roles = designs.map(generateRole);
  logger.info({ count: roles.length }, "Roles generated");
  return roles;
}

/**
 * Validate a generated role has minimum required fields.
 */
export function validateRole(role: GeneratedRole): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!role.role || role.role.length < 2) {
    errors.push("Role name must be at least 2 characters");
  }
  if (!role.title || role.title.length < 2) {
    errors.push("Title must be at least 2 characters");
  }
  if (role.capabilities.length === 0) {
    errors.push("At least one capability is required");
  }
  if (role.taskTypes.length === 0) {
    errors.push("At least one task type is required");
  }
  if (role.priority < 1 || role.priority > 10) {
    errors.push("Priority must be between 1 and 10");
  }
  if (role.budgetCents < 0) {
    errors.push("Budget cannot be negative");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Merge a generated role into a format compatible with roleRegistry.
 */
export function toRoleDefinition(generated: GeneratedRole): RoleDefinition {
  return {
    role: generated.role,
    title: generated.title,
    capabilities: generated.capabilities,
    taskTypes: generated.taskTypes,
    canDelegate: generated.canDelegate,
    canApprove: generated.canApprove,
    priority: generated.priority,
  };
}
