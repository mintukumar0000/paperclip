import { Router } from "express";
import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import { eq, and } from "@paperclipai/db";
import { executeAI } from "../ai/index.js";
import { getRecentUsage, getUsageByProvider, listExecutionEngines } from "../ai/index.js";
import {
  listAvailableEngines,
  listEnginesByCategory,
  resolveEngine,
} from "../ai/router/adapterRouter.js";
import { detectCapabilities } from "../ai/runtime/capabilities.js";
import { getEngineRegistry } from "../ai/runtime/engineRegistry.js";
import { companyExecutionLoop } from "../ai/orchestration/companyLoop.js";
import { agentOrchestrator } from "../ai/orchestration/agentOrchestrator.js";
import { planStore } from "../ai/memory/planStore.js";
import { resolveXBearerToken } from "../ai/tools/externalTools.js";
import { logActivity } from "../services/activity-log.js";
import { canCreateGoal } from "../ai/governance/goalContainment.js";
import pino from "pino";

const logger = pino({ name: "ai-routes" });

type ConnectivityProbe = {
  service: string;
  configured: boolean;
  required: boolean;
  ok: boolean;
  reachable: boolean;
  authorized: boolean;
  status?: number;
  latencyMs?: number;
  endpoint?: string;
  message: string;
};

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (typeof value !== "string") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

async function runConnectivityProbe(params: {
  service: string;
  endpoint: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  configured: boolean;
  required: boolean;
  allowExpectedClientError?: boolean;
}): Promise<ConnectivityProbe> {
  if (!params.configured) {
    return {
      service: params.service,
      configured: false,
      required: params.required,
      ok: false,
      reachable: false,
      authorized: false,
      endpoint: params.endpoint,
      message: "Not configured",
    };
  }

  const start = Date.now();
  try {
    const res = await fetch(params.endpoint, {
      method: params.method ?? "GET",
      headers: params.headers,
      body: params.body,
    });

    const latencyMs = Date.now() - start;
    const reachable = true;
    const authorized = res.status !== 401 && res.status !== 403;
    const ok =
      (res.ok && authorized) ||
      Boolean(params.allowExpectedClientError && res.status < 500 && authorized);

    return {
      service: params.service,
      configured: true,
      required: params.required,
      ok,
      reachable,
      authorized,
      status: res.status,
      latencyMs,
      endpoint: params.endpoint,
      message: ok
        ? "Connectivity OK"
        : `Connectivity failed (status ${res.status})`,
    };
  } catch (err) {
    const errorMessage =
      err instanceof Error
        ? `${err.message}${(err as Error & { cause?: unknown }).cause ? `: ${String((err as Error & { cause?: unknown }).cause)}` : ""}`
        : "Network probe failed";
    return {
      service: params.service,
      configured: true,
      required: params.required,
      ok: false,
      reachable: false,
      authorized: false,
      latencyMs: Date.now() - start,
      endpoint: params.endpoint,
      message: errorMessage,
    };
  }
}

