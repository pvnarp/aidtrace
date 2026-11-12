import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import type { LedgerTransaction } from "../ledger/journal";
import { attributeGifts, type AttributionResult } from "./attribution";

// IAC-379 step 2: the read-only loader for GIFT_ATTRIBUTION_V1.
// It issues SELECT statements only. It writes no row, posts no journal entry and changes no allocation, reservation,
// freeze, confirmation or approval. No exact PayPal capture time is stored (effective_on is only a date), so the timing basis
// for a gift is the time AidTrace recorded the completed capture: the recorded_at of
// the gift's paypal_capture fund credit, which src/ledger/donation.ts inserts only in the transaction that completes the receipt.
// donation_receipts.recorded_at is not enough on its own: a receipt first stored as PENDING keeps its PENDING insert time when
// it later completes (the migration 0006 guard refuses a change), so it could date a gift before the money reached the fund.
// The later of the two times is used. attributeGifts uses the oldest open layer first, so a later time for one gift can move
// gifts in the same fund between claims: the gift first stored PENDING, and other gifts whose layers it used to precede. An
// approved note for any gift in that fund may then disagree with a later read. A completed receipt with no
// credit row (only rows inserted outside recordDesignatedDonation, as some tests do) falls back to the receipt time.
// The basis for a claim is allocation_decisions.recognized_at.
export async function readGiftAttribution(db: AppDatabase | LedgerTransaction, organizationId: string): Promise<AttributionResult> {
  // credit_source_fund_unique (source_type, source_id, fund_id) allows at most one matching credit, so the join adds no row.
  const receipts = await db.select({ captureId: s.donationReceipts.captureId, fundId: s.donationReceipts.fundId, grossCents: s.donationReceipts.grossCents,
    receiptRecordedAt: s.donationReceipts.recordedAt, creditRecordedAt: s.fundCredits.recordedAt }).from(s.donationReceipts)
    .leftJoin(s.fundCredits, and(eq(s.fundCredits.sourceType, "paypal_capture"), eq(s.fundCredits.sourceId, s.donationReceipts.captureId), eq(s.fundCredits.fundId, s.donationReceipts.fundId), eq(s.fundCredits.isOpening, false)))
    .where(and(eq(s.donationReceipts.organizationId, organizationId), eq(s.donationReceipts.status, "COMPLETED")));
  const gifts = receipts.map(receipt => {
    if (!receipt.captureId || receipt.grossCents === null) throw new Error("A completed donation needs a capture ID and gross cents");
    const credit = receipt.creditRecordedAt;
    const recordedAt = credit && credit.getTime() > receipt.receiptRecordedAt.getTime() ? credit : receipt.receiptRecordedAt;
    return { captureId: receipt.captureId, fundId: receipt.fundId, grossCents: receipt.grossCents, recordedAt };
  });
  // Recognized and not invalidated. A claim with a rejection row for its version attributes nothing, even if a row slipped through.
  const decisions = await db.select().from(s.allocationDecisions).where(and(eq(s.allocationDecisions.organizationId, organizationId), isNotNull(s.allocationDecisions.recognizedAt), isNull(s.allocationDecisions.invalidatedAt)));
  const rejections = decisions.length ? await db.select().from(s.claimRejections).where(inArray(s.claimRejections.claimId, [...new Set(decisions.map(decision => decision.claimId))])) : [];
  const rejected = new Set(rejections.map(row => JSON.stringify([row.claimId, row.claimVersion])));
  const accepted = decisions.filter(decision => !rejected.has(JSON.stringify([decision.claimId, decision.claimVersion])));
  const edges = accepted.length ? await db.select().from(s.allocationEdges).where(inArray(s.allocationEdges.decisionId, accepted.map(decision => decision.id))) : [];
  const claims = accepted.map(decision => ({
    claimId: decision.claimId, claimVersion: decision.claimVersion, decisionHash: decision.decisionHash, recognizedAt: decision.recognizedAt!,
    edges: edges.filter(edge => edge.decisionId === decision.id).map(edge => ({ lineId: edge.lineId, fundId: edge.fundId, amountCents: edge.amountCents })),
  }));
  return attributeGifts({ gifts, claims });
}
