// IAC-405 step 3 PR P. The read of the kill switch state (guardrail G8), kept apart from the writers in switch.ts so the ledger module can read it without
// importing the writers. Read-only. ON only when the latest ON or OFF event of the organization is ON, no automated attempt of the organization is still unresolved, and no automated send is
// left unconfirmed without a later OFF event, and no historical PayPal event review of an automated payment is open.
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { LedgerTransaction } from "../ledger/journal";

export type SwitchReader = Pick<LedgerTransaction, "select" | "execute">;
// The unresolved attempt states. UNKNOWN is a send whose outcome is not known, UNKNOWN_STATUS a status poll that could not be mapped.
export const UNRESOLVED_ATTEMPT_STATES = ["UNKNOWN", "UNKNOWN_STATUS"] as const;
export type AutomationState = { on: boolean; unknownOutstanding: boolean; lastEvent: { seq: number; event: string; reason: string | null } | null };

export async function automationState(tx: SwitchReader, organizationId: string): Promise<AutomationState> {
  const [last] = await tx.select({ seq: s.automationSwitchEvents.seq, event: s.automationSwitchEvents.event, reason: s.automationSwitchEvents.reason }).from(s.automationSwitchEvents)
    .where(and(eq(s.automationSwitchEvents.organizationId, organizationId), inArray(s.automationSwitchEvents.event, ["ON", "OFF"]))).orderBy(desc(s.automationSwitchEvents.seq)).limit(1);
  const unresolved = await tx.select({ id: s.disbursementAttempts.id }).from(s.disbursementAttempts)
    .innerJoin(s.disbursements, eq(s.disbursements.id, s.disbursementAttempts.disbursementId))
    .innerJoin(s.disbursementOrigins, eq(s.disbursementOrigins.disbursementId, s.disbursements.id))
    .innerJoin(s.claims, and(eq(s.claims.id, s.disbursements.claimId), eq(s.claims.version, s.disbursements.claimVersion)))
    .where(and(eq(s.claims.organizationId, organizationId), inArray(s.disbursementAttempts.state, [...UNRESOLVED_ATTEMPT_STATES]), sql`${s.disbursementOrigins.automatedDecisionId} is not null`)).limit(1);
  // An open historical PayPal event review (an event for an earlier attempt after a retry, not yet reconciled by a person) of an automated disbursement also holds automation.
  const openReview = await tx.select({ id: s.historicalEventReviews.id }).from(s.historicalEventReviews)
    .innerJoin(s.disbursementOrigins, eq(s.disbursementOrigins.disbursementId, s.historicalEventReviews.disbursementId))
    .innerJoin(s.claims, and(eq(s.claims.id, s.historicalEventReviews.claimId), eq(s.claims.version, s.historicalEventReviews.claimVersion)))
    .leftJoin(s.historicalEventReviewResolutions, eq(s.historicalEventReviewResolutions.reviewId, s.historicalEventReviews.id))
    .where(and(eq(s.claims.organizationId, organizationId), isNull(s.historicalEventReviewResolutions.id), sql`${s.disbursementOrigins.automatedDecisionId} is not null`)).limit(1);
  // Fail closed (review item 8): an automated send with no AUTO_SEND_CONFIRMED record (the send result was never stored as known) and no OFF event after it blocks automation, even after the
  // attempt is resolved by a person. It lifts only when an OFF event is written after the send, and turning back ON then takes the two-approver proposal and confirmation.
  const unconfirmed = await tx.execute<{ id: string }>(sql`
    select a.id from automated_decisions a join allocation_decisions ad on ad.decision_hash = a.decision_hash
    where a.kind = 'AUTO_SENT' and ad.organization_id = ${organizationId}
      and not exists (select 1 from automated_decisions c where c.decision_hash = a.decision_hash and c.kind = 'AUTO_SEND_CONFIRMED')
      and not exists (select 1 from automation_switch_events e where e.organization_id = ${organizationId} and e.event = 'OFF' and e.recorded_at > a.recorded_at)
    limit 1`);
  return { on: last?.event === "ON", unknownOutstanding: unresolved.length > 0 || openReview.length > 0 || unconfirmed.length > 0, lastEvent: last ?? null };
}
export const automationAllowed = (state: AutomationState): boolean => state.on && !state.unknownOutstanding;
