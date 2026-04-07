import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { executionLoop } from "../core/executionLoop.js";

export function executionLoopRoutes(db: Db) {
  const router = Router();
  const loop = executionLoop(db);

  /** Trigger one execution loop cycle for a company */
  router.post("/companies/:companyId/loop/run", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await loop.runCycle(companyId);
    res.json(result);
  });

  return router;
}
