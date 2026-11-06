import { and, asc, eq, isNull, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import type { LedgerTransaction } from "./journal";
import { serializable } from "./service";

// Historical PayPal event review (option A, November 5). A verified event for an earlier attempt, received after a retry, is recorded as a review row by webhooks.ts.
// The latest attempt and the claim are not touched. A review is open until an independent approver records the reconciliation. This file writes only the resolution
// row. It posts no journal entry, makes no provider call and sends nothing.
export const HISTORICAL_NOTE_MIN = 10;
export const HISTORICAL_NOTE_MAX = 1000;
type Reader = Pick<LedgerTransaction, "select">;

export async function openHistoricalReviews(tx: Reader, claimId: string) {
  return tx.select({ id: s.historicalEventReviews.id, claimVersion: s.historicalEventReviews.claimVersion, eventAttemptId: s.historicalEventReviews.eventAttemptId, eventAttemptNumber: s.disbursementAttempts.attemptNumber, recordedAt: s.historicalEventReviews.recordedAt })
    .from(s.historicalEventReviews)
    .innerJoin(s.disbursementAttempts, eq(s.disbursementAttempts.id, s.historicalEventReviews.eventAttemptId))
    .leftJoin(s.historicalEventReviewResolutions, eq(s.historicalEventReviewResolutions.reviewId, s.historicalEventReviews.id))
    .where(and(eq(s.historicalEventReviews.claimId, claimId), isNull(s.historicalEventReviewResolutions.id)))
    .orderBy(asc(s.historicalEventReviews.recordedAt), asc(s.historicalEventReviews.id));
}

export async function resolveHistoricalReview(db: AppDatabase, reviewId: string, actorId: string, note: string) {
  const trimmed = note.trim();
  if (trimmed.length < HISTORICAL_NOTE_MIN || trimmed.length > HISTORICAL_NOTE_MAX) throw new Error(`The reconciliation note needs ${HISTORICAL_NOTE_MIN} to ${HISTORICAL_NOTE_MAX} characters`);
  return serializable(db, async tx => {
    const [review] = await tx.select().from(s.historicalEventReviews).where(eq(s.historicalEventReviews.id, reviewId));
    if (!review) throw new Error("Historical event review not found");
    const [claim] = await tx.select().from(s.claims).where(and(eq(s.claims.id, review.claimId), eq(s.claims.version, review.claimVersion)));
    if (!claim) throw new Error("Historical event review claim missing");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${claim.organizationId})::bigint)`);
    const [resolved] = await tx.select({ id: s.historicalEventReviewResolutions.id }).from(s.historicalEventReviewResolutions).where(eq(s.historicalEventReviewResolutions.reviewId, review.id));
    if (resolved) throw new Error("Historical event review is already resolved");
    const [actor] = await tx.select({ id: s.users.id, role: s.users.role, organizationId: s.users.organizationId }).from(s.users).where(eq(s.users.id, actorId));
    if (!actor || actor.organizationId !== claim.organizationId || actor.role !== "APPROVER" || actor.id === claim.claimantId) throw new Error("Independent authenticated approver required");
    const [row] = await tx.insert(s.historicalEventReviewResolutions).values({ reviewId: review.id, resolvedBy: actor.id, note: trimmed }).returning({ id: s.historicalEventReviewResolutions.id });
    if (!row) throw new Error("Resolution not persisted");
    return { resolutionId: row.id };
  });
}
