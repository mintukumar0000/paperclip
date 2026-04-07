// ---------------------------------------------------------------------------
// Agent Profiles — runtime state for collaboration-aware agent instances
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq, and } from "@paperclipai/db";
import { getRoleDefinition, type RoleDefinition } from "./roleRegistry.js";
import pino from "pino";

const logger = pino({ name: "agent-profiles" });

export interface AgentProfile {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
  reportsTo: string | null;
  capabilities: string[];
  taskTypes: string[];
  canDelegate: boolean;
  canApprove: boolean;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  roleDefinition: RoleDefinition;
}

/** Build a collaboration-aware profile for an agent */
export function buildAgentProfile(agent: typeof agents.$inferSelect): AgentProfile {
  const roleDef = getRoleDefinition(agent.role);

  // Merge DB capabilities with role defaults
  const dbCapabilities = agent.capabilities
    ? agent.capabilities.split(",").map((c) => c.trim()).filter(Boolean)
    : [];
  const mergedCapabilities = [...new Set([...roleDef.capabilities, ...dbCapabilities])];

  return {
    id: agent.id,
    companyId: agent.companyId,
    name: agent.name,
    role: agent.role,
    title: agent.title,
    status: agent.status,
    reportsTo: agent.reportsTo,
    capabilities: mergedCapabilities,
    taskTypes: roleDef.taskTypes,
    canDelegate: roleDef.canDelegate,
    canApprove: roleDef.canApprove,
    budgetMonthlyCents: agent.budgetMonthlyCents,
    spentMonthlyCents: agent.spentMonthlyCents,
    roleDefinition: roleDef,
  };
}

/** Load all active agent profiles for a company */
export async function loadCompanyProfiles(
  db: Db,
  companyId: string,
): Promise<AgentProfile[]> {
  const rows = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agents.status, "active"),
      ),
    );

  const profiles = rows.map(buildAgentProfile);
  logger.debug({ companyId, agentCount: profiles.length }, "Loaded company agent profiles");
  return profiles;
}

/** Load profiles for agents that can handle a specific task type */
export async function findAgentsForTaskType(
  db: Db,
  companyId: string,
  taskType: string,
): Promise<AgentProfile[]> {
  const profiles = await loadCompanyProfiles(db, companyId);
  return profiles.filter((p) => p.taskTypes.includes(taskType));
}

/** Find the CEO or top-level delegator for a company */
export async function findDelegator(
  db: Db,
  companyId: string,
): Promise<AgentProfile | null> {
  const profiles = await loadCompanyProfiles(db, companyId);
  // Prefer CEO, then lowest priority number
  const sorted = profiles
    .filter((p) => p.canDelegate)
    .sort((a, b) => a.roleDefinition.priority - b.roleDefinition.priority);
  return sorted[0] ?? null;
}

/** Load a single agent profile by ID */
export async function loadAgentProfile(
  db: Db,
  agentId: string,
): Promise<AgentProfile | null> {
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!row) return null;
  return buildAgentProfile(row);
}
