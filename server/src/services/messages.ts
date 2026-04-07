import type { Db } from "@paperclipai/db";
import { agentMessages } from "@paperclipai/db";
import { eq, and, desc } from "@paperclipai/db";
import pino from "pino";
import { publishEvent } from "../events/eventPublisher.js";

const logger = pino({ name: "message-service" });

export function messageService(db: Db) {
  return {
    /** Send a message from one agent to another */
    async sendMessage(companyId: string, fromAgentId: string, toAgentId: string, message: string) {
      const [row] = await db
        .insert(agentMessages)
        .values({
          companyId,
          fromAgentId,
          toAgentId,
          message,
          status: "sent",
        })
        .returning();

      await publishEvent("message.sent", {
        companyId,
        messageId: row.id,
        fromAgentId,
        toAgentId,
      });

      logger.info(
        { messageId: row.id, fromAgentId, toAgentId },
        "Message sent",
      );
      return row;
    },

    /** Get inbox for an agent (messages sent TO them) */
    async getInbox(companyId: string, agentId: string) {
      return db
        .select()
        .from(agentMessages)
        .where(
          and(
            eq(agentMessages.companyId, companyId),
            eq(agentMessages.toAgentId, agentId),
          ),
        )
        .orderBy(desc(agentMessages.createdAt));
    },

    /** Get outbox for an agent (messages sent BY them) */
    async getOutbox(companyId: string, agentId: string) {
      return db
        .select()
        .from(agentMessages)
        .where(
          and(
            eq(agentMessages.companyId, companyId),
            eq(agentMessages.fromAgentId, agentId),
          ),
        )
        .orderBy(desc(agentMessages.createdAt));
    },

    /** Get conversation between two agents */
    async getConversation(companyId: string, agentA: string, agentB: string) {
      const all = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.companyId, companyId))
        .orderBy(desc(agentMessages.createdAt));

      return all.filter(
        (m) =>
          (m.fromAgentId === agentA && m.toAgentId === agentB) ||
          (m.fromAgentId === agentB && m.toAgentId === agentA),
      );
    },

    /** Mark a message as read */
    async markRead(messageId: string) {
      const [updated] = await db
        .update(agentMessages)
        .set({ status: "read" })
        .where(eq(agentMessages.id, messageId))
        .returning();
      return updated;
    },

    /** List all messages in a company */
    async listAll(companyId: string) {
      return db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.companyId, companyId))
        .orderBy(desc(agentMessages.createdAt));
    },
  };
}
