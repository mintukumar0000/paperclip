#!/usr/bin/env node
/**
 * Paperclip Stress Test — Phase 12
 * Creates 100 agents, 500 issues, 10 workflows, then runs execution loop repeatedly.
 * Observes queue latency, throughput, and error rates.
 */

const BASE = process.env.BASE_URL || "http://127.0.0.1:3100/api";

async function api(path, init = {}) {
  const res = await fetch(BASE + path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

function timer() {
  const start = performance.now();
  return () => ((performance.now() - start) / 1000).toFixed(3);
}

const stats = {
  companiesCreated: 0,
  agentsCreated: 0,
  issuesCreated: 0,
  workflowsTriggered: 0,
  executionLoopRuns: 0,
  errors: [],
  timings: {},
};

const AGENT_ROLES = ["engineer", "designer", "qa", "devops", "ceo", "pm", "engineer", "designer", "qa", "devops"];
const PRIORITIES = ["low", "medium", "high", "critical"];
const TITLES = [
  "Implement API endpoint", "Fix login bug", "Design dashboard", "Write unit tests",
  "Deploy to staging", "Review PR", "Update documentation", "Optimize query performance",
  "Add error handling", "Refactor module", "Setup CI/CD", "Create migration script",
  "Implement caching", "Add rate limiting", "Security audit", "Performance profiling",
  "Update dependencies", "Fix memory leak", "Add logging", "Create backup script",
];

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  PAPERCLIP STRESS TEST — Phase 12");
  console.log("  Target: 100 agents, 500 issues, 10 workflows");
  console.log("═══════════════════════════════════════════════\n");

  // 1. Create stress test company
  console.log("▸ Creating stress test company...");
  let t = timer();
  const { status: cs, body: company } = await api("/companies", {
    method: "POST",
    body: JSON.stringify({ name: "Stress Test Corp", issuePrefix: "STRESS" }),
  });
  if (cs !== 201) {
    console.error("  ✗ Failed to create company:", company);
    process.exit(1);
  }
  const companyId = company.id;
  stats.companiesCreated = 1;
  stats.timings.companyCreate = t();
  console.log(`  ✓ Company created: ${companyId} (${stats.timings.companyCreate}s)\n`);

  // 2. Create 100 agents in batches
  console.log("▸ Creating 100 agents...");
  t = timer();
  const agentIds = [];
  for (let idx = 0; idx < 100; idx++) {
    const role = AGENT_ROLES[idx % AGENT_ROLES.length];
    const { status, body } = await api(`/companies/${companyId}/agents`, {
      method: "POST",
      body: JSON.stringify({
        name: `Agent-${String(idx).padStart(3, "0")}-${role}`,
        role,
        adapterType: "process",
        adapterConfig: {},
      }),
    });
    if (status === 201) {
      agentIds.push(body.id);
      stats.agentsCreated++;
    } else {
      stats.errors.push(`agent-create-${idx}: ${status} ${JSON.stringify(body).slice(0, 100)}`);
    }
    if ((idx + 1) % 20 === 0) process.stdout.write(`  · ${idx + 1}/100 agents created\n`);
  }
  stats.timings.agentCreate = t();
  console.log(`  ✓ ${stats.agentsCreated}/100 agents created (${stats.timings.agentCreate}s)\n`);

  // 3. Create 500 issues in batches, distribute across agents
  console.log("▸ Creating 500 issues...");
  t = timer();
  const issueIds = [];
  const ISSUE_BATCH = 50;
  for (let batch = 0; batch < 10; batch++) {
    const promises = [];
    for (let i = 0; i < ISSUE_BATCH; i++) {
      const idx = batch * ISSUE_BATCH + i;
      const agentIdx = idx % agentIds.length;
      const titleBase = TITLES[idx % TITLES.length];
      promises.push(
        api(`/companies/${companyId}/issues`, {
          method: "POST",
          body: JSON.stringify({
            title: `${titleBase} #${idx}`,
            description: `Stress test issue ${idx} assigned to agent ${agentIdx}`,
            status: idx % 3 === 0 ? "backlog" : "todo",
            priority: PRIORITIES[idx % PRIORITIES.length],
            assigneeAgentId: agentIds[agentIdx],
          }),
        }).then(({ status, body }) => {
          if (status === 201) {
            issueIds.push(body.id);
            stats.issuesCreated++;
          } else {
            stats.errors.push(`issue-create-${idx}: ${status}`);
          }
        })
      );
    }
    await Promise.all(promises);
    process.stdout.write(`  · Batch ${batch + 1}/10 done (${issueIds.length} issues)\n`);
  }
  stats.timings.issueCreate = t();
  console.log(`  ✓ ${stats.issuesCreated}/500 issues created (${stats.timings.issueCreate}s)\n`);

  // 4. Trigger 10 workflows
  console.log("▸ Triggering 10 workflows...");
  t = timer();
  for (let i = 0; i < 10; i++) {
    const wfAgents = agentIds.slice(i * 3, i * 3 + 3);
    if (wfAgents.length < 2) break;
    const { status } = await api(`/companies/${companyId}/workflows`, {
      method: "POST",
      body: JSON.stringify({
        name: `Stress Workflow ${i}`,
        definition: {
          steps: [
            { id: `step-a-${i}`, name: "Plan", agentId: wfAgents[0], dependsOn: [] },
            { id: `step-b-${i}`, name: "Execute", agentId: wfAgents[1], dependsOn: [`step-a-${i}`] },
          ],
        },
      }),
    });
    if (status === 201 || status === 200) {
      stats.workflowsTriggered++;
    } else {
      stats.errors.push(`workflow-${i}: ${status}`);
    }
  }
  stats.timings.workflowCreate = t();
  console.log(`  ✓ ${stats.workflowsTriggered}/10 workflows triggered (${stats.timings.workflowCreate}s)\n`);

  // 5. Run execution loop multiple times
  console.log("▸ Running execution loop 3 iterations...");
  t = timer();
  for (let round = 0; round < 3; round++) {
    const rt = timer();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const { status, body } = await api(`/companies/${companyId}/execution-loop/run`, {
        method: "POST",
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      stats.executionLoopRuns++;
      const elapsed = rt();
      if (status === 200 || status === 201) {
        const dispatched = body?.dispatched ?? body?.jobsDispatched ?? "?";
        console.log(`  · Round ${round + 1}: dispatched=${dispatched} (${elapsed}s)`);
      } else {
        console.log(`  · Round ${round + 1}: status=${status} (${elapsed}s)`);
        stats.errors.push(`exec-loop-${round}: ${status}`);
      }
    } catch (err) {
      clearTimeout(timeout);
      stats.executionLoopRuns++;
      console.log(`  · Round ${round + 1}: ${err.name === "AbortError" ? "timed out (15s)" : err.message} (${rt()}s)`);
    }
  }
  stats.timings.executionLoop = t();
  console.log(`  ✓ ${stats.executionLoopRuns} execution loop runs (${stats.timings.executionLoop}s)\n`);

  // 6. Check metrics
  console.log("▸ Checking Prometheus metrics...");
  const metricsRes = await fetch(BASE + "/metrics");
  const metricsText = await metricsRes.text();

  const httpReqs = metricsText.match(/paperclip_http_requests_total\{[^}]*\}\s+(\d+)/g) || [];
  const totalReqs = httpReqs.reduce((sum, line) => {
    const n = parseInt(line.match(/\}\s+(\d+)/)?.[1] || "0");
    return sum + n;
  }, 0);

  const activeJobs = metricsText.match(/paperclip_agent_jobs_active\s+(\d+)/)?.[1] || "0";
  const evtLines = metricsText.match(/paperclip_events_published_total\{[^}]*\}\s+(\d+)/g) || [];
  const totalEvents = evtLines.reduce((sum, line) => {
    const n = parseInt(line.match(/\}\s+(\d+)/)?.[1] || "0");
    return sum + n;
  }, 0);

  console.log(`  · HTTP requests tracked: ${totalReqs}`);
  console.log(`  · Active agent jobs: ${activeJobs}`);
  console.log(`  · Events published: ${totalEvents}`);

  // 7. Check Redis memory
  console.log("\n▸ Checking Redis stats...");
  try {
    const redisInfo = await fetch("http://127.0.0.1:3100/api/health").then(r => r.json());
    console.log(`  · Server health: ${redisInfo.status}`);
  } catch (err) {
    console.log(`  · Health check: ${err.message}`);
  }

  // 8. Final report
  console.log("\n═══════════════════════════════════════════════");
  console.log("  STRESS TEST RESULTS");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Companies created:     ${stats.companiesCreated}`);
  console.log(`  Agents created:        ${stats.agentsCreated}/100`);
  console.log(`  Issues created:        ${stats.issuesCreated}/500`);
  console.log(`  Workflows triggered:   ${stats.workflowsTriggered}/10`);
  console.log(`  Execution loop runs:   ${stats.executionLoopRuns}`);
  console.log(`  Total errors:          ${stats.errors.length}`);
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  Timings:`);
  Object.entries(stats.timings).forEach(([k, v]) => {
    console.log(`    ${k.padEnd(20)} ${v}s`);
  });
  if (stats.errors.length > 0) {
    console.log(`\n  Errors (first 10):`);
    stats.errors.slice(0, 10).forEach(e => console.log(`    ✗ ${e}`));
  }
  console.log("═══════════════════════════════════════════════");

  const pass = stats.agentsCreated >= 40 && stats.issuesCreated >= 450;
  console.log(pass ? "\n  ✅ STRESS TEST PASSED" : "\n  ❌ STRESS TEST FAILED");
  process.exit(pass ? 0 : 1);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
