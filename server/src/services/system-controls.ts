import type { Db } from "@paperclipai/db";
import { and, desc, eq, gte } from "@paperclipai/db";
import { systemControls, systemDecisions } from "@paperclipai/db";
import type {
  DecisionMode,
  ResolveSystemDecision,
  TrafficChannel,
  TrafficMode,
  UpdateSystemControls,
} from "@paperclipai/shared";

const ALLOWED_TRAFFIC_CHANNELS = new Set<TrafficChannel>([
  "reddit",
  "twitter",
  "indie_hackers",
  "hacker_news",
]);

const ALLOWED_TRAFFIC_MODES = new Set<TrafficMode>([
  "conservative",
  "balanced",
  "aggressive",
]);

const ALLOWED_DECISION_MODES = new Set<DecisionMode>([
  "approval_required",
  "approval_for_high_impact",
  "auto_execute",
]);

const DEFAULT_SYSTEM_CONTROLS = {
  trafficEnabled: true,
  redditEnabled: true,
  twitterEnabled: true,
  indieHackersEnabled: true,
  hackerNewsEnabled: true,
  maxMultiplier: 3,
  postFrequency: 1,
  subredditTargets: [] as string[],
  pricingVariant: "entry_9",
  paywallTriggerCount: 3,
  cycleMode: "launch" as const,
  autonomyLevel: "semi" as const,
  trafficChannels: ["reddit", "twitter", "indie_hackers", "hacker_news"] as TrafficChannel[],
  trafficMultiplier: 1,
  trafficPostIntervalMs: 60_000,
  trafficMaxPostsPerCycle: 8,
  trafficSubredditWhitelist: [] as string[],
  trafficMode: "balanced" as const,
  decisionMode: "approval_for_high_impact" as const,
};

function normalizeSubredditTargets(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const normalized = raw.trim().replace(/^r\//i, "");
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }
  return deduped;
}

