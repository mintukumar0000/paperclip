import {
  createDb,
  and,
  eq,
  ne,
  count,
  inArray,
  companies,
  agents,
  activityLog,
  approvals,
  approvalComments,
  issueApprovals,
  issueComments,
  issueAttachments,
  issueLabels,
  issues,
  goals,
  assets,
  heartbeatRuns,
  heartbeatRunEvents,
  agentWakeupRequests,
  agentTaskSessions,
  agentRuntimeState,
  costEvents,
  aiLearningRecords,
  strategyPlans,
  agentPlans,
  systemControls,
  systemDecisions,
  cycleState,
  systemMetrics,
  ecosystemMetrics,
  paymentEvents,
  waitlistSignups,
  companyFinance,
} from "@paperclipai/db";

type TableCounts = Record<string, number>;

function arg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function countRows<T extends { companyId: unknown }>(
  db: ReturnType<typeof createDb>,
  table: T,
  companyId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(table as never)
    .where(eq((table as { companyId: unknown }).companyId as never, companyId));
  return Number(rows[0]?.value ?? 0);
}

async function snapshot(db: ReturnType<typeof createDb>, companyId: string): Promise<TableCounts> {
  const queuedWakeups = await db
    .select({ value: count() })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, companyId),
        inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
      ),
    );

  const pendingRuns = await db
    .select({ value: count() })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, ["queued", "running"]),
      ),
    );

  return {
    systemDecisions: await countRows(db, systemDecisions, companyId),
    cycleState: await countRows(db, cycleState, companyId),
    activityLog: await countRows(db, activityLog, companyId),
    systemMetrics: await countRows(db, systemMetrics, companyId),
    ecosystemMetrics: await countRows(db, ecosystemMetrics, companyId),
    issues: await countRows(db, issues, companyId),
    goals: await countRows(db, goals, companyId),
    approvals: await countRows(db, approvals, companyId),
    pendingWakeups: Number(queuedWakeups[0]?.value ?? 0),
    pendingHeartbeatRuns: Number(pendingRuns[0]?.value ?? 0),
    aiLearningRecords: await countRows(db, aiLearningRecords, companyId),
    strategyPlans: await countRows(db, strategyPlans, companyId),
    agentPlans: await countRows(db, agentPlans, companyId),
    paymentEvents: await countRows(db, paymentEvents, companyId),
    waitlistSignups: await countRows(db, waitlistSignups, companyId),
    assets: await countRows(db, assets, companyId),
  };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  const companyId = arg("--company-id") ?? process.env.ACTIVE_COMPANY_ID?.trim() ?? "";
  const execute = hasFlag("--execute");
  const clearSignals = !hasFlag("--keep-signals");
  const confirm = process.env.HARD_RESET_CONFIRM?.trim() === "YES";

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }
  if (!companyId) {
    throw new Error("Company id is required. Pass --company-id <uuid> or set ACTIVE_COMPANY_ID.");
  }

  const db = createDb(databaseUrl);
  const company = await db
    .select({ id: companies.id, name: companies.name, status: companies.status })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!company) {
    throw new Error(`Company not found: ${companyId}`);
  }

  const before = await snapshot(db, companyId);

  console.log(JSON.stringify({
    mode: execute ? "execute" : "dry-run",
    clearSignals,
    company,
    before,
  }, null, 2));

  if (!execute) {
    console.log("Dry-run only. Re-run with --execute and HARD_RESET_CONFIRM=YES to apply reset.");
    return;
  }

  if (!confirm) {
    throw new Error("Refusing to execute without HARD_RESET_CONFIRM=YES.");
  }

  await db.transaction(async (tx) => {
    const now = new Date();

    // Stop autonomy + traffic loops before clearing runtime state.
    await tx
      .update(systemControls)
      .set({
        trafficEnabled: false,
        redditEnabled: false,
        twitterEnabled: false,
        indieHackersEnabled: false,
        hackerNewsEnabled: false,
        autonomyLevel: "manual",
        decisionMode: "approval_required",
        trafficMode: "conservative",
        trafficMultiplier: 1,
        updatedAt: now,
      })
      .where(eq(systemControls.companyId, companyId));

    await tx
      .update(agents)
      .set({ status: "idle", updatedAt: now })
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

    await tx
      .update(companyFinance)
      .set({ revenueCents: 0, creditsCents: 0, spentCents: 0, updatedAt: now })
      .where(eq(companyFinance.companyId, companyId));

    // Queue and execution state.
    await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId));
    await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.companyId, companyId));
    await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.companyId, companyId));

    // Decision and cycle runtime state.
    await tx.delete(systemDecisions).where(eq(systemDecisions.companyId, companyId));
    await tx.delete(cycleState).where(eq(cycleState.companyId, companyId));

    // Paperclip work state.
    await tx.delete(approvalComments).where(eq(approvalComments.companyId, companyId));
    await tx.delete(issueApprovals).where(eq(issueApprovals.companyId, companyId));
    await tx.delete(issueAttachments).where(eq(issueAttachments.companyId, companyId));
    await tx.delete(issueComments).where(eq(issueComments.companyId, companyId));
    await tx.delete(issueLabels).where(eq(issueLabels.companyId, companyId));
    await tx.delete(approvals).where(eq(approvals.companyId, companyId));
    await tx.delete(issues).where(eq(issues.companyId, companyId));
    await tx.delete(goals).where(eq(goals.companyId, companyId));

    // Metrics and learned runtime artifacts.
    await tx.delete(systemMetrics).where(eq(systemMetrics.companyId, companyId));
    await tx.delete(ecosystemMetrics).where(eq(ecosystemMetrics.companyId, companyId));
    await tx.delete(aiLearningRecords).where(eq(aiLearningRecords.companyId, companyId));
    await tx.delete(strategyPlans).where(eq(strategyPlans.companyId, companyId));
    await tx.delete(agentPlans).where(eq(agentPlans.companyId, companyId));

    // Runtime evidence/history feeds.
    await tx.delete(costEvents).where(eq(costEvents.companyId, companyId));
    await tx.delete(activityLog).where(eq(activityLog.companyId, companyId));
    await tx.delete(assets).where(eq(assets.companyId, companyId));

    if (clearSignals) {
      await tx.delete(paymentEvents).where(eq(paymentEvents.companyId, companyId));
      await tx.delete(waitlistSignups).where(eq(waitlistSignups.companyId, companyId));
    }
  });

  const after = await snapshot(db, companyId);
  console.log(JSON.stringify({ companyId, clearSignals, after }, null, 2));
}

main().catch((error) => {
  console.error("hard-reset-runtime failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
