import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { messageService } from "../services/messages.js";

export function messageRoutes(db: Db) {
  const router = Router();
  const svc = messageService(db);

  /** List all messages in a company */
  router.get("/companies/:companyId/messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.listAll(companyId);
    res.json(result);
  });

  /** Send a message between agents */
  router.post("/companies/:companyId/messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { fromAgentId, toAgentId, message } = req.body;
    if (!fromAgentId || !toAgentId || !message) {
      res.status(400).json({ error: "fromAgentId, toAgentId, and message are required" });
      return;
    }

    const result = await svc.sendMessage(companyId, fromAgentId, toAgentId, message);
    res.status(201).json(result);
  });

  /** Get inbox for a specific agent */
  router.get("/companies/:companyId/agents/:agentId/inbox", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = req.params.agentId as string;
    const result = await svc.getInbox(companyId, agentId);
    res.json(result);
  });

  /** Get outbox for a specific agent */
  router.get("/companies/:companyId/agents/:agentId/outbox", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = req.params.agentId as string;
    const result = await svc.getOutbox(companyId, agentId);
    res.json(result);
  });

  /** Get conversation between two agents */
  router.get("/companies/:companyId/conversations/:agentA/:agentB", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { agentA, agentB } = req.params;
    const result = await svc.getConversation(companyId, agentA as string, agentB as string);
    res.json(result);
  });

  /** Mark a message as read */
  router.patch("/messages/:messageId/read", async (req, res) => {
    const messageId = req.params.messageId as string;
    const result = await svc.markRead(messageId);
    if (!result) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    res.json(result);
  });

  return router;
}