function normalizeTrafficChannels(values: string[] | undefined): TrafficChannel[] | undefined {
  if (!values) return undefined;
  const deduped: TrafficChannel[] = [];
  const seen = new Set<TrafficChannel>();
  for (const raw of values) {
    const normalized = raw.trim().toLowerCase().replace(/\s+/g, "_") as TrafficChannel;
    if (!ALLOWED_TRAFFIC_CHANNELS.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function normalizeTrafficMode(value: string | undefined): TrafficMode | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase() as TrafficMode;
  if (!ALLOWED_TRAFFIC_MODES.has(normalized)) return undefined;
  return normalized;
}

function normalizeDecisionMode(value: string | undefined): DecisionMode | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase() as DecisionMode;
  if (!ALLOWED_DECISION_MODES.has(normalized)) return undefined;
  return normalized;
}

function sanitizeUpdate(input: UpdateSystemControls): Partial<typeof systemControls.$inferInsert> {
  const mappedTrafficEnabled = typeof input.systemActive === "boolean"
    ? input.systemActive
    : input.trafficEnabled;
  const mappedPostInterval = typeof input.loopIntervalSeconds === "number"
    ? Math.max(5_000, Math.min(3_600_000, Math.trunc(input.loopIntervalSeconds * 1000)))
    : typeof input.trafficPostIntervalMs === "number"
      ? Math.max(5_000, Math.min(3_600_000, Math.trunc(input.trafficPostIntervalMs)))
      : input.trafficPostIntervalMs;

  return {
    trafficEnabled: mappedTrafficEnabled,
    redditEnabled: input.redditEnabled,
    twitterEnabled: input.twitterEnabled,
    indieHackersEnabled: input.indieHackersEnabled,
    hackerNewsEnabled: input.hackerNewsEnabled,
    maxMultiplier:
      typeof input.maxMultiplier === "number"
        ? Math.max(1, Math.min(20, Math.trunc(input.maxMultiplier)))
        : input.maxMultiplier,
    postFrequency:
      typeof input.postFrequency === "number"
        ? Math.max(1, Math.min(24, Math.trunc(input.postFrequency)))
        : input.postFrequency,
    subredditTargets: normalizeSubredditTargets(input.subredditTargets),
    pricingVariant: input.pricingVariant,
    paywallTriggerCount:
      typeof input.paywallTriggerCount === "number"
        ? Math.max(1, Math.min(50, Math.trunc(input.paywallTriggerCount)))
        : input.paywallTriggerCount,
    cycleMode: input.cycleMode,
    autonomyLevel: input.autonomyLevel,
    trafficChannels: normalizeTrafficChannels(input.trafficChannels),
    trafficMultiplier:
      typeof input.trafficMultiplier === "number"
        ? Math.max(1, Math.min(20, Math.trunc(input.trafficMultiplier)))
        : input.trafficMultiplier,
    trafficPostIntervalMs: mappedPostInterval,
    trafficMaxPostsPerCycle:
      typeof input.trafficMaxPostsPerCycle === "number"
        ? Math.max(1, Math.min(40, Math.trunc(input.trafficMaxPostsPerCycle)))
        : input.trafficMaxPostsPerCycle,
    trafficSubredditWhitelist: normalizeSubredditTargets(input.trafficSubredditWhitelist),
    trafficMode: normalizeTrafficMode(input.trafficMode),
    decisionMode: normalizeDecisionMode(input.decisionMode),
  };
}

export type SystemControlsRow = typeof systemControls.$inferSelect;
export type SystemDecisionRow = typeof systemDecisions.$inferSelect;

export async function getSystemControls(db: Db, companyId: string): Promise<SystemControlsRow> {
  const existing = await db
    .select()
    .from(systemControls)
    .where(eq(systemControls.companyId, companyId))
    .then((rows) => rows[0] ?? null);

  if (existing) return existing;

  const now = new Date();
  try {
    const created = await db
      .insert(systemControls)
      .values({
        companyId,
        ...DEFAULT_SYSTEM_CONTROLS,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (created) return created;
  } catch {
    // Concurrent insert is safe to ignore; fetch the winner row below.
  }

  const fallback = await db
    .select()
    .from(systemControls)
    .where(eq(systemControls.companyId, companyId))
    .then((rows) => rows[0] ?? null);

  if (!fallback) {
    throw new Error(`Failed to load system controls for company ${companyId}`);
  }

  return fallback;
}

export async function updateSystemControls(
  db: Db,
  companyId: string,
  patch: UpdateSystemControls,
): Promise<SystemControlsRow> {
  await getSystemControls(db, companyId);

  const sanitized = sanitizeUpdate(patch);
  const [updated] = await db
    .update(systemControls)
    .set({
      ...sanitized,
      updatedAt: new Date(),
    })
    .where(eq(systemControls.companyId, companyId))
    .returning();

  if (!updated) {
    throw new Error(`Failed to update system controls for company ${companyId}`);
  }

  return updated;
}

export async function listSystemDecisions(
  db: Db,
  companyId: string,
  limit = 100,
): Promise<SystemDecisionRow[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit || 100)));
  return db
    .select()
    .from(systemDecisions)
    .where(eq(systemDecisions.companyId, companyId))
    .orderBy(desc(systemDecisions.createdAt))
    .limit(safeLimit);
}

export async function getSystemDecisionById(
  db: Db,
  companyId: string,
  decisionId: string,
): Promise<SystemDecisionRow | null> {
  return db
    .select()
    .from(systemDecisions)
    .where(and(eq(systemDecisions.companyId, companyId), eq(systemDecisions.id, decisionId)))
    .then((rows) => rows[0] ?? null);
}

