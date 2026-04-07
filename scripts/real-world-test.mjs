#!/usr/bin/env node
/**
 * Real-World Testing Script for Paperclip
 * Autonomous Organizational Intelligence Platform
 *
 * Prerequisites:
 * - Server running: pnpm dev (default http://localhost:3100)
 * - Board auth: server in local_trusted mode OR pass session cookie (see below)
 * - For agent execution with Codex: OPENAI_API_KEY in env
 *
 * Usage:
 *   node scripts/real-world-test.mjs
 *   BASE_URL=http://localhost:3100 node scripts/real-world-test.mjs
 *   COMPANY_ID=<uuid> node scripts/real-world-test.mjs   # Skip create, use existing
 *   COOKIE="session=..." node scripts/real-world-test.mjs  # Auth cookie from browser
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3100";
const API = `${BASE_URL}/api`;
const EXISTING_COMPANY_ID = process.env.COMPANY_ID;
const AUTH_COOKIE = process.env.COOKIE;
const DELAY_MS = Number(process.env.DELAY_MS) || 800;  // Delay between requests to avoid 429

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Headers for board mutations (trusted origin + optional auth)
const BOARD_HEADERS = {
  "Content-Type": "application/json",
  Origin: BASE_URL,
  ...(AUTH_COOKIE && { Cookie: AUTH_COOKIE }),
};

async function fetchJson(path, opts = {}) {
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: { ...BOARD_HEADERS, ...opts.headers },
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text };
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function main() {
  const results = { passed: [], failed: [], skipped: [] };

  console.log("\n=== Real-World Testing: Paperclip ===\n");
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`API: ${API}\n`);

  // Step 1: Health
  try {
    const health = await fetchJson("/health");
    console.log("✓ Step 1 — Health:", health.status);
    if (health.boardClaimUrl) {
      console.log("  ⚠ Board claim pending:", health.boardClaimUrl);
    }
    results.passed.push("health");
    await sleep(DELAY_MS);
  } catch (e) {
    console.error("✗ Step 1 — Health failed:", e.message);
    results.failed.push("health");
    console.error("\nEnsure server is running: pnpm dev");
    process.exit(1);
  }

  // Step 2: Create Company (GrowthAI) or use existing
  let companyId = EXISTING_COMPANY_ID;
  if (companyId) {
    console.log("✓ Step 2 — Using existing company:", companyId);
    results.passed.push("create_company");
  } else {
    try {
      const company = await fetchJson("/companies", {
        method: "POST",
        body: JSON.stringify({
          name: "GrowthAI",
          description: "AI Marketing startup — automate marketing for startups",
          budgetMonthlyCents: 0,
        }),
      });
      companyId = company.id;
      console.log("✓ Step 2 — Company created:", company.name, `(${companyId})`);
      results.passed.push("create_company");
      await sleep(DELAY_MS);
    } catch (e) {
      console.error("✗ Step 2 — Create company failed:", e.message);
      if (e.message.includes("403") || e.message.includes("Board access") || e.message.includes("Instance admin")) {
        console.error("\n  Board auth required. Options:");
        console.error("  1. Run server in local_trusted mode (see config)");
        console.error("  2. Complete board claim, log in via UI, then run with:");
        console.error('     COOKIE="better-auth.session_token=YOUR_TOKEN" node scripts/real-world-test.mjs');
        console.error("  3. Use existing company: COMPANY_ID=<uuid> node scripts/real-world-test.mjs");
      }
      results.failed.push("create_company");
      const companies = await fetchJson("/companies").catch(() => []);
      if (Array.isArray(companies) && companies.length > 0) {
        companyId = companies[0].id;
        console.log("  → Using first existing company:", companyId);
      } else {
        process.exit(1);
      }
    }
  }

  // Step 3: Create Agents
  const agentIds = [];
  const agentPayloads = [
    { name: "Marketing Strategist", role: "cmo", capabilities: "growth, marketing, analysis" },
    { name: "Content Generator", role: "engineer", capabilities: "writing, seo" },
    { name: "Data Analyst", role: "researcher", capabilities: "data, metrics" },
  ];
  for (const payload of agentPayloads) {
    try {
      const agent = await fetchJson(`/companies/${companyId}/agents`, {
        method: "POST",
        body: JSON.stringify({
          name: payload.name,
          role: payload.role,
          capabilities: payload.capabilities,
          adapterType: "process",
          adapterConfig: {},
        }),
      });
      agentIds.push(agent.id);
      results.passed.push(`create_agent_${payload.name.replace(/\s/g, "_")}`);
      await sleep(DELAY_MS);
    } catch (e) {
      console.error(`✗ Create agent "${payload.name}" failed:`, e.message);
      results.failed.push(`create_agent_${payload.name}`);
    }
  }
  if (agentIds.length > 0) {
    console.log("✓ Step 3 — Agents created:", agentIds.length, agentIds);
  }

  // Step 4: Create Goal
  let goalId;
  try {
    const goal = await fetchJson(`/companies/${companyId}/goals`, {
      method: "POST",
      body: JSON.stringify({
        title: "Acquire 1000 users",
        description: "Grow the platform user base",
        level: "task",
        status: "planned",
      }),
    });
    goalId = goal.id;
    console.log("✓ Step 4 — Goal created:", goal.title, `(${goalId})`);
    results.passed.push("create_goal");
    await sleep(DELAY_MS);
  } catch (e) {
    console.error("✗ Step 4 — Create goal failed:", e.message);
    results.failed.push("create_goal");
  }

  // Step 5: Verify Goals
  try {
    const goals = await fetchJson(`/companies/${companyId}/goals`);
    console.log("✓ Step 5 — Goals list:", Array.isArray(goals) ? goals.length : 0, "goals");
    results.passed.push("list_goals");
    await sleep(DELAY_MS);
  } catch (e) {
    console.error("✗ Step 5 — List goals failed:", e.message);
    results.failed.push("list_goals");
  }

  // Step 6: Create Issue (task)
  let issueId;
  try {
    const issue = await fetchJson(`/companies/${companyId}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "Launch marketing campaign",
        description: "Create landing page and initial content",
        status: "backlog",
        priority: "high",
      }),
    });
    issueId = issue.id;
    console.log("✓ Step 6 — Issue created:", issue.title, `(${issueId})`);
    results.passed.push("create_issue");
    await sleep(DELAY_MS);
  } catch (e) {
    console.error("✗ Step 6 — Create issue failed:", e.message);
    results.failed.push("create_issue");
  }

  // Step 7: List agents
  try {
    const agents = await fetchJson(`/companies/${companyId}/agents`);
    console.log("✓ Step 7 — Agents list:", Array.isArray(agents) ? agents.length : 0, "agents");
    results.passed.push("list_agents");
  } catch (e) {
    console.error("✗ Step 7 — List agents failed:", e.message);
    results.failed.push("list_agents");
  }

  // Governance / Stability / Simulation — check if routes exist
  const governanceExists = await fetch(`${API}/companies/${companyId}/governance/rules`, {
    method: "GET",
    headers: BOARD_HEADERS,
  }).then((r) => r.status !== 404).catch(() => false);

  const stabilityExists = await fetch(`${API}/stability/assessment`, {
    method: "GET",
    headers: BOARD_HEADERS,
  }).then((r) => r.status !== 404).catch(() => false);

  const simulationExists = await fetch(`${API}/simulation/run`, {
    method: "POST",
    headers: BOARD_HEADERS,
  }).then((r) => r.status !== 405 && r.status !== 404).catch(() => false);

  if (!governanceExists) {
    console.log("○ Step 8 — Governance routes: not implemented (skipped)");
    results.skipped.push("governance");
  }
  if (!stabilityExists) {
    console.log("○ Step 9 — Stability routes: not implemented (skipped)");
    results.skipped.push("stability");
  }
  if (!simulationExists) {
    console.log("○ Step 10 — Simulation routes: not implemented (skipped)");
    results.skipped.push("simulation");
  }

  // Summary
  console.log("\n=== Summary ===");
  console.log("Passed:", results.passed.length);
  console.log("Failed:", results.failed.length);
  console.log("Skipped:", results.skipped.length);

  if (results.failed.length > 0) {
    console.error("\nFailed:", results.failed.join(", "));
    process.exit(1);
  }
  console.log("\n✓ Real-world test flow completed.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
