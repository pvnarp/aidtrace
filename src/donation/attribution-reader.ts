import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import type { LedgerTransaction } from "../ledger/journal";
import { attributeGifts, type AttributionResult } from "./attribution";

// IAC-379 step 2: the read-only loader for GIFT_ATTRIBUTION_V1 (docs/plans/DONATION_LOOP_SCOPE.md section 5).
// It issues SELECT statements only. It writes no row, posts no journal entry and changes no allocation, reservation,
// freeze, confirmation or approval. The timing basis for a gift is donation_receipts.recorded_at, because no exact
// PayPal capture time is stored (effective_on is only a date). The basis for a claim is allocation_decisions.recognized_at.
export async function readGiftAttribution(db: AppDatabase | LedgerTransaction, organizationId: string): Promise<AttributionResult> {
  const receipts = await db.select().from(s.donationReceipts).where(and(eq(s.donationReceipts.organizationId, organizationId), eq(s.donationReceipts.status, "COMPLETED")));
  const gifts = receipts.map(receipt => {
    if (!receipt.captureId || receipt.grossCents === null) throw new Error("A completed donation needs a capture ID and gross cents");
    return { captureId: receipt.captureId, fundId: receipt.fundId, grossCents: receipt.grossCents, recordedAt: receipt.recordedAt };
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
