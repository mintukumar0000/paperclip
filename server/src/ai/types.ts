// ---------------------------------------------------------------------------
// AI Layer — Universal LLM & Runtime types
// ---------------------------------------------------------------------------

/** Input for LLM generation */
export interface LLMGenerateInput {
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: LLMToolDefinition[];
}

/** Tool definition exposed to the LLM */
export interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Standardized tool-call envelope used by the execution engine */
export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/** LLM response — either plain text or a tool call */
export interface LLMResponse {
  text?: string;
  toolCall?: ToolCall;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  provider: string;
  model: string;
}

/** Universal LLM adapter interface */
export interface LLMAdapter {
  readonly name: string;
  generate(input: LLMGenerateInput): Promise<LLMResponse>;
}

/** Runtime execution context passed through the pipeline */
export interface AIExecutionContext {
  runId: string;
  agent: {
    id: string;
    companyId: string;
    name: string;
    role?: string;
    runtime?: string;
    adapterConfig?: Record<string, unknown>;
  };
  issue: {
    id: string;
    title: string;
    description?: string;
    status?: string;
  };
  memoryContext?: string;
  tools?: string[];
  forcedToolCall?: ToolCall;
}

/** Result of a full AI execution cycle */
export interface AIExecutionResult {
  status: "completed" | "tool_executed" | "failed" | "guarded";
  output?: string;
  toolName?: string;
  toolResult?: unknown;
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    provider: string;
    model: string;
  };
}

/** Runtime adapter for external autonomous systems */
export interface RuntimeAdapter {
  readonly name: string;
  execute(context: AIExecutionContext): Promise<{
    status: string;
    output: unknown;
  }>;
}
