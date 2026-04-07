#!/usr/bin/env node

/**
 * Smoke flow: create company + run deterministic AI goal for
 * "Acquire 100 users for our product".
 *
 * Usage:
 *   node scripts/smoke/acquire-100-users.mjs
 *   BASE_URL=http://localhost:3100 node scripts/smoke/acquire-100-users.mjs
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3100";
const API_BASE = `${BASE_URL}/api`;

const DEFAULT_HEADERS = {
  "content-type": "application/json",
  origin: BASE_URL,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...DEFAULT_HEADERS,
      ...(options.headers ?? {}),
    },
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${path}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const companyName = `Growth Test Acquire-100 ${stamp}`;

  const health = await request("/health");
  if (health.deploymentMode !== "local_trusted") {
    throw new Error(
      `Expected local_trusted mode for non-interactive smoke setup. Current mode: ${health.deploymentMode}`,
    );
  }

  const company = await request("/companies", {
    method: "POST",
    body: JSON.stringify({
      name: companyName,
      description: "Smoke test company for acquire-100 users scenario",
      budgetMonthlyCents: 20000,
    }),
  });

  const ceo = await request(`/companies/${company.id}/agents`, {
    method: "POST",
    body: JSON.stringify({
      name: "Growth CEO",
      role: "ceo",
      capabilities: "strategy, growth, execution",
      adapterType: "process",
      adapterConfig: {},
    }),
  });

  const reviewer = await request(`/companies/${company.id}/agents`, {
    method: "POST",
    body: JSON.stringify({
      name: "Growth Reviewer",
      role: "cmo",
      capabilities: "marketing review, growth analytics",
      reportsTo: ceo.id,
      adapterType: "process",
      adapterConfig: {},
    }),
  });

  const coreIssue = await request(`/companies/${company.id}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: "Acquire 100 users for our product",
      description:
        "Create and execute a practical growth sprint to acquire the first 100 active users.",
      priority: "high",
      status: "backlog",
      assigneeAgentId: ceo.id,
    }),
  });

  const deterministicSteps = [
    {
      name: "Capture growth hypothesis",
      description: "Store core hypothesis and acquisition constraints in memory.",
      toolName: "store_memory",
      toolArgs: {
        type: "knowledge",
        title: "Acquire 100 users hypothesis",
        content:
          "Target ICP: founders and startup operators. Channels: founder communities, short-form educational posts, and targeted onboarding demos. Goal: first 100 active users in 30 days.",
      },
    },
    {
      name: "Create campaign task",
      description: "Create an execution task for campaign launch.",
      dependsOn: ["step_1"],
      toolName: "create_issue",
      toolArgs: {
        title: "Launch 14-day acquisition campaign",
        description:
          "Execute a campaign across founder communities and social channels with weekly optimization.",
        priority: "high",
      },
    },
    {
      name: "Mark core issue in progress",
      description: "Move the main issue into active execution.",
      dependsOn: ["step_2"],
      toolName: "update_issue",
      toolArgs: {
        issueId: coreIssue.id,
        status: "in_progress",
        description:
          "Execution started. Campaign task created and growth hypothesis documented.",
      },
    },
    {
      name: "Notify reviewer",
      description: "Send a status message for review and alignment.",
      dependsOn: ["step_3"],
      toolName: "send_message",
      toolArgs: {
        toAgentId: reviewer.id,
        message:
          "Acquire-100 plan is running. Please review campaign assumptions and propose optimization ideas.",
      },
    },
    {
      name: "Close the planning issue",
      description: "Mark the planning issue done for smoke verification.",
      dependsOn: ["step_4"],
      toolName: "update_issue",
      toolArgs: {
        issueId: coreIssue.id,
        status: "done",
        description:
          "Planning smoke workflow completed. Ready for iterative execution cycles.",
      },
    },
  ];

  const goalStart = await request(`/companies/${company.id}/ai/goals`, {
    method: "POST",
    body: JSON.stringify({
      agentId: ceo.id,
      issueId: coreIssue.id,
      goal: "Acquire 100 users for our product",
      deterministic: true,
      deterministicSteps,
      maxIterations: 20,
    }),
  });

  let finalGoal = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const current = await request(`/companies/${company.id}/ai/goals/${goalStart.planId}`);
    if (["completed", "failed", "cancelled"].includes(current.status)) {
      finalGoal = current;
      break;
    }
  }

  // If the AI goal fails (for example due model quota), simulate the same
  // tool outcomes through first-class API endpoints so UI validation remains useful.
  if (!finalGoal || finalGoal.status !== "completed") {
    await request(`/companies/${company.id}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "Launch 14-day acquisition campaign",
        description:
          "Execute campaign across founder channels and optimize weekly toward 100 users.",
        priority: "high",
        status: "todo",
        assigneeAgentId: reviewer.id,
      }),
    });

    await request(`/issues/${coreIssue.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "in_progress",
        description:
          "Campaign task created and in progress. Tracking toward 100 users.",
      }),
    });

    await request(`/companies/${company.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        fromAgentId: ceo.id,
        toAgentId: reviewer.id,
        message: "Please review channel mix and optimize conversion for the 100-user target.",
      }),
    });

    await request(`/companies/${company.id}/memories`, {
      method: "POST",
      body: JSON.stringify({
        agentId: ceo.id,
        type: "knowledge",
        title: "Acquire 100 users strategy",
        content:
          "Primary channels are founder communities, onboarding demos, and short educational posts. Iterate weekly based on conversion metrics.",
        metadata: { source: "smoke-fallback", goalPlanId: goalStart.planId },
      }),
    });

    await request(`/issues/${coreIssue.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "done",
        description:
          "Smoke workflow completed. Target strategy and execution artifacts created for 100-user goal.",
      }),
    });
  }

  const issueAfter = await request(`/issues/${coreIssue.id}`);
  const messages = await request(`/companies/${company.id}/messages`).catch(() => null);
  const memories = await request(`/companies/${company.id}/memories`).catch(() => null);

  console.log("\nSmoke scenario created successfully.\n");
  console.log("Company:", company.name, company.id);
  console.log("Issue Prefix:", company.issuePrefix);
  console.log("Core Issue:", coreIssue.id, "status=", issueAfter.status);
  console.log("Goal Plan:", goalStart.planId, "status=", finalGoal?.status ?? "active");
  if (!finalGoal || finalGoal.status !== "completed") {
    console.log("Goal fallback:", "API fallback actions applied for UI testability");
  }
  console.log(
    "Messages Count:",
    Array.isArray(messages) ? messages.length : messages ? "available" : "unavailable",
  );
  console.log(
    "Memory Entries:",
    Array.isArray(memories) ? memories.length : memories ? "available" : "unavailable",
  );

  const prefix = company.issuePrefix;
  console.log("\nOpen these UI pages:");
  console.log(`- ${BASE_URL}/${prefix}/dashboard`);
  console.log(`- ${BASE_URL}/${prefix}/issues`);
  console.log(`- ${BASE_URL}/${prefix}/issues/${coreIssue.id}`);
  console.log(`- ${BASE_URL}/${prefix}/goals`);
  console.log(`- ${BASE_URL}/${prefix}/goals/${goalStart.planId}`);
  console.log(`- ${BASE_URL}/${prefix}/messages`);
  console.log(`- ${BASE_URL}/${prefix}/memory`);
  console.log(`- ${BASE_URL}/${prefix}/activity`);
}

main().catch((err) => {
  console.error("Smoke setup failed:", err.message);
  process.exit(1);
});
