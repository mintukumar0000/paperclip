import type { Db } from "@paperclipai/db";
import { waitlistSignups } from "@paperclipai/db";
import { eq, desc } from "@paperclipai/db";
import pino from "pino";
import { routeLLM } from "../llmRouter.js";
import { validateOutput } from "../quality/executionQualityGate.js";
import { eventBus } from "../../events/eventBus.js";
import { getSystemControls } from "../../services/system-controls.js";
import { setCycleState } from "../../services/cycle-state.js";
import { logActivity } from "../../services/activity-log.js";

const logger = pino({ name: "email-sequence" });

type SequenceStep = "value" | "case_study" | "objection" | "urgency" | "last_call";

interface EmailTemplate {
  step: SequenceStep;
  subject: string;
  html: string;
}

const DAY_MS = 24 * 60 * 60_000;
const SEQUENCE_ORDER: SequenceStep[] = ["value", "case_study", "objection", "urgency", "last_call"];

function getInitialDelayMs(controls?: { cycleMode?: string; postFrequency?: number } | null): number {
  const frequency = Math.max(1, Math.trunc(controls?.postFrequency ?? 1));
  const cycleMode = (controls?.cycleMode ?? "launch").toLowerCase();
  const cadenceFactor = cycleMode === "dominate"
    ? 0.4
    : cycleMode === "scale"
      ? 0.55
      : cycleMode === "improve"
        ? 0.75
        : 1;
  const frequencyFactor = Math.max(0.35, 1 / Math.min(6, frequency));
  return Math.max(6 * 60 * 60_000, Math.round(DAY_MS * cadenceFactor * frequencyFactor));
}

function getStepDelayMs(controls?: { cycleMode?: string; postFrequency?: number } | null): number {
  const frequency = Math.max(1, Math.trunc(controls?.postFrequency ?? 1));
  const cycleMode = (controls?.cycleMode ?? "launch").toLowerCase();
  const cadenceFactor = cycleMode === "dominate"
    ? 0.33
    : cycleMode === "scale"
      ? 0.5
      : cycleMode === "improve"
        ? 0.7
        : 1;
  const frequencyFactor = Math.max(0.3, 1 / Math.min(8, frequency));
  return Math.max(4 * 60 * 60_000, Math.round(DAY_MS * cadenceFactor * frequencyFactor));
}

