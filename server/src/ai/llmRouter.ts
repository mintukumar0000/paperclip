import pino from "pino";

const logger = pino({ name: "llm-router" });

export type LLMTask =
  | "reasoning"    // Analysis/planning support → low-cost GPT
  | "decision"     // Decision engine path → strong GPT
  | "content"      // Reddit posts, tweets, blog drafts → low-cost GPT
  | "reply"        // Human-sounding replies → low-cost GPT
  | "strategy"     // Goal/strategy interpretation → strong GPT
  | "email"        // Email copy generation → low-cost GPT
  | "seo";         // SEO content generation → low-cost GPT

interface ModelConfig {
  model: string;
  maxTokens: number;
  temperature: number;
}

const DEFAULT_MAX_LLM_CALLS_PER_HOUR = 50;
const LLM_BUDGET_WINDOW_MS = 60 * 60_000;
const DEFAULT_STRONG_GPT_MODEL = "openai/gpt-4o";
const DEFAULT_LOW_COST_GPT_MODEL = "openai/gpt-4o-mini";
const DEFAULT_LOW_COST_MAX_TOKENS = 900;

const llmBudgetState = {
  windowStartedAt: Date.now(),
  callsInWindow: 0,
};

function refreshLLMBudgetWindow(now = Date.now()): void {
  if (now - llmBudgetState.windowStartedAt >= LLM_BUDGET_WINDOW_MS) {
    llmBudgetState.windowStartedAt = now;
    llmBudgetState.callsInWindow = 0;
  }
}

const TASK_MODEL_MAP: Record<LLMTask, ModelConfig> = {
  reasoning: { model: DEFAULT_LOW_COST_GPT_MODEL, maxTokens: 2000, temperature: 0.3 },
  decision:  { model: DEFAULT_STRONG_GPT_MODEL, maxTokens: 1000, temperature: 0.4 },
  content:   { model: DEFAULT_LOW_COST_GPT_MODEL, maxTokens: 800, temperature: 0.8 },
  reply:     { model: DEFAULT_LOW_COST_GPT_MODEL, maxTokens: 500, temperature: 0.6 },
  strategy:  { model: DEFAULT_STRONG_GPT_MODEL, maxTokens: 3000, temperature: 0.3 },
  email:     { model: DEFAULT_LOW_COST_GPT_MODEL, maxTokens: 1200, temperature: 0.5 },
  seo:       { model: DEFAULT_LOW_COST_GPT_MODEL, maxTokens: 3000, temperature: 0.6 },
};

function isStrongTask(task: LLMTask): boolean {
  return task === "decision" || task === "strategy";
}

function getApiConfig(): { baseUrl: string; apiKey: string } {
  const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://openrouter.ai/api/v1").trim();
  return { baseUrl, apiKey };
}

function isOpenRouterLike(baseUrl: string): boolean {
  return /openrouter\.ai|aicredits\.in/i.test(baseUrl);
}

function normalizeModelForBase(model: string, baseUrl: string): string {
  if (isOpenRouterLike(baseUrl)) {
    return model;
  }

  if (model.startsWith("openai/")) {
    return model.slice("openai/".length);
  }

  if (model.startsWith("anthropic/")) {
    const fallback = (process.env.OPENAI_MODEL ?? "gpt-4o-mini").trim();
    return fallback || "gpt-4o-mini";
  }

  return model;
}

