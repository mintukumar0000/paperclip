import type { Db } from "@paperclipai/db";
import pino from "pino";
import {
  buildIntegrationContext,
  createDodoCheckoutSession,
  createNotionPage,
  createStripeCheckoutSession,
  executeBrowserAutomation,
  executeHttpApiRequest,
  tavilyWebSearch,
  postXThread,
  posthogTrackEvent,
  postToRedditPlaywright,
  postToTwitterPlaywright,
  sendResendEmail,
  triggerVercelDeploy,
  submitRedditPost,
} from "./externalTools.js";

const logger = pino({ name: "ai-tool-registry" });

interface ToolHealthState {
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  averageLatencyMs: number;
  lastError?: string;
  lastFailureAt?: string;
  circuitOpenUntilMs?: number;
}

const toolHealth = new Map<string, ToolHealthState>();
const TOOL_TIMEOUT_MS = Math.max(5_000, Number(process.env.AI_TOOL_TIMEOUT_MS ?? 60_000));
const TOOL_CIRCUIT_BREAKER_THRESHOLD = Math.max(2, Number(process.env.AI_TOOL_CB_THRESHOLD ?? 3));
const TOOL_CIRCUIT_BREAKER_OPEN_MS = Math.max(5_000, Number(process.env.AI_TOOL_CB_OPEN_MS ?? 30_000));

function getToolHealthState(toolName: string): ToolHealthState {
  let current = toolHealth.get(toolName);
  if (!current) {
    current = {
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      averageLatencyMs: 0,
    };
    toolHealth.set(toolName, current);
  }
  return current;
}

function updateAverageLatency(current: number, sample: number): number {
  if (current <= 0) return sample;
  return Math.round(current * 0.8 + sample * 0.2);
}

