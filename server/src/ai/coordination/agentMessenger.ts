// ---------------------------------------------------------------------------
// Agent Messenger — inter-agent communication via DB persistence + events
//
// Durability guarantees:
//   1. All messages are persisted to agentMessages DB table (primary store)
//   2. Event broadcast is fire-and-forget (observers may miss events)
//   3. Failed sends are retried up to MAX_RETRIES before giving up
//   4. Dead-letter messages are logged for recovery
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { agentMessages, agents } from "@paperclipai/db";
import { eq, and, desc, sql } from "@paperclipai/db";
import { publishEvent } from "../../events/eventPublisher.js";
import pino from "pino";

const logger = pino({ name: "agent-messenger" });

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 200;

export interface AgentMessage {
  id: string;
  companyId: string;
  fromAgentId: string;
  toAgentId: string;
  message: string;
  messageType: string;
  status: string;
  createdAt: Date;
}

export type MessageType =
  | "task_assignment"      // Manager → Agent: here's your task
  | "task_result"          // Agent → Manager: here's the result
  | "status_update"        // Agent → Manager: progress update
  | "collaboration_request"// Agent → Agent: need help
  | "approval_request"     // Agent → Approver: please approve this
  | "approval_response"    // Approver → Agent: approved/rejected
  | "information"          // General info sharing
  | "escalation";          // Agent → Manager: escalating issue

export interface SendMessageRequest {
  companyId: string;
  fromAgentId: string;
  toAgentId: string;
  message: string;
  messageType: MessageType;
  metadata?: Record<string, unknown>;
}

/**
 * Send a message between agents with DB persistence and event broadcast.
 * Retries on transient DB failures up to MAX_RETRIES.
 */
export async function sendAgentMessage(
  db: Db,
  request: SendMessageRequest,
): Promise<AgentMessage> {
  const { companyId, fromAgentId, toAgentId, message, messageType } = request;

  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Persist the message (primary durability layer)
      const [row] = await db
        .insert(agentMessages)
        .values({
          companyId,
          fromAgentId,
          toAgentId,
          message: `[${messageType}] ${message}`,
          status: "sent",
        })
        .returning();

      // Broadcast via event bus (fire-and-forget for observers)
      try {
        await publishEvent("message.sent", {
          messageId: row.id,
          companyId,
          fromAgentId,
          toAgentId,
          messageType,
          preview: message.slice(0, 200),
        });
      } catch (eventErr) {
        // Event broadcast failure is non-fatal — message is already persisted
        logger.warn(
          { messageId: row.id, err: eventErr },
          "Event broadcast failed (message persisted to DB)",
        );
      }

      logger.info(
        { messageId: row.id, from: fromAgentId, to: toAgentId, type: messageType },
        "Agent message sent",
      );

      return {
        id: row.id,
        companyId: row.companyId,
        fromAgentId: row.fromAgentId,
        toAgentId: row.toAgentId,
        message: row.message,
        messageType,
        status: row.status,
        createdAt: row.createdAt,
      };
    } catch (err) {
      lastErr = err;
      logger.warn(
        { attempt: attempt + 1, from: fromAgentId, to: toAgentId, err },
        "Message send failed, retrying",
      );
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
      }
    }
  }

  // Dead-letter log for recovery
  logger.error(
    { from: fromAgentId, to: toAgentId, messageType, companyId, message: message.slice(0, 500) },
    "Message send failed after max retries (dead-letter)",
  );
  throw lastErr;
}

/**
 * Mark a message as read/acted-on.
 */
export async function markMessageActedOn(
  db: Db,
  messageId: string,
): Promise<void> {
  await db
    .update(agentMessages)
    .set({ status: "acted_on" })
    .where(eq(agentMessages.id, messageId));
}

/**
 * Get unread messages for an agent.
 */
export async function getUnreadMessages(
  db: Db,
  agentId: string,
  companyId: string,
): Promise<AgentMessage[]> {
  const rows = await db
    .select()
    .from(agentMessages)
    .where(
      and(
        eq(agentMessages.toAgentId, agentId),
        eq(agentMessages.companyId, companyId),
        eq(agentMessages.status, "sent"),
      ),
    )
    .orderBy(desc(agentMessages.createdAt));

  return rows.map((r) => ({
    id: r.id,
    companyId: r.companyId,
    fromAgentId: r.fromAgentId,
    toAgentId: r.toAgentId,
    message: r.message,
    messageType: extractMessageType(r.message),
    status: r.status,
    createdAt: r.createdAt,
  }));
}

/**
 * Get recent messages between two agents.
 */
export async function getConversation(
  db: Db,
  companyId: string,
  agentA: string,
  agentB: string,
  limit = 20,
): Promise<AgentMessage[]> {
  // Get messages in both directions
  const rows = await db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.companyId, companyId))
    .orderBy(desc(agentMessages.createdAt))
    .limit(limit * 2); // over-fetch, filter in memory

  const filtered = rows.filter(
    (r) =>
      (r.fromAgentId === agentA && r.toAgentId === agentB) ||
      (r.fromAgentId === agentB && r.toAgentId === agentA),
  ).slice(0, limit);

  return filtered.map((r) => ({
    id: r.id,
    companyId: r.companyId,
    fromAgentId: r.fromAgentId,
    toAgentId: r.toAgentId,
    message: r.message,
    messageType: extractMessageType(r.message),
    status: r.status,
    createdAt: r.createdAt,
  }));
}

/** Extract message type from the prefixed message string */
function extractMessageType(message: string): string {
  const match = message.match(/^\[(\w+)\]/);
  return match ? match[1] : "information";
}

/**
 * Broadcast a message to all active agents in a company.
 */
export async function broadcastToCompany(
  db: Db,
  companyId: string,
  fromAgentId: string,
  message: string,
  messageType: MessageType,
): Promise<AgentMessage[]> {
  const activeAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agents.status, "active"),
      ),
    );

  const messages: AgentMessage[] = [];
  for (const agent of activeAgents) {
    if (agent.id === fromAgentId) continue;
    const msg = await sendAgentMessage(db, {
      companyId,
      fromAgentId,
      toAgentId: agent.id,
      message,
      messageType,
    });
    messages.push(msg);
  }

  return messages;
}

/**
 * Get total message count for an agent (for workload/activity metrics).
 */
export async function getMessageCount(
  db: Db,
  agentId: string,
  companyId: string,
  status?: string,
): Promise<number> {
  const conditions = [
    eq(agentMessages.toAgentId, agentId),
    eq(agentMessages.companyId, companyId),
  ];
  if (status) {
    conditions.push(eq(agentMessages.status, status));
  }
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentMessages)
    .where(and(...conditions));
  return result?.count ?? 0;
}
