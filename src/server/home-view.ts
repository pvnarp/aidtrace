import { inArray } from "drizzle-orm";
import { claimLines } from "../../db/schema";
import type { AppDatabase } from "./db";

/**
 * Read-only (IAC-403): the sum of each listed claim version's line amounts, in integer cents, keyed `${id}:${version}`.
 * The same claim_lines rows the claim page sums for its title. A claim with no lines has no entry, and the home page then shows no amount.
 */
export async function claimTotals(db: AppDatabase, claims: readonly { id: string; version: number }[]): Promise<Map<string, bigint>> {
  const totals = new Map<string, bigint>();
  if (claims.length === 0) return totals;
  const rows = await db.select().from(claimLines).where(inArray(claimLines.claimId, claims.map(claim => claim.id)));
  const wanted = new Set(claims.map(claim => `${claim.id}:${claim.version}`));
  for (const row of rows) {
    const key = `${row.claimId}:${row.claimVersion}`;
    if (wanted.has(key)) totals.set(key, (totals.get(key) ?? 0n) + row.amountCents);
  }
  return totals;
}