export async function createSystemDecision(
  db: Db,
  input: {
    companyId: string;
    source: string;
    actionType: string;
    actionKey: string;
    reason: string;
    metricName?: string | null;
    metricValue?: number | null;
    thresholdValue?: number | null;
    actionPayload?: Record<string, unknown>;
    status?: string;
  },
): Promise<SystemDecisionRow> {
  const now = new Date();
  const [row] = await db
    .insert(systemDecisions)
    .values({
      companyId: input.companyId,
      source: input.source,
      actionType: input.actionType,
      actionKey: input.actionKey,
      reason: input.reason,
      metricName: input.metricName ?? null,
      metricValue: input.metricValue ?? null,
      thresholdValue: input.thresholdValue ?? null,
      actionPayload: input.actionPayload ?? {},
      status: input.status ?? "pending",
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (!row) {
    throw new Error("Failed to create system decision");
  }

  return row;
}

export async function resolveSystemDecision(
  db: Db,
  companyId: string,
  decisionId: string,
  input: {
    resolution: "approve" | "reject";
    actorId: string;
    note?: ResolveSystemDecision["note"];
  },
): Promise<SystemDecisionRow | null> {
  const now = new Date();
  const updatePayload = input.resolution === "approve"
    ? {
        status: "approved",
        approvedBy: input.actorId,
        approvedAt: now,
        overrideNote: input.note ?? null,
        updatedAt: now,
      }
    : {
        status: "rejected",
        rejectedBy: input.actorId,
        rejectedAt: now,
        overrideNote: input.note ?? null,
        updatedAt: now,
      };

  const [row] = await db
    .update(systemDecisions)
    .set(updatePayload)
    .where(and(eq(systemDecisions.companyId, companyId), eq(systemDecisions.id, decisionId)))
    .returning();

  return row ?? null;
}

export async function setSystemDecisionExecutionResult(
  db: Db,
  companyId: string,
  decisionId: string,
  input: {
    status: "executed" | "failed" | "overridden";
    note?: string | null;
  },
): Promise<void> {
  const now = new Date();
  await db
    .update(systemDecisions)
    .set({
      status: input.status,
      overrideNote: input.note ?? null,
      executedAt: input.status === "executed" ? now : null,
      updatedAt: now,
    })
    .where(and(eq(systemDecisions.companyId, companyId), eq(systemDecisions.id, decisionId)));
}

export async function isDecisionKeyBlocked(
  db: Db,
  companyId: string,
  actionKey: string,
  windowHours = 24,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - Math.max(1, windowHours) * 60 * 60 * 1000);
  const blocked = await db
    .select({ id: systemDecisions.id })
    .from(systemDecisions)
    .where(
      and(
        eq(systemDecisions.companyId, companyId),
        eq(systemDecisions.actionKey, actionKey),
        gte(systemDecisions.createdAt, cutoff),
        eq(systemDecisions.status, "rejected"),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return !!blocked;
}

export function shouldRequireApprovalForAction(
  decisionMode: DecisionMode,
  actionType: string,
  actionKey: string,
): boolean {
  if (decisionMode === "approval_required") return true;
  if (decisionMode === "auto_execute") return false;

  const normalizedType = actionType.toLowerCase();
  const normalizedKey = actionKey.toLowerCase();
  const highImpactType = normalizedType === "trigger_expansion";
  const highImpactKey =
    normalizedKey.includes("scale")
    || normalizedKey.includes("expansion")
    || normalizedKey.includes("pricing")
    || normalizedKey.includes("payment")
    || normalizedKey.includes("traffic.execution");
  return highImpactType || highImpactKey;
}

export async function hasOpenDecisionForActionKey(
  db: Db,
  companyId: string,
  actionKey: string,
  windowMinutes = 90,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - Math.max(1, windowMinutes) * 60 * 1000);
  const existing = await db
    .select({ id: systemDecisions.id })
    .from(systemDecisions)
    .where(
      and(
        eq(systemDecisions.companyId, companyId),
        eq(systemDecisions.actionKey, actionKey),
        gte(systemDecisions.createdAt, cutoff),
      ),
    )
    .orderBy(desc(systemDecisions.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!existing) return false;

  const row = await getSystemDecisionById(db, companyId, existing.id);
  return row ? ["pending", "awaiting_approval", "approved"].includes(row.status) : false;
}
