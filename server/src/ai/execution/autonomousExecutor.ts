import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import pino from "pino";
import { eventBus } from "../../events/eventBus.js";
import { recordActionOutcome } from "../../memory/embeddingMemory.js";
import { recordSkillUsage, getSkillsByCategory, type SkillCategory } from "../skills/skillStore.js";
import { issueService } from "../../services/issues.js";

const logger = pino({ name: "autonomous-executor" });

const DEFAULT_MAX_EXECUTIONS_PER_CYCLE = 2;
const DEFAULT_MAX_EXECUTIONS_PER_HOUR = 10;
const EXECUTION_HOURLY_WINDOW_MS = 60 * 60_000;
const UNHANDLED_ACTION_ISSUE_COOLDOWN_MS = 6 * 60 * 60_000;

export interface ExecutionAction {
  key: string;
  type: string;
  reasoning: string;
  priority: "high" | "medium" | "low";
  expectedImpact: string;
  confidence: number;
  source: string;
  skillIds?: string[];
}

export interface ExecutionResult {
  action: ExecutionAction;
  executed: boolean;
  success: boolean;
  method: "auto" | "queued" | "skipped";
  details: Record<string, unknown>;
}

const AUTO_EXECUTE_THRESHOLD = 0.65;
const executionHistory = new Map<string, { lastRun: number; consecutiveFailures: number }>();
const unhandledActionIssueCooldown = new Map<string, number>();
const hourlyExecutionBudget = new Map<string, { windowStartedAt: number; executionsInWindow: number }>();

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function getHourlyExecutionBudget(companyId: string): { windowStartedAt: number; executionsInWindow: number } {
  const now = Date.now();
  const current = hourlyExecutionBudget.get(companyId);
  if (!current || now - current.windowStartedAt >= EXECUTION_HOURLY_WINDOW_MS) {
    const fresh = { windowStartedAt: now, executionsInWindow: 0 };
    hourlyExecutionBudget.set(companyId, fresh);
    return fresh;
  }
  return current;
}

function shouldAutoExecute(action: ExecutionAction): boolean {
  if (action.confidence < AUTO_EXECUTE_THRESHOLD) return false;

  const histKey = `${action.source}:${action.key}`;
  const hist = executionHistory.get(histKey);
  if (hist) {
    if (Date.now() - hist.lastRun < 30 * 60_000) return false;
    if (hist.consecutiveFailures >= 3) return false;
  }

  return true;
}

function recordExecution(action: ExecutionAction, success: boolean): void {
  const histKey = `${action.source}:${action.key}`;
  const hist = executionHistory.get(histKey) ?? { lastRun: 0, consecutiveFailures: 0 };
  hist.lastRun = Date.now();
  hist.consecutiveFailures = success ? 0 : hist.consecutiveFailures + 1;
  executionHistory.set(histKey, hist);
}

async function createUnhandledActionIssue(
  db: Db,
  companyId: string,
  action: ExecutionAction,
): Promise<Record<string, unknown>> {
  const cooldownKey = `${companyId}:${action.key}`;
  const lastCreatedAt = unhandledActionIssueCooldown.get(cooldownKey) ?? 0;
  if (Date.now() - lastCreatedAt < UNHANDLED_ACTION_ISSUE_COOLDOWN_MS) {
    return { unhandledActionIssueCreated: false, reason: "cooldown_active" };
  }

  try {
    const svc = issueService(db);
    const issue = await svc.create(companyId, {
      title: `Unhandled autonomous action: ${action.key}`,
      description: `No executor is registered for action key "${action.key}" (type: ${action.type}).\n\nReasoning: ${action.reasoning}`,
      priority: "high",
      status: "backlog",
    });
    unhandledActionIssueCooldown.set(cooldownKey, Date.now());
    return {
      unhandledActionIssueCreated: true,
      issueId: issue.id,
      issueIdentifier: issue.identifier ?? null,
    };
  } catch (err) {
    logger.warn({ err, companyId, actionKey: action.key }, "Failed to create fallback issue for unhandled action");
    return { unhandledActionIssueCreated: false, reason: "issue_create_failed" };
  }
}

async function executeTrafficAction(db: Db, companyId: string, action: ExecutionAction): Promise<boolean> {
  try {
    const { _runTrafficCycleForTest } = await import("../../core/trafficLoop.js");
    const baseUrl = (process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ?? "http://localhost:3100").trim();
    logger.info({ companyId, key: action.key }, "Executor: triggering traffic cycle");
    void _runTrafficCycleForTest({ db, baseUrl });
    return true;
  } catch (err) {
    logger.warn({ err, key: action.key }, "Traffic action execution failed");
    return false;
  }
}

