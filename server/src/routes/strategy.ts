import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { strategyEngine } from "../strategy/strategyEngine.js";

export function strategyRoutes(db: Db) {
  const router = Router();
  const engine = strategyEngine(db);

  /** Run strategy analysis for a company */
  router.post("/companies/:companyId/strategy/analyze", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const plan = await engine.runForCompany(companyId);
    res.json(plan);
  });

  /** List strategy plans for a company */
  router.get("/companies/:companyId/strategy/plans", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const plans = await engine.listPlans(companyId);
    res.json(plans);
  });

  return router;
}