function usesCompletionTokens(model: string): boolean {
  return /^gpt-5(?:$|[.-])/.test(model);
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function resolveLowCostModel(): string {
  const configured = (
    process.env.LOW_COST_GPT_MODEL ??
    process.env.OPENAI_MODEL ??
    DEFAULT_LOW_COST_GPT_MODEL
  ).trim();
  if (!configured) return DEFAULT_LOW_COST_GPT_MODEL;
  if (configured.includes("/")) return configured;
  return `openai/${configured}`;
}

function resolveStrongModel(): string {
  const configured = (process.env.STRONG_GPT_MODEL ?? DEFAULT_STRONG_GPT_MODEL).trim();
  if (!configured) return DEFAULT_STRONG_GPT_MODEL;
  if (configured.includes("/")) return configured;
  return `openai/${configured}`;
}

function resolveTaskConfig(task: LLMTask, overrides?: Partial<ModelConfig>): ModelConfig {
  const selectedModel = isStrongTask(task) ? resolveStrongModel() : resolveLowCostModel();
  const base = { ...TASK_MODEL_MAP[task], model: selectedModel, ...overrides };

  if (isStrongTask(task)) return base;

  return {
    ...base,
    maxTokens: Math.min(
      base.maxTokens,
      readPositiveIntEnv("LOW_COST_MAX_TOKENS", DEFAULT_LOW_COST_MAX_TOKENS),
    ),
  };
}

export function getModel(task: LLMTask, options?: { baseUrl?: string; normalizeForBase?: boolean }): string {
  const baseUrl = options?.baseUrl ?? getApiConfig().baseUrl;
  const model = resolveTaskConfig(task).model;
  if (options?.normalizeForBase) {
    return normalizeModelForBase(model, baseUrl);
  }
  return model;
}

function consumeLLMBudget(task: LLMTask, model: string): boolean {
  refreshLLMBudgetWindow();

  const maxCalls = readPositiveIntEnv("MAX_LLM_CALLS_PER_HOUR", DEFAULT_MAX_LLM_CALLS_PER_HOUR);
  if (llmBudgetState.callsInWindow >= maxCalls) {
    logger.warn(
      {
        task,
        model,
        callsInWindow: llmBudgetState.callsInWindow,
        maxCalls,
      },
      "LLM hourly budget exceeded",
    );
    return false;
  }

  llmBudgetState.callsInWindow += 1;
  return true;
}

export type LLMBudgetSnapshot = {
  callsInWindow: number;
  maxCalls: number;
  remainingCalls: number;
  windowStartedAt: string;
};

export function getLLMBudgetSnapshot(): LLMBudgetSnapshot {
  refreshLLMBudgetWindow();
  const maxCalls = readPositiveIntEnv("MAX_LLM_CALLS_PER_HOUR", DEFAULT_MAX_LLM_CALLS_PER_HOUR);
  return {
    callsInWindow: llmBudgetState.callsInWindow,
    maxCalls,
    remainingCalls: Math.max(0, maxCalls - llmBudgetState.callsInWindow),
    windowStartedAt: new Date(llmBudgetState.windowStartedAt).toISOString(),
  };
}

function getHeaders(apiKey: string, baseUrl: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (!isOpenRouterLike(baseUrl)) {
    return headers;
  }
  const siteUrl = (process.env.OPENROUTER_SITE_URL ?? "").trim();
  const appName = (process.env.OPENROUTER_APP_NAME ?? "paperclip").trim();
  if (siteUrl) headers["HTTP-Referer"] = siteUrl;
  if (appName) headers["X-Title"] = appName;
  return headers;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  task: LLMTask;
  tokensUsed: number;
}

export async function routeLLM(
  task: LLMTask,
  messages: LLMMessage[],
  overrides?: Partial<ModelConfig>,
): Promise<LLMResponse | null> {
  const { baseUrl, apiKey } = getApiConfig();
  if (!apiKey) {
    logger.warn({ task }, "LLM router: no API key configured");
    return null;
  }

  const config = resolveTaskConfig(task, overrides);
  const resolvedModel = normalizeModelForBase(config.model, baseUrl);
  if (!consumeLLMBudget(task, resolvedModel)) {
    return null;
  }

  try {
    const body: Record<string, unknown> = {
      model: resolvedModel,
      temperature: config.temperature,
      messages,
    };
    if (usesCompletionTokens(resolvedModel)) {
      body.max_completion_tokens = config.maxTokens;
    } else {
      body.max_tokens = config.maxTokens;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: getHeaders(apiKey, baseUrl),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      logger.warn({ task, model: resolvedModel, status: response.status, body: text.slice(0, 200) }, "LLM router request failed");
      return null;
    }

    const data = (await response.json()) as Record<string, unknown>;
    const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
    let content = choices?.[0]?.message?.content?.trim() ?? "";

    if (content.startsWith("```")) {
      content = content.replace(/^```(?:json|html|markdown)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    }

    const usage = data.usage as { total_tokens?: number } | undefined;
    const tokensUsed = usage?.total_tokens ?? 0;
    const llmCallDebugEnabled = parseBooleanEnv(process.env.LLM_DEBUG_LOGS, true);
    if (llmCallDebugEnabled) {
      const budget = getLLMBudgetSnapshot();
      console.log("LLM CALL", {
        task,
        model: resolvedModel,
        tokens: tokensUsed,
        hourUsage: `${budget.callsInWindow}/${budget.maxCalls}`,
      });
    }

    return {
      content,
      model: resolvedModel,
      task,
      tokensUsed,
    };
  } catch (err) {
    logger.error({ err, task, model: resolvedModel }, "LLM router error");
    return null;
  }
}

export async function routeLLMJSON<T = Record<string, unknown>>(
  task: LLMTask,
  messages: LLMMessage[],
  overrides?: Partial<ModelConfig>,
): Promise<T | null> {
  const response = await routeLLM(task, messages, overrides);
  if (!response?.content) return null;

  try {
    return JSON.parse(response.content) as T;
  } catch {
    logger.warn({ task, contentPreview: response.content.slice(0, 100) }, "LLM JSON parse failed");
    return null;
  }
}
