import type { Db } from "@paperclipai/db";
import { workflows, workflowRuns, agents, issues } from "@paperclipai/db";
import { eq, and } from "@paperclipai/db";
import { v4 as uuidv4 } from "uuid";
import { runWorkflow } from "./workflowRunner.js";
import type { WorkflowDefinition, WorkflowStep } from "./dependencyGraph.js";
import { eventPublisher } from "../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "workflow-engine" });

export function workflowEngine(db: Db) {
  return {
    /** Create a reusable workflow definition */
    async createWorkflow(
      companyId: string,
      params: { name: string; description?: string; definition: any },
    ) {
      const [row] = await db
        .insert(workflows)
        .values({
          companyId,
          name: params.name,
          description: params.description,
          definition: params.definition,
        })
        .returning();
      logger.info({ workflowId: row.id, name: params.name }, "Workflow created");
      return row;
    },

    /** List workflows for a company */
    async listWorkflows(companyId: string) {
      return db.select().from(workflows).where(eq(workflows.companyId, companyId));
    },

    /** Trigger execution of a workflow */
    async triggerWorkflow(
      workflowId: string,
      context: Record<string, unknown> = {},
    ) {
      const [wf] = await db.select().from(workflows).where(eq(workflows.id, workflowId));
      if (!wf) throw new Error(`Workflow ${workflowId} not found`);

      const companyId = wf.companyId;
      const runId = uuidv4();
      await db.insert(workflowRuns).values({
        id: runId,
        workflowId,
        companyId,
        status: "running",
        context,
      });

      await eventPublisher.publish("workflow.started", {
        workflowRunId: runId,
        workflowId,
        companyId,
      });

      // Normalize definition: may be stored as array of steps (from templates)
      // or as a full WorkflowDefinition object { name, steps }
      const rawDef = wf.definition as unknown;
      const definition: WorkflowDefinition = Array.isArray(rawDef)
        ? { name: wf.name, steps: rawDef as WorkflowStep[] }
        : rawDef as WorkflowDefinition;

      // Build agentMap: resolve role names → agent IDs
      const companyAgents = await db
        .select()
        .from(agents)
        .where(eq(agents.companyId, companyId));

      const agentMap = new Map<string, string>();
      for (const step of definition.steps) {
        if (!agentMap.has(step.agent)) {
          // Try matching by role first, then by name (case-insensitive)
          const match =
            companyAgents.find((a) => a.role === step.agent) ??
            companyAgents.find((a) => a.name.toLowerCase() === step.agent.toLowerCase()) ??
            companyAgents.find((a) => a.id === step.agent);
          if (match) {
            agentMap.set(step.agent, match.id);
          }
        }
      }

      // Build issueMap: create an issue for each workflow step
      const issueMap = new Map<string, string>();
      for (const step of definition.steps) {
        const [issue] = await db
          .insert(issues)
          .values({
            companyId,
            title: `[Workflow] ${step.description ?? step.id}`,
            description: `Auto-created for workflow run ${runId}, step: ${step.id}`,
            status: "backlog",
            priority: "medium",
          })
          .returning();
        issueMap.set(step.id, issue.id);
      }

      const { completed, failed } = await runWorkflow(definition, {
        workflowRunId: runId,
        companyId,
        agentMap,
        issueMap,
      });

      const finalStatus = failed.length === 0 ? "completed" : "failed";
      await db
        .update(workflowRuns)
        .set({
          status: finalStatus,
          stepsCompleted: completed.map((c) => c.stepId),
          stepsFailed: failed.map((f) => f.stepId),
          completedAt: new Date(),
        })
        .where(eq(workflowRuns.id, runId));

      logger.info({ runId, status: finalStatus }, "Workflow run finished");
      return { runId, status: finalStatus, completed, failed };
    },

    /** List workflow runs for a company */
    async listRuns(companyId: string) {
      return db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.companyId, companyId));
    },
  };
}
