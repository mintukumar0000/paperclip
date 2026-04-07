import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { eq } from "@paperclipai/db";

export function getActiveCompanyId(): string | null {
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
      .where(eq(companies.id, activeCompanyId))
      .limit(1);
    return rows.map((row) => row.id);
  }

  const limit = options?.limit;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    const rows = await db.select({ id: companies.id }).from(companies).limit(limit);
    return rows.map((row) => row.id);
  }

  const rows = await db.select({ id: companies.id }).from(companies);
  return rows.map((row) => row.id);
}
