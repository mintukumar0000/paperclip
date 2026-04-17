import type { Db } from "@paperclipai/db";
import { and, asc, eq } from "@paperclipai/db";
import { cycleState } from "@paperclipai/db";

export type RuntimeLoopKey = "traffic" | "email_sequence" | "decision_engine" | "execution_loop" | "cycle_orchestrator";

export type CycleStateRow = typeof cycleState.$inferSelect;

type CycleStatePatch = {
  status?: CycleStateRow["status"];
  stage?: string | null;
  currentAction?: string | null;
  decisionId?: string | null;
  lastError?: string | null;
  lastRunStartedAt?: Date | null;
  lastRunCompletedAt?: Date | null;
  lastRunDurationMs?: number | null;
  details?: Record<string, unknown>;
};

export async function setCycleState(
  db: Db,
  companyId: string,
  loopKey: RuntimeLoopKey,
  patch: CycleStatePatch,
): Promise<CycleStateRow> {
  const now = new Date();
  const payload = {
    ...patch,
    updatedAt: now,
  };

  const updated = await db
    .update(cycleState)
    .set(payload)
    .where(and(eq(cycleState.companyId, companyId), eq(cycleState.loopKey, loopKey)))
    .returning()
    .then((rows) => rows[0] ?? null);

  if (updated) return updated;

  try {
    const inserted = await db
      .insert(cycleState)
      .values({
        companyId,
        loopKey,
        status: patch.status ?? "idle",
        stage: patch.stage ?? null,
        currentAction: patch.currentAction ?? null,
        decisionId: patch.decisionId ?? null,
        lastError: patch.lastError ?? null,
        lastRunStartedAt: patch.lastRunStartedAt ?? null,
        lastRunCompletedAt: patch.lastRunCompletedAt ?? null,
        lastRunDurationMs: patch.lastRunDurationMs ?? null,
        details: patch.details ?? {},
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .then((rows) => rows[0] ?? null);

    if (inserted) return inserted;
  } catch {
    // ignore race and update winner row below
  }

  const fallback = await db
    .update(cycleState)
    .set(payload)
    .where(and(eq(cycleState.companyId, companyId), eq(cycleState.loopKey, loopKey)))
    .returning()
    .then((rows) => rows[0] ?? null);

  if (!fallback) {
    throw new Error(`Failed to upsert cycle state for ${companyId}/${loopKey}`);
  }

  return fallback;
}

export async function listCompanyCycleState(db: Db, companyId: string): Promise<CycleStateRow[]> {
  return db
    .select()
    .from(cycleState)
    .where(eq(cycleState.companyId, companyId))
    .orderBy(asc(cycleState.loopKey));
}