async function executeLandingAction(db: Db, companyId: string, action: ExecutionAction): Promise<boolean> {
  try {
    const { generateLandingVariants } = await import("../distribution/landingVariants.js");
    await generateLandingVariants(db, companyId);
    logger.info({ companyId }, "Executor: generated new landing variants");
    return true;
  } catch (err) {
    logger.warn({ err }, "Landing variant generation failed");
    return false;
  }
}

async function executeEmailAction(db: Db, companyId: string, action: ExecutionAction): Promise<boolean> {
  try {
    const { runEmailSequenceCycle } = await import("../distribution/emailSequence.js");
    await runEmailSequenceCycle(db);
    logger.info({ companyId }, "Executor: triggered email sequence cycle");
    return true;
  } catch (err) {
    logger.warn({ err }, "Email sequence execution failed");
    return false;
  }
}

async function executePricingAction(db: Db, companyId: string, action: ExecutionAction): Promise<boolean> {
  // Persist a concrete optimization task so downstream loops can act deterministically.
  try {
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "autonomous-executor",
      agentId: null,
      runId: null,
      action: "pricing.optimization.requested",
      entityType: "company",
      entityId: companyId,
      details: {
        key: action.key,
        reasoning: action.reasoning,
        expectedImpact: action.expectedImpact,
        confidence: action.confidence,
      },
    });
  } catch (err) {
    logger.warn({ err, companyId, key: action.key }, "Failed to persist pricing optimization request");
  }

  eventBus.publish("executor.pricing.optimization", {
    companyId,
    actionKey: action.key,
    reasoning: action.reasoning,
    timestamp: new Date().toISOString(),
  });
  logger.info({ companyId, key: action.key }, "Executor: pricing optimization event published");
  return true;
}

async function executeContentAction(db: Db, companyId: string, action: ExecutionAction): Promise<boolean> {
  try {
    const { generateBlogPost, publishBlogPost } = await import("../distribution/seoContentEngine.js");
    const keyword = "cold email templates for startups";
    const post = await generateBlogPost(keyword);
    if (post) {
      await publishBlogPost(db, companyId, post);
      return true;
    }
    return false;
  } catch (err) {
    logger.warn({ err }, "Content generation execution failed");
    return false;
  }
}

export async function checkAndScaleWinners(
  db: Db,
  companyId: string,
  metrics: { ctr?: number; signupRate?: number; paymentRate?: number },
): Promise<void> {
  const shouldScale = (metrics.ctr ?? 0) > 0.05 || (metrics.signupRate ?? 0) > 0.15;

  if (shouldScale) {
    logger.info({ companyId, metrics }, "Winner detected — triggering immediate scale");
    await executeTrafficAction(db, companyId, {
      key: "auto_scale_distribution",
      type: "auto_scale",
      reasoning: `Auto-scaling: CTR=${metrics.ctr ?? 0}, signup=${metrics.signupRate ?? 0}`,
      priority: "high",
      expectedImpact: "2x traffic on winning channel",
      confidence: 0.9,
      source: "auto-scaler",
    });
  }

  const shouldKill = (metrics.ctr ?? 0) < 0.005 && (metrics.signupRate ?? 0) < 0.005;
  if (shouldKill) {
    logger.info({ companyId, metrics }, "Underperformer detected — killing channel");
    eventBus.publish("executor.kill.underperformer", {
      companyId,
      metrics,
      timestamp: new Date().toISOString(),
    });
  }
}

async function executeKillUnderperformerAction(db: Db, companyId: string, action: ExecutionAction): Promise<boolean> {
  await db.insert(activityLog).values({
    companyId,
    actorType: "system",
    actorId: "autonomous-executor",
    agentId: null,
    runId: null,
    action: "distribution.channel.pause.requested",
    entityType: "company",
    entityId: companyId,
    details: {
      key: action.key,
      reasoning: action.reasoning,
      expectedImpact: action.expectedImpact,
      requestedBy: action.source,
    },
  });

  eventBus.publish("executor.kill.underperformer", {
    companyId,
    actionKey: action.key,
    reasoning: action.reasoning,
    timestamp: new Date().toISOString(),
  });

  return true;
}

async function executePauseSpendingAction(db: Db, companyId: string, action: ExecutionAction): Promise<boolean> {
  await db.insert(activityLog).values({
    companyId,
    actorType: "system",
    actorId: "autonomous-executor",
    agentId: null,
    runId: null,
    action: "finance.spend.pause.requested",
    entityType: "company",
    entityId: companyId,
    details: {
      key: action.key,
      reasoning: action.reasoning,
      expectedImpact: action.expectedImpact,
      requestedBy: action.source,
    },
  });

  eventBus.publish("executor.finance.pause_requested", {
    companyId,
    actionKey: action.key,
    reasoning: action.reasoning,
    timestamp: new Date().toISOString(),
  });

  return true;
}