function wrapEmailLinksWithTracking(html: string, args: {
  baseUrl: string;
  email: string;
  step: SequenceStep;
  companyId: string | null;
}): string {
  const normalizedBase = args.baseUrl.replace(/\/$/, "");
  const emailParam = encodeURIComponent(args.email);
  const stepParam = encodeURIComponent(args.step);
  const companyParam = args.companyId ? `&companyId=${encodeURIComponent(args.companyId)}` : "";

  return html.replace(/href\s*=\s*(["'])([^"']+)\1/gi, (_match, quote: string, href: string) => {
    const target = href.trim();
    if (!target) return _match;
    if (/^(mailto:|tel:|#|javascript:)/i.test(target)) return _match;
    if (target.includes("/api/email/click")) return _match;

    const tracked = `${normalizedBase}/api/email/click?email=${emailParam}&step=${stepParam}${companyParam}&url=${encodeURIComponent(target)}`;
    return `href=${quote}${tracked}${quote}`;
  });
}

function appendOpenPixel(html: string, args: {
  baseUrl: string;
  email: string;
  step: SequenceStep;
  companyId: string | null;
}): string {
  const normalizedBase = args.baseUrl.replace(/\/$/, "");
  const pixelUrl = `${normalizedBase}/api/email/open?email=${encodeURIComponent(args.email)}&step=${encodeURIComponent(args.step)}${args.companyId ? `&companyId=${encodeURIComponent(args.companyId)}` : ""}`;
  const pixelTag = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:block;opacity:0;pointer-events:none" />`;

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${pixelTag}</body>`);
  }
  return `${html}\n${pixelTag}`;
}

async function generateEmailContent(
  step: SequenceStep,
  recipientName: string,
  tier: string,
): Promise<EmailTemplate> {
  const priceCents = tier === "premium" ? 2900 : tier === "upsell" ? 1900 : 900;
  const priceUsd = (priceCents / 100).toFixed(0);

  const prompts: Record<SequenceStep, string> = {
    value: `Write a VALUE email. Subject line + HTML body.
Goal: Provide genuine value, build trust, softly introduce the product.
Include: One actionable cold email tip they can use immediately.
Recipient: ${recipientName}, a startup founder
Product: Cold email template pack ($${priceUsd})
Tone: Friendly, founder-to-founder, no corporate speak`,

    case_study: `Write a CASE STUDY email. Subject line + HTML body.
Goal: Show social proof and real results.
Include: A mini case study of a founder who used cold email templates to book meetings.
Recipient: ${recipientName}, who received our first email yesterday
Product: Cold email template pack ($${priceUsd})
Tone: Story-driven, specific numbers, relatable`,

    objection: `Write an OBJECTION-HANDLING email. Subject line + HTML body.
  Goal: Remove purchase friction from a skeptical founder.
  Include: Address "this won't work for my niche" and "I don't have time" with concise answers.
  Recipient: ${recipientName}, who has seen value and case-study emails but not purchased yet
  Product: Cold email template pack ($${priceUsd})
  Tone: Helpful, confident, practical`,

    urgency: `Write an URGENCY/LAST CHANCE email. Subject line + HTML body.
Goal: Create legitimate scarcity and drive purchase.
Include: Price going up tomorrow, limited spots, or bonus expiring.
Recipient: ${recipientName}, who received 2 previous emails
Product: Cold email template pack ($${priceUsd})
Tone: Direct, urgent but not spammy, genuine deadline`,

    last_call: `Write a FINAL CALL email. Subject line + HTML body.
  Goal: Clear close with one decisive CTA and no fluff.
  Include: concise summary of outcomes, explicit deadline, and a final reminder this is the last email.
  Recipient: ${recipientName}, who received previous nurture emails and still has not purchased
  Product: Cold email template pack ($${priceUsd})
  Tone: Respectful, firm, concise`,
  };

  const baseMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    {
      role: "system",
      content: `You write high-converting email sequences for startups. Return ONLY a JSON object:
{
  "subject": "Email subject line",
  "html": "<html>Full email body with HTML formatting</html>"
}
Use simple HTML. Include a clear CTA button linking to {payment_link}. Keep emails short (150-250 words).`,
    },
    { role: "user", content: prompts[step] },
  ];

  const messages = [...baseMessages];
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await routeLLM("email", messages);
    if (!response?.content) continue;

    try {
      let content = response.content;
      if (content.startsWith("```")) {
        content = content.replace(/^```(?:json|html)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
      }
      const parsed = JSON.parse(content) as { subject?: string; html?: string };
      if (!parsed.subject || !parsed.html) continue;

      const quality = validateOutput(parsed.html, "email");
      if (quality.valid) {
        return { step, subject: parsed.subject, html: parsed.html };
      }

      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: `Quality gate rejected your email for: ${quality.reasons.join("; ")}. Rewrite and return strict JSON again.`,
      });
    } catch {
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: "Output must be strict JSON with subject and html fields. Try again.",
      });
    }
  }

  return getDefaultEmail(step, recipientName, priceUsd);
}

function getDefaultEmail(step: SequenceStep, name: string, priceUsd: string): EmailTemplate {
  const safeName = name || "Founder";

  if (step === "value") {
    return {
      step,
      subject: `${safeName}, one cold email trick that booked me 5 calls last week`,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
<p>Hey ${safeName},</p>
<p>Quick tip that's been working really well:</p>
<p><strong>The "mutual connection" opener.</strong></p>
<p>Instead of "I noticed your company..." try: "I was talking to [mutual connection/shared community] about [their problem] and your name came up."</p>
<p>Even if the connection is loose (same subreddit, same industry), it works because it feels warm.</p>
<p>I've got 12 more templates like this in our founder pack — all tested on real outreach campaigns.</p>
<p><a href="{payment_link}" style="display:inline-block;background:#000;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px">Get All 12 Templates — $${priceUsd}</a></p>
<p>— The Paperclip Team</p>
</div>`,
    };
  }

  if (step === "case_study") {
    return {
      step,
      subject: `${safeName}, how a solo founder booked 8 calls in one week`,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
<p>Hey ${safeName},</p>
<p>Quick story: A founder in our community was struggling with cold outreach. Response rate: 2%.</p>
<p>They switched to our template sequence — specifically the "problem-agitation-solution" framework — and here's what happened:</p>
<ul>
<li>Week 1: 47 emails sent, 8 replies, 5 calls booked</li>
<li>Response rate jumped from 2% to 17%</li>
<li>Closed their first paying customer from a cold email</li>
</ul>
<p>The difference? Templates that sound human, not AI-generated.</p>
<p><a href="{payment_link}" style="display:inline-block;background:#000;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px">Get the Same Templates — $${priceUsd}</a></p>
<p>— The Paperclip Team</p>
</div>`,
    };
  }

  if (step === "objection") {
    return {
      step,
      subject: `${safeName}, quick answers before you decide`,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
<p>Hey ${safeName},</p>
<p>A couple founders asked the same two questions, so here's the short version:</p>
<p><strong>"Will this work in my niche?"</strong><br/>Yes, because the templates are frameworks, not scripts. You keep the structure and swap in your market language.</p>
<p><strong>"I don't have time to personalize."</strong><br/>Start with one core angle and reuse it across 10 prospects. You can still sound specific in under 5 minutes.</p>
<p>If you want, use the pack for one week and measure reply rate delta. Keep what works, ignore the rest.</p>
<p><a href="{payment_link}" style="display:inline-block;background:#000;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px">Access the Template Pack — $${priceUsd}</a></p>
<p>— The Paperclip Team</p>
</div>`,
    };
  }

  if (step === "urgency") {
    return {
      step,
      subject: `${safeName}, last chance: $${priceUsd} pricing ends tonight`,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
<p>Hey ${safeName},</p>
<p>Just a heads up — the $${priceUsd} founder price for our cold email template pack is going away tonight at midnight.</p>
<p>After that, founder pricing closes and this offer resets.</p>
<p>This isn't fake scarcity — we're raising the price because we've added new templates and the pack keeps getting better results.</p>
<p><strong>What you get:</strong></p>
<ul>
<li>12 proven cold email templates</li>
<li>3 follow-up sequences</li>
<li>Subject line formulas that get 40%+ open rates</li>
</ul>
<p><a href="{payment_link}" style="display:inline-block;background:#e53e3e;color:#fff;padding:14px 28px;text-decoration:none;border-radius:6px;font-weight:bold">Lock In $${priceUsd} Before Midnight</a></p>
<p>— The Paperclip Team</p>
</div>`,
    };
  }

  return {
    step,
    subject: `${safeName}, final reminder before this closes`,
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
<p>Hey ${safeName},</p>
<p>Final note from me: this is the last email in this sequence.</p>
<p>If outbound is a priority this month, the template pack gives you a tested starting point instead of another blank page.</p>
<p><strong>Offer ends tonight.</strong> If you want in at $${priceUsd}, use this link now:</p>
<p><a href="{payment_link}" style="display:inline-block;background:#111827;color:#fff;padding:14px 28px;text-decoration:none;border-radius:6px;font-weight:bold">Get Instant Access</a></p>
<p>Either way, wishing you a strong quarter.</p>
<p>— The Paperclip Team</p>
</div>`,
  };
}

async function sendSequenceEmail(
  db: Db,
  email: string,
  name: string,
  step: SequenceStep,
  companyId: string | null,
  paymentLink: string,
): Promise<boolean> {
  const resendKey = (process.env.RESEND_API_KEY ?? "").trim();
  const fromEmail = (process.env.RESEND_FROM_EMAIL ?? "").trim();
  if (!resendKey || !fromEmail) return false;

  const tier = "entry";
  const template = await generateEmailContent(step, name || "Founder", tier);

  const baseUrl = (process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ?? "http://localhost:3100").trim();
  const htmlWithPaymentLink = template.html.replace(/\{payment_link\}/g, paymentLink);
  const trackedHtml = appendOpenPixel(
    wrapEmailLinksWithTracking(htmlWithPaymentLink, { baseUrl, email, step, companyId }),
    { baseUrl, email, step, companyId },
  );

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resendKey}`,
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [email],
      subject: template.subject,
      html: trackedHtml,
    }),
  });

  if (!response.ok) {
    logger.warn({ email, step, status: response.status }, "Sequence email send failed");
    return false;
  }

  if (companyId) {
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "email-sequence",
      action: `email.sequence.${step}.sent`,
      entityType: "company",
      entityId: companyId,
      details: {
        status: "success",
        email,
        step,
        subject: template.subject,
        tracked: true,
      },
    });
  }

  return true;
}

let sequenceRunning = false;

export interface EmailSequenceCycleResult {
  status: "success" | "failed";
  sent: number;
  attempted: number;
  companyIds: string[];
  error?: string;
}

export async function runEmailSequenceCycle(
  db: Db,
  options: { companyId?: string } = {},
): Promise<EmailSequenceCycleResult> {
  if (sequenceRunning) {
    return {
      status: "success",
      sent: 0,
      attempted: 0,
      companyIds: options.companyId ? [options.companyId] : [],
    };
  }
  sequenceRunning = true;
  const cycleStartedAt = Date.now();

  try {
    const now = new Date();
    const baseUrl = (
      process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ?? "http://localhost:3100"
    ).trim();

    const signups = options.companyId
      ? await db
        .select()
        .from(waitlistSignups)
        .where(eq(waitlistSignups.companyId, options.companyId))
        .orderBy(desc(waitlistSignups.createdAt))
        .limit(100)
        .then((rows) => rows.filter((row) => row.monetizationSent))
      : await db
        .select()
        .from(waitlistSignups)
        .where(eq(waitlistSignups.monetizationSent, true))
        .orderBy(desc(waitlistSignups.createdAt))
        .limit(100);

    let sent = 0;
    let attempted = 0;
    const summaryByCompany = new Map<string, { sent: number; attempted: number }>();
    const bumpCompanySummary = (companyId: string, attemptedDelta: number, sentDelta: number) => {
      const current = summaryByCompany.get(companyId) ?? { sent: 0, attempted: 0 };
      current.attempted += attemptedDelta;
      current.sent += sentDelta;
      summaryByCompany.set(companyId, current);
    };

    const companyIds = new Set<string>();
    for (const signup of signups) {
      if (signup.companyId) companyIds.add(signup.companyId);
    }

    for (const companyId of companyIds) {
      await setCycleState(db, companyId, "email_sequence", {
        status: "running",
        stage: "planning",
        currentAction: "scan_candidates",
        lastError: null,
        lastRunStartedAt: new Date(cycleStartedAt),
        details: {
          queueSize: signups.length,
        },
      }).catch(() => undefined);

      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "email-sequence",
        action: "email.execution.plan",
        entityType: "company",
        entityId: companyId,
        details: {
          status: "pending",
          queueSize: signups.filter((signup) => signup.companyId === companyId).length,
        },
      }).catch(() => undefined);
    }

    const controlsByCompany = new Map<string, Awaited<ReturnType<typeof getSystemControls>> | null>();

    const loadControls = async (companyId: string | null): Promise<Awaited<ReturnType<typeof getSystemControls>> | null> => {
      if (!companyId) return null;
      if (controlsByCompany.has(companyId)) {
        return controlsByCompany.get(companyId) ?? null;
      }
      const controls = await getSystemControls(db, companyId).catch(() => null);
      controlsByCompany.set(companyId, controls);
      return controls;
    };

    for (const signup of signups) {
      const controls = await loadControls(signup.companyId);
      if (controls && (!controls.trafficEnabled || controls.autonomyLevel === "manual")) {
        continue;
      }

      const metadata = (signup.metadata ?? {}) as Record<string, unknown>;
      const sequenceStep = Math.max(0, Number(metadata.emailSequenceStep ?? 0));
      const lastEmailAt = metadata.lastSequenceEmailAt
        ? new Date(String(metadata.lastSequenceEmailAt))
        : signup.monetizationSentAt ?? signup.createdAt;

      if (!lastEmailAt) continue;
      if (sequenceStep >= SEQUENCE_ORDER.length) continue;

      const elapsed = now.getTime() - lastEmailAt.getTime();

      const requiredDelay = sequenceStep === 0 ? getInitialDelayMs(controls) : getStepDelayMs(controls);
      if (elapsed < requiredDelay) continue;

      const nextStep = SEQUENCE_ORDER[sequenceStep] ?? null;

      if (!nextStep) continue;

      const paymentLink = `${baseUrl}/api/waitlist/offer-click?email=${encodeURIComponent(signup.email)}&tier=entry${signup.companyId ? `&companyId=${encodeURIComponent(signup.companyId)}` : ""}`;

      attempted += 1;
      const success = await sendSequenceEmail(
        db,
        signup.email,
        signup.name ?? "",
        nextStep,
        signup.companyId,
        paymentLink,
      );

      if (signup.companyId) {
        bumpCompanySummary(signup.companyId, 1, success ? 1 : 0);
      }

      if (success) {
        const newStep = sequenceStep + 1;
        const completed = newStep >= SEQUENCE_ORDER.length;
        await db
          .update(waitlistSignups)
          .set({
            metadata: {
              ...(typeof signup.metadata === "object" && signup.metadata ? signup.metadata : {}),
              emailSequenceStep: newStep,
              lastSequenceEmailAt: now.toISOString(),
              emailSequenceState: completed ? "completed" : "active",
              emailSequenceLastStep: nextStep,
            } as Record<string, unknown>,
          })
          .where(eq(waitlistSignups.id, signup.id));
        sent++;
      }
    }

    const hardFailure = attempted > 0 && sent === 0;
    const hardFailureReason = "email credentials missing or send failed";

    for (const companyId of companyIds) {
      const summary = summaryByCompany.get(companyId) ?? { sent: 0, attempted: 0 };
      const companyFailed = hardFailure && summary.attempted > 0 && summary.sent === 0;
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "email-sequence",
        action: "email.execution.result",
        entityType: "company",
        entityId: companyId,
        details: {
          status: companyFailed ? "failed" : "success",
          sent: summary.sent,
          attempted: summary.attempted,
          reason: companyFailed ? hardFailureReason : null,
          queueSize: signups.filter((signup) => signup.companyId === companyId).length,
        },
      }).catch(() => undefined);

      await setCycleState(db, companyId, "email_sequence", {
        status: companyFailed ? "failed" : "completed",
        stage: "idle",
        currentAction: null,
        lastError: companyFailed ? hardFailureReason : null,
        lastRunCompletedAt: new Date(),
        lastRunDurationMs: Date.now() - cycleStartedAt,
        details: {
          sent: summary.sent,
          attempted: summary.attempted,
        },
      }).catch(() => undefined);
    }

    if (sent > 0) {
      logger.info({ sent }, "Email sequence cycle: sent follow-up emails");
    }

    eventBus.publish("email.sequence.cycle.completed", { sent, timestamp: now.toISOString() });
    if (hardFailure) {
      return {
        status: "failed",
        sent,
        attempted,
        companyIds: Array.from(companyIds),
        error: hardFailureReason,
      };
    }

    return {
      status: "success",
      sent,
      attempted,
      companyIds: Array.from(companyIds),
    };
  } catch (err) {
    logger.error({ err }, "Email sequence cycle failed");

    const companyIds = options.companyId
      ? [options.companyId]
      : await db
        .select({ companyId: waitlistSignups.companyId })
        .from(waitlistSignups)
        .where(eq(waitlistSignups.monetizationSent, true))
        .limit(100)
        .then((rows) => rows
          .map((row) => row.companyId)
          .filter((companyId): companyId is string => typeof companyId === "string"));

    const message = err instanceof Error ? err.message : String(err);
    for (const companyId of new Set(companyIds)) {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "email-sequence",
        action: "email.execution.result",
        entityType: "company",
        entityId: companyId,
        details: {
          status: "failed",
          error: message,
        },
      }).catch(() => undefined);
      await setCycleState(db, companyId, "email_sequence", {
        status: "failed",
        stage: "idle",
        currentAction: null,
        lastError: message,
        lastRunCompletedAt: new Date(),
        lastRunDurationMs: Date.now() - cycleStartedAt,
      }).catch(() => undefined);
    }

    return {
      status: "failed",
      sent: 0,
      attempted: 0,
      companyIds: Array.from(new Set(companyIds)),
      error: message,
    };
  } finally {
    sequenceRunning = false;
  }
}

let sequenceInterval: ReturnType<typeof setInterval> | null = null;

export function startEmailSequenceScheduler(db: Db, intervalMs = 60 * 60_000): () => void {
  logger.info({ intervalMs }, "Starting email sequence scheduler");

  setTimeout(() => void runEmailSequenceCycle(db), 5 * 60_000);

  sequenceInterval = setInterval(() => {
    void runEmailSequenceCycle(db);
  }, intervalMs);

  return () => {
    if (sequenceInterval) {
      clearInterval(sequenceInterval);
      sequenceInterval = null;
    }
  };
}
