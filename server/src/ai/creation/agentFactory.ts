// ---------------------------------------------------------------------------
// Agent Factory — creates actual agent instances from design specs
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq, and } from "@paperclipai/db";
import type { AgentDesignSpec } from "../expansion/agentDesigner.js";
import type { GeneratedRole } from "./roleGenerator.js";
import { generateRole, validateRole } from "./roleGenerator.js";
import { loadCompanyProfiles, type AgentProfile } from "../agents/agentProfiles.js";
import { publishEvent } from "../../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "agent-factory" });

export interface AgentCreationRequest {
  companyId: string;
  design: AgentDesignSpec;
  requestedBy?: string; // agent ID that requested creation
  expansionRequestId?: string;
}

export interface AgentCreationResult {
  success: boolean;
  agentId?: string;
  agentName?: string;
  role: string;
  department: string;
  budgetCents: number;
  error?: string;
}

/**
 * Create a new agent from a design spec.
 *
 * Process:
 *   1. Generate role definition
 *   2. Validate role
 *   3. Find manager agent (reportsTo)
 *   4. Create agent in DB
 *   5. Publish event
 */
export async function createAgent(
  db: Db,
  request: AgentCreationRequest,
): Promise<AgentCreationResult> {
  const { companyId, design } = request;

  // Generate and validate role
  const role = generateRole(design);
  const validation = validateRole(role);
  if (!validation.valid) {
    return {
      success: false,
      role: design.role,
      department: design.department,
      budgetCents: design.budgetCents,
      error: `Invalid role spec: ${validation.errors.join(", ")}`,
    };
  }

  // Find the manager agent
  const profiles = await loadCompanyProfiles(db, companyId);
  const manager = profiles.find((p) => p.role === design.reportsTo);

  // Generate agent name
  const agentName = generateAgentName(design.title, profiles);

  // Create the agent
  const [created] = await db
    .insert(agents)
    .values({
      companyId,
      name: agentName,
      role: design.role,
      title: design.title,
      status: "idle",
      reportsTo: manager?.id ?? null,
      capabilities: design.capabilities.join(","),
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: design.budgetCents,
      spentMonthlyCents: 0,
      permissions: {},
      metadata: {
        createdByExpansion: true,
        department: design.department,
        sourceGaps: design.sourceGaps,
        requestedBy: request.requestedBy ?? null,
        expansionRequestId: request.expansionRequestId ?? null,
      },
    })
    .returning();

  await publishEvent("ai.agent.created", {
    companyId,
    agentId: created.id,
    role: design.role,
    department: design.department,
    name: agentName,
    reportsTo: manager?.id ?? null,
    createdByExpansion: true,
  });

  logger.info(
    { companyId, agentId: created.id, role: design.role, department: design.department },
    "Agent created via expansion",
  );

  return {
    success: true,
    agentId: created.id,
    agentName,
    role: design.role,
    department: design.department,
    budgetCents: design.budgetCents,
  };
}

/**
 * Create multiple agents from designs.
 */
export async function createAgents(
  db: Db,
  companyId: string,
  designs: AgentDesignSpec[],
  requestedBy?: string,
): Promise<AgentCreationResult[]> {
  const results: AgentCreationResult[] = [];
  for (const design of designs) {
    const result = await createAgent(db, { companyId, design, requestedBy });
    results.push(result);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateAgentName(title: string, existingProfiles: AgentProfile[]): string {
  const baseName = title;
  const existingNames = new Set(existingProfiles.map((p) => p.name));

  if (!existingNames.has(baseName)) return baseName;

  // Add number suffix if name exists
  for (let i = 2; i <= 100; i++) {
    const candidate = `${baseName} ${i}`;
    if (!existingNames.has(candidate)) return candidate;
  }

  return `${baseName} ${Date.now()}`;
}
