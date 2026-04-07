import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToolRegistry } from "../ai/tools/toolRegistry.js";
import { executeHttpApiRequest, triggerVercelDeploy } from "../ai/tools/externalTools.js";

describe("external tool layer", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("registers real-world action tools in the tool registry", () => {
    const registry = createToolRegistry({
      db: {} as any,
      companyId: "company_1",
      agentId: "agent_1",
      adapterConfig: { env: {} },
    });

    const expected = [
      "http_api_request",
      "tavily_web_search",
      "browser_automation",
      "x_post_thread",
      "post_twitter",
      "reddit_submit_post",
      "post_reddit",
      "notion_create_page",
      "stripe_create_checkout_session",
      "dodo_create_checkout_session",
      "resend_send_email",
      "posthog_track_event",
      "vercel_trigger_deploy",
    ];

    for (const name of expected) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it("executes structured HTTP API requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, source: "test" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await executeHttpApiRequest(
      { integrationEnv: {} },
      {
        method: "POST",
        url: "https://example.com/api/test",
        headers: { "X-Test": "1" },
        query: { q: "hello" },
        body: { message: "hi" },
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain("https://example.com/api/test");
    expect(calledUrl).toContain("q=hello");
    expect(calledInit.method).toBe("POST");
    expect((calledInit.headers as Record<string, string>)["X-Test"]).toBe("1");
    expect(typeof calledInit.body).toBe("string");

    expect(result).toMatchObject({
      ok: true,
      status: 201,
      body: { ok: true, source: "test" },
    });
  });

  it("prefers API deploy in auto mode and falls back to deploy hook on auth errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "forbidden" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ job: { id: "job_1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await triggerVercelDeploy(
      {
        integrationEnv: {
          AI_GATEWAY_API_KEY: "token_1",
          VERCEL_DEPLOY_HOOK_URL: "https://api.vercel.com/v1/integrations/deploy/prj_123/hook_abc",
        },
      },
      {
        files: [{ file: "index.html", data: "<h1>Hello</h1>" }],
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [apiEndpoint] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [hookEndpoint] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(apiEndpoint).toContain("/v13/deployments?projectId=prj_123");
    expect(hookEndpoint).toBe("https://api.vercel.com/v1/integrations/deploy/prj_123/hook_abc");
    expect(result).toMatchObject({
      mode: "deploy_hook_fallback",
      fallbackFrom: "api",
    });
  });

  it("supports explicit API mode with project id inferred from deploy hook URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "dpl_123",
            url: "example-deploy.vercel.app",
            readyState: "QUEUED",
            projectId: "prj_123",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "dpl_123",
            url: "example-deploy.vercel.app",
            readyState: "READY",
            createdAt: 1_744_324_760_000,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await triggerVercelDeploy(
      {
        integrationEnv: {
          AI_GATEWAY_API_KEY: "token_1",
        },
      },
      {
        mode: "api",
        deployHookUrl: "https://api.vercel.com/v1/integrations/deploy/prj_123/hook_abc",
        files: [{ file: "index.html", data: "<h1>Hello</h1>" }],
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [apiEndpoint] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [statusEndpoint] = fetchMock.mock.calls[1] as [string, RequestInit];
    const [verificationEndpoint] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(apiEndpoint).toContain("/v13/deployments?projectId=prj_123");
    expect(statusEndpoint).toContain("/v13/deployments/dpl_123");
    expect(verificationEndpoint).toBe("https://example-deploy.vercel.app");
    expect(result).toMatchObject({
      success: true,
      status: "ready",
      mode: "api",
      deploymentId: "dpl_123",
      deploymentUrl: "https://example-deploy.vercel.app",
      projectId: "prj_123",
    });
  });

  it("retries tool handlers up to 2 times before succeeding", async () => {
    const registry = createToolRegistry({
      db: {} as any,
      companyId: "company_1",
      agentId: "agent_1",
      adapterConfig: {
        env: {
          POSTHOG_API_KEY: "phc_test",
          POSTHOG_HOST: "https://us.i.posthog.com",
        },
      },
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "temporary" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "temporary" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const handler = registry.get("posthog_track_event");
    expect(handler).toBeDefined();

    const result = await handler!({
      event: "visit",
      distinctId: "session_1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ status: "tracked", event: "visit" });
  });
});