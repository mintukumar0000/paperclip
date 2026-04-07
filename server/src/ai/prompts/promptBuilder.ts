import type { AIExecutionContext, LLMToolDefinition } from "../types.js";

/**
 * Build a structured prompt for agent reasoning.
 */
export function buildPrompt(context: AIExecutionContext): {
  prompt: string;
  systemPrompt: string;
  tools: LLMToolDefinition[];
} {
  const { agent, issue, memoryContext } = context;

  const systemPrompt = [
    `You are ${agent.name}, an autonomous AI agent operating within a company management system.`,
    agent.role ? `Your role: ${agent.role}` : "",
    "",
    "You can perform actions by calling tools. Think step-by-step.",
    "If a tool is needed, call it. Otherwise, return your analysis directly.",
    "If the model/runtime cannot emit a native tool-call envelope, output strict JSON with this shape: {\"tool\":\"tool_name\",\"args\":{...}}.",
    "For website deployment tasks, call vercel_trigger_deploy. Prefer mode=api for dynamic deployments when projectId and payload/files are available; otherwise use mode=auto.",
    "After deploying a landing page for growth goals, execute distribution immediately: post_twitter -> post_reddit -> posthog_track_event.",
    "For landing-page tasks, the output must include: headline, subheadline, primary CTA, at least 3 benefit bullets, and an email capture field.",
    "Use concrete, conversion-focused copy. Avoid placeholder headlines and generic one-line pages.",
    "",
    "Available capabilities:",
    "- Create and update issues (tasks)",
    "- Send messages to other agents",
    "- Store knowledge and observations in memory",
    "",
    "Always be precise, concise, and action-oriented.",
  ]
    .filter(Boolean)
    .join("\n");

  const promptParts = [
    `## Current Task`,
    `Title: ${issue.title}`,
    issue.description ? `Description: ${issue.description}` : "",
    issue.status ? `Status: ${issue.status}` : "",
    "",
  ];

  if (memoryContext) {
    promptParts.push("## Context Memory", memoryContext, "");
  }

  promptParts.push(
    "## Instructions",
    "Analyze the task above. If you need to take an action, call the appropriate tool.",
    "For deployment requests, use the vercel_trigger_deploy tool rather than returning manual deployment instructions.",
    "For launch/growth workflows, wire this sequence when relevant: landing deploy -> post_twitter -> post_reddit -> posthog_track_event for landing_view/cta_clicked/email_submitted/user_signed_up.",
    "If you can provide a direct answer or analysis, respond with your findings.",
  );

  const tools = getDefaultToolDefinitions(context);

  return {
    prompt: promptParts.filter(Boolean).join("\n"),
    systemPrompt,
    tools,
  };
}

/**
 * Generate tool definitions based on what tools the agent has access to.
 */
