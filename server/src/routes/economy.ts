// ---------------------------------------------------------------------------
// Economy Routes — AI Economic System API (Phase 25)
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  registerService,
  autoRegisterFromCompany,
  listActiveServices,
  findServicesByCategory,
  findServicesByCompany,
  getRegistryStats,
  getService,
  pauseService,
  resumeService,
  type ServiceCategory,
} from "../ai/economy/serviceRegistry.js";
import {
  findBestProvider,
  findMatches,
  createServiceRequest,
  getMarketplaceStats,
  listRequests,
} from "../ai/economy/marketplace.js";
import {
  calculatePrice,
  calculatePriceById,
  calculateCategoryPrices,
  getCategoryAveragePrice,
  getPricingHistory,
} from "../ai/economy/pricingEngine.js";
import {
  createContract,
  executeContract,
  getContract,
  listContractsByCompany,
  listActiveContracts,
  cancelContract,
  getContractExecutions,
  getContractSummary,
  getCompanyRevenue,
  getCompanySpending,
} from "../ai/economy/contractManager.js";
import {
  analyzeEcosystem,
  analyzeCompanyPerformance,
  getRecommendations,
} from "../ai/economy/profitOptimizer.js";
import {
  checkEconomicStatus,
  canCreateContract,
  checkCompanyEconomicStatus,
  getEconomicLimits,
  canRegisterService,
} from "../ai/governance/economicLimits.js";
import pino from "pino";

const logger = pino({ name: "economy-routes" });

