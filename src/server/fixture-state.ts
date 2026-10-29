import { eq, inArray } from "drizzle-orm";
import * as s from "../../db/schema";
import type { LedgerTransaction } from "../ledger/journal";

// A narrow presentation distinction, never a reconciliation override. Only an untouched,
// internally consistent fixture may be described as waiting for opening journals.
export async function fixtureNotStarted(tx: LedgerTransaction, organizationId: string) {
  const organizations = await tx.select().from(s.organizations);
  if (organizations.length !== 1 || organizations[0]?.id !== organizationId || !organizations[0].isFixture || organizations[0].openingSourceType !== "fixture_opening_balance") return false;
  const funds = await tx.select().from(s.funds).where(eq(s.funds.organizationId, organizationId));
  if (!funds.length) return false;
  const ids = funds.map(row => row.id);
  const credits = await tx.select().from(s.fundCredits).where(inArray(s.fundCredits.fundId, ids));
  if (!credits.length || credits.some(row => !row.isOpening || row.sourceType !== "fixture_opening_balance" || row.amountCents <= 0n) || new Set(credits.map(row => row.sourceId)).size !== 1 || new Set(credits.map(row => row.effectiveOn)).size !== 1 || funds.some(fund => !credits.some(row => row.fundId === fund.id))) return false;
  const [entry] = await tx.select({ id: s.journalEntries.id }).from(s.journalEntries).limit(1);
  const [posting] = await tx.select({ id: s.journalPostings.id }).from(s.journalPostings).limit(1);
  const [debit] = await tx.select({ id: s.fundDebits.id }).from(s.fundDebits).where(inArray(s.fundDebits.fundId, ids)).limit(1);
  const [reservation] = await tx.select({ id: s.fundReservations.id }).from(s.fundReservations).where(inArray(s.fundReservations.fundId, ids)).limit(1);
  const [decision] = await tx.select({ id: s.allocationDecisions.id }).from(s.allocationDecisions).limit(1);
  const [attempt] = await tx.select({ id: s.disbursementAttempts.id }).from(s.disbursementAttempts).limit(1);
  const [donation] = await tx.select({ orderId: s.donationReceipts.orderId }).from(s.donationReceipts).limit(1);
  const [rejection] = await tx.select({ id: s.claimRejections.id }).from(s.claimRejections).limit(1);
  return !entry && !posting && !debit && !reservation && !decision && !attempt && !donation && !rejection;
}
