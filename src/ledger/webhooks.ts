import { and, desc, eq, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import type { PayoutTransport } from "../paypal/adapter";
import type { LedgerTransaction } from "./journal";
import { refreshAttempt, type VerifiedPayoutEvent } from "./payout";
import { serializable } from "./service";

// Internal service. Only the signature-verifying receiver may invoke it from HTTP.
export async function refreshVerifiedPayoutEvent(db: AppDatabase, event: VerifiedPayoutEvent, batchId: string | undefined, itemId: string | undefined, provider: PayoutTransport) {
  const candidates = await db.select().from(s.disbursementAttempts).where(batchId ? eq(s.disbursementAttempts.payoutBatchId, batchId) : eq(s.disbursementAttempts.payoutItemId, itemId ?? ""));
  if (candidates.length !== 1) return { state: "IGNORED", notice: "UNMATCHED_EVENT" };
  const target = candidates[0]!;
  const reload = async (tx: LedgerTransaction) => {
    const [disbursement] = await tx.select().from(s.disbursements).where(eq(s.disbursements.id, target.disbursementId));
    if (!disbursement) throw new Error("Event disbursement missing");
    const [claim] = await tx.select().from(s.claims).where(and(eq(s.claims.id, disbursement.claimId), eq(s.claims.version, disbursement.claimVersion)));
    if (!claim) throw new Error("Event claim missing");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${claim.organizationId})::bigint)`);
    const [attempt] = await tx.select().from(s.disbursementAttempts).where(eq(s.disbursementAttempts.disbursementId, disbursement.id)).orderBy(desc(s.disbursementAttempts.attemptNumber)).limit(1);
    if (!attempt) throw new Error("Event attempt missing");
    return { claim, disbursement, attempt };
  };
  const before = await serializable(db, reload);
  if (batchId && batchId !== target.payoutBatchId || itemId && target.payoutItemId && itemId !== target.payoutItemId) throw new Error("Event resource binding failed");
  if ((await db.select({ id: s.providerEvents.id }).from(s.providerEvents).where(eq(s.providerEvents.eventId, event.eventId))).length) return { state: before.attempt.state, notice: "DUPLICATE_EVENT" };
  if (before.attempt.id !== target.id) {
    // A past attempt becoming active after a retry needs a human to reconcile both, so it is recorded as a review row.
    // The latest attempt and the claim stay as they are, so polling and settlement continue.
    // No journal or automatic resend is inferred from the old event payload.
    return serializable(db, async tx => {
      const current = await reload(tx);
      const [saved] = await tx.insert(s.providerEvents).values({ ...event, verificationStatus: "SUCCESS", processedAt: new Date() }).onConflictDoNothing().returning({ id: s.providerEvents.id });
      if (saved && current.attempt.id !== target.id) {
        await tx.insert(s.historicalEventReviews).values({ providerEventId: saved.id, claimId: current.claim.id, claimVersion: current.claim.version, disbursementId: current.disbursement.id, eventAttemptId: target.id, latestAttemptId: current.attempt.id, latestStateAtEvent: current.attempt.state });
      }
      return { state: current.attempt.state, notice: "HISTORICAL_ATTEMPT_EVENT" };
    });
  }
  return refreshAttempt(db, before, provider, reload, event);
}