export function economyRoutes(db: Db) {
  const router = Router();

  // -----------------------------------------------------------------------
  // Service Registry
  // -----------------------------------------------------------------------

  /** GET /economy/services — list all active services */
  router.get("/economy/services", async (_req, res) => {
    try {
      const services = listActiveServices();
      res.json({ services, total: services.length });
    } catch (err: unknown) {
      logger.error({ err }, "List services failed");
      res.status(500).json({ error: "List services failed" });
    }
  });

  /** GET /economy/services/stats — registry statistics */
  router.get("/economy/services/stats", async (_req, res) => {
    try {
      const stats = getRegistryStats();
      res.json(stats);
    } catch (err: unknown) {
      logger.error({ err }, "Get registry stats failed");
      res.status(500).json({ error: "Get registry stats failed" });
    }
  });

  /** GET /economy/services/category/:category — find services by category */
  router.get("/economy/services/category/:category", async (req, res) => {
    try {
      const category = req.params.category as ServiceCategory;
      const services = findServicesByCategory(category);
      res.json({ services, category, total: services.length });
    } catch (err: unknown) {
      logger.error({ err }, "Find services by category failed");
      res.status(500).json({ error: "Find services by category failed" });
    }
  });

  /** POST /companies/:companyId/economy/services — register a service */
  router.post("/companies/:companyId/economy/services", async (req, res) => {
    try {
      const companyId = req.params.companyId;

      // Check if company can register
      const check = canRegisterService(companyId);
      if (!check.allowed) {
        res.status(422).json({ error: check.reason });
        return;
      }

      const { serviceName, description, category, capabilities, pricePerRequestCents, maxRequestsPerDay } = req.body;
      if (!serviceName || !category) {
        res.status(400).json({ error: "serviceName and category are required" });
        return;
      }

      const listing = await registerService(db, {
        companyId,
        serviceName,
        description: description ?? "",
        category,
        capabilities: capabilities ?? [],
        pricePerRequestCents: pricePerRequestCents ?? 5,
        maxRequestsPerDay: maxRequestsPerDay ?? 1000,
      });

      res.status(201).json(listing);
    } catch (err: unknown) {
      logger.error({ err }, "Register service failed");
      res.status(500).json({ error: "Register service failed" });
    }
  });

  /** POST /companies/:companyId/economy/services/auto — auto-register from company capabilities */
  router.post("/companies/:companyId/economy/services/auto", async (req, res) => {
    try {
      const listings = await autoRegisterFromCompany(db, req.params.companyId);
      res.json({ registered: listings.length, services: listings });
    } catch (err: unknown) {
      logger.error({ err }, "Auto-register services failed");
      res.status(500).json({ error: "Auto-register services failed" });
    }
  });

  /** GET /companies/:companyId/economy/services — services by company */
  router.get("/companies/:companyId/economy/services", async (req, res) => {
    try {
      const services = findServicesByCompany(req.params.companyId);
      res.json({ services, total: services.length });
    } catch (err: unknown) {
      logger.error({ err }, "Get company services failed");
      res.status(500).json({ error: "Get company services failed" });
    }
  });

  /** POST /economy/services/:serviceId/pause */
  router.post("/economy/services/:serviceId/pause", async (req, res) => {
    try {
      const success = pauseService(req.params.serviceId);
      if (!success) {
        res.status(404).json({ error: "Service not found" });
        return;
      }
      res.json({ paused: true });
    } catch (err: unknown) {
      logger.error({ err }, "Pause service failed");
      res.status(500).json({ error: "Pause service failed" });
    }
  });

  /** POST /economy/services/:serviceId/resume */
  router.post("/economy/services/:serviceId/resume", async (req, res) => {
    try {
      const success = resumeService(req.params.serviceId);
      if (!success) {
        res.status(404).json({ error: "Service not found or deprecated" });
        return;
      }
      res.json({ resumed: true });
    } catch (err: unknown) {
      logger.error({ err }, "Resume service failed");
      res.status(500).json({ error: "Resume service failed" });
    }
  });

  // -----------------------------------------------------------------------
  // Marketplace
  // -----------------------------------------------------------------------

  /** POST /companies/:companyId/economy/marketplace/find — find best provider */
  router.post("/companies/:companyId/economy/marketplace/find", async (req, res) => {
    try {
      const { category, requiredCapabilities, maxPriceCents, minPerformanceScore } = req.body;
      if (!category) {
        res.status(400).json({ error: "category is required" });
        return;
      }

      const result = await findBestProvider(req.params.companyId, category, {
        requiredCapabilities,
        maxPriceCents,
        minPerformanceScore,
      });

      res.json(result);
    } catch (err: unknown) {
      logger.error({ err }, "Marketplace find failed");
      res.status(500).json({ error: "Marketplace find failed" });
    }
  });

  /** GET /economy/marketplace/stats */
  router.get("/economy/marketplace/stats", async (_req, res) => {
    try {
      const stats = getMarketplaceStats();
      res.json(stats);
    } catch (err: unknown) {
      logger.error({ err }, "Get marketplace stats failed");
      res.status(500).json({ error: "Get marketplace stats failed" });
    }
  });

  // -----------------------------------------------------------------------
  // Pricing
  // -----------------------------------------------------------------------

  /** GET /economy/pricing/:serviceId — get current dynamic price */
  router.get("/economy/pricing/:serviceId", async (req, res) => {
    try {
      const service = getService(req.params.serviceId);
      if (!service) {
        res.status(404).json({ error: "Service not found" });
        return;
      }
      const categoryServices = findServicesByCategory(service.category);
      const price = calculatePrice(service, categoryServices.length);
      res.json(price);
    } catch (err: unknown) {
      logger.error({ err }, "Calculate price failed");
      res.status(500).json({ error: "Calculate price failed" });
    }
  });

  /** GET /economy/pricing/:serviceId/history — pricing history */
  router.get("/economy/pricing/:serviceId/history", async (req, res) => {
    try {
      const history = getPricingHistory(req.params.serviceId);
      res.json({ serviceId: req.params.serviceId, history });
    } catch (err: unknown) {
      logger.error({ err }, "Get pricing history failed");
      res.status(500).json({ error: "Get pricing history failed" });
    }
  });

  // -----------------------------------------------------------------------
  // Contracts
  // -----------------------------------------------------------------------

  /** POST /economy/contracts — create a new contract from marketplace match */
  router.post("/economy/contracts", async (req, res) => {
    try {
      const input = req.body;
      if (!input.providerCompanyId || !input.consumerCompanyId || !input.serviceId) {
        res.status(400).json({ error: "providerCompanyId, consumerCompanyId, and serviceId are required" });
        return;
      }

      // Check limits
      const check = canCreateContract(input.providerCompanyId, input.consumerCompanyId);
      if (!check.allowed) {
        res.status(422).json({ error: check.reason });
        return;
      }

      const contract = await createContract(input);
      res.status(201).json(contract);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Create contract failed";
      logger.error({ err }, "Create contract failed");
      res.status(400).json({ error: msg });
    }
  });

  /** POST /economy/contracts/:contractId/execute — execute service call */
  router.post("/economy/contracts/:contractId/execute", async (req, res) => {
    try {
      const { responseTimeMs, success } = req.body;
      const execution = await executeContract(
        req.params.contractId,
        responseTimeMs ?? 100,
        success ?? true,
      );
      res.json(execution);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Execute contract failed";
      logger.error({ err }, "Execute contract failed");
      res.status(400).json({ error: msg });
    }
  });

  /** GET /economy/contracts/:contractId — get contract details */
  router.get("/economy/contracts/:contractId", async (req, res) => {
    try {
      const contract = getContract(req.params.contractId);
      if (!contract) {
        res.status(404).json({ error: "Contract not found" });
        return;
      }
      res.json(contract);
    } catch (err: unknown) {
      logger.error({ err }, "Get contract failed");
      res.status(500).json({ error: "Get contract failed" });
    }
  });

  /** GET /economy/contracts/:contractId/executions — execution log */
  router.get("/economy/contracts/:contractId/executions", async (req, res) => {
    try {
      const executions = getContractExecutions(req.params.contractId);
      res.json({ contractId: req.params.contractId, executions, total: executions.length });
    } catch (err: unknown) {
      logger.error({ err }, "Get contract executions failed");
      res.status(500).json({ error: "Get contract executions failed" });
    }
  });

  /** POST /economy/contracts/:contractId/cancel — cancel contract */
  router.post("/economy/contracts/:contractId/cancel", async (req, res) => {
    try {
      const success = await cancelContract(req.params.contractId, req.body.reason);
      if (!success) {
        res.status(404).json({ error: "Contract not found or not active" });
        return;
      }
      res.json({ cancelled: true });
    } catch (err: unknown) {
      logger.error({ err }, "Cancel contract failed");
      res.status(500).json({ error: "Cancel contract failed" });
    }
  });

  /** GET /companies/:companyId/economy/contracts — company contracts */
  router.get("/companies/:companyId/economy/contracts", async (req, res) => {
    try {
      const role = req.query.role as "provider" | "consumer" | undefined;
      const contracts = listContractsByCompany(req.params.companyId, role);
      res.json({ contracts, total: contracts.length });
    } catch (err: unknown) {
      logger.error({ err }, "List company contracts failed");
      res.status(500).json({ error: "List company contracts failed" });
    }
  });

  /** GET /economy/contracts — all active contracts */
  router.get("/economy/contracts", async (_req, res) => {
    try {
      const contracts = listActiveContracts();
      const summary = getContractSummary();
      res.json({ contracts, summary });
    } catch (err: unknown) {
      logger.error({ err }, "List contracts failed");
      res.status(500).json({ error: "List contracts failed" });
    }
  });

  // -----------------------------------------------------------------------
  // Profit Optimizer
  // -----------------------------------------------------------------------

  /** GET /economy/analysis — full ecosystem analysis + recommendations */
  router.get("/economy/analysis", async (_req, res) => {
    try {
      const analysis = await analyzeEcosystem(db);
      res.json(analysis);
    } catch (err: unknown) {
      logger.error({ err }, "Ecosystem analysis failed");
      res.status(500).json({ error: "Ecosystem analysis failed" });
    }
  });

  /** GET /companies/:companyId/economy/performance — single company performance */
  router.get("/companies/:companyId/economy/performance", async (req, res) => {
    try {
      const perf = analyzeCompanyPerformance(req.params.companyId, ""); // name filled from in-memory
      res.json(perf);
    } catch (err: unknown) {
      logger.error({ err }, "Company performance analysis failed");
      res.status(500).json({ error: "Company performance analysis failed" });
    }
  });

  /** GET /economy/recommendations — all optimization recommendations */
  router.get("/economy/recommendations", async (_req, res) => {
    try {
      const recs = getRecommendations();
      res.json({ recommendations: recs, total: recs.length });
    } catch (err: unknown) {
      logger.error({ err }, "Get recommendations failed");
      res.status(500).json({ error: "Get recommendations failed" });
    }
  });

  // -----------------------------------------------------------------------
  // Economic Limits & Status
  // -----------------------------------------------------------------------

  /** GET /economy/limits — current economic limits */
  router.get("/economy/limits", async (_req, res) => {
    try {
      const limits = getEconomicLimits();
      res.json(limits);
    } catch (err: unknown) {
      logger.error({ err }, "Get economic limits failed");
      res.status(500).json({ error: "Get economic limits failed" });
    }
  });

  /** GET /economy/status — ecosystem-wide economic status */
  router.get("/economy/status", async (_req, res) => {
    try {
      const status = checkEconomicStatus();
      res.json(status);
    } catch (err: unknown) {
      logger.error({ err }, "Check economic status failed");
      res.status(500).json({ error: "Check economic status failed" });
    }
  });

  /** GET /companies/:companyId/economy/status — company economic status */
  router.get("/companies/:companyId/economy/status", async (req, res) => {
    try {
      const status = checkCompanyEconomicStatus(req.params.companyId);
      res.json(status);
    } catch (err: unknown) {
      logger.error({ err }, "Check company economic status failed");
      res.status(500).json({ error: "Check company economic status failed" });
    }
  });

  // -----------------------------------------------------------------------
  // Full Pipeline: auto-register → match → price → contract → execute
  // -----------------------------------------------------------------------

  /** POST /economy/trade — automated trade between two companies */
  router.post("/economy/trade", async (req, res) => {
    try {
      const { consumerCompanyId, providerCompanyId, category } = req.body;
      if (!consumerCompanyId || !category) {
        res.status(400).json({ error: "consumerCompanyId and category are required" });
        return;
      }

      // 1. Find best provider
      const { request, match } = await findBestProvider(consumerCompanyId, category, {
        maxPriceCents: req.body.maxPriceCents,
      });

      if (!match.bestMatch) {
        res.json({ traded: false, reason: "No matching provider found" });
        return;
      }

      const bestService = match.bestMatch.service;

      // 2. Calculate dynamic price
      const categoryServices = findServicesByCategory(bestService.category);
      const pricing = calculatePrice(bestService, categoryServices.length);

      // 3. Check limits
      const limitCheck = canCreateContract(bestService.companyId, consumerCompanyId);
      if (!limitCheck.allowed) {
        res.status(422).json({ traded: false, reason: limitCheck.reason });
        return;
      }

      // 4. Create contract
      const contract = await createContract({
        providerCompanyId: bestService.companyId,
        providerCompanyName: bestService.companyName,
        consumerCompanyId,
        consumerCompanyName: `Company_${consumerCompanyId.slice(0, 8)}`,
        serviceId: bestService.id,
        serviceName: bestService.serviceName,
        category: bestService.category,
        pricePerRequestCents: pricing.adjustedPriceCents,
        maxRequestsPerDay: req.body.maxRequestsPerDay ?? 100,
        maxTotalRequests: req.body.maxTotalRequests ?? 1000,
        durationDays: req.body.durationDays ?? 30,
      });

      // 5. Execute first request
      const execution = await executeContract(contract.id, 50, true);

      res.json({
        traded: true,
        contract: {
          id: contract.id,
          provider: bestService.companyName,
          consumer: consumerCompanyId,
          service: bestService.serviceName,
          priceCents: pricing.adjustedPriceCents,
        },
        firstExecution: execution,
        matchScore: match.bestMatch.overallScore,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Trade failed";
      logger.error({ err }, "Automated trade failed");
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
