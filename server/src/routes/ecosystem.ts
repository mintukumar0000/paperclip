// ---------------------------------------------------------------------------
// Ecosystem Routes — Autonomous Business Creation & Multi-Company Ecosystem API
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { scanOpportunities } from "../ai/ecosystem/opportunityScanner.js";
import { designBusiness, designBusinesses } from "../ai/ecosystem/businessDesigner.js";
import { planVenture, planVentures } from "../ai/ecosystem/venturePlanner.js";
import { createVentureCompany } from "../ai/company/companyFactory.js";
import { bootstrapCompany } from "../ai/company/companyBootstrap.js";
import { checkEcosystemStatus, canCreateNewCompany, getEcosystemLimits } from "../ai/governance/ecosystemBudget.js";
import {
  submitCompanyCreationRequest,
  approveCompanyCreation,
  rejectCompanyCreation,
  completeCompanyCreation,
  listPendingCompanyRequests,
  listCompanyRequests,
  determineCompanyApprovalLevel,
} from "../ai/governance/companyApproval.js";
import { checkRateLimit } from "../ai/governance/systemRateLimiter.js";
import { requestGovernanceClearance } from "../ai/governance/governanceEngine.js";
import pino from "pino";

const logger = pino({ name: "ecosystem-routes" });

export function ecosystemRoutes(db: Db) {
  const router = Router();

  // -----------------------------------------------------------------------
  // Opportunity Scanning
  // -----------------------------------------------------------------------

  /** GET /companies/:companyId/ecosystem/opportunities — scan for opportunities */
  router.get("/companies/:companyId/ecosystem/opportunities", async (req, res) => {
    try {
      // Rate limit opportunity scanning to prevent unbounded analysis
      const rl = checkRateLimit("opportunity_scanning", req.params.companyId);
      if (!rl.allowed) {
        res.status(429).json({ error: "Rate limit exceeded", reason: rl.reason });
        return;
      }
      const result = await scanOpportunities(db, req.params.companyId);
      res.json(result);
    } catch (err: unknown) {
      logger.error({ err }, "Opportunity scan failed");
      res.status(500).json({ error: "Opportunity scan failed" });
    }
  });

  // -----------------------------------------------------------------------
  // Business Design
  // -----------------------------------------------------------------------

  /** POST /companies/:companyId/ecosystem/design — design businesses from opportunities */
  router.post("/companies/:companyId/ecosystem/design", async (req, res) => {
    try {
      const { opportunities } = req.body;
      if (!opportunities || !Array.isArray(opportunities) || opportunities.length === 0) {
        // Auto-scan if no opportunities provided
        const scan = await scanOpportunities(db, req.params.companyId);
        if (scan.opportunities.length === 0) {
          res.json({ designs: [], reason: "No opportunities found" });
          return;
        }
        const designs = await designBusinesses(scan.opportunities);
        res.json({ designs, scannedOpportunities: scan.opportunities.length });
        return;
      }
      const designs = await designBusinesses(opportunities);
      res.json({ designs });
    } catch (err: unknown) {
      logger.error({ err }, "Business design failed");
      res.status(500).json({ error: "Business design failed" });
    }
  });

  // -----------------------------------------------------------------------
  // Venture Planning
  // -----------------------------------------------------------------------

  /** POST /companies/:companyId/ecosystem/plan — create venture plans */
  router.post("/companies/:companyId/ecosystem/plan", async (req, res) => {
    try {
      const { businessModels } = req.body;
      if (!businessModels || !Array.isArray(businessModels) || businessModels.length === 0) {
        res.status(400).json({ error: "businessModels array is required" });
        return;
      }
      const plans = await planVentures(businessModels);
      res.json({ plans });
    } catch (err: unknown) {
      logger.error({ err }, "Venture planning failed");
      res.status(500).json({ error: "Venture planning failed" });
    }
  });

  // -----------------------------------------------------------------------
  // Ecosystem Budget & Limits
  // -----------------------------------------------------------------------

  /** GET /ecosystem/status — get ecosystem-wide status and limits */
  router.get("/ecosystem/status", async (_req, res) => {
    try {
      const status = await checkEcosystemStatus(db);
      res.json(status);
    } catch (err: unknown) {
      logger.error({ err }, "Ecosystem status check failed");
      res.status(500).json({ error: "Ecosystem status check failed" });
    }
  });

  /** GET /ecosystem/limits — get ecosystem limits */
  router.get("/ecosystem/limits", async (_req, res) => {
    try {
      const limits = getEcosystemLimits();
      res.json(limits);
    } catch (err: unknown) {
      logger.error({ err }, "Failed to get ecosystem limits");
      res.status(500).json({ error: "Failed to get ecosystem limits" });
    }
  });

  // -----------------------------------------------------------------------
  // Company Approval Requests
  // -----------------------------------------------------------------------

  /** GET /companies/:companyId/ecosystem/requests — list company creation requests */
  router.get("/companies/:companyId/ecosystem/requests", async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const requests = await listCompanyRequests(db, req.params.companyId, status as any);
      res.json({ requests });
    } catch (err: unknown) {
      logger.error({ err }, "List company requests failed");
      res.status(500).json({ error: "List company requests failed" });
    }
  });

  /** GET /companies/:companyId/ecosystem/requests/pending — list pending requests */
  router.get("/companies/:companyId/ecosystem/requests/pending", async (req, res) => {
    try {
      const requests = await listPendingCompanyRequests(db, req.params.companyId);
      res.json({ requests });
    } catch (err: unknown) {
      logger.error({ err }, "List pending company requests failed");
      res.status(500).json({ error: "List pending company requests failed" });
    }
  });

  /** POST /companies/:companyId/ecosystem/requests/:requestId/approve */
  router.post("/companies/:companyId/ecosystem/requests/:requestId/approve", async (req, res) => {
    try {
      const success = await approveCompanyCreation(db, req.params.requestId, req.params.companyId, req.body.approvedBy);
      if (!success) {
        res.status(404).json({ error: "Request not found or not pending" });
        return;
      }
      res.json({ approved: true });
    } catch (err: unknown) {
      logger.error({ err }, "Approve company creation failed");
      res.status(500).json({ error: "Approve company creation failed" });
    }
  });

  /** POST /companies/:companyId/ecosystem/requests/:requestId/reject */
  router.post("/companies/:companyId/ecosystem/requests/:requestId/reject", async (req, res) => {
    try {
      const { reason, rejectedBy } = req.body;
      if (!reason) {
        res.status(400).json({ error: "reason is required" });
        return;
      }
      const success = await rejectCompanyCreation(db, req.params.requestId, req.params.companyId, reason, rejectedBy);
      if (!success) {
        res.status(404).json({ error: "Request not found or not pending" });
        return;
      }
      res.json({ rejected: true });
    } catch (err: unknown) {
      logger.error({ err }, "Reject company creation failed");
      res.status(500).json({ error: "Reject company creation failed" });
    }
  });

  // -----------------------------------------------------------------------
  // Full Ecosystem Pipeline (scan → design → plan → approve → create → bootstrap)
  // -----------------------------------------------------------------------

  /** POST /companies/:companyId/ecosystem/launch — run full company creation pipeline */
  router.post("/companies/:companyId/ecosystem/launch", async (req, res) => {
    try {
      const sourceCompanyId = req.params.companyId;

      // 0. Governance gate — central clearance for company creation
      const governance = await requestGovernanceClearance(db, {
        action: "create_company",
        actorType: req.body.requestedBy ? "board" : "agent",
        actorId: req.body.requestedBy ?? "system",
        companyId: sourceCompanyId,
      });
      if (!governance.allowed) {
        res.status(422).json({ error: "Governance blocked", reason: governance.reason, blockedBy: governance.blockedBy, traceId: governance.traceId });
        return;
      }

      // 0b. Rate limit check
      const rl = checkRateLimit("company_creation", sourceCompanyId);
      if (!rl.allowed) {
        res.status(429).json({ error: "Rate limit exceeded", reason: rl.reason });
        return;
      }

      // 1. Check ecosystem limits
      const ecosystemStatus = await checkEcosystemStatus(db);
      if (!ecosystemStatus.canCreateCompany) {
        res.status(422).json({ error: "Ecosystem limits reached", violations: ecosystemStatus.violations });
        return;
      }

      // 2. Scan → design → plan
      const scan = await scanOpportunities(db, sourceCompanyId);
      if (scan.opportunities.length === 0) {
        res.json({ launched: false, reason: "No opportunities found" });
        return;
      }

      const designs = await designBusinesses(scan.opportunities);
      if (designs.length === 0) {
        res.json({ launched: false, reason: "No viable businesses designed" });
        return;
      }

      const plans = await planVentures(designs.map((d) => d.businessModel));

      // 3. For each viable venture, request approval → create → bootstrap
      const results = [];
      for (let i = 0; i < designs.length; i++) {
        const design = designs[i];
        const plan = plans[i];

        // Budget check
        const budgetCheck = await canCreateNewCompany(db, design.businessModel.initialBudgetCents);
        if (!budgetCheck.allowed) {
          results.push({
            companyName: design.businessModel.companyName,
            launched: false,
            reason: budgetCheck.reason,
          });
          continue;
        }

        // Submit approval request
        const approvalRequest = await submitCompanyCreationRequest(
          db,
          sourceCompanyId,
          design.businessModel,
          req.body.requestedBy,
        );

        if (approvalRequest.status === "approved") {
          // Create the company
          const creationResult = await createVentureCompany(db, {
            businessModel: design.businessModel,
            venturePlan: plan,
            requestedBy: req.body.requestedBy,
            approvalRequestId: approvalRequest.id,
          });

          if (creationResult.success && creationResult.companyId) {
            // Bootstrap with agents
            const bootstrap = await bootstrapCompany(db, creationResult.companyId, design.businessModel);
            await completeCompanyCreation(db, approvalRequest.id, sourceCompanyId, creationResult.companyId);

            results.push({
              companyName: design.businessModel.companyName,
              launched: true,
              companyId: creationResult.companyId,
              agentsCreated: bootstrap.agentsCreated.length,
              departmentsCreated: bootstrap.departmentsCreated.length,
              requestId: approvalRequest.id,
            });
          } else {
            results.push({
              companyName: design.businessModel.companyName,
              launched: false,
              reason: creationResult.error,
              requestId: approvalRequest.id,
            });
          }
        } else {
          results.push({
            companyName: design.businessModel.companyName,
            launched: false,
            status: approvalRequest.status,
            approvalLevel: approvalRequest.approvalLevel,
            requestId: approvalRequest.id,
          });
        }
      }

      res.json({
        launched: results.some((r) => r.launched),
        opportunitiesFound: scan.opportunities.length,
        businessesDesigned: designs.length,
        results,
      });
    } catch (err: unknown) {
      logger.error({ err }, "Full ecosystem launch pipeline failed");
      res.status(500).json({ error: "Ecosystem launch pipeline failed" });
    }
  });

  return router;
}
