import type { LLMAdapter, LLMGenerateInput, LLMResponse } from "../../types.js";
import pino from "pino";

const logger = pino({ name: "ai-mistral-adapter" });

export class MistralAdapter implements LLMAdapter {
  readonly name = "mistral";

  async generate(input: LLMGenerateInput): Promise<LLMResponse> {
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) {
      throw new Error("MISTRAL_API_KEY environment variable is required");
    }

    const model = process.env.MISTRAL_MODEL ?? "mistral-small-latest";
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
      body.max_tokens = input.maxTokens;
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

    logger.info({ model, promptLength: input.prompt.length }, "Mistral request");

    const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Mistral API error ${res.status}: ${errorText}`);
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
      provider: "mistral",
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
      "Mistral response received",
    );

    return response;
  }
}
