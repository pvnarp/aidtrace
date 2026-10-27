import { and, eq, inArray } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import type { PayoutTransport } from "../paypal/adapter";
import type { LedgerTransaction } from "./journal";
import { serializable } from "./service";
import { attemptFor, transmitPrepared } from "./payout";

type Attempt = typeof s.disbursementAttempts.$inferSelect;
export function isRetryableAttempt(attempt: Pick<Attempt, "state" | "itemStatus" | "batchStatus" | "lastErrorCode" | "payoutBatchId" | "payoutItemId">) {
  if (attempt.state === "FUNDING_REJECTED") return !attempt.payoutBatchId && !attempt.payoutItemId && attempt.lastErrorCode === "INSUFFICIENT_FUNDS";
  if (attempt.state !== "FAILED") return false;
  return attempt.itemStatus ? ["FAILED", "RETURNED", "BLOCKED"].includes(attempt.itemStatus) : Boolean(attempt.batchStatus && ["DENIED", "CANCELED"].includes(attempt.batchStatus));
}
async function retryContext(tx: LedgerTransaction, claimId: string, actorId: string, expectedHash: string) {
  const current = await attemptFor(tx, claimId, actorId);
  const { claim, disbursement, attempt } = current;
  const [decision] = await tx.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.decisionHash, expectedHash));
  if (!decision?.recognizedAt || decision.invalidatedAt || decision.claimId !== claim.id || decision.claimVersion !== claim.version || disbursement.decisionHash !== expectedHash) throw new Error("Recognized claim decision required for retry");
  if (claim.status !== "PAYOUT_ISSUE" || !isRetryableAttempt(attempt)) throw new Error("Latest payout is not retryable; reconcile or keep polling");
  const attempts = await tx.select().from(s.disbursementAttempts).where(eq(s.disbursementAttempts.disbursementId, disbursement.id));
  if (attempts.some(row => !isRetryableAttempt(row))) throw new Error("An unresolved or settled attempt prevents retry");
  if (claim.payeeEmail !== disbursement.payeeEmail || attempt.payeeEmail !== disbursement.payeeEmail || attempt.amountCents !== disbursement.amountCents) throw new Error("Retry cannot change payee or amount");
  const itemIds = attempts.flatMap(row => row.payoutItemId ? [row.payoutItemId] : []);
  const entries = await tx.select().from(s.journalEntries).where(inArray(s.journalEntries.sourceId, [decision.id, ...itemIds]));
  const payableEntries = entries.filter(row => (row.sourceType === "claim_recognition" && row.sourceId === decision.id && row.purpose === "recognition") || (row.sourceType === "paypal_payout_item" && row.purpose === "settlement" && itemIds.includes(row.sourceId)));
  const postings = payableEntries.length ? await tx.select().from(s.journalPostings).where(inArray(s.journalPostings.entryId, payableEntries.map(row => row.id))) : [];
  const openPayable = postings.filter(row => row.accountCode === "2010" && row.subKey === claim.claimantId).reduce((sum, row) => sum + row.creditCents - row.debitCents, 0n);
  if (openPayable <= 0n || openPayable !== disbursement.amountCents) throw new Error("Retry requires the unchanged full open claim payable");
  return { ...current, openPayable };
}
export async function authorizePayoutRetry(db: AppDatabase, claimId: string, actorId: string, expectedHash: string, failedAttemptId: string) {
  return serializable(db, async tx => {
    const { claim, disbursement, attempt, openPayable } = await retryContext(tx, claimId, actorId, expectedHash);
    if (attempt.id !== failedAttemptId) throw new Error("Retry authorization requires the current failed attempt");
    const [authorization] = await tx.insert(s.retryAuthorizations).values({ claimId, claimVersion: claim.version, decisionHash: expectedHash, attemptNumber: attempt.attemptNumber + 1, payeeEmail: disbursement.payeeEmail, amountCents: openPayable, authorizedBy: actorId }).onConflictDoNothing().returning();
    if (!authorization) throw new Error("Retry already authorized");
    return { authorizationId: authorization.id, attemptNumber: authorization.attemptNumber };
  });
}
export async function sendAuthorizedPayoutRetry(db: AppDatabase, claimId: string, actorId: string, expectedHash: string, authorizationId: string, provider: PayoutTransport) {
  const validate = async (tx: LedgerTransaction) => {
    const current = await retryContext(tx, claimId, actorId, expectedHash);
    const [authorization] = await tx.select().from(s.retryAuthorizations).where(eq(s.retryAuthorizations.id, authorizationId));
    const [authorizer] = authorization ? await tx.select().from(s.users).where(eq(s.users.id, authorization.authorizedBy)) : [];
    if (!authorization || authorization.claimId !== claimId || authorization.claimVersion !== current.claim.version || authorization.decisionHash !== expectedHash || authorization.attemptNumber !== current.attempt.attemptNumber + 1 || authorization.payeeEmail !== current.disbursement.payeeEmail || authorization.amountCents !== current.openPayable || !authorizer || authorizer.organizationId !== current.claim.organizationId || authorizer.role !== "APPROVER" || authorizer.id === current.claim.claimantId) throw new Error("Bound independent retry authorization required");
    provider.validatePayout(authorization.payeeEmail, authorization.amountCents);
    return { ...current, authorization };
  };
  await serializable(db, validate);
  const balance = await provider.balance();
  const prepared = await serializable(db, async tx => {
    const { claim, disbursement, authorization } = await validate(tx);
    if (balance.readable && (balance.availableCents === undefined || balance.availableCents < authorization.amountCents)) throw new Error("Readable provider balance is short; fund the sandbox account first");
    const senderBatchId = `AT-${disbursement.id}-${authorization.attemptNumber}`;
    const [attempt] = await tx.insert(s.disbursementAttempts).values({ disbursementId: disbursement.id, attemptNumber: authorization.attemptNumber, senderBatchId, senderItemId: `${senderBatchId}-1`, amountCents: authorization.amountCents, payeeEmail: authorization.payeeEmail, state: "UNKNOWN", providerBalanceCents: balance.readable ? balance.availableCents : null, providerBalanceAsOf: balance.asOf }).returning();
    await tx.update(s.claims).set({ status: "PAYOUT_PROCESSING" }).where(and(eq(s.claims.id, claimId), eq(s.claims.version, claim.version)));
    if (!attempt) throw new Error("Retry attempt not persisted");
    return attempt;
  });
  return transmitPrepared(db, claimId, actorId, prepared, provider);
}
