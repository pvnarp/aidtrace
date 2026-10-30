import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "../server/db";
import * as s from "../../db/schema";

export type LedgerTransaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];
export type SourceType = typeof s.sourceType.enumValues[number];
export type AccountCode = "1010" | "2010" | "3100" | "3200" | "4100" | "5100" | "5200" | "5300" | "5400" | "5500" | "5900";
// SF-424A object class to expense account. 5200 was "hospitality" and is now "Other" (same code).
// "hospitality" stays as a legacy alias for preserved lines only; new code never writes it.
export const ACCOUNT_FOR_BUDGET_LINE: Record<string, AccountCode> = {
  supplies: "5100", other: "5200", hospitality: "5200", travel: "5300", equipment: "5400", contractual: "5500",
};
export interface Posting { accountCode: AccountCode; subKey?: string | null; debitCents: bigint; creditCents: bigint; }
export interface Journal { sourceType: SourceType; sourceId: string; purpose: string; effectiveOn: string; postings: readonly Posting[]; }
const signature = (postings: readonly Posting[]) => postings.map(row => JSON.stringify([row.accountCode, row.subKey ?? null, row.debitCents.toString(), row.creditCents.toString()])).sort().join("\n");
export async function postJournal(tx: LedgerTransaction, entry: Journal) {
  let debit = 0n; let credit = 0n;
  if (entry.postings.length < 2) throw new Error("Journal needs at least two postings");
  for (const row of entry.postings) {
    if (typeof row.debitCents !== "bigint" || typeof row.creditCents !== "bigint" || !((row.debitCents > 0n && row.creditCents === 0n) || (row.creditCents > 0n && row.debitCents === 0n))) throw new Error("Each posting requires exactly one positive bigint side");
    debit += row.debitCents; credit += row.creditCents;
  }
  if (debit !== credit) throw new Error("Journal does not balance");
  const key = and(eq(s.journalEntries.sourceType, entry.sourceType), eq(s.journalEntries.sourceId, entry.sourceId), eq(s.journalEntries.purpose, entry.purpose));
  const [created] = await tx.insert(s.journalEntries).values({ sourceType: entry.sourceType, sourceId: entry.sourceId, purpose: entry.purpose, effectiveOn: entry.effectiveOn }).onConflictDoNothing().returning();
  if (!created) {
    const [existing] = await tx.select().from(s.journalEntries).where(key);
    if (!existing) throw new Error("Journal source conflict");
    const rows = await tx.select().from(s.journalPostings).where(eq(s.journalPostings.entryId, existing.id));
    if (existing.effectiveOn !== entry.effectiveOn || signature(rows as Posting[]) !== signature(entry.postings)) throw new Error("Journal replay differs from immutable source");
    return existing.id;
  }
  await tx.insert(s.journalPostings).values(entry.postings.map(row => ({ ...row, subKey: row.subKey ?? null, entryId: created.id })));
  return created.id;
}
