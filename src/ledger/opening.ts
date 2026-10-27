import { and, eq, inArray } from "drizzle-orm";
import * as s from "../../db/schema";
import { postJournal, type LedgerTransaction, type Posting } from "./journal";

export async function ensureFixtureOpening(tx: LedgerTransaction, organizationId: string) {
  const [organization] = await tx.select().from(s.organizations).where(eq(s.organizations.id, organizationId));
  if (!organization || organization.openingSourceType !== "fixture_opening_balance") throw new Error("Fixture opening source required");
  const funds = await tx.select().from(s.funds).where(eq(s.funds.organizationId, organizationId));
  if (!funds.length) throw new Error("Fixture funds required");
  const credits = await tx.select().from(s.fundCredits).where(and(inArray(s.fundCredits.fundId, funds.map(fund => fund.id)), eq(s.fundCredits.isOpening, true)));
  if (!credits.length || credits.some(row => row.sourceType !== "fixture_opening_balance") || new Set(credits.map(row => row.sourceId)).size !== 1 || new Set(credits.map(row => row.effectiveOn)).size !== 1) throw new Error("One consistent fixture opening source required");
  const postings: Posting[] = [{ accountCode: "1010", debitCents: credits.reduce((sum, row) => sum + row.amountCents, 0n), creditCents: 0n }];
  for (const fund of funds) {
    const amount = credits.filter(row => row.fundId === fund.id).reduce((sum, row) => sum + row.amountCents, 0n);
    if (amount) postings.push({ accountCode: fund.fundClass === "RESTRICTED" ? "3100" : "3200", subKey: fund.fundClass === "RESTRICTED" ? fund.id : null, debitCents: 0n, creditCents: amount });
  }
  return postJournal(tx, { sourceType: "fixture_opening_balance", sourceId: credits[0]!.sourceId, purpose: "opening", effectiveOn: credits[0]!.effectiveOn, postings });
}