function getDefaultToolDefinitions(context: AIExecutionContext): LLMToolDefinition[] {
  const allowedTools = context.tools;
  const allTools: LLMToolDefinition[] = [
    {
      name: "create_issue",
      description: "Create a new issue/task in the company board",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Issue title" },
          description: { type: "string", description: "Issue description" },
          priority: {
            type: "string",
            enum: ["urgent", "high", "medium", "low", "none"],
            description: "Priority level",
          },
        },
        required: ["title"],
      },
    },
    {
      name: "update_issue",
      description: "Update an existing issue's fields",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "ID of the issue to update" },
          title: { type: "string", description: "New title" },
          status: {
            type: "string",
            enum: ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"],
            description: "New status",
          },
          description: { type: "string", description: "New description" },
        },
        required: ["issueId"],
      },
    },
    {
      name: "send_message",
      description: "Send a message to another agent",
      parameters: {
        type: "object",
        properties: {
          toAgentId: { type: "string", description: "ID of the recipient agent" },
          message: { type: "string", description: "Message content" },
        },
        required: ["toAgentId", "message"],
      },
    },
    {
      name: "store_memory",
      description: "Store a piece of knowledge, observation, or decision in persistent memory",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["knowledge", "observation", "decision", "experiment"],
            description: "Type of memory",
          },
          title: { type: "string", description: "Short summary title" },
          content: { type: "string", description: "Full content to remember" },
        },
        required: ["type", "title", "content"],
      },
    },
    {
      name: "http_api_request",
      description: "Call an external HTTP API with structured method/url/headers/body input",
      parameters: {
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
            description: "HTTP method",
          },
          url: { type: "string", description: "Absolute URL" },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Optional request headers",
          },
          query: {
            type: "object",
            additionalProperties: true,
            description: "Optional query parameters",
          },
          body: {
            description: "Optional request payload for non-GET methods",
          },
          timeoutMs: { type: "number", description: "Optional timeout in milliseconds" },
        },
        required: ["method", "url"],
      },
    },
    {
      name: "tavily_web_search",
      description: "Search the web using Tavily and return ranked sources",
      parameters: {
        type: "object",
        properties: {
          apiKey: { type: "string", description: "Optional override Tavily API key" },
          query: { type: "string", description: "Search query" },
          searchDepth: { type: "string", enum: ["basic", "advanced"] },
          maxResults: { type: "number", description: "Maximum number of results (1-20)" },
          includeAnswer: { type: "boolean" },
          includeImages: { type: "boolean" },
          topic: { type: "string", description: "Optional Tavily topic" },
        },
        required: ["query"],
      },
    },
    {
      name: "browser_automation",
      description: "Automate browser tasks for scraping, posting, and workflow automation",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Optional initial URL" },
          headless: { type: "boolean", description: "Run browser headless (default true)" },
          timeoutMs: { type: "number", description: "Step timeout in milliseconds" },
          steps: {
            type: "array",
            description: "Ordered automation steps",
            items: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: [
                    "goto",
                    "click",
                    "fill",
                    "press",
                    "wait_for_selector",
                    "extract_text",
                    "screenshot",
                  ],
                },
                selector: { type: "string" },
                value: { type: "string" },
                key: { type: "string" },
                url: { type: "string" },
                waitUntil: {
                  type: "string",
                  enum: ["load", "domcontentloaded", "networkidle", "commit"],
                },
                timeoutMs: { type: "number" },
                name: { type: "string" },
                fullPage: { type: "boolean" },
              },
              required: ["action"],
            },
          },
        },
      },
    },
    {
      name: "x_post_thread",
      description: "Post a tweet or thread to X/Twitter",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Single tweet text" },
          thread: {
            type: "array",
            items: { type: "string" },
            description: "Thread parts posted in order",
          },
          replyToTweetId: { type: "string", description: "Optional tweet ID to reply to" },
          bearerToken: { type: "string", description: "Optional override bearer token" },
          clientId: { type: "string", description: "Optional OAuth2 client ID (app credentials)" },
          clientSecret: { type: "string", description: "Optional OAuth2 client secret (app credentials)" },
          oauthTokenUrl: { type: "string", description: "Optional OAuth2 token endpoint override" },
          consumerKey: { type: "string", description: "Optional OAuth1a consumer key" },
          consumerSecret: { type: "string", description: "Optional OAuth1a consumer secret" },
          accessToken: { type: "string", description: "Optional OAuth1a access token" },
          accessTokenSecret: { type: "string", description: "Optional OAuth1a access token secret" },
          mockMode: { type: "boolean", description: "Optional local mock mode that returns fake tweet IDs without calling X" },
          apiBaseUrl: { type: "string", description: "Optional API base URL" },
        },
      },
    },
    {
      name: "post_twitter",
      description: "Post to X/Twitter using Playwright web automation (session-based)",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Tweet body text" },
          username: { type: "string", description: "Optional override X username" },
          password: { type: "string", description: "Optional override X password for bootstrap login" },
          storageStatePath: { type: "string", description: "Optional storage state file path" },
          headless: { type: "boolean", description: "Run browser in headless mode" },
          timeoutMs: { type: "number", description: "Timeout in milliseconds" },
        },
        required: ["text"],
      },
    },
    {
      name: "reddit_submit_post",
      description: "Submit a post to Reddit for distribution and validation",
      parameters: {
        type: "object",
        properties: {
          subreddit: { type: "string" },
          title: { type: "string" },
          kind: { type: "string", enum: ["self", "link"] },
          text: { type: "string", description: "Self-post content" },
          url: { type: "string", description: "Link URL for link posts" },
          accessToken: { type: "string", description: "Optional override access token" },
          userAgent: { type: "string" },
          apiBaseUrl: { type: "string" },
        },
        required: ["subreddit", "title"],
      },
    },
    {
      name: "post_reddit",
      description: "Post to Reddit using Playwright web automation (session-based)",
      parameters: {
        type: "object",
        properties: {
          subreddit: { type: "string" },
          title: { type: "string" },
          kind: { type: "string", enum: ["self", "link"] },
          text: { type: "string" },
          url: { type: "string" },
          username: { type: "string", description: "Optional override Reddit username" },
          password: { type: "string", description: "Optional override Reddit password for bootstrap login" },
          storageStatePath: { type: "string", description: "Optional storage state file path" },
          headless: { type: "boolean" },
          timeoutMs: { type: "number" },
        },
        required: ["subreddit", "title"],
      },
    },
    {
      name: "notion_create_page",
      description: "Create a Notion page/template entry",
      parameters: {
        type: "object",
        properties: {
          apiKey: { type: "string", description: "Optional override Notion API key" },
          parentPageId: { type: "string" },
          parentDatabaseId: { type: "string" },
          title: { type: "string" },
          titlePropertyName: { type: "string" },
          properties: { type: "object", additionalProperties: true },
          children: { type: "array", items: { type: "object", additionalProperties: true } },
        },
      },
    },
    {
      name: "stripe_create_checkout_session",
      description: "Create a Stripe checkout session for product sales",
      parameters: {
        type: "object",
        properties: {
          apiKey: { type: "string", description: "Optional override Stripe API key" },
          successUrl: { type: "string" },
          cancelUrl: { type: "string" },
          mode: { type: "string", enum: ["payment", "subscription"] },
          currency: { type: "string" },
          lineItems: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                amountCents: { type: "number" },
                quantity: { type: "number" },
                currency: { type: "string" },
              },
              required: ["name", "amountCents"],
            },
          },
        },
        required: ["successUrl", "cancelUrl", "lineItems"],
      },
    },
    {
      name: "dodo_create_checkout_session",
      description: "Create a Dodo Payments checkout session",
      parameters: {
        type: "object",
        properties: {
          apiKey: { type: "string", description: "Optional override Dodo API key" },
          apiBaseUrl: { type: "string" },
          endpointPath: { type: "string" },
          hostedCheckoutUrl: { type: "string", description: "Optional hosted checkout URL fallback" },
          useHostedCheckoutUrl: { type: "boolean", description: "If true, skip API call and return hosted checkout URL" },
          fallbackToHostedCheckoutUrl: { type: "boolean", description: "If true, return hosted checkout URL when API fails" },
          payload: {
            type: "object",
            additionalProperties: true,
            description: "Dodo checkout payload",
          },
        },
        required: ["payload"],
      },
    },
    {
      name: "resend_send_email",
      description: "Send transactional or growth email via Resend",
      parameters: {
        type: "object",
        properties: {
          apiKey: { type: "string", description: "Optional override Resend API key" },
          from: { type: "string" },
          to: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
          },
          subject: { type: "string" },
          html: { type: "string" },
          text: { type: "string" },
          cc: { type: "array", items: { type: "string" } },
          bcc: { type: "array", items: { type: "string" } },
          replyTo: { type: "string" },
        },
        required: ["from", "to", "subject"],
      },
    },
    {
      name: "posthog_track_event",
      description: "Track analytics events (visits, signups, conversion) with PostHog",
      parameters: {
        type: "object",
        properties: {
          apiKey: { type: "string", description: "Optional override PostHog API key" },
          host: { type: "string", description: "Optional PostHog host (default from POSTHOG_HOST)" },
          event: { type: "string", description: "Event name, e.g. visit/sign_up/conversion" },
          distinctId: { type: "string", description: "User or session identifier" },
          properties: { type: "object", additionalProperties: true },
          timestamp: { type: "string", description: "Optional ISO-8601 timestamp" },
        },
        required: ["event"],
      },
    },
    {
      name: "vercel_trigger_deploy",
      description: "Trigger a website deployment on Vercel. Prefer dynamic API deploy (v13) and fallback to deploy hook when configured.",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["auto", "api", "deploy_hook"],
            description: "Deployment mode selector. auto prefers API and can fallback to deploy hook.",
          },
          apiKey: {
            type: "string",
            description: "Optional override token (AI_GATEWAY_API_KEY/VERCEL_TOKEN)",
          },
          deployHookUrl: {
            type: "string",
            description: "Optional Vercel deploy hook URL; if provided, hook mode is used",
          },
          projectId: {
            type: "string",
            description: "Vercel project id (required for API mode)",
          },
          teamId: {
            type: "string",
            description: "Optional Vercel team id for API mode",
          },
          skipAutoDetectionConfirmation: {
            type: "boolean",
            description:
              "Optional Vercel API flag for dynamic deployments; defaults true in API mode to bypass framework auto-detection confirmation.",
          },
          apiBaseUrl: {
            type: "string",
            description: "Optional Vercel API base URL",
          },
          payload: {
            type: "object",
            additionalProperties: true,
            description: "Raw Vercel deployment payload for API mode or optional metadata for hook mode",
          },
          name: {
            type: "string",
            description: "Optional deployment name when using files[] helper",
          },
          files: {
            type: "array",
            description:
              "Optional helper for dynamic deploy mode. Each item should include file and data; converted to payload.files when payload is omitted.",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                data: { type: "string" },
              },
              required: ["file", "data"],
            },
          },
          target: {
            type: "string",
            description: "Optional Vercel target environment, e.g. production or preview",
          },
          projectSettings: {
            type: "object",
            additionalProperties: true,
            description: "Optional Vercel project settings passed in API payload",
          },
          gitSource: {
            type: "object",
            additionalProperties: true,
            description: "Optional Vercel gitSource payload object",
          },
        },
      },
    },
  ];

  // If specific tools are requested, filter to those
  if (allowedTools && allowedTools.length > 0) {
    return allTools.filter((t) => allowedTools.includes(t.name));
  }

  return allTools;
}
