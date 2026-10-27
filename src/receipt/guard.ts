import { and, desc, eq } from "drizzle-orm";
import * as s from "../../db/schema";
import type { LedgerTransaction } from "../ledger/journal";
import { CLAIM_ID, draftHash } from "./terms";
export async function requireReceiptConfirmation(tx: LedgerTransaction, claim: typeof s.claims.$inferSelect) {
  if (!CLAIM_ID.test(claim.id)) return;
  const [review] = await tx.select().from(s.receiptReviews).where(and(eq(s.receiptReviews.claimId, claim.id), eq(s.receiptReviews.claimVersion, claim.version))).orderBy(desc(s.receiptReviews.revision)).limit(1);
  const [confirmation] = review ? await tx.select().from(s.receiptConfirmations).where(eq(s.receiptConfirmations.reviewId, review.id)) : [];
  const lines = await tx.select().from(s.claimLines).where(and(eq(s.claimLines.claimId, claim.id), eq(s.claimLines.claimVersion, claim.version)));
  if (!review || !confirmation || confirmation.confirmedBy !== claim.claimantId || review.draftHash !== draftHash(claim, lines) ||
    confirmation.termsHash !== draftHash(claim, lines, true) || lines.some(line => line.category === "UNKNOWN")) throw new Error("Current receipt categories require human confirmation");
}
