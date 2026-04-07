import type { Db } from "@paperclipai/db";
import { companies, agents, goals, projects, workflows } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { getTemplate, type CompanyTemplate } from "./templateLoader.js";
import { publishEvent } from "../events/eventPublisher.js";

const logger = pino({ name: "template-deployer" });

export interface DeployResult {
  companyId: string;
  companyName: string;
  agentsCreated: number;
  goalsCreated: number;
  projectsCreated: number;
  workflowsCreated: number;
}

/**
 * Deploys a company template: creates the company with pre-configured
 * agents, goals, projects, and workflows.
 */
export function templateDeployer(db: Db) {
  return {
    async deploy(templateId: string, companyName: string): Promise<DeployResult> {
      const template = getTemplate(templateId);
      if (!template) {
        throw new Error(`Template not found: ${templateId}`);
      }

      const companyId = randomUUID();

      // Generate a unique issue prefix from the company name
      const prefix = companyName
        .replace(/[^a-zA-Z0-9 ]/g, "")
        .split(/\s+/)
        .map((w) => w[0]?.toUpperCase() ?? "")
        .join("")
        .slice(0, 4) || "CO";
      const suffix = randomUUID().slice(0, 4).toUpperCase();
      const issuePrefix = `${prefix}-${suffix}`;

      // Create company
      await db.insert(companies).values({
        id: companyId,
        name: companyName,
        issuePrefix,
      });

      // Create agents
      const agentIdsByRole = new Map<string, string>();
      for (const agentDef of template.agents) {
        const agentId = randomUUID();
        agentIdsByRole.set(agentDef.role, agentId);
        await db.insert(agents).values({
          id: agentId,
          companyId,
          name: agentDef.name,
          role: agentDef.role,
          status: "idle",
        });
      }

      // Create goals
      for (const goalDef of template.goals) {
        await db.insert(goals).values({
          id: randomUUID(),
          companyId,
          title: goalDef.title,
          level: goalDef.level as any,
          description: goalDef.description,
          status: "active",
        });
      }

      // Create projects
      for (const projDef of template.projects) {
        await db.insert(projects).values({
          id: randomUUID(),
          companyId,
          name: projDef.name,
          description: projDef.description,
          status: "active",
        });
      }

      // Create workflows
      for (const wfDef of template.workflows) {
        await db.insert(workflows).values({
          id: randomUUID(),
          companyId,
          name: wfDef.name,
          description: wfDef.description,
          definition: wfDef.steps,
          status: "active",
        });
      }

      const result: DeployResult = {
        companyId,
        companyName,
        agentsCreated: template.agents.length,
        goalsCreated: template.goals.length,
        projectsCreated: template.projects.length,
        workflowsCreated: template.workflows.length,
      };

      await publishEvent("company.template.deployed", {
        templateId,
        ...result,
      });

      logger.info(result, "Template deployed");
      return result;
    },
  };
}
