import { and, desc, eq } from "drizzle-orm";
import * as s from "../../db/schema";
import type { LedgerTransaction } from "../ledger/journal";
import { CLAIM_ID, draftHash } from "./terms";
import { PROHIBITED_TERMS_VERSION, screenReceiptText, unresolvedMatches, type ProhibitedMatch } from "./prohibited-screen";
// Compared field by field: jsonb returns object keys in its own order, so a string comparison would be wrong.
const sameMatches = (a: readonly ProhibitedMatch[], b: readonly ProhibitedMatch[]) => a.length === b.length && a.every((match, i) => match.category === b[i]!.category && match.term === b[i]!.term);
export async function requireReceiptConfirmation(tx: LedgerTransaction, claim: typeof s.claims.$inferSelect) {
  if (!CLAIM_ID.test(claim.id)) return;
  const [review] = await tx.select().from(s.receiptReviews).where(and(eq(s.receiptReviews.claimId, claim.id), eq(s.receiptReviews.claimVersion, claim.version))).orderBy(desc(s.receiptReviews.revision)).limit(1);
  const [confirmation] = review ? await tx.select().from(s.receiptConfirmations).where(eq(s.receiptConfirmations.reviewId, review.id)) : [];
  const lines = await tx.select().from(s.claimLines).where(and(eq(s.claimLines.claimId, claim.id), eq(s.claimLines.claimVersion, claim.version)));
  if (!review || !confirmation || confirmation.confirmedBy !== claim.claimantId || review.draftHash !== draftHash(claim, lines) ||
    confirmation.termsHash !== draftHash(claim, lines, true) || lines.some(line => line.category === "UNKNOWN")) throw new Error("Current receipt categories require human confirmation");
  // IAC-394: a receipt that names alcohol or gift cards needs a stored acknowledgement of exactly the current unresolved matches.
  // A preserved row with a null screen passes only when nothing is unresolved. A term list version change therefore forces a
  // new confirmation (through an edit) only for receipts the new list now flags.
  const unresolved = unresolvedMatches(screenReceiptText(review.source, lines.map(line => line.description)).matches, lines.map(line => line.category));
  const stored = confirmation.prohibitedScreen;
  if (unresolved.length && !(stored && stored.version === PROHIBITED_TERMS_VERSION && stored.acknowledged === true && sameMatches(stored.unresolved, unresolved))) throw new Error("Current receipt categories require human confirmation");
}
