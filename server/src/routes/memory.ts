import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { memoryService } from "../memory/memoryService.js";

export function memoryRoutes(db: Db) {
  const router = Router();
  const svc = memoryService(db);

  /** List memories for a company */
  router.get("/companies/:companyId/memories", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const type = req.query.type as string | undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const result = await svc.listMemories(companyId, { type: type as any, limit });
    res.json(result);
  });

  /** Store a new memory */
  router.post("/companies/:companyId/memories", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { agentId, type, title, content, metadata } = req.body;
    if (!type || !title || !content) {
      res.status(400).json({ error: "type, title, and content are required" });
      return;
    }

    const memory = await svc.storeMemory({
      companyId,
      agentId: agentId ?? null,
      type,
      title,
      content,
      metadata: metadata ?? {},
    });
    res.status(201).json(memory);
  });

  /** Search memories by keyword */
  router.get("/companies/:companyId/memories/search", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const q = req.query.q as string;
    if (!q) {
      res.status(400).json({ error: "q query parameter is required" });
      return;
    }

    const results = await svc.searchMemories(companyId, q);
    res.json(results);
  });

  return router;
}
