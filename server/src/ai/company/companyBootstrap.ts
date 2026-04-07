// ---------------------------------------------------------------------------
// Company Bootstrap — provisions initial workforce for a new company
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import type { AgentRoleSpec, BusinessModel } from "../ecosystem/businessDesigner.js";
import { createDepartment } from "../expansion/departmentPlanner.js";
import { publishEvent } from "../../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "company-bootstrap" });

export interface BootstrapResult {
  companyId: string;
  companyName: string;
  agentsCreated: AgentCreated[];
  departmentsCreated: string[];
  bootstrappedAt: string;
}

export interface AgentCreated {
  agentId: string;
  name: string;
  role: string;
}

/** Maps roles to departments */
const ROLE_DEPARTMENT: Record<string, string> = {
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
  customer_success: "Customer Success",
  seo_specialist: "Marketing",
  content_writer: "Marketing",
  data_analyst: "Engineering",
  compliance_officer: "Legal",
  security_engineer: "Engineering",
};

/** Default departments to create for a new company */
const BOOTSTRAP_DEPARTMENTS: { name: string; description: string }[] = [
  { name: "Executive", description: "Strategic leadership and company oversight" },
  { name: "Engineering", description: "Software development and technical operations" },
  { name: "Product", description: "Product management and design" },
];

/**
 * Bootstrap a new company with initial agents and departments.
 *
 * Process:
 *   1. Create departments
 *   2. Create agents from business model roles
 *   3. Assign reporting chains (everyone reports to CEO)
 *   4. Publish bootstrap event
 */
export async function bootstrapCompany(
  db: Db,
  companyId: string,
  businessModel: BusinessModel,
): Promise<BootstrapResult> {
  const departmentsCreated: string[] = [];
  const agentsCreated: AgentCreated[] = [];

  // 1. Create core departments
  const neededDepts = new Set<string>();
  for (const role of businessModel.initialAgentRoles) {
    const dept = ROLE_DEPARTMENT[role.role] ?? "General";
    neededDepts.add(dept);
  }
  // Always include Executive + Engineering
  neededDepts.add("Executive");
  neededDepts.add("Engineering");

  for (const deptName of neededDepts) {
    const template = BOOTSTRAP_DEPARTMENTS.find((d) => d.name === deptName);
    try {
      await createDepartment(db, companyId, {
        name: deptName,
        description: template?.description ?? `${deptName} department`,
        capabilities: [],
      });
      departmentsCreated.push(deptName);
    } catch {
      // Department may already exist; skip
    }
  }

  // 2. Create agents — sort by priority so CEO is first
  const sortedRoles = [...businessModel.initialAgentRoles].sort(
    (a, b) => a.priority - b.priority,
  );

  let ceoAgentId: string | null = null;

  for (const roleSpec of sortedRoles) {
    const [created]: { id: string }[] = await db
      .insert(agents)
      .values({
        companyId,
        name: roleSpec.title,
        role: roleSpec.role,
        title: roleSpec.title,
        status: "idle",
        reportsTo: roleSpec.role === "ceo" ? null : ceoAgentId,
        capabilities: roleSpec.capabilities.join(","),
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        budgetMonthlyCents: Math.floor(businessModel.initialBudgetCents / businessModel.initialAgentRoles.length),
        spentMonthlyCents: 0,
        permissions: {},
        metadata: {
          bootstrapped: true,
          department: ROLE_DEPARTMENT[roleSpec.role] ?? "General",
          sourceOpportunity: businessModel.sourceOpportunity,
        },
      })
      .returning();

    agentsCreated.push({ agentId: created.id, name: roleSpec.title, role: roleSpec.role });

    if (roleSpec.role === "ceo") {
      ceoAgentId = created.id;
    }
  }

  // 3. Publish bootstrap event
  await publishEvent("ai.ecosystem.company.bootstrapped", {
    companyId,
    companyName: businessModel.companyName,
    agentsCreated: agentsCreated.length,
    departmentsCreated: departmentsCreated.length,
    roles: agentsCreated.map((a) => a.role),
  });

  logger.info(
    { companyId, agents: agentsCreated.length, departments: departmentsCreated.length },
    "Company bootstrapped",
  );

  return {
    companyId,
    companyName: businessModel.companyName,
    agentsCreated,
    departmentsCreated,
    bootstrappedAt: new Date().toISOString(),
  };
}
