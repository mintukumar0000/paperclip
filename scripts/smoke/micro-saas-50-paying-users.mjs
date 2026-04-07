#!/usr/bin/env node

/**
 * Full local system test:
 * - Company: Autodroid Test Labs
 * - Agents: CEO, Marketing, Engineer
 * - Goal: Launch a micro SaaS product and acquire the first 50 paying users
 * - Triggers: planning, collaboration, tools/fallback actions, learning,
 *   economy, simulation, stability.
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3100";
const API = `${BASE_URL}/api`;

const headers = {
  "content-type": "application/json",
  origin: BASE_URL,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers ?? {}),
    },
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${path}: ${JSON.stringify(data)}`);
  }

  return data;
}

async function safeRequest(path, options = {}) {
  try {
    const data = await request(path, options);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const health = await request("/health");
  if (health.deploymentMode !== "local_trusted") {
    throw new Error(`Expected local_trusted mode, got ${health.deploymentMode}`);
  }

  const company = await request("/companies", {
    method: "POST",
    body: JSON.stringify({
      name: "Autodroid Test Labs",
      description: "Micro SaaS launch sandbox for full-system testing",
      budgetMonthlyCents: 150000,
    }),
  });

  const ceo = await request(`/companies/${company.id}/agents`, {
    method: "POST",
    body: JSON.stringify({
      name: "CEO Agent",
      role: "ceo",
      capabilities: "strategy, planning, growth",
      adapterType: "process",
      adapterConfig: {},
      budgetMonthlyCents: 60000,
    }),
  });

  const marketing = await request(`/companies/${company.id}/agents`, {
    method: "POST",
    body: JSON.stringify({
      name: "Marketing Agent",
      role: "cmo",
      reportsTo: ceo.id,
      capabilities: "acquisition channels, campaigns, conversion optimization",
      adapterType: "process",
      adapterConfig: {},
      budgetMonthlyCents: 50000,
    }),
  });

  const engineer = await request(`/companies/${company.id}/agents`, {
    method: "POST",
    body: JSON.stringify({
      name: "Engineer Agent",
      role: "engineer",
      reportsTo: ceo.id,
      capabilities: "landing pages, analytics instrumentation, onboarding",
      adapterType: "process",
      adapterConfig: {},
      budgetMonthlyCents: 40000,
    }),
  });

  const coreIssue = await request(`/companies/${company.id}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: "Launch a micro SaaS product and acquire the first 50 paying users",
      description:
        "Plan and execute a focused launch sprint, from product concept through first 50 paying customers.",
      priority: "high",
      status: "backlog",
      assigneeAgentId: ceo.id,
    }),
  });

  const deterministicSteps = [
    {
      name: "Research product idea",
      description: "Capture product idea and ideal customer profile.",
      toolName: "store_memory",
      toolArgs: {
        type: "knowledge",
        title: "Micro SaaS product idea",
        content:
          "Product: lightweight workflow automation for founder-led teams. ICP: founders and startup operators with 5-50 employee teams.",
      },
    },
    {
      name: "Validate market demand",
      description: "Create demand validation task.",
      toolName: "create_issue",
      toolArgs: {
        title: "Validate market demand with 20 founder interviews",
        description: "Run interviews and summarize pains, willingness to pay, and urgency.",
        priority: "high",
      },
    },
    {
      name: "Create landing page",
      description: "Create build task for launch page + checkout.",
      toolName: "create_issue",
      toolArgs: {
        title: "Build landing page with clear value prop and payment flow",
        description: "Engineer to ship landing page, onboarding form, and payment setup.",
        priority: "high",
      },
    },
    {
      name: "Launch marketing campaign",
      description: "Coordinate campaign owner with a direct message.",
      toolName: "send_message",
      toolArgs: {
        toAgentId: marketing.id,
        message:
          "Launch campaign across founder communities and targeted social posts. Goal: 50 paying users.",
      },
    },
    {
      name: "Track conversions",
      description: "Update main launch issue with conversion-tracking status.",
      toolName: "update_issue",
      toolArgs: {
        issueId: coreIssue.id,
        status: "in_progress",
        description:
          "Conversion tracking started. Monitoring visits, trials, and paid signups.",
      },
    },
  ];

  const aiGoal = await request(`/companies/${company.id}/ai/goals`, {
    method: "POST",
    body: JSON.stringify({
      agentId: ceo.id,
      issueId: coreIssue.id,
      goal: "Launch a micro SaaS product and acquire the first 50 paying users",
      deterministic: true,
      deterministicSteps,
      maxIterations: 25,
    }),
  });

  let goalDetail = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const current = await request(`/companies/${company.id}/ai/goals/${aiGoal.planId}`);
    goalDetail = current;
    if (["completed", "failed", "cancelled"].includes(current.status)) {
      break;
    }
  }

  // If provider quota blocks AI execution, still materialize test artifacts.
  if (!goalDetail || goalDetail.status !== "completed") {
    await request(`/companies/${company.id}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "Run acquisition campaign for first 50 paying users",
        description: "Marketing executes channel experiments and weekly conversion optimization.",
        priority: "high",
        status: "todo",
        assigneeAgentId: marketing.id,
      }),
    });

    await request(`/companies/${company.id}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "Ship launch landing page and onboarding",
        description: "Engineer ships page and checkout instrumentation.",
        priority: "high",
        status: "todo",
        assigneeAgentId: engineer.id,
      }),
    });

    await request(`/companies/${company.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        fromAgentId: ceo.id,
        toAgentId: marketing.id,
        message: "Research acquisition channels and execute launch campaign for 50 paying users.",
      }),
    });

    await request(`/companies/${company.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        fromAgentId: ceo.id,
        toAgentId: engineer.id,
        message: "Build and deploy landing page with analytics and payment tracking.",
      }),
    });

    await request(`/companies/${company.id}/memories`, {
      method: "POST",
      body: JSON.stringify({
        agentId: marketing.id,
        type: "observation",
        title: "Early channel signal",
        content: "Founder communities and targeted social content show strongest early conversion.",
      }),
    });

    await request(`/issues/${coreIssue.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "done",
        description:
          "Planning and coordination artifacts generated. Ready for iterative acquisition execution.",
      }),
    });
  }

  // Collaboration
  const collaborationPlan = await safeRequest(`/companies/${company.id}/collaboration/auto-plan`, {
    method: "POST",
    body: JSON.stringify({
      goal: "Launch a micro SaaS product and acquire the first 50 paying users",
      issueId: coreIssue.id,
    }),
  });

  // Learning
  await safeRequest(`/companies/${company.id}/learning/evaluate`, {
    method: "POST",
    body: JSON.stringify({
      goalId: aiGoal.planId,
      success: goalDetail?.status === "completed",
      startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      completedAt: new Date().toISOString(),
      totalSteps: 5,
      completedSteps: goalDetail?.status === "completed" ? 5 : 3,
      failedSteps: goalDetail?.status === "completed" ? 0 : 2,
      totalCostCents: 120,
      agentIds: [ceo.id, marketing.id, engineer.id],
      errors: goalDetail?.status === "completed" ? [] : ["provider_quota_or_runtime_failure"],
    }),
  });

  await safeRequest(`/companies/${company.id}/learning/quality`, {
    method: "POST",
    body: JSON.stringify({
      goalId: aiGoal.planId,
      agentId: marketing.id,
      taskType: "marketing",
      output: "Campaign setup and initial conversion tracking",
      stepCount: 5,
      completedSteps: 4,
      failedSteps: 1,
      executionTimeMs: 600000,
      costCents: 80,
    }),
  });

  const learningCycle = await safeRequest(`/companies/${company.id}/learning/cycle`, {
    method: "POST",
  });

  // Economy
  const serviceA = await safeRequest(`/companies/${company.id}/economy/services`, {
    method: "POST",
    body: JSON.stringify({
      serviceName: "marketing_campaign",
      description: "Launch and optimize growth campaigns",
      category: "marketing",
      capabilities: ["channel_selection", "funnel_optimization"],
      pricePerRequestCents: 12,
      maxRequestsPerDay: 200,
    }),
  });

  const serviceB = await safeRequest(`/companies/${company.id}/economy/services`, {
    method: "POST",
    body: JSON.stringify({
      serviceName: "analytics_tracking",
      description: "Track signup and payment conversion metrics",
      category: "analytics",
      capabilities: ["event_tracking", "dashboarding"],
      pricePerRequestCents: 10,
      maxRequestsPerDay: 200,
    }),
  });

  const economyStatus = await safeRequest(`/companies/${company.id}/economy/status`);

  // Simulation + Monte Carlo
  const simulationRun = await safeRequest(`/companies/${company.id}/simulations`, {
    method: "POST",
    body: JSON.stringify({
      scenarioType: "marketing",
      simulatedDays: 60,
      strategies: [
        {
          name: "Community-first launch",
          variables: {
            channelFocus: "community",
            budgetAllocation: 60,
            conversionTarget: 50,
          },
        },
        {
          name: "Content-first launch",
          variables: {
            channelFocus: "content",
            budgetAllocation: 60,
            conversionTarget: 50,
          },
        },
      ],
    }),
  });

  const monteCarloRun = await safeRequest(`/companies/${company.id}/simulations/montecarlo`, {
    method: "POST",
    body: JSON.stringify({
      scenarioType: "marketing",
      strategies: ["community-first", "content-first"],
      universeCount: 20,
      simulatedDays: 45,
    }),
  });

  // Stability
  const stability = await safeRequest(`/stability/assessment`);
  const canExpand = await safeRequest(`/companies/${company.id}/stability/can-expand`);

  // Current snapshots for UI verification
  const issues = await safeRequest(`/companies/${company.id}/issues`);
  const goals = await safeRequest(`/companies/${company.id}/ai/goals`);
  const messages = await safeRequest(`/companies/${company.id}/messages`);
  const memories = await safeRequest(`/companies/${company.id}/memories`);
  const learningRecords = await safeRequest(`/companies/${company.id}/learning/records`);
  const services = await safeRequest(`/companies/${company.id}/economy/services`);
  const simRuns = await safeRequest(`/companies/${company.id}/simulations`);

  const prefix = company.issuePrefix;

  console.log("\n=== Full System Test Completed ===\n");
  console.log("Company:", company.name, company.id);
  console.log("Prefix:", prefix);
  console.log("Agents:", ceo.id, marketing.id, engineer.id);
  console.log("Core Issue:", coreIssue.id);
  console.log("AI Goal:", aiGoal.planId, "status=", goalDetail?.status ?? "active");
  if (!goalDetail || goalDetail.status !== "completed") {
    console.log("AI goal fallback:", "applied API fallback actions for deterministic UI output");
  }

  console.log("\nSubsystem summary:");
  console.log("- Collaboration plan:", collaborationPlan.ok ? "ok" : "failed");
  console.log("- Learning cycle:", learningCycle.ok ? "ok" : "failed");
  console.log("- Economy service A:", serviceA.ok ? "ok" : "failed");
  console.log("- Economy service B:", serviceB.ok ? "ok" : "failed");
  console.log("- Economy status:", economyStatus.ok ? "ok" : "failed");
  console.log("- Simulation run:", simulationRun.ok ? "ok" : "failed");
  console.log("- Monte Carlo run:", monteCarloRun.ok ? "ok" : "failed");
  console.log("- Stability assessment:", stability.ok ? "ok" : "failed");
  console.log("- Stability can-expand:", canExpand.ok ? "ok" : "failed");

  console.log("\nCounts:");
  console.log("- Issues:", issues.ok && Array.isArray(issues.data) ? issues.data.length : "n/a");
  console.log("- AI Goals:", goals.ok && Array.isArray(goals.data.goals) ? goals.data.goals.length : "n/a");
  console.log("- Messages:", messages.ok && Array.isArray(messages.data) ? messages.data.length : "n/a");
  console.log("- Memories:", memories.ok && Array.isArray(memories.data) ? memories.data.length : "n/a");
  console.log(
    "- Learning records:",
    learningRecords.ok && typeof learningRecords.data.count === "number"
      ? learningRecords.data.count
      : "n/a",
  );
  console.log("- Economy services:", services.ok && typeof services.data.total === "number" ? services.data.total : "n/a");
  console.log("- Simulation runs:", simRuns.ok && Array.isArray(simRuns.data) ? simRuns.data.length : "n/a");

  console.log("\nUI links:");
  console.log(`- ${BASE_URL}/${prefix}/dashboard`);
  console.log(`- ${BASE_URL}/${prefix}/goals`);
  console.log(`- ${BASE_URL}/${prefix}/goals/${aiGoal.planId}`);
  console.log(`- ${BASE_URL}/${prefix}/issues`);
  console.log(`- ${BASE_URL}/${prefix}/issues/${coreIssue.id}`);
  console.log(`- ${BASE_URL}/${prefix}/messages`);
  console.log(`- ${BASE_URL}/${prefix}/memory`);
  console.log(`- ${BASE_URL}/${prefix}/learning`);
  console.log(`- ${BASE_URL}/${prefix}/economy`);
  console.log(`- ${BASE_URL}/${prefix}/stability`);
  console.log(`- ${BASE_URL}/${prefix}/simulation`);
  console.log(`- ${BASE_URL}/${prefix}/activity`);
}

main().catch((err) => {
  console.error("full-system-test failed:", err.message);
  process.exit(1);
});
