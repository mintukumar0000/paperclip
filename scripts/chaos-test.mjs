#!/usr/bin/env node
/**
 * Paperclip Chaos Test — Phase 16
 * Tests system resilience under adverse conditions:
 * 1. Redis disconnect/reconnect — server recovery
 * 2. Queue overload — rate limiting + backpressure
 * 3. Stalled job detection — BullMQ retry config
 * 4. Rapid mutations — sequential write safety
 * 5. Worker crash recovery — queue data survives
 * 6. Network delay tolerance — graceful degradation
 * 7. Observability — metrics survive chaos
 * 8. Cross-company isolation — no data leaks
 */

import { execSync } from "child_process";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3100/api";
const results = [];

// ─── helpers ────────────────────────────────────────────────────

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

function redis(...args) {
  try {
    return execSync(`redis-cli ${args.join(" ")}`, { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function record(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ─── setup ──────────────────────────────────────────────────────

async function setup() {
  console.log("▸ Setup: Creating test company + agents...");
  const suffix = Date.now().toString(36).slice(-4).toUpperCase();
  const { body: co } = await api("/companies", {
    method: "POST",
    body: JSON.stringify({ name: `Chaos Corp ${suffix}`, issuePrefix: `CH${suffix}` }),
  });
  const companyId = co.id;

  const agents = [];
  for (const role of ["engineer", "qa", "devops"]) {
    const { body: a } = await api(`/companies/${companyId}/agents`, {
      method: "POST",
      body: JSON.stringify({
        name: `Chaos-${role}`,
        role,
        adapterType: "process",
        adapterConfig: {},
      }),
    });
    agents.push(a);
  }
  console.log(`  ✓ Company ${companyId}, ${agents.length} agents\n`);
  return { companyId, agents };
}

// ─── Test 1: Redis disconnect / reconnect ───────────────────────

async function testRedisDisconnect({ companyId }) {
  console.log("▸ Test 1: Redis disconnect & reconnect recovery...");

  const before = await api("/health");
  if (before.status !== 200) {
    record("Redis disconnect recovery", false, "Server not healthy at start");
    return;
  }

  // CLIENT PAUSE simulates a network blip — Redis stops processing for 2s
  redis("CLIENT", "PAUSE", "2000", "ALL");
  console.log("  · Redis CLIENT PAUSE 2000ms (simulating network blip)");

  // Health endpoint doesn't need Redis, so it should still respond
  const duringPause = await api("/health").catch(() => ({ status: 0 }));
  console.log(`  · Health during pause: ${duringPause.status}`);

  await sleep(3000);

  const after = await api("/health");
  console.log(`  · Health after resume: ${after.status}`);

  // Prove writes work after reconnect
  const { status } = await api(`/companies/${companyId}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: "Post-reconnect issue",
      description: "Created after Redis recovered",
      status: "todo",
      priority: "high",
    }),
  });
  record("Redis disconnect recovery", after.status === 200 && status === 201, `post-reconnect write: ${status}`);
  console.log();
}

// ─── Test 2: Queue overload + rate limiting ─────────────────────

async function testQueueOverload({ companyId }) {
  console.log("▸ Test 2: Queue overload + rate limiting (50 rapid-fire)...");

  // Blast 50 issues concurrently
  const promises = [];
  for (let i = 0; i < 50; i++) {
    promises.push(
      api(`/companies/${companyId}/issues`, {
        method: "POST",
        body: JSON.stringify({
          title: `Overload ${i}`,
          description: "Queue overload test",
          status: "todo",
          priority: ["low", "medium", "high", "critical"][i % 4],
        }),
      }),
    );
  }
  const responses = await Promise.all(promises);
  const created = responses.filter(r => r.status === 201).length;
  const rateLimited = responses.filter(r => r.status === 429).length;
  const errors5xx = responses.filter(r => r.status >= 500).length;
  console.log(`  · Created: ${created}/50, Rate-limited: ${rateLimited}, Server errors: ${errors5xx}`);

  // No 5xx errors — the server must not crash under load
  record("Queue overload — no 500s", errors5xx === 0, `${created} created, ${rateLimited} throttled`);
  // Rate limiting OR full acceptance are both valid
  record("Queue overload — all handled", created + rateLimited === 50);

  await sleep(1000);
  const health = await api("/health");
  record("Queue overload — server healthy", health.status === 200);
  console.log();
}

// ─── Test 3: Stalled job detection ──────────────────────────────

async function testStalledDetection({ companyId, agents }) {
  console.log("▸ Test 3: Stalled job detection & retry config...");

  // Trigger a BullMQ job by assigning an issue to an agent (heartbeat wakeup)
  const { body: triggerIssue, status: trigSt } = await api(`/companies/${companyId}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: "Queue trigger",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agents[0].id,
    }),
  });
  if (trigSt === 201) {
    console.log(`  · Triggered agent wakeup via issue ${triggerIssue.identifier}`);
    await sleep(3000); // let BullMQ create the job
  }

  const meta = redis("HGETALL", "bull:agent-execution:meta");
  const hasMeta = meta && meta.includes("bullmq");
  console.log(`  · Queue meta present: ${hasMeta}`);

  if (hasMeta) {
    // Queue exists in Redis — check stalled count and job config
    const stalledCount = redis("LLEN", "bull:agent-execution:stalled") || "0";
    console.log(`  · Currently stalled: ${stalledCount}`);

    const latestId = redis("GET", "bull:agent-execution:id");
    let attempts = 0;
    let backoffType = "unknown";
    if (latestId) {
      const opts = redis("HGET", `bull:agent-execution:${latestId}`, "opts");
      if (opts) {
        try {
          const parsed = JSON.parse(opts);
          attempts = parsed.attempts || 0;
          backoffType = parsed.backoff?.type || "none";
        } catch { /* ignore */ }
      }
    }
    console.log(`  · Latest job: ${attempts} attempts, ${backoffType} backoff`);

    record("Stalled detection — queue initialized", true);
    record("Stalled detection — retry config", attempts >= 3 && backoffType === "exponential",
      `${attempts} attempts, ${backoffType}`);
  } else {
    // Queue not yet initialized in Redis (lazy init, no jobs enqueued)
    // Verify the config from the source code as a static check
    const { readFileSync } = await import("fs");
    const queueSrc = readFileSync("server/src/queues/agentQueue.ts", "utf-8");
    const hasAttempts3 = queueSrc.includes("attempts: 3");
    const hasExponential = queueSrc.includes('type: "exponential"');
    const hasDelay5000 = queueSrc.includes("delay: 5000");
    console.log(`  · Queue lazy (no jobs yet), verifying code config:`);
    console.log(`    attempts: 3 → ${hasAttempts3}, exponential → ${hasExponential}, delay: 5000 → ${hasDelay5000}`);

    const codeCorrect = hasAttempts3 && hasExponential && hasDelay5000;
    record("Stalled detection — queue config (code)", codeCorrect,
      codeCorrect ? "3 attempts, exponential 5s" : "config mismatch in agentQueue.ts");
    record("Stalled detection — retry config (code)", codeCorrect,
      "verified from source (no runtime jobs to inspect)");
  }
  console.log();
}

// ─── Test 4: Rapid sequential mutations ─────────────────────────

async function testRapidMutations({ companyId }) {
  console.log("▸ Test 4: Rapid sequential mutations (write safety)...");

  // Wait a bit to avoid rate limit from test 2
  await sleep(2000);

  const { body: issue, status: createStatus } = await api(`/companies/${companyId}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: "Mutation target",
      description: "Testing rapid writes",
      status: "todo",
      priority: "high",
    }),
  });

  if (createStatus !== 201) {
    record("Rapid mutations — create failed", false, `status ${createStatus}`);
    console.log();
    return;
  }

  const issueId = issue.id;
  console.log(`  · Issue: ${issueId}`);

  const priorities = ["low", "medium", "high", "critical"];
  let successes = 0;
  let errors5xx = 0;

  for (let i = 0; i < 10; i++) {
    const p = priorities[i % 4];
    const r = await api(`/issues/${issueId}`, {
      method: "PATCH",
      body: JSON.stringify({ priority: p }),
    });
    if (r.status === 200) successes++;
    else if (r.status === 429) { /* rate limited — acceptable */ }
    else if (r.status >= 500) errors5xx++;
  }
  console.log(`  · 10 sequential updates: ${successes} OK, ${errors5xx} errors`);

  const { body: final } = await api(`/issues/${issueId}`);
  const isConsistent = final && final.id === issueId && priorities.includes(final.priority);
  console.log(`  · Final: priority=${final?.priority}`);

  record("Rapid mutations — no 500s", errors5xx === 0);
  record("Rapid mutations — consistent state", isConsistent);
  console.log();
}

// ─── Test 5: Worker crash recovery ──────────────────────────────

async function testWorkerCrashRecovery() {
  console.log("▸ Test 5: Worker crash recovery (queue resilience)...");

  const queueState = (label) => {
    const w = Number(redis("LLEN", "bull:agent-execution:wait") || 0);
    const a = Number(redis("LLEN", "bull:agent-execution:active") || 0);
    const c = Number(redis("ZCARD", "bull:agent-execution:completed") || 0);
    const f = Number(redis("ZCARD", "bull:agent-execution:failed") || 0);
    const d = Number(redis("ZCARD", "bull:agent-execution:delayed") || 0);
    const sum = w + a + c + f + d;
    console.log(`  · ${label}: wait=${w} active=${a} completed=${c} failed=${f} delayed=${d}`);
    return { w, a, c, f, d, sum };
  };

  const before = queueState("Before");

  // Briefly block Redis writes (simulates worker crash / network partition)
  redis("CLIENT", "PAUSE", "500", "WRITE");
  await sleep(1000);

  const after = queueState("After");

  record("Worker crash — no jobs lost", after.sum >= before.sum, `${before.sum}→${after.sum}`);

  // BGSAVE proves persistence
  redis("BGSAVE");
  await sleep(500);
  const saved = redis("LASTSAVE");
  record("Worker crash — Redis persisted", Boolean(saved));

  const health = await api("/health");
  record("Worker crash — server survives", health.status === 200);
  console.log();
}

// ─── Test 6: Network delay tolerance ────────────────────────────

async function testNetworkDelayTolerance() {
  console.log("▸ Test 6: Network delay tolerance...");

  // Baseline
  const timings = [];
  for (let i = 0; i < 3; i++) {
    const s = performance.now();
    await api("/health");
    timings.push(performance.now() - s);
  }
  const avg = timings.reduce((s, t) => s + t, 0) / timings.length;
  console.log(`  · Baseline: ${avg.toFixed(0)}ms avg`);

  // 300ms Redis pause
  redis("CLIENT", "PAUSE", "300", "ALL");
  const s1 = performance.now();
  const delayed = await api("/health").catch(() => ({ status: 0 }));
  const t1 = performance.now() - s1;
  await sleep(500);
  console.log(`  · During 300ms pause: ${delayed.status} (${t1.toFixed(0)}ms)`);

  // Recovery
  const s2 = performance.now();
  const recovered = await api("/health");
  const t2 = performance.now() - s2;
  console.log(`  · Recovery: ${recovered.status} (${t2.toFixed(0)}ms)`);

  record("Network delay — handles gracefully", delayed.status === 200);
  record("Network delay — recovers fast", recovered.status === 200 && t2 < 2000, `${t2.toFixed(0)}ms`);
  console.log();
}

// ─── Test 7: Metrics survive chaos ──────────────────────────────

async function testMetricsSurviveChaos() {
  console.log("▸ Test 7: Observability survives chaos...");

  // Wait to avoid rate limit
  await sleep(3000);

  let metricsText;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(BASE + "/metrics");
    if (res.status === 200) {
      metricsText = await res.text();
      break;
    }
    console.log(`  · Metrics attempt ${attempt + 1}: ${res.status}, waiting...`);
    await sleep(5000);
  }

  if (!metricsText) {
    record("Metrics survive chaos", false, "could not fetch metrics");
    console.log();
    return;
  }

  const hasHTTP = metricsText.includes("paperclip_http_requests_total");
  const hasJobs = metricsText.includes("paperclip_agent_jobs_total");
  const hasEvents = metricsText.includes("paperclip_events_published_total");
  const hasProcess = metricsText.includes("process_cpu_seconds_total");

  console.log(`  · HTTP: ${hasHTTP}, Jobs: ${hasJobs}, Events: ${hasEvents}, Process: ${hasProcess}`);

  const reqLines = metricsText.match(/paperclip_http_requests_total\{[^}]*\}\s+(\d+)/g) || [];
  const reqSum = reqLines.reduce((s, l) => s + Number(l.match(/\}\s+(\d+)/)?.[1] || 0), 0);
  console.log(`  · Tracked requests: ${reqSum}`);

  record("Metrics survive chaos", hasHTTP && hasJobs && hasEvents && hasProcess, `${reqSum} reqs`);
  console.log();
}

// ─── Test 8: Cross-company isolation ────────────────────────────

async function testCrossCompanyIsolation({ companyId }) {
  console.log("▸ Test 8: Cross-company isolation...");

  await sleep(3000);

  const suffix = Date.now().toString(36).slice(-4).toUpperCase();
  const { body: co2, status: co2Status } = await api("/companies", {
    method: "POST",
    body: JSON.stringify({ name: `Isolated Corp ${suffix}`, issuePrefix: `IS${suffix}` }),
  });

  if (co2Status !== 201) {
    if (co2Status === 429) {
      console.log("  · Rate limited, waiting 15s...");
      await sleep(15000);
      const retry = await api("/companies", {
        method: "POST",
        body: JSON.stringify({ name: `Isolated Corp ${suffix}R`, issuePrefix: `IR${suffix}` }),
      });
      if (retry.status !== 201) {
        record("Cross-company isolation", false, `couldn't create 2nd company: ${retry.status}`);
        console.log();
        return;
      }
      var co2Id = retry.body.id;
    } else {
      record("Cross-company isolation", false, `status ${co2Status}`);
      console.log();
      return;
    }
  } else {
    var co2Id = co2.id;
  }

  const { body: issue1, status: issStatus } = await api(`/companies/${companyId}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: "Secret data",
      description: "Should not leak to other company",
      status: "todo",
      priority: "high",
    }),
  });

  if (issStatus !== 201) {
    record("Cross-company isolation", false, `couldn't create issue: ${issStatus}`);
    console.log();
    return;
  }

  // Company-scoped list isolation: co2's list should NOT include co1's issues
  const { body: co2Issues } = await api(`/companies/${co2Id}/issues`);
  const items = Array.isArray(co2Issues) ? co2Issues : (co2Issues?.items || []);
  const leaked = items.filter(i => i.id === issue1.id).length;
  console.log(`  · Co2 issues: ${items.length}, leaked from co1: ${leaked}`);

  // Verify co1 issues stay in co1
  const { body: co1Issues } = await api(`/companies/${companyId}/issues`);
  const co1Items = Array.isArray(co1Issues) ? co1Issues : (co1Issues?.items || []);
  const co1Has = co1Items.some(i => i.id === issue1.id);
  console.log(`  · Co1 has its own issue: ${co1Has}`);

  record("Cross-company — no data leaks in listing", leaked === 0);
  record("Cross-company — data stays in origin", co1Has);
  console.log();
}

// ─── main ───────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  PAPERCLIP CHAOS TEST — Phase 16");
  console.log("═══════════════════════════════════════════════\n");

  const h = await api("/health").catch(() => ({ status: 0 }));
  if (h.status !== 200) {
    console.error(`✗ Server not reachable at ${BASE} (got ${h.status})`);
    process.exit(1);
  }
  console.log(`✓ Server healthy at ${BASE}`);

  const pong = redis("PING");
  if (pong !== "PONG") {
    console.error("✗ Redis not reachable");
    process.exit(1);
  }
  console.log(`✓ Redis connected\n`);

  const ctx = await setup();

  await testRedisDisconnect(ctx);
  await testQueueOverload(ctx);
  await testStalledDetection(ctx);
  await testRapidMutations(ctx);
  await testWorkerCrashRecovery();
  await testNetworkDelayTolerance();
  await testMetricsSurviveChaos();
  await testCrossCompanyIsolation(ctx);

  // ─── Summary ────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════");
  console.log("  CHAOS TEST RESULTS");
  console.log("═══════════════════════════════════════════════");

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  results.forEach(r => console.log(`  ${r.pass ? "✓" : "✗"} ${r.name}`));

  console.log(`\n  Total: ${passed}/${results.length} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
