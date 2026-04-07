import { companyFinance, eq, sql, type Db } from "@paperclipai/db";

export interface CompanyFinanceSnapshot {
  companyId: string;
  revenueCents: number;
  creditsCents: number;
  spentCents: number;
  updatedAt: Date;
}

function toSnapshot(row: {
  companyId: string;
  revenueCents: number;
  creditsCents: number;
  spentCents: number;
  updatedAt: Date;
}): CompanyFinanceSnapshot {
  return {
    companyId: row.companyId,
    revenueCents: Number(row.revenueCents ?? 0),
    creditsCents: Number(row.creditsCents ?? 0),
    spentCents: Number(row.spentCents ?? 0),
    updatedAt: row.updatedAt,
  };
}

async function ensureCompanyFinanceRow(db: Db, companyId: string): Promise<void> {
  await db
    .insert(companyFinance)
    .values({ companyId })
    .onConflictDoNothing();
}

export async function getCompanyFinanceSnapshot(
  db: Db,
  companyId: string,
): Promise<CompanyFinanceSnapshot> {
  await ensureCompanyFinanceRow(db, companyId);

  const row = await db
    .select({
      companyId: companyFinance.companyId,
      revenueCents: companyFinance.revenueCents,
      creditsCents: companyFinance.creditsCents,
      spentCents: companyFinance.spentCents,
      updatedAt: companyFinance.updatedAt,
    })
    .from(companyFinance)
    .where(eq(companyFinance.companyId, companyId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!row) {
    return {
      companyId,
      revenueCents: 0,
      creditsCents: 0,
      spentCents: 0,
      updatedAt: new Date(),
    };
  }

  return toSnapshot(row);
}

export async function creditCompanyFinanceForPayment(
  db: Db,
  input: { companyId: string; amountCents: number },
): Promise<CompanyFinanceSnapshot> {
  const amountCents = Math.max(0, Math.round(input.amountCents));
  if (amountCents <= 0) {
    return getCompanyFinanceSnapshot(db, input.companyId);
  }

  const row = await db
    .insert(companyFinance)
    .values({
      companyId: input.companyId,
      revenueCents: amountCents,
      creditsCents: amountCents,
      spentCents: 0,
    })
    .onConflictDoUpdate({
      target: companyFinance.companyId,
      set: {
        revenueCents: sql`${companyFinance.revenueCents} + ${amountCents}`,
        creditsCents: sql`${companyFinance.creditsCents} + ${amountCents}`,
        updatedAt: new Date(),
      },
    })
    .returning({
      companyId: companyFinance.companyId,
      revenueCents: companyFinance.revenueCents,
      creditsCents: companyFinance.creditsCents,
      spentCents: companyFinance.spentCents,
      updatedAt: companyFinance.updatedAt,
    })
    .then((rows) => rows[0] ?? null);

  if (!row) return getCompanyFinanceSnapshot(db, input.companyId);
  return toSnapshot(row);
}

export async function debitCompanyFinanceForUsage(
  db: Db,
  input: { companyId: string; costCents: number },
): Promise<CompanyFinanceSnapshot> {
  const costCents = Math.max(0, Math.round(input.costCents));
  if (costCents <= 0) {
    return getCompanyFinanceSnapshot(db, input.companyId);
  }

  const row = await db
    .insert(companyFinance)
    .values({
      companyId: input.companyId,
      revenueCents: 0,
      creditsCents: 0,
      spentCents: costCents,
    })
    .onConflictDoUpdate({
      target: companyFinance.companyId,
      set: {
        spentCents: sql`${companyFinance.spentCents} + ${costCents}`,
        creditsCents: sql`GREATEST(0, ${companyFinance.creditsCents} - ${costCents})`,
        updatedAt: new Date(),
      },
    })
    .returning({
      companyId: companyFinance.companyId,
      revenueCents: companyFinance.revenueCents,
      creditsCents: companyFinance.creditsCents,
      spentCents: companyFinance.spentCents,
      updatedAt: companyFinance.updatedAt,
    })
    .then((rows) => rows[0] ?? null);

  if (!row) return getCompanyFinanceSnapshot(db, input.companyId);
  return toSnapshot(row);
}
