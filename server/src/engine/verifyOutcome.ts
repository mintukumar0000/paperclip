import type { Db } from "@paperclipai/db";
import { activityLog, and, eq, gte, inArray } from "@paperclipai/db";
import { getRecentSystemMetricsSnapshot } from "../ai/feedback/metricsEngine.js";

export interface LandingVerification {
  url: string;
  visitors: number;
  signups: number;
  conversionRate: number;
  success: boolean;
}

export interface RedditVerification {
  posts: number;
  replies: number;
  upvotes: number;
  comments: number;
  success: boolean;
}

export interface EmailVerification {
  emailsSent: number;
  openRate: number | null;
  clickRate: number | null;
  success: boolean;
  notes: string[];
}

export interface RevenueVerification {
  visitors: number;
  revenueCents: number;
  rpv: number;
  previousRpv: number;
  trend: "increasing" | "flat" | "down";
  decision: "scale" | "improve" | "kill";
  increased: boolean;
}

function readFiniteMetric(details: unknown, key: string): number {
  if (!details || typeof details !== "object") return 0;
  const value = (details as Record<string, unknown>)[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

export async function verifyLanding(
  db: Db,
  companyId: string,
  url: string,
  windowMinutes = 180,
): Promise<LandingVerification> {
  const snapshot = await getRecentSystemMetricsSnapshot(db, companyId, windowMinutes);
  const visitors = Math.max(0, snapshot.traffic);
  const signups = Math.max(0, snapshot.conversions);
  const conversionRate = visitors > 0 ? signups / visitors : 0;

  return {
    url,
    visitors,
    signups,
    conversionRate,
    success: signups > 0,
  };
}

export async function verifyReddit(
  db: Db,
  companyId: string,
  windowMinutes = 180,
): Promise<RedditVerification> {
  const cutoff = new Date(Date.now() - windowMinutes * 60_000);
  const rows = await db
    .select({ action: activityLog.action, details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        gte(activityLog.createdAt, cutoff),
        inArray(activityLog.action, ["distribution.reddit.posted", "distribution.reddit.reply.posted"]),
      ),
    );

  const posts = rows.filter((row) => row.action === "distribution.reddit.posted").length;
  const replies = rows.filter((row) => row.action === "distribution.reddit.reply.posted").length;

  const upvotes = rows.reduce((sum, row) => {
    const details = row.details;
    const explicitUpvotes = readFiniteMetric(details, "upvotes");
    const fallbackScore = readFiniteMetric(details, "commentScore");
    return sum + (explicitUpvotes > 0 ? explicitUpvotes : fallbackScore);
  }, 0);

  const comments = rows.reduce((sum, row) => {
    const details = row.details;
    const explicitComments = readFiniteMetric(details, "comments");
    return sum + explicitComments;
  }, 0);

  // Success is based on measurable post engagement, not just posting volume.
  const success = upvotes > 5 || comments > 2;

  return {
    posts,
    replies,
    upvotes,
    comments,
    success,
  };
}

export async function verifyEmail(
  db: Db,
  companyId: string,
  windowMinutes = 180,
): Promise<EmailVerification> {
  const cutoff = new Date(Date.now() - windowMinutes * 60_000);
  const rows = await db
    .select({ action: activityLog.action, details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        gte(activityLog.createdAt, cutoff),
        inArray(activityLog.action, [
          "email.sequence.value.sent",
          "email.sequence.case_study.sent",
          "email.sequence.objection.sent",
          "email.sequence.urgency.sent",
          "email.sequence.last_call.sent",
          "email.sequence.opened",
          "email.sequence.clicked",
        ]),
      ),
    );

  const emailsSent = rows.filter((row) => row.action.startsWith("email.sequence.") && row.action.endsWith(".sent")).length;
  const opens = rows.filter((row) => row.action === "email.sequence.opened").length;
  const clicks = rows.filter((row) => row.action === "email.sequence.clicked").length;

  const openRate = emailsSent > 0 ? opens / emailsSent : null;
  const clickRate = emailsSent > 0 ? clicks / emailsSent : null;

  const notes: string[] = [];
  notes.push(`Email events window: sent=${emailsSent}, opens=${opens}, clicks=${clicks}`);

  // Success threshold: click rate above 2%.
  const success = clickRate != null ? clickRate > 0.02 : false;

  return {
    emailsSent,
    openRate,
    clickRate,
    success,
    notes,
  };
}

export async function verifyRevenue(
  db: Db,
  companyId: string,
  windowMinutes = 180,
): Promise<RevenueVerification> {
  const now = new Date();
  const current = await getRecentSystemMetricsSnapshot(db, companyId, windowMinutes, now);
  const previousWindowEnd = new Date(now.getTime() - windowMinutes * 60_000);
  const previous = await getRecentSystemMetricsSnapshot(db, companyId, windowMinutes, previousWindowEnd);

  const currentRpv = Math.max(0, current.revenue_per_visit);
  const previousRpv = Math.max(0, previous.revenue_per_visit);
  const delta = currentRpv - previousRpv;

  const trend: RevenueVerification["trend"] =
    previousRpv <= 0
      ? currentRpv > 0
        ? "increasing"
        : "flat"
      : delta > previousRpv * 0.05
        ? "increasing"
        : delta < -previousRpv * 0.05
          ? "down"
          : "flat";

  const decision: RevenueVerification["decision"] =
    trend === "increasing" ? "scale" : trend === "down" ? "kill" : "improve";

  return {
    visitors: Math.max(0, current.traffic),
    revenueCents: Math.max(0, current.revenue),
    rpv: currentRpv,
    previousRpv,
    trend,
    decision,
    increased: trend === "increasing",
  };
}
