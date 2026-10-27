import { and, desc, eq, isNull, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "./db";
import { reconcile } from "../ledger/reconcile";

// Local record summary only. It does not call PayPal or decide a human gate outcome.
export async function readGateAEvidence(db: AppDatabase) {
  return db.transaction(async tx => {
    await tx.execute(sql`set transaction read only`);
    const [claim] = await tx.select({ id: s.claims.id, version: s.claims.version, status: s.claims.status, organizationId: s.claims.organizationId }).from(s.claims).where(eq(s.claims.id, "C-104")).orderBy(desc(s.claims.version)).limit(1);
    if (!claim) throw new Error("C-104 is not seeded");
    const [decision] = await tx.select({ id: s.allocationDecisions.id, hash: s.allocationDecisions.decisionHash, recognizedAt: s.allocationDecisions.recognizedAt }).from(s.allocationDecisions).where(and(eq(s.allocationDecisions.claimId, claim.id), eq(s.allocationDecisions.claimVersion, claim.version), isNull(s.allocationDecisions.invalidatedAt))).orderBy(desc(s.allocationDecisions.frozenAt)).limit(1);
    const approvals = decision ? await tx.select({ username: s.users.username }).from(s.approvals).innerJoin(s.users, eq(s.users.id, s.approvals.approverId)).where(eq(s.approvals.decisionHash, decision.hash)) : [];
    const [disbursement] = await tx.select({ id: s.disbursements.id, amountCents: s.disbursements.amountCents }).from(s.disbursements).where(and(eq(s.disbursements.claimId, claim.id), eq(s.disbursements.claimVersion, claim.version)));
    const [attempt] = disbursement ? await tx.select({ state: s.disbursementAttempts.state, senderBatchId: s.disbursementAttempts.senderBatchId, senderItemId: s.disbursementAttempts.senderItemId, batchId: s.disbursementAttempts.payoutBatchId, itemId: s.disbursementAttempts.payoutItemId, batchStatus: s.disbursementAttempts.batchStatus, itemStatus: s.disbursementAttempts.itemStatus, feeCents: s.disbursementAttempts.feeCents, settledOn: s.disbursementAttempts.settledOn, lastHttpStatus: s.disbursementAttempts.lastHttpStatus, lastErrorCode: s.disbursementAttempts.lastErrorCode }).from(s.disbursementAttempts).where(eq(s.disbursementAttempts.disbursementId, disbursement.id)).orderBy(desc(s.disbursementAttempts.attemptNumber)).limit(1) : [];
    const report = await reconcile(tx, claim.organizationId);
    const settlements = attempt?.itemId ? await tx.select({ purpose: s.journalEntries.purpose }).from(s.journalEntries).where(and(eq(s.journalEntries.sourceType, "paypal_payout_item"), eq(s.journalEntries.sourceId, attempt.itemId))) : [];
    const nextStep = !report.matches ? "STOP_LEDGER_TIE_OUT" : attempt?.state === "UNKNOWN" && !attempt.batchId ? "STOP_MANUAL_RECONCILIATION" : attempt?.state === "SETTLED" && claim.status === "PAID" ? "OWNER_REVIEW_AND_RECORD_DEMO" : attempt ? "REVIEW_ATTEMPT_AND_REFRESH_KNOWN_BATCH_ONLY" : claim.status === "APPROVED" ? "OWNER_REVIEW_AND_EXPLICIT_SANDBOX_SEND" : claim.status === "AWAITING_APPROVAL" ? "COLLECT_DISTINCT_TARA_AND_BEN_APPROVALS" : claim.status === "DRAFT" ? "MARIA_FREEZE_ALLOCATION" : "OWNER_REVIEW_CLAIM_STATE";
    return {
      source: "LOCAL_APPLICATION_DATABASE", providerRequestsMade: 0,
      note: "Recorded local facts only. This helper does not independently confirm provider state or assign Gate A PASS.",
      claim: { id: claim.id, version: claim.version, status: claim.status },
      decisionHashShort: decision?.hash.slice(0, 16) ?? null,
      approvedBy: approvals.map(row => row.username).sort(), recognized: Boolean(decision?.recognizedAt),
      payout: attempt ? { ...attempt, amountCents: disbursement!.amountCents.toString(), feeCents: attempt.feeCents?.toString() ?? null } : null,
      ledger: { matches: report.matches, openPayableCents: report.openPayableCents.toString(), restrictedCents: report.restrictedCents.toString(), generalCents: report.generalCents.toString(), bookCashCents: report.bookCashCents.toString(), settlementEntries: settlements.filter(row => row.purpose === "settlement").length, feeEntries: settlements.filter(row => row.purpose === "payout_fee").length },
      nextStep,
    };
  }, { isolationLevel: "repeatable read" });
}
