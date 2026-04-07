import type { LLMAdapter, LLMGenerateInput, LLMResponse } from "../../types.js";
import pino from "pino";

const logger = pino({ name: "ai-openai-adapter" });

function usesCompletionTokens(model: string): boolean {
  return /^gpt-5(?:$|[.-])/.test(model);
}

export class OpenAIAdapter implements LLMAdapter {
  readonly name = "openai";

  async generate(input: LLMGenerateInput): Promise<LLMResponse> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is required");
    }

    const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    const messages: Array<{ role: string; content: string }> = [];

    if (input.systemPrompt) {
      messages.push({ role: "system", content: input.systemPrompt });
    }
    messages.push({ role: "user", content: input.prompt });

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: input.temperature ?? 0.7,
    };
    if (input.maxTokens) {
      if (usesCompletionTokens(model)) {
        body.max_completion_tokens = input.maxTokens;
      } else {
        body.max_tokens = input.maxTokens;
      }
    }
    if (input.tools && input.tools.length > 0) {
      body.tools = input.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    const apiBaseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const endpoint = `${apiBaseUrl}/chat/completions`;
    const isOpenRouter = apiBaseUrl.includes("openrouter.ai");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };

    if (isOpenRouter) {
      const siteUrl = process.env.OPENROUTER_SITE_URL?.trim();
      const appName = process.env.OPENROUTER_APP_NAME?.trim();
      if (siteUrl) headers["HTTP-Referer"] = siteUrl;
      if (appName) headers["X-Title"] = appName;
    }

    logger.info({ model, promptLength: input.prompt.length, apiBaseUrl }, "OpenAI-compatible request");

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${errorText}`);
    }

    const data = (await res.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices[0];
    const toolCalls = choice?.message?.tool_calls;

    const response: LLMResponse = {
      provider: "openai",
      model,
    };

    if (toolCalls && toolCalls.length > 0) {
      const tc = toolCalls[0];
      response.toolCall = {
        tool: tc.function.name,
        args: JSON.parse(tc.function.arguments),
      };
    } else {
      response.text = choice?.message?.content ?? undefined;
    }

    if (data.usage) {
      response.usage = {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      };
    }

    logger.info(
      { model, inputTokens: response.usage?.inputTokens, outputTokens: response.usage?.outputTokens },
      "OpenAI response received",
    );

    return response;
  }
}
