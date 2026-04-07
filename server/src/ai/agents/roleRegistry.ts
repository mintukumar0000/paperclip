// ---------------------------------------------------------------------------
// Role Registry — defines capabilities, skills, and task scopes for each role
// ---------------------------------------------------------------------------

import type { AgentRole } from "@paperclipai/shared";

export interface RoleDefinition {
  role: AgentRole;
  title: string;
  capabilities: string[];
  taskTypes: string[];
  canDelegate: boolean;
  canApprove: boolean;
  priority: number; // lower = higher priority (CEO=1)
}

const roleDefinitions: Record<string, RoleDefinition> = {
  ceo: {
    role: "ceo",
    title: "Chief Executive Officer",
    capabilities: ["strategic_planning", "delegation", "budget_management", "hiring", "goal_setting", "company_oversight"],
    taskTypes: ["strategy", "planning", "delegation", "oversight", "hiring"],
    canDelegate: true,
    canApprove: true,
    priority: 1,
  },
  cto: {
    role: "cto",
    title: "Chief Technology Officer",
    capabilities: ["technical_architecture", "code_review", "system_design", "engineering_oversight", "tech_decisions"],
    taskTypes: ["architecture", "technical_planning", "code_review", "system_design", "engineering"],
    canDelegate: true,
    canApprove: true,
    priority: 2,
  },
  cmo: {
    role: "cmo",
    title: "Chief Marketing Officer",
    capabilities: ["marketing_strategy", "content_creation", "brand_management", "campaign_planning", "market_analysis"],
    taskTypes: ["marketing", "content", "branding", "campaigns", "market_research"],
    canDelegate: true,
    canApprove: true,
    priority: 2,
  },
  cfo: {
    role: "cfo",
    title: "Chief Financial Officer",
    capabilities: ["financial_planning", "budget_analysis", "cost_optimization", "financial_reporting"],
    taskTypes: ["finance", "budgeting", "cost_analysis", "financial_reporting"],
    canDelegate: true,
    canApprove: true,
    priority: 2,
  },
  engineer: {
    role: "engineer",
    title: "Software Engineer",
    capabilities: ["coding", "debugging", "testing", "implementation", "code_review"],
    taskTypes: ["implementation", "bug_fix", "feature", "testing", "code_review", "engineering"],
    canDelegate: false,
    canApprove: false,
    priority: 5,
  },
  designer: {
    role: "designer",
    title: "Designer",
    capabilities: ["ui_design", "ux_research", "prototyping", "visual_design"],
    taskTypes: ["design", "ui", "ux", "prototyping", "visual_design"],
    canDelegate: false,
    canApprove: false,
    priority: 5,
  },
  pm: {
    role: "pm",
    title: "Product Manager",
    capabilities: ["product_planning", "requirements", "prioritization", "stakeholder_management"],
    taskTypes: ["product_planning", "requirements", "prioritization", "planning"],
    canDelegate: true,
    canApprove: false,
    priority: 3,
  },
  qa: {
    role: "qa",
    title: "QA Engineer",
    capabilities: ["testing", "quality_assurance", "test_planning", "bug_reporting"],
    taskTypes: ["testing", "qa", "bug_reporting", "quality_assurance"],
    canDelegate: false,
    canApprove: false,
    priority: 5,
  },
  devops: {
    role: "devops",
    title: "DevOps Engineer",
    capabilities: ["infrastructure", "deployment", "monitoring", "ci_cd", "system_administration"],
    taskTypes: ["deployment", "infrastructure", "monitoring", "ci_cd", "devops"],
    canDelegate: false,
    canApprove: false,
    priority: 4,
  },
  researcher: {
    role: "researcher",
    title: "Researcher",
    capabilities: ["research", "analysis", "data_collection", "reporting"],
    taskTypes: ["research", "analysis", "data_collection", "market_research"],
    canDelegate: false,
    canApprove: false,
    priority: 5,
  },
  general: {
    role: "general",
    title: "General Agent",
    capabilities: ["general_tasks", "communication", "coordination"],
    taskTypes: ["general", "communication", "coordination"],
    canDelegate: false,
    canApprove: false,
    priority: 10,
  },
};

/** Get the role definition for a given agent role */
export function getRoleDefinition(role: string): RoleDefinition {
  return roleDefinitions[role] ?? roleDefinitions.general;
}

/** Get all role definitions */
export function getAllRoles(): RoleDefinition[] {
  return Object.values(roleDefinitions);
}

/** Check if a role can handle a given task type */
export function canRoleHandleTask(role: string, taskType: string): boolean {
  const def = getRoleDefinition(role);
  return def.taskTypes.includes(taskType);
}

/** Find the best role for a given task type */
export function findBestRoleForTask(taskType: string): AgentRole {
  for (const def of Object.values(roleDefinitions)) {
    if (def.taskTypes.includes(taskType)) {
      return def.role;
    }
  }
  return "general";
}

/** Check if a role has a specific capability */
export function roleHasCapability(role: string, capability: string): boolean {
  const def = getRoleDefinition(role);
  return def.capabilities.includes(capability);
}
