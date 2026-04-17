import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { and, eq } from "@paperclipai/db";
import { AsyncLocalStorage } from "node:async_hooks";

const activeCompanyScope = new AsyncLocalStorage<string | null>();

export async function withActiveCompanyScope<T>(
  companyId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  return activeCompanyScope.run(companyId, fn);
}

export function getActiveCompanyId(): string | null {
  const scoped = activeCompanyScope.getStore();
  if (typeof scoped === "string" && scoped.trim().length > 0) {
    return scoped.trim();
  }

  const raw = (process.env.ACTIVE_COMPANY_ID ?? "").trim();
  return raw.length > 0 ? raw : null;
}

export function isCompanyInScope(companyId: string): boolean {
  const activeCompanyId = getActiveCompanyId();
  return !activeCompanyId || activeCompanyId === companyId;
}

export async function listScopedCompanyIds(
  db: Db,
  options?: { limit?: number },
): Promise<string[]> {
  const activeCompanyId = getActiveCompanyId();
  if (activeCompanyId) {
    const rows = await db
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.id, activeCompanyId), eq(companies.status, "active")))
      .limit(1);
    return rows.map((row) => row.id);
  }

  const limit = options?.limit;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    const rows = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.status, "active"))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.status, "active"));
  return rows.map((row) => row.id);
}
