import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { listTemplateSummaries, getTemplate } from "../templates/templateLoader.js";
import { templateDeployer } from "../templates/templateDeployer.js";
import { logActivity } from "../services/index.js";
import { generateAndDeployCompany } from "../ai/company/universalCompanyGenerator.js";

export function templateRoutes(db: Db) {
  const router = Router();
  const deployer = templateDeployer(db);

  /** List available templates */
  router.get("/templates", (_req, res) => {
    const templates = listTemplateSummaries();
    res.json(templates);
  });

  /** Get template details */
  router.get("/templates/:id", (req, res) => {
    const template = getTemplate(req.params.id as string);
    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    res.json(template);
  });

  /** Deploy a template to create a new company */
  router.post("/templates/:id/deploy", async (req, res) => {
    const templateId = req.params.id as string;
    const { companyName } = req.body;

    if (!companyName || typeof companyName !== "string") {
      res.status(400).json({ error: "companyName is required" });
      return;
    }

    const template = getTemplate(templateId);
    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    const result = await deployer.deploy(templateId, companyName);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: result.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "company.template.deployed",
      entityType: "company",
      entityId: result.companyId,
      details: { templateId, companyName },
    });

    res.status(201).json(result);
  });

  /** Generate a company from a natural language prompt */
  router.post("/templates/generate", async (req, res) => {
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== "string" || prompt.length < 10) {
      res.status(400).json({ error: "prompt is required (min 10 characters). Example: 'Launch a Notion template business for project managers'" });
      return;
    }

    const result = await generateAndDeployCompany(db, prompt);
    if (!result) {
      res.status(500).json({ error: "Failed to generate company blueprint. Check LLM API credits." });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: result.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "company.generated.from_prompt",
      entityType: "company",
      entityId: result.companyId,
      details: { prompt: prompt.slice(0, 200) },
    });

    res.status(201).json({
      companyId: result.companyId,
      name: result.blueprint.name,
      description: result.blueprint.description,
      businessModel: result.blueprint.businessModel,
      targetAudience: result.blueprint.targetAudience,
      pricingStrategy: result.blueprint.pricingStrategy,
      channels: result.blueprint.channels,
      agentCount: result.deployment.agentCount,
      goalCount: result.deployment.goalCount,
      skillCount: result.deployment.skillCount,
      landingHeadline: result.blueprint.landingHeadline,
      landingSubheadline: result.blueprint.landingSubheadline,
      landingCta: result.blueprint.landingCta,
      weekOnePlan: result.blueprint.weekOnePlan,
    });
  });

  return router;
}