async function runXClientCredentialsProbe(params: {
  required: boolean;
  clientId: string;
  clientSecret: string;
}): Promise<ConnectivityProbe> {
  const start = Date.now();
  try {
    const tokenResolution = await resolveXBearerToken(
      { integrationEnv: {} },
      {
        clientId: params.clientId,
        clientSecret: params.clientSecret,
      },
    );

    if (!tokenResolution) {
      return {
        service: "x",
        configured: true,
        required: params.required,
        ok: false,
        reachable: false,
        authorized: false,
        endpoint: "https://api.x.com/2/oauth2/token",
        latencyMs: Date.now() - start,
        message: "X client credentials are configured, but token exchange returned no token.",
      };
    }

    return {
      service: "x",
      configured: true,
      required: params.required,
      ok: true,
      reachable: true,
      authorized: true,
      endpoint: "https://api.x.com/2/oauth2/token",
      latencyMs: Date.now() - start,
      message:
        "X client credentials exchanged successfully for an app token. Note: write actions like posting tweets still require user-context OAuth credentials.",
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Client credential probe failed";
    return {
      service: "x",
      configured: true,
      required: params.required,
      ok: false,
      reachable: false,
      authorized: false,
      endpoint: "https://api.x.com/2/oauth2/token",
      latencyMs: Date.now() - start,
      message: errorMessage,
    };
  }
}

export function aiRoutes(db: Db) {
  const router = Router();

  /**
   * POST /companies/:companyId/ai/execute
   * Trigger an AI execution cycle for an agent + issue pair.
   */
  router.post("/companies/:companyId/ai/execute", async (req, res) => {
    try {
      const { companyId } = req.params;
      const { agentId, issueId, tools } = req.body as {
        agentId: string;
        issueId: string;
        tools?: string[];
      };

      if (!agentId || !issueId) {
        res.status(400).json({ error: "agentId and issueId are required" });
        return;
      }

      // Fetch agent
      const agent = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
        .then((rows) => rows[0] ?? null);

      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      // Fetch issue
      const issue = await db
        .select()
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);

      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }

      const runId = randomUUID();

      const result = await executeAI(
        {
          runId,
          agent: {
            id: agent.id,
            companyId: agent.companyId,
            name: agent.name,
            role: (agent.adapterConfig as any)?.role,
            runtime: (agent.adapterConfig as any)?.aiRuntime ?? "openai",
            adapterConfig: agent.adapterConfig as Record<string, unknown> | undefined,
          },
          issue: {
            id: issue.id,
            title: issue.title,
            description: issue.description ?? undefined,
            status: issue.status ?? undefined,
          },
          tools,
        },
        db,
      );

      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: agentId,
        action: "ai.execution",
        entityType: "agent",
        entityId: agentId,
        details: {
          runId,
          issueId,
          status: result.status,
          toolName: result.toolName,
        },
      });

      logger.info(
        { runId, agentId, issueId, status: result.status },
        "AI execution completed",
      );

      res.json({ runId, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      logger.error({ err }, "AI execution route error");
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /companies/:companyId/ai/usage
   * Get recent AI token usage for a company.
   */
  router.get("/companies/:companyId/ai/usage", async (req, res) => {
    const { companyId } = req.params;
    const windowMinutes = Number(req.query.window ?? 60);
    const usage = getRecentUsage(companyId, windowMinutes);
    const byProvider = getUsageByProvider(companyId, windowMinutes);
    res.json({ ...usage, byProvider });
  });

  /**
   * GET /ai/engines
   * List all execution engines (enabled + disabled).
   */
  router.get("/ai/engines", (_req, res) => {
    res.json({ engines: listExecutionEngines() });
  });

  /**
   * GET /ai/engines/available
   * List only engines that are currently available (enabled).
   */
  router.get("/ai/engines/available", (_req, res) => {
    res.json({ engines: listAvailableEngines() });
  });

  /**
   * GET /ai/engines/capabilities
   * Show raw capability detection results.
   */
  router.get("/ai/engines/capabilities", (_req, res) => {
    res.json({ capabilities: detectCapabilities() });
  });

  /**
   * GET /ai/engines/registry
   * Full engine registry with enabled status.
   */
  router.get("/ai/engines/registry", (_req, res) => {
    res.json({ registry: getEngineRegistry() });
  });

  /**
   * GET /ai/engines/categories
   * Engines grouped as "brains" (LLM) and "hands" (runtime).
   */
  router.get("/ai/engines/categories", (_req, res) => {
    res.json(listEnginesByCategory());
  });

  /**
   * GET /ai/self-test/connectivity
   * Non-destructive runtime connectivity checks for external action providers.
   */
  router.get("/ai/self-test/connectivity", async (_req, res) => {
    const xToken =
      process.env.X_BEARER_TOKEN ??
      process.env.X_API_KEY ??
      process.env.TWITTER_BEARER_TOKEN ??
      "";
    const xMockMode = parseBooleanEnv(process.env.X_MOCK_MODE, false);
    const xRequired = parseBooleanEnv(process.env.X_REQUIRED, true);
    const notionRequired = parseBooleanEnv(process.env.NOTION_REQUIRED, false);
    const resendRequired = parseBooleanEnv(process.env.RESEND_REQUIRED, true);
    const xConsumerKey = (process.env.X_CONSUMER_KEY ?? "").trim();
    const xConsumerSecret = (
      process.env.X_CONSUMER_SECRET ??
      process.env.X_CONSUMER_KEY_SECRET ??
      process.env.X_API_SECRET ??
      ""
    ).trim();
    const xAccessToken = (process.env.X_ACCESS_TOKEN ?? "").trim();
    const xAccessTokenSecret = (process.env.X_ACCESS_TOKEN_SECRET ?? "").trim();
    const xClientId = (process.env.X_CLIENT_ID ?? process.env.X_API_CLIENT_ID ?? "").trim();
    const xClientSecret = (process.env.X_CLIENT_SECRET ?? process.env.X_API_CLIENT_SECRET ?? "").trim();
    const notionKey = process.env.NOTION_API_KEY ?? "";
    const resendKey = process.env.RESEND_API_KEY ?? "";
    const dodoKey = process.env.DODO_PAYMENTS_API_KEY ?? process.env.DODO_API_KEY ?? "";
    const stripeKey = process.env.STRIPE_API_KEY ?? "";
    const vercelToken =
      process.env.AI_GATEWAY_API_KEY ??
      process.env.VERCEL_TOKEN ??
      process.env.VERCEL_API_TOKEN ??
      "";

    const dodoEnvironment = (process.env.DODO_PAYMENTS_ENVIRONMENT ?? "").trim().toLowerCase();
    const defaultDodoBaseUrl = dodoEnvironment === "test_mode"
      ? "https://test.dodopayments.com"
      : "https://live.dodopayments.com";
    const dodoBaseUrl = (process.env.DODO_PAYMENTS_BASE_URL ?? defaultDodoBaseUrl).replace(/\/$/, "");
    const dodoWebhookUrl = (process.env.DODO_PAYMENTS_WEBHOOK_URL ?? "").trim();
    const dodoCheckoutUrl = (process.env.DODO_PAYMENTS_CHECKOUT_URL ?? "").trim();

    const hasConsumerCreds = xConsumerKey.length > 0 || xConsumerSecret.length > 0;
    const hasUserTokenPair = xAccessToken.length > 0 && xAccessTokenSecret.length > 0;
    const hasClientCreds = xClientId.length > 0 && xClientSecret.length > 0;

    let xProbePromise: Promise<ConnectivityProbe>;
    if (xMockMode) {
      xProbePromise = Promise.resolve({
        service: "x",
        configured: true,
        required: xRequired,
        ok: true,
        reachable: true,
        authorized: true,
        endpoint: "mock://x",
        message: "X mock mode enabled (X_MOCK_MODE=true). No network call performed.",
      });
    } else if (hasClientCreds && !hasConsumerCreds && !hasUserTokenPair && xToken.trim().length === 0) {
      xProbePromise = runXClientCredentialsProbe({
        required: xRequired,
        clientId: xClientId,
        clientSecret: xClientSecret,
      });
    } else if (hasConsumerCreds && !hasUserTokenPair) {
      if (hasClientCreds) {
        xProbePromise = runXClientCredentialsProbe({
          required: xRequired,
          clientId: xClientId,
          clientSecret: xClientSecret,
        }).then((probe) => ({
          ...probe,
          message:
            `${probe.message} OAuth1a consumer credentials are present but missing X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET for user-context posting.`,
        }));
      } else if (xToken.trim().length > 0) {
        xProbePromise = runConnectivityProbe({
          service: "x",
          endpoint: "https://api.twitter.com/2/users/me",
          method: "GET",
          headers: {
            Authorization: `Bearer ${xToken}`,
          },
          configured: true,
          required: xRequired,
        }).then((probe) => ({
          ...probe,
          message:
            `${probe.message} OAuth1a consumer credentials are present, but posting still needs X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET.`,
        }));
      } else {
        xProbePromise = Promise.resolve({
          service: "x",
          configured: true,
          required: xRequired,
          ok: false,
          reachable: false,
          authorized: false,
          endpoint: "https://api.twitter.com/2/tweets",
          message: "X consumer credentials found, but user context is incomplete. Add X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET.",
        });
      }
    } else if (hasConsumerCreds && hasUserTokenPair) {
      xProbePromise = Promise.resolve({
        service: "x",
        configured: true,
        required: xRequired,
        ok: true,
        reachable: true,
        authorized: true,
        endpoint: "https://api.twitter.com/2/tweets",
        message: "OAuth1a user-context credentials are configured. Use x_post_thread to validate posting permissions.",
      });
    } else if (xToken.trim().length > 0) {
      xProbePromise = runConnectivityProbe({
        service: "x",
        endpoint: "https://api.twitter.com/2/users/me",
        method: "GET",
        headers: {
          Authorization: `Bearer ${xToken}`,
        },
        configured: true,
        required: xRequired,
      });
    } else {
      xProbePromise = Promise.resolve({
        service: "x",
        configured: false,
        required: xRequired,
        ok: false,
        reachable: false,
        authorized: false,
        endpoint: "https://api.twitter.com/2/users/me",
        message: "Not configured",
      });
    }

    const [xProbe, notionProbe, resendProbe, dodoProbe, dodoWebhookProbe, dodoCheckoutProbe, stripeProbe, vercelProbe] = await Promise.all([
      xProbePromise,
      runConnectivityProbe({
        service: "notion",
        endpoint: "https://api.notion.com/v1/users/me",
        method: "GET",
        headers: {
          Authorization: `Bearer ${notionKey}`,
          "Notion-Version": "2022-06-28",
        },
        configured: notionKey.trim().length > 0,
        required: notionRequired,
      }),
      runConnectivityProbe({
        service: "resend",
        endpoint: "https://api.resend.com/emails",
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        configured: resendKey.trim().length > 0,
        required: resendRequired,
        allowExpectedClientError: true,
      }),
      runConnectivityProbe({
        service: "dodo_payments",
        endpoint: `${dodoBaseUrl}/checkouts`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${dodoKey}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        configured: dodoKey.trim().length > 0,
        required: false,
        allowExpectedClientError: true,
      }),
      runConnectivityProbe({
        service: "dodo_webhook_receiver",
        endpoint: dodoWebhookUrl || "https://example.invalid",
        method: "GET",
        configured: dodoWebhookUrl.length > 0,
        required: false,
        allowExpectedClientError: true,
      }),
      runConnectivityProbe({
        service: "dodo_checkout_page",
        endpoint: dodoCheckoutUrl || "https://example.invalid",
        method: "GET",
        configured: dodoCheckoutUrl.length > 0,
        required: false,
      }),
      runConnectivityProbe({
        service: "stripe",
        endpoint: "https://api.stripe.com/v1/account",
        method: "GET",
        headers: {
          Authorization: `Bearer ${stripeKey}`,
        },
        configured: stripeKey.trim().length > 0,
        required: false,
      }),
      runConnectivityProbe({
        service: "vercel",
        endpoint: "https://api.vercel.com/v2/user",
        method: "GET",
        headers: {
          Authorization: `Bearer ${vercelToken}`,
        },
        configured: vercelToken.trim().length > 0,
        required: false,
      }),
    ]);

    const paymentsOk =
      (dodoProbe.configured && dodoProbe.ok) ||
      (dodoCheckoutProbe.configured && dodoCheckoutProbe.ok) ||
      (stripeProbe.configured && stripeProbe.ok);
    const webhookReachable = dodoWebhookProbe.configured
      ? dodoWebhookProbe.reachable
      : false;
    const checkoutPageReachable = dodoCheckoutProbe.configured
      ? dodoCheckoutProbe.reachable
      : false;
    const requiredChecksOk =
      (!xRequired || xProbe.ok) && (!notionRequired || notionProbe.ok) && (!resendRequired || resendProbe.ok);
    const overallOk = requiredChecksOk && paymentsOk;

    res.json({
      ok: overallOk,
      summary: {
        requiredChecksOk,
        paymentsOk,
        webhookReachable,
        checkoutPageReachable,
        xRequired,
        notionRequired,
        resendRequired,
        xMockMode,
      },
      results: [
        xProbe,
        notionProbe,
        resendProbe,
        dodoProbe,
        dodoWebhookProbe,
        dodoCheckoutProbe,
        stripeProbe,
        vercelProbe,
      ],
    });
  });

  /**
   * POST /ai/engines/resolve
   * Check if a specific engine is available and resolve it.
   */
  router.post("/ai/engines/resolve", (req, res) => {
    const { engine } = req.body as { engine?: string };
    if (!engine) {
      res.status(400).json({ error: "engine is required" });
      return;
    }
    try {
      const resolved = resolveEngine(engine);
      res.json({ engine, kind: resolved.kind, available: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(422).json({ engine, available: false, error: message });
    }
  });

  /**
   * POST /companies/:companyId/ai/loop/tick
   * Trigger one tick of the company execution loop.
   */
  router.post("/companies/:companyId/ai/loop/tick", async (req, res) => {
    try {
      const { companyId } = req.params;
      const result = await companyExecutionLoop(db, companyId);

      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "company-loop",
        action: "ai.loop.tick",
        entityType: "company",
        entityId: companyId,
        details: {
          goalsProcessed: result.goalsProcessed,
          stepsExecuted: result.stepsExecuted,
          goalsCompleted: result.goalsCompleted,
          goalsFailed: result.goalsFailed,
        },
      });

      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      logger.error({ err }, "Company loop tick error");
      res.status(500).json({ error: message });
    }
  });

  // -----------------------------------------------------------------------
  // Autonomous Goal / Plan routes
  // -----------------------------------------------------------------------

  /**
   * POST /companies/:companyId/ai/goals
   * Create and execute an autonomous goal.
   */
  router.post("/companies/:companyId/ai/goals", async (req, res) => {
    try {
      const { companyId } = req.params;
      const {
        agentId,
        issueId,
        goal,
        maxSteps,
        maxIterations,
        deterministic,
        deterministicSteps,
      } = req.body as {
        agentId: string;
        issueId: string;
        goal: string;
        maxSteps?: number;
        maxIterations?: number;
        deterministic?: boolean;
        deterministicSteps?: Array<{
          name: string;
          description: string;
          dependsOn?: string[];
          toolName?: string;
          toolArgs?: Record<string, unknown>;
        }>;
      };

      if (!agentId || !issueId || !goal) {
        res.status(400).json({ error: "agentId, issueId, and goal are required" });
        return;
      }

      if (deterministic) {
        if (!Array.isArray(deterministicSteps) || deterministicSteps.length === 0) {
          res.status(400).json({ error: "deterministicSteps is required when deterministic=true" });
          return;
        }
      }

      // Goal containment — check active goal budget before creating new work
      const containment = await canCreateGoal(db, companyId);
      if (!containment.allowed) {
        res.status(422).json({ error: containment.reason });
        return;
      }

      // Fetch agent
      const agent = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
        .then((rows) => rows[0] ?? null);

      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      // Fetch issue
      const issue = await db
        .select()
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);

      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }

      const runId = randomUUID();
      const orchestrator = agentOrchestrator(db);

      // Start the goal execution (async — returns immediately with plan ID)
      const resultPromise = orchestrator.executeGoal({
        companyId,
        agentId,
        issueId,
        goal,
        maxSteps,
        maxIterations,
        deterministic,
        deterministicSteps,
        context: {
          runId,
          agent: {
            id: agent.id,
            companyId: agent.companyId,
            name: agent.name,
            role: (agent.adapterConfig as any)?.role,
            runtime: (agent.adapterConfig as any)?.aiRuntime ?? "openai",
            adapterConfig: agent.adapterConfig as Record<string, unknown> | undefined,
          },
          issue: {
            id: issue.id,
            title: issue.title,
            description: issue.description ?? undefined,
            status: issue.status ?? undefined,
          },
        },
      });

      // For long-running goals, we don't await — return plan ID immediately
      // The plan store will track progress
      const store = planStore(db);
      const plans = await store.listPlans(companyId, { agentId, limit: 1 });

      // Wait briefly to let the plan be created
      await new Promise((resolve) => setTimeout(resolve, 100));

      const latestPlans = await store.listPlans(companyId, { agentId, limit: 1 });
      const planId = latestPlans[0]?.id ?? runId;

      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: agentId,
        action: "ai.goal.created",
        entityType: "agent",
        entityId: agentId,
        details: { planId, goal, issueId },
      });

      logger.info({ planId, agentId, goal }, "Goal created");

      // Fire and forget the execution
      resultPromise.catch((err) => {
        logger.error({ err, planId }, "Background goal execution failed");
      });

      res.status(201).json({ planId, goal, status: "active", runId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      logger.error({ err }, "Goal creation route error");
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /companies/:companyId/ai/goals
   * List goals/plans for a company.
   */
  router.get("/companies/:companyId/ai/goals", async (req, res) => {
    try {
      const { companyId } = req.params;
      const agentId = req.query.agentId as string | undefined;
      const status = req.query.status as string | undefined;
      const limit = Number(req.query.limit ?? 50);

      const store = planStore(db);
      const plans = await store.listPlans(companyId, { agentId, status: status as any, limit });

      res.json({ goals: plans });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      logger.error({ err }, "Goal list route error");
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /companies/:companyId/ai/goals/:goalId
   * Get a specific goal/plan.
   */
  router.get("/companies/:companyId/ai/goals/:goalId", async (req, res) => {
    try {
      const { companyId, goalId } = req.params;
      const store = planStore(db);
      const plan = await store.getPlanScoped(goalId, companyId);

      if (!plan) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }

      const orchestrator = agentOrchestrator(db);
      res.json({ ...plan, isRunning: orchestrator.isGoalRunning(plan.id) });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      logger.error({ err }, "Goal get route error");
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /companies/:companyId/ai/goals/:goalId/cancel
   * Cancel a running goal.
   */
  router.post("/companies/:companyId/ai/goals/:goalId/cancel", async (req, res) => {
    try {
      const { companyId, goalId } = req.params;

      const store = planStore(db);
      const plan = await store.getPlanScoped(goalId, companyId);

      if (!plan) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }

      const orchestrator = agentOrchestrator(db);
      orchestrator.cancelGoal(goalId);
      await store.cancelPlan(goalId, companyId);

      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: plan.agentId,
        action: "ai.goal.cancelled",
        entityType: "agent",
        entityId: plan.agentId,
        details: { planId: goalId },
      });

      res.json({ status: "cancelled", planId: goalId });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      logger.error({ err }, "Goal cancel route error");
      res.status(500).json({ error: message });
    }
  });

  return router;
}
