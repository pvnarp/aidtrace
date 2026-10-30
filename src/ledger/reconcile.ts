import { eq, inArray } from "drizzle-orm";
import * as s from "../../db/schema";
import type { LedgerTransaction } from "./journal";

export async function reconcile(tx: LedgerTransaction, organizationId: string) {
  const funds = await tx.select().from(s.funds).where(eq(s.funds.organizationId, organizationId));
  if (!funds.length) throw new Error("Funds required for reconciliation");
  const credits = await tx.select().from(s.fundCredits).where(inArray(s.fundCredits.fundId, funds.map(fund => fund.id)));
  const debits = await tx.select().from(s.fundDebits).where(inArray(s.fundDebits.fundId, funds.map(fund => fund.id)));
  const reservations = await tx.select().from(s.fundReservations).where(inArray(s.fundReservations.fundId, funds.map(fund => fund.id)));
  // Gate A supports one organization. Journal entries have no organization key in v0.2.1.
  const organizations = await tx.select().from(s.organizations);
  if (organizations.length !== 1) throw new Error("Multi-organization journals are outside the Gate A model");
  const entries = await tx.select().from(s.journalEntries); const postings = await tx.select().from(s.journalPostings);
  const debitBalance = (account: string) => postings.filter(row => row.accountCode === account).reduce((sum, row) => sum + row.debitCents - row.creditCents, 0n);
  const fundBalances = funds.map(fund => {
    const bookCents = credits.filter(row => row.fundId === fund.id).reduce((sum, row) => sum + row.amountCents, 0n) - debits.filter(row => row.fundId === fund.id).reduce((sum, row) => sum + row.amountCents, 0n);
    const reservedCents = reservations.filter(row => row.fundId === fund.id && row.status === "ACTIVE").reduce((sum, row) => sum + row.amountCents, 0n);
    return { fundId: fund.id, fundClass: fund.fundClass, bookCents, reservedCents, availableCents: bookCents - reservedCents };
  });
  const restrictedCents = fundBalances.filter(row => row.fundClass === "RESTRICTED").reduce((sum, row) => sum + row.bookCents, 0n);
  const generalCents = fundBalances.filter(row => row.fundClass === "UNRESTRICTED").reduce((sum, row) => sum + row.bookCents, 0n);
  const restrictedGlCents = -debitBalance("3100") - debitBalance("4100");
  const generalGlCents = -debitBalance("3200") - debitBalance("5100") - debitBalance("5200") - debitBalance("5300") - debitBalance("5400") - debitBalance("5500") - debitBalance("5900");
  const fixtureIds = new Set(entries.filter(row => row.sourceType === "fixture_opening_balance").map(row => row.id));
  const fixtureCashCents = postings.filter(row => row.accountCode === "1010" && fixtureIds.has(row.entryId)).reduce((sum, row) => sum + row.debitCents - row.creditCents, 0n);
  return { matches: restrictedCents === restrictedGlCents && generalCents === generalGlCents,
    restrictedCents, restrictedGlCents, generalCents, generalGlCents, fundBalances,
    openPayableCents: -debitBalance("2010"), bookCashCents: debitBalance("1010"),
    fixtureCashCents, providerActivityCashDeltaCents: debitBalance("1010") - fixtureCashCents };
}