function healthScore(state: ToolHealthState): number {
  const total = state.successCount + state.failureCount;
  const successRate = total > 0 ? state.successCount / total : 1;
  const failurePenalty = Math.min(1, state.consecutiveFailures / TOOL_CIRCUIT_BREAKER_THRESHOLD);
  const latencyPenalty = Math.min(1, Math.max(0, state.averageLatencyMs - 1_500) / 10_000);

  const score = (successRate * 0.65 + (1 - failurePenalty) * 0.2 + (1 - latencyPenalty) * 0.15) * 100;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface ToolRegistryDeps {
  db: Db;
  companyId: string;
  agentId: string;
  adapterConfig?: Record<string, unknown>;
}

/**
 * Build a tool registry scoped to a specific company and agent.
 * Tools interact with real services (issues, messages, memory).
 */
export function createToolRegistry(deps: ToolRegistryDeps): Map<string, ToolHandler> {
  const { db, companyId, agentId } = deps;
  const tools = new Map<string, ToolHandler>();
  const integrationCtx = buildIntegrationContext(deps.adapterConfig);

  const withRetries = (toolName: string, handler: ToolHandler): ToolHandler => {
    return async (args: Record<string, unknown>) => {
      const state = getToolHealthState(toolName);
      const nowMs = Date.now();
      if (state.circuitOpenUntilMs && state.circuitOpenUntilMs > nowMs) {
        const retryAfterMs = state.circuitOpenUntilMs - nowMs;
        throw new Error(
          `Tool ${toolName} circuit breaker is open. Retry after ${Math.ceil(retryAfterMs / 1000)}s (healthScore=${healthScore(state)})`,
        );
      }

      let lastError: unknown;
      const startedAt = Date.now();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          if (attempt > 0) {
            logger.warn({ toolName, attempt: attempt + 1, agentId }, "Retrying tool execution");
          }

          const result = await Promise.race([
            handler(args),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error(`Tool timeout after ${Math.round(TOOL_TIMEOUT_MS / 1000)}s`)), TOOL_TIMEOUT_MS);
            }),
          ]);

          const latencyMs = Date.now() - startedAt;
          state.successCount += 1;
          state.consecutiveFailures = 0;
          state.lastError = undefined;
          state.lastFailureAt = undefined;
          state.circuitOpenUntilMs = undefined;
          state.averageLatencyMs = updateAverageLatency(state.averageLatencyMs, latencyMs);

          logger.info(
            { toolName, agentId, latencyMs, healthScore: healthScore(state) },
            "Tool execution succeeded",
          );

          return result;
        } catch (err) {
          lastError = err;
          if (attempt < 2) {
            await sleep(250 * (attempt + 1));
            continue;
          }
        }
      }

      const latencyMs = Date.now() - startedAt;
      state.failureCount += 1;
      state.consecutiveFailures += 1;
      state.lastError = lastError instanceof Error ? lastError.message : String(lastError);
      state.lastFailureAt = new Date().toISOString();
      state.averageLatencyMs = updateAverageLatency(state.averageLatencyMs, latencyMs);

      if (state.consecutiveFailures >= TOOL_CIRCUIT_BREAKER_THRESHOLD) {
        state.circuitOpenUntilMs = Date.now() + TOOL_CIRCUIT_BREAKER_OPEN_MS;
        logger.warn(
          {
            toolName,
            agentId,
            consecutiveFailures: state.consecutiveFailures,
            circuitOpenUntil: new Date(state.circuitOpenUntilMs).toISOString(),
            healthScore: healthScore(state),
          },
          "Tool circuit breaker opened",
        );
      }

      throw lastError instanceof Error ? lastError : new Error(`Tool ${toolName} failed`);
    };
  };

  const registerTool = (name: string, handler: ToolHandler): void => {
    tools.set(name, withRetries(name, handler));
  };

  // Lazy-import services to avoid circular dependencies
  registerTool("create_issue", async (args) => {
    const { issueService } = await import("../../services/index.js");
    const svc = issueService(db);
    const result = await svc.create(companyId, {
      title: String(args.title ?? ""),
      description: args.description != null ? String(args.description) : undefined,
      priority: args.priority != null ? String(args.priority) as any : undefined,
    });
    logger.info({ issueId: result.id, agentId }, "Tool: created issue");
    return { id: result.id, title: result.title, status: result.status };
  });

  registerTool("update_issue", async (args) => {
    const { issueService } = await import("../../services/index.js");
    const svc = issueService(db);
    const issueId = String(args.issueId ?? "");
    if (!issueId) throw new Error("issueId is required");
    const result = await svc.update(issueId, {
      ...(args.title != null ? { title: String(args.title) } : {}),
      ...(args.status != null ? { status: String(args.status) as any } : {}),
      ...(args.description != null ? { description: String(args.description) } : {}),
    });
    if (!result) throw new Error(`Issue ${issueId} not found`);
    logger.info({ issueId: result.id, agentId }, "Tool: updated issue");
    return { id: result.id, title: result.title, status: result.status };
  });

  registerTool("send_message", async (args) => {
    const { messageService } = await import("../../services/index.js");
    const svc = messageService(db);
    const toAgentId = String(args.toAgentId ?? "");
    const message = String(args.message ?? "");
    if (!toAgentId || !message) throw new Error("toAgentId and message are required");
    const result = await svc.sendMessage(companyId, agentId, toAgentId, message);
    logger.info({ messageId: result.id, toAgentId, agentId }, "Tool: sent message");
    return { id: result.id, status: result.status };
  });

  registerTool("store_memory", async (args) => {
    const { memoryService: getMemorySvc } = await import("../../memory/memoryService.js");
    const memorySvc = getMemorySvc(db);
    const result = await memorySvc.storeMemory({
      companyId,
      agentId,
      type: (args.type as "knowledge" | "observation" | "decision" | "experiment") ?? "knowledge",
      title: String(args.title ?? ""),
      content: String(args.content ?? ""),
    });
    logger.info({ memoryId: result.id, type: args.type, agentId }, "Tool: stored memory");
    return { id: result.id, type: result.type };
  });

  registerTool("http_api_request", async (args) => {
    const result = await executeHttpApiRequest(integrationCtx, args);
    logger.info({ agentId }, "Tool: HTTP API request executed");
    return result;
  });

  registerTool("tavily_web_search", async (args) => {
    const result = await tavilyWebSearch(integrationCtx, args);
    logger.info({ agentId }, "Tool: Tavily web search executed");
    return result;
  });

  registerTool("browser_automation", async (args) => {
    const result = await executeBrowserAutomation(integrationCtx, args);
    logger.info({ agentId }, "Tool: browser automation executed");
    return result;
  });

  registerTool("x_post_thread", async (args) => {
    const result = await postXThread(integrationCtx, args);
    logger.info({ agentId }, "Tool: X thread posted");
    return result;
  });

  registerTool("post_twitter", async (args) => {
    const result = await postToTwitterPlaywright(integrationCtx, args);
    logger.info({ agentId }, "Tool: Twitter post submitted via Playwright");
    return result;
  });

  registerTool("reddit_submit_post", async (args) => {
    const result = await submitRedditPost(integrationCtx, args);
    logger.info({ agentId }, "Tool: Reddit post submitted");
    return result;
  });

  registerTool("post_reddit", async (args) => {
    const result = await postToRedditPlaywright(integrationCtx, args);
    logger.info({ agentId }, "Tool: Reddit post submitted via Playwright");
    return result;
  });

  registerTool("notion_create_page", async (args) => {
    const result = await createNotionPage(integrationCtx, args);
    logger.info({ agentId }, "Tool: Notion page created");
    return result;
  });

  registerTool("stripe_create_checkout_session", async (args) => {
    const result = await createStripeCheckoutSession(integrationCtx, args);
    logger.info({ agentId }, "Tool: Stripe checkout session created");
    return result;
  });

  registerTool("dodo_create_checkout_session", async (args) => {
    const result = await createDodoCheckoutSession(integrationCtx, args);
    logger.info({ agentId }, "Tool: Dodo checkout session created");
    return result;
  });

  registerTool("resend_send_email", async (args) => {
    const result = await sendResendEmail(integrationCtx, args);
    logger.info({ agentId }, "Tool: Resend email sent");
    return result;
  });

  registerTool("posthog_track_event", async (args) => {
    const result = await posthogTrackEvent(integrationCtx, args);
    const eventName = typeof args.event === "string" ? args.event.toLowerCase() : "";
    const isTrafficEvent = /(visit|page_view|landing_view|session_start|\$screen)/.test(eventName);
    const isEngagementEvent = /(cta_clicked|email_submitted|payment_started)/.test(eventName);
    const isConversionEvent = /(conversion|subscribe|sign_up|signup|user_signed_up|email_capture|payment_completed)/.test(eventName);

    try {
      if (!(db as { insert?: unknown }).insert || typeof (db as { insert?: unknown }).insert !== "function") {
        logger.warn({ agentId, companyId }, "Skipping PostHog decision-loop wiring: db adapter unavailable");
        return result;
      }

      const { getRecentSystemMetricsSnapshot, recordSystemMetric } = await import("../feedback/metricsEngine.js");
      await recordSystemMetric(db, {
        companyId,
        sourceType: "tool_action",
        sourceId: `${agentId}:posthog:${Date.now()}`,
        traffic: isTrafficEvent ? 1 : 0,
        conversions: isConversionEvent ? 1 : 0,
        taskSuccessRate: 1,
        metadata: {
          tool: "posthog_track_event",
          event: args.event,
          distinctId: args.distinctId,
          source: (args.properties as Record<string, unknown> | undefined)?.source,
          engagement: isEngagementEvent,
        },
      });

      const { dispatchDecisionCycle } = await import("../../services/decision-dispatch.js");

      if (isConversionEvent) {
        await dispatchDecisionCycle(db, {
          companyId,
          source: "manual",
          reason: `PostHog conversion event: ${eventName}`,
          dedupeKey: `${companyId}:posthog-conversion:${eventName}:${new Date().toISOString().slice(0, 16)}`,
        });
      }

      if (isTrafficEvent || isEngagementEvent || isConversionEvent) {
        const snapshot = await getRecentSystemMetricsSnapshot(db, companyId, 180);
        const minimumTraffic = Math.max(10, Number(process.env.AI_MIN_TRAFFIC_FOR_CONVERSION_ALERT ?? 25));
        const thresholdPercent = Math.max(0.1, Number(process.env.AI_CONVERSION_THRESHOLD_PERCENT ?? 2));

        if (snapshot.traffic >= minimumTraffic && snapshot.conversion_rate < thresholdPercent) {
          await dispatchDecisionCycle(db, {
            companyId,
            source: "manual",
            reason: `Low conversion rate detected (${snapshot.conversion_rate.toFixed(2)}% < ${thresholdPercent.toFixed(2)}%)`,
            dedupeKey: `${companyId}:low-conversion:${new Date().toISOString().slice(0, 13)}`,
          });
        }
      }
    } catch (err) {
      logger.warn({ err, agentId, companyId }, "Failed to wire PostHog event into decision loop");
    }

    logger.info({ agentId }, "Tool: PostHog event tracked");
    return result;
  });

  registerTool("vercel_trigger_deploy", async (args) => {
    const result = await triggerVercelDeploy(integrationCtx, args);
    logger.info({ agentId }, "Tool: Vercel deploy triggered");
    return result;
  });

  return tools;
}
