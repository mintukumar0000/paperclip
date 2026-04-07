// ---------------------------------------------------------------------------
// Department Planner — organizes agents into departments
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { departments, agents } from "@paperclipai/db";
import { eq, and } from "@paperclipai/db";
import { loadCompanyProfiles } from "../agents/agentProfiles.js";
import { publishEvent } from "../../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "department-planner" });

export interface Department {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  headAgentId: string | null;
  parentDepartmentId: string | null;
  capabilities: string[];
  agentCount: number;
  createdAt: Date;
}

export interface DepartmentPlan {
  companyId: string;
  existing: Department[];
  proposed: ProposedDepartment[];
  agentAssignments: AgentDepartmentAssignment[];
  generatedAt: Date;
}

export interface ProposedDepartment {
  name: string;
  description: string;
  suggestedHead: string | null; // agent role
  capabilities: string[];
  reason: string;
}

export interface AgentDepartmentAssignment {
  agentId: string;
  agentRole: string;
  departmentName: string;
  reason: string;
}

/** Default department templates */
export const DEFAULT_DEPARTMENTS: Record<string, { description: string; headRole: string; capabilities: string[] }> = {
  Executive: {
    description: "Strategic leadership and company oversight",
    headRole: "ceo",
    capabilities: ["strategic_planning", "delegation", "goal_setting", "company_oversight"],
  },
  Engineering: {
    description: "Software development, architecture, and technical operations",
    headRole: "cto",
    capabilities: ["coding", "debugging", "testing", "system_design", "infrastructure"],
  },
  Marketing: {
    description: "Marketing strategy, brand management, and campaign execution",
    headRole: "cmo",
    capabilities: ["marketing_strategy", "content_creation", "campaign_planning", "brand_management"],
  },
  Finance: {
    description: "Financial planning, budgeting, and cost analysis",
    headRole: "cfo",
    capabilities: ["financial_planning", "budget_analysis", "cost_optimization"],
  },
  Product: {
    description: "Product management, design, and user experience",
    headRole: "pm",
    capabilities: ["product_planning", "ui_design", "ux_research", "requirements"],
  },
};

/**
 * Get all departments for a company.
 */
export async function getCompanyDepartments(
  db: Db,
  companyId: string,
): Promise<Department[]> {
  const rows = await db
    .select()
    .from(departments)
    .where(eq(departments.companyId, companyId));

  return rows.map((r) => ({
    id: r.id,
    companyId: r.companyId,
    name: r.name,
    description: r.description,
    headAgentId: r.headAgentId,
    parentDepartmentId: r.parentDepartmentId,
    capabilities: r.capabilities ? r.capabilities.split(",").map((c) => c.trim()).filter(Boolean) : [],
    agentCount: 0, // will be enriched below
    createdAt: r.createdAt,
  }));
}

/**
 * Plan department structure based on current agents and gaps.
 */
export async function planDepartments(
  db: Db,
  companyId: string,
): Promise<DepartmentPlan> {
  const existing = await getCompanyDepartments(db, companyId);
  const profiles = await loadCompanyProfiles(db, companyId);
  const existingNames = new Set(existing.map((d) => d.name));

  const proposed: ProposedDepartment[] = [];
  const assignments: AgentDepartmentAssignment[] = [];

  // Check which default departments are missing
  for (const [name, template] of Object.entries(DEFAULT_DEPARTMENTS)) {
    if (existingNames.has(name)) continue;
    // Only propose if we have an agent of the head role
    const hasHead = profiles.some((p) => p.role === template.headRole);
    if (hasHead) {
      proposed.push({
        name,
        description: template.description,
        suggestedHead: template.headRole,
        capabilities: template.capabilities,
        reason: `Default department for ${template.headRole} role`,
      });
    }
  }

  // Assign agents to departments based on their roles
  for (const profile of profiles) {
    const dept = agentToDepartment(profile.role);
    if (dept && (existingNames.has(dept) || proposed.some((p) => p.name === dept))) {
      assignments.push({
        agentId: profile.id,
        agentRole: profile.role,
        departmentName: dept,
        reason: `Role ${profile.role} belongs to ${dept}`,
      });
    }
  }

  const plan: DepartmentPlan = {
    companyId,
    existing,
    proposed,
    agentAssignments: assignments,
    generatedAt: new Date(),
  };

  logger.info(
    { companyId, existing: existing.length, proposed: proposed.length, assignments: assignments.length },
    "Department plan generated",
  );

  return plan;
}

/**
 * Create a department.
 */
export async function createDepartment(
  db: Db,
  companyId: string,
  data: { name: string; description?: string; headAgentId?: string; capabilities?: string[] },
): Promise<Department> {
  const [row] = await db
    .insert(departments)
    .values({
      companyId,
      name: data.name,
      description: data.description ?? null,
      headAgentId: data.headAgentId ?? null,
      capabilities: data.capabilities?.join(",") ?? null,
    })
    .returning();

  await publishEvent("ai.expansion.department.created", {
    companyId,
    departmentId: row.id,
    name: data.name,
  });

  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    description: row.description,
    headAgentId: row.headAgentId,
    parentDepartmentId: row.parentDepartmentId,
    capabilities: row.capabilities ? row.capabilities.split(",").map((c) => c.trim()) : [],
    agentCount: 0,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agentToDepartment(role: string): string | null {
  const mapping: Record<string, string> = {
    ceo: "Executive",
    cto: "Engineering",
    cmo: "Marketing",
    cfo: "Finance",
    engineer: "Engineering",
    designer: "Product",
    pm: "Product",
    qa: "Engineering",
    devops: "Engineering",
    researcher: "Marketing",
    localization_specialist: "Localization",
    compliance_officer: "Legal",
    data_analyst: "Analytics",
    security_engineer: "Engineering",
    customer_success_agent: "Customer Success",
    seo_specialist: "Marketing",
    content_writer: "Marketing",
  };
  return mapping[role] ?? null;
}
