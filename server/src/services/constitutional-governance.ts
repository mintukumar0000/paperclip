import { eq, and, desc } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  governanceRules,
  institutionalKnowledge,
  organizationalPlaybooks,
} from "@paperclipai/db";

// ---------------------------------------------------------------------------
// Governance Rules Service
// ---------------------------------------------------------------------------

export function governanceRuleService(db: Db) {
  return {
    list: (companyId: string) =>
      db
        .select()
        .from(governanceRules)
        .where(eq(governanceRules.companyId, companyId))
        .orderBy(desc(governanceRules.createdAt)),

    getById: (id: string) =>
      db
        .select()
        .from(governanceRules)
        .where(eq(governanceRules.id, id))
        .then((rows) => rows[0] ?? null),

    create: (
      companyId: string,
      data: Omit<typeof governanceRules.$inferInsert, "companyId">,
    ) =>
      db
        .insert(governanceRules)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    update: (id: string, data: Partial<typeof governanceRules.$inferInsert>) =>
      db
        .update(governanceRules)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(governanceRules.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    remove: (id: string) =>
      db
        .delete(governanceRules)
        .where(eq(governanceRules.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    listActive: (companyId: string) =>
      db
        .select()
        .from(governanceRules)
        .where(
          and(
            eq(governanceRules.companyId, companyId),
            eq(governanceRules.active, true),
          ),
        )
        .orderBy(desc(governanceRules.createdAt)),
  };
}

// ---------------------------------------------------------------------------
// Institutional Knowledge Service
// ---------------------------------------------------------------------------

export function institutionalKnowledgeService(db: Db) {
  return {
    list: (companyId: string) =>
      db
        .select()
        .from(institutionalKnowledge)
        .where(eq(institutionalKnowledge.companyId, companyId))
        .orderBy(desc(institutionalKnowledge.createdAt)),

    getById: (id: string) =>
      db
        .select()
        .from(institutionalKnowledge)
        .where(eq(institutionalKnowledge.id, id))
        .then((rows) => rows[0] ?? null),

    create: (
      companyId: string,
      data: Omit<typeof institutionalKnowledge.$inferInsert, "companyId">,
    ) =>
      db
        .insert(institutionalKnowledge)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    approve: (id: string, approvedBy: string) =>
      db
        .update(institutionalKnowledge)
        .set({
          status: "approved",
          approvedBy,
          approvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(institutionalKnowledge.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    archive: (id: string) =>
      db
        .update(institutionalKnowledge)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(institutionalKnowledge.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    remove: (id: string) =>
      db
        .delete(institutionalKnowledge)
        .where(eq(institutionalKnowledge.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}

// ---------------------------------------------------------------------------
// Organizational Playbooks Service
// ---------------------------------------------------------------------------

export function organizationalPlaybookService(db: Db) {
  return {
    list: (companyId: string) =>
      db
        .select()
        .from(organizationalPlaybooks)
        .where(eq(organizationalPlaybooks.companyId, companyId))
        .orderBy(desc(organizationalPlaybooks.createdAt)),

    getById: (id: string) =>
      db
        .select()
        .from(organizationalPlaybooks)
        .where(eq(organizationalPlaybooks.id, id))
        .then((rows) => rows[0] ?? null),

    create: (
      companyId: string,
      data: Omit<typeof organizationalPlaybooks.$inferInsert, "companyId">,
    ) =>
      db
        .insert(organizationalPlaybooks)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    update: (
      id: string,
      data: Partial<typeof organizationalPlaybooks.$inferInsert>,
    ) =>
      db
        .update(organizationalPlaybooks)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(organizationalPlaybooks.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    apply: (id: string) =>
      db
        .update(organizationalPlaybooks)
        .set({
          timesApplied: 1, // will use sql increment in production
          updatedAt: new Date(),
        })
        .where(eq(organizationalPlaybooks.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    remove: (id: string) =>
      db
        .delete(organizationalPlaybooks)
        .where(eq(organizationalPlaybooks.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
