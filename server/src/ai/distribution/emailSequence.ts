import type { Db } from "@paperclipai/db";
import { waitlistSignups, activityLog, aiLearningRecords } from "@paperclipai/db";
import { and, eq, desc, sql, isNull, lt } from "@paperclipai/db";
import pino from "pino";
import { routeLLM } from "../llmRouter.js";
import { validateOutput } from "../quality/executionQualityGate.js";
import { eventBus } from "../../events/eventBus.js";

const logger = pino({ name: "email-sequence" });

type SequenceStep = "value" | "case_study" | "urgency";

interface EmailTemplate {
  step: SequenceStep;
  subject: string;
  html: string;
}

const SEQUENCE_DELAYS: Record<SequenceStep, number> = {
  value: 0,
  case_study: 24 * 60 * 60_000,
  urgency: 48 * 60 * 60_000,
};

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
  const priceCents = tier === "premium" ? 4900 : tier === "upsell" ? 1500 : 500;
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

    urgency: `Write an URGENCY/LAST CHANCE email. Subject line + HTML body.
Goal: Create legitimate scarcity and drive purchase.
Include: Price going up tomorrow, limited spots, or bonus expiring.
Recipient: ${recipientName}, who received 2 previous emails
Product: Cold email template pack ($${priceUsd})
Tone: Direct, urgent but not spammy, genuine deadline`,
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

  return {
    step,
    subject: `${safeName}, last chance: $${priceUsd} pricing ends tonight`,
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
<p>Hey ${safeName},</p>
<p>Just a heads up — the $${priceUsd} founder price for our cold email template pack is going away tonight at midnight.</p>
<p>After that, it goes to $19.</p>
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
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "email-sequence",
      agentId: null,
      runId: null,
      action: `email.sequence.${step}.sent`,
      entityType: "company",
      entityId: companyId,
      details: { email, step, subject: template.subject, tracked: true },
    });
  }

  return true;
}

let sequenceRunning = false;

export async function runEmailSequenceCycle(db: Db): Promise<void> {
  if (sequenceRunning) return;
  sequenceRunning = true;

  try {
    const now = new Date();
    const baseUrl = (
      process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ?? "http://localhost:3100"
    ).trim();

    const signups = await db
      .select()
      .from(waitlistSignups)
      .where(eq(waitlistSignups.monetizationSent, true))
      .orderBy(desc(waitlistSignups.createdAt))
      .limit(100);

    let sent = 0;

    for (const signup of signups) {
      const metadata = (signup.metadata ?? {}) as Record<string, unknown>;
      const sequenceStep = Number(metadata.emailSequenceStep ?? 0);
      const lastEmailAt = metadata.lastSequenceEmailAt
        ? new Date(String(metadata.lastSequenceEmailAt))
        : signup.monetizationSentAt ?? signup.createdAt;

      if (!lastEmailAt) continue;

      const elapsed = now.getTime() - lastEmailAt.getTime();

      let nextStep: SequenceStep | null = null;
      if (sequenceStep === 0 && elapsed >= SEQUENCE_DELAYS.case_study) {
        nextStep = "case_study";
      } else if (sequenceStep === 1 && elapsed >= SEQUENCE_DELAYS.urgency) {
        nextStep = "urgency";
      }

      if (!nextStep) continue;

      const paymentLink = `${baseUrl}/api/waitlist/offer-click?email=${encodeURIComponent(signup.email)}&tier=entry${signup.companyId ? `&companyId=${encodeURIComponent(signup.companyId)}` : ""}`;

      const success = await sendSequenceEmail(
        db,
        signup.email,
        signup.name ?? "",
        nextStep,
        signup.companyId,
        paymentLink,
      );

      if (success) {
        const newStep = nextStep === "case_study" ? 1 : 2;
        await db
          .update(waitlistSignups)
          .set({
            metadata: {
              ...(typeof signup.metadata === "object" && signup.metadata ? signup.metadata : {}),
              emailSequenceStep: newStep,
              lastSequenceEmailAt: now.toISOString(),
            } as Record<string, unknown>,
          })
          .where(eq(waitlistSignups.id, signup.id));
        sent++;
      }
    }

    if (sent > 0) {
      logger.info({ sent }, "Email sequence cycle: sent follow-up emails");
    }

    eventBus.publish("email.sequence.cycle.completed", { sent, timestamp: now.toISOString() });
  } catch (err) {
    logger.error({ err }, "Email sequence cycle failed");
  } finally {
    sequenceRunning = false;
  }
}

let sequenceInterval: ReturnType<typeof setInterval> | null = null;

export function startEmailSequenceScheduler(db: Db, intervalMs = 60 * 60_000): () => void {
  const enabled = (process.env.EMAIL_SEQUENCE_ENABLED ?? "true").trim().toLowerCase();
  if (enabled === "false" || enabled === "0") {
    logger.info("Email sequence scheduler disabled");
    return () => {};
  }

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