const ACTION_EXECUTORS: Record<string, (db: Db, companyId: string, action: ExecutionAction) => Promise<boolean>> = {
  increase_content_output: executeTrafficAction,
  auto_scale_distribution: executeTrafficAction,
  improve_landing_page: executeLandingAction,
  increase_reddit_frequency: executeTrafficAction,
  kill_underperformer: executeKillUnderperformerAction,
  run_pricing_experiment: executePricingAction,
  optimize_pricing: executePricingAction,
  profitability_pricing_experiment: executePricingAction,
  payment_conversion_under_target: executePricingAction,
  low_revenue_per_visitor: executePricingAction,
  improve_offer_framing: executePricingAction,
  audience_repositioning: executePricingAction,
  audience_repositioning_test: executePricingAction,
  revenue_per_user_under_target: executePricingAction,
  email_sequence_optimization: executeEmailAction,
  improve_email_sequence: executeEmailAction,
  generate_seo_content: executeContentAction,
  pause_spending: executePauseSpendingAction,
};

export async function executeActions(
  db: Db,
  companyId: string,
  actions: ExecutionAction[],
): Promise<ExecutionResult[]> {
  const sorted = [...actions].sort((a, b) => {
    const priorityOrder = { high: 3, medium: 2, low: 1 };
    const pDiff = (priorityOrder[b.priority] ?? 0) - (priorityOrder[a.priority] ?? 0);
    if (pDiff !== 0) return pDiff;
    return b.confidence - a.confidence;
  });

  const results: ExecutionResult[] = [];
  const maxAutoExecutions = readPositiveIntEnv(
    "MAX_EXECUTIONS_PER_CYCLE",
    DEFAULT_MAX_EXECUTIONS_PER_CYCLE,
  );
  const maxExecutionsPerHour = readPositiveIntEnv(
    "MAX_EXECUTIONS_PER_HOUR",
    DEFAULT_MAX_EXECUTIONS_PER_HOUR,
  );
  const hourlyBudget = getHourlyExecutionBudget(companyId);
  let autoExecuted = 0;

  for (const action of sorted) {
    const executor = ACTION_EXECUTORS[action.key];
    const hourlyCapReached = hourlyBudget.executionsInWindow >= maxExecutionsPerHour;
    const canAuto = shouldAutoExecute(action) && autoExecuted < maxAutoExecutions && !hourlyCapReached;

    if (!executor || !canAuto) {
      const fallbackDetails = !executor
        ? await createUnhandledActionIssue(db, companyId, action)
        : {};

      results.push({
        action,
        executed: false,
        success: false,
        method: action.confidence < AUTO_EXECUTE_THRESHOLD ? "skipped" : "queued",
        details: {
          reason: !executor
            ? "no_executor_registered"
            : action.confidence < AUTO_EXECUTE_THRESHOLD
            ? "confidence_below_threshold"
            : hourlyCapReached
            ? "max_executions_per_hour_reached"
            : "max_executions_reached",
          ...fallbackDetails,
        },
      });
      continue;
    }

    let success = false;
    try {
      success = await executor(db, companyId, action);
      autoExecuted++;
      hourlyBudget.executionsInWindow += 1;
    } catch (err) {
      logger.error({ err, key: action.key }, "Action execution failed");
    }

    recordExecution(action, success);

    await recordActionOutcome(db, companyId, action.key, success, {
      type: action.type,
      reasoning: action.reasoning,
      confidence: action.confidence,
      source: action.source,
    }).catch(() => {});

    if (action.skillIds) {
      for (const sid of action.skillIds) {
        await recordSkillUsage(db, sid, success).catch(() => {});
      }
    }

    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "autonomous-executor",
      agentId: null,
      runId: null,
      action: `executor.${action.key}.${success ? "success" : "failure"}`,
      entityType: "company",
      entityId: companyId,
      details: {
        key: action.key,
        priority: action.priority,
        confidence: action.confidence,
        reasoning: action.reasoning.slice(0, 200),
        source: action.source,
        success,
      },
    });

    results.push({
      action,
      executed: true,
      success,
      method: "auto",
      details: { autoExecuted: true },
    });
  }

  const successCount = results.filter((r) => r.success).length;
  const skippedCount = results.filter((r) => r.method === "skipped").length;

  logger.info(
    {
      companyId,
      total: results.length,
      autoExecuted,
      successCount,
      skippedCount,
      executionsInCurrentHour: hourlyBudget.executionsInWindow,
      maxExecutionsPerHour,
    },
    "Autonomous execution cycle completed",
  );

  eventBus.publish("executor.cycle.completed", {
    companyId,
    total: results.length,
    autoExecuted,
    successCount,
    skippedCount,
    executionsInCurrentHour: hourlyBudget.executionsInWindow,
    maxExecutionsPerHour,
    timestamp: new Date().toISOString(),
  });

  return results;
}
