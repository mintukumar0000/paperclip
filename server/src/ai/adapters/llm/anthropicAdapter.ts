import type { LLMAdapter, LLMGenerateInput, LLMResponse } from "../../types.js";
import pino from "pino";

const logger = pino({ name: "ai-anthropic-adapter" });

export class AnthropicAdapter implements LLMAdapter {
  readonly name = "anthropic";

  async generate(input: LLMGenerateInput): Promise<LLMResponse> {
    const apiKey = (process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_CODE_API_KEY ?? "").trim();
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY or CLAUDE_CODE_API_KEY environment variable is required");
    }

    const model = process.env.ANTHROPIC_MODEL ?? "claude-3-7-sonnet-latest";
    const maxTokens = input.maxTokens ?? 1024;

    const messages: Array<{ role: string; content: string }> = [
      { role: "user", content: input.prompt },
    ];

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages,
      temperature: input.temperature ?? 0.7,
    };

    if (input.systemPrompt) {
      body.system = input.systemPrompt;
    }

    if (input.tools && input.tools.length > 0) {
      body.tools = input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    logger.info({ model, promptLength: input.prompt.length }, "Anthropic request");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${errorText}`);
    }

    const data = (await res.json()) as {
      content: Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      >;
      usage?: { input_tokens: number; output_tokens: number };
    };

    const response: LLMResponse = {
      provider: "anthropic",
      model,
    };

    const toolUse = data.content.find((c) => c.type === "tool_use");
    if (toolUse && toolUse.type === "tool_use") {
      response.toolCall = {
        tool: toolUse.name,
        args: toolUse.input,
      };
    } else {
      const textBlock = data.content.find((c) => c.type === "text");
      response.text = textBlock && textBlock.type === "text" ? textBlock.text : undefined;
    }

    if (data.usage) {
      response.usage = {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
      };
    }

    logger.info(
      { model, inputTokens: response.usage?.inputTokens, outputTokens: response.usage?.outputTokens },
      "Anthropic response received",
    );

    return response;
  }
}
