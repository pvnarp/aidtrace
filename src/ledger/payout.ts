import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import type { PayoutTransport, PayoutItemResult } from "../paypal/adapter";
import { postJournal, type LedgerTransaction } from "./journal";
import { reconcile } from "./reconcile";
import { serializable } from "./service";

type Attempt = typeof s.disbursementAttempts.$inferSelect;
const knownBatches = new Set(["SUCCESS", "PENDING", "PROCESSING", "DENIED", "CANCELED"]);
const pendingItems = new Set(["PENDING"]);
const heldItems = new Set(["UNCLAIMED", "ONHOLD"]);
const failedItems = new Set(["FAILED", "RETURNED", "BLOCKED"]);
const manualItems = new Set(["REFUNDED", "REVERSED"]);

async function context(tx: LedgerTransaction, claimId: string, actorId: string) {
  const [claim] = await tx.select().from(s.claims).where(eq(s.claims.id, claimId)).orderBy(desc(s.claims.version)).limit(1);
  if (!claim) throw new Error("Claim not found");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${claim.organizationId})::bigint)`);
  await tx.execute(sql`select id from claims where id=${claim.id} and version=${claim.version} for update`);
  const [actor] = await tx.select({ id: s.users.id, role: s.users.role, organizationId: s.users.organizationId }).from(s.users).where(eq(s.users.id, actorId));
  if (!actor || actor.organizationId !== claim.organizationId || actor.role !== "APPROVER" || actor.id === claim.claimantId) throw new Error("Independent authenticated approver required");
  return claim;
}
export async function attemptFor(tx: LedgerTransaction, claimId: string, actorId: string) {
  const claim = await context(tx, claimId, actorId);
  const [disbursement] = await tx.select().from(s.disbursements).where(and(eq(s.disbursements.claimId, claim.id), eq(s.disbursements.claimVersion, claim.version)));
  if (!disbursement) throw new Error("No payout exists");
  const [attempt] = await tx.select().from(s.disbursementAttempts).where(eq(s.disbursementAttempts.disbursementId, disbursement.id)).orderBy(desc(s.disbursementAttempts.attemptNumber)).limit(1);
  if (!attempt) throw new Error("No payout attempt exists");
  return { claim, disbursement, attempt };
}
const safeCode = (value: string | undefined) => value && /^[A-Z0-9_]{1,100}$/.test(value) ? value : undefined;
export async function sendClaimPayout(db: AppDatabase, claimId: string, actorId: string, expectedHash: string, provider: PayoutTransport) {
  await serializable(db, async tx => {
    const claim = await context(tx, claimId, actorId);
    if (claim.status !== "APPROVED") throw new Error("Only an approved claim may be paid");
    const lines = await tx.select().from(s.claimLines).where(and(eq(s.claimLines.claimId, claim.id), eq(s.claimLines.claimVersion, claim.version)));
    provider.validatePayout(claim.payeeEmail, lines.reduce((sum, row) => sum + row.amountCents, 0n));
  });
  const balance = await provider.balance();
  const prepared = await serializable(db, async tx => {
    const claim = await context(tx, claimId, actorId);
    if (claim.status !== "APPROVED") throw new Error("Only an approved claim may be paid");
    // There can be invalidated historical decisions; select the recognized one explicitly.
    const decisions = await tx.select().from(s.allocationDecisions).where(and(eq(s.allocationDecisions.claimId, claim.id), eq(s.allocationDecisions.claimVersion, claim.version)));
    const recognized = decisions.filter(row => row.recognizedAt && !row.invalidatedAt);
    if (recognized.length !== 1 || recognized[0]!.decisionHash !== expectedHash) throw new Error("Current recognized decision hash required");
    const approvals = await tx.select().from(s.approvals).where(eq(s.approvals.decisionHash, expectedHash));
    if (!approvals.some(row => row.approverId === actorId)) throw new Error("An approving signer must send the payout");
    const existing = await tx.select().from(s.disbursements).where(and(eq(s.disbursements.claimId, claim.id), eq(s.disbursements.claimVersion, claim.version)));
    if (existing.length) throw new Error("A payout already exists; refresh or resolve it without sending again");
    const lines = await tx.select().from(s.claimLines).where(and(eq(s.claimLines.claimId, claim.id), eq(s.claimLines.claimVersion, claim.version)));
    const amountCents = lines.reduce((sum, line) => sum + line.amountCents, 0n);
    provider.validatePayout(claim.payeeEmail, amountCents);
    if (claim.payeeIsPlaceholder) throw new Error("A real sandbox recipient is required");
    if (balance.readable && (balance.availableCents === undefined || balance.availableCents < amountCents)) throw new Error("Readable provider balance is short; fund the sandbox account first");
    const disbursementId = randomUUID(); const senderBatchId = `AT-${disbursementId}-1`; const senderItemId = `${senderBatchId}-1`;
    await tx.insert(s.disbursements).values({ id: disbursementId, claimId: claim.id, claimVersion: claim.version, decisionHash: expectedHash, payeeEmail: claim.payeeEmail, amountCents });
    const [attempt] = await tx.insert(s.disbursementAttempts).values({ disbursementId, attemptNumber: 1, senderBatchId, senderItemId, amountCents, payeeEmail: claim.payeeEmail, state: "UNKNOWN", providerBalanceCents: balance.readable ? balance.availableCents : null, providerBalanceAsOf: balance.asOf }).returning();
    await tx.update(s.claims).set({ status: "PAYOUT_PROCESSING" }).where(and(eq(s.claims.id, claim.id), eq(s.claims.version, claim.version)));
    if (!attempt) throw new Error("Attempt was not persisted");
    return attempt;
  });
  return transmitPrepared(db, claimId, actorId, prepared, provider);
}
export async function transmitPrepared(db: AppDatabase, claimId: string, actorId: string, prepared: Attempt, provider: PayoutTransport) {
  // Commit sender IDs and UNKNOWN before any POST. A crash cannot authorize a fresh send.
  let result: Awaited<ReturnType<PayoutTransport["send"]>>;
  try { result = await provider.send(prepared); }
  catch {
    await serializable(db, async tx => {
      await context(tx, claimId, actorId);
      await tx.update(s.disbursementAttempts).set({ lastErrorCode: "SEND_OUTCOME_UNKNOWN" }).where(eq(s.disbursementAttempts.id, prepared.id));
    });
    return { state: "UNKNOWN" as const };
  }
  return serializable(db, async tx => {
    const claim = await context(tx, claimId, actorId);
    const batchCreated = result.httpStatus === 201 && Boolean(result.batchId);
    const fundingRejected = !result.batchId && !result.itemId && result.httpStatus >= 400 && result.httpStatus < 500 && result.errorCode === "INSUFFICIENT_FUNDS";
    const state = batchCreated ? "SUBMITTED" : fundingRejected ? "FUNDING_REJECTED" : "UNKNOWN";
    // Preserve returned IDs even on an ambiguous HTTP result. IDs alone never settle a claim.
    await tx.update(s.disbursementAttempts).set({ state, payoutBatchId: result.batchId ?? null, payoutItemId: result.itemId ?? null, batchStatus: result.batchStatus ?? null, lastHttpStatus: result.httpStatus, lastErrorCode: safeCode(result.errorCode) ?? (state === "UNKNOWN" ? "SEND_OUTCOME_UNKNOWN" : null) }).where(eq(s.disbursementAttempts.id, prepared.id));
    if (fundingRejected) await tx.update(s.claims).set({ status: "PAYOUT_ISSUE" }).where(and(eq(s.claims.id, claimId), eq(s.claims.version, claim.version)));
    return { state };
  });
}
function matchesItem(attempt: Attempt, item: PayoutItemResult) {
  return item.httpStatus === 200 && item.itemId && item.batchId === attempt.payoutBatchId && item.senderBatchId === attempt.senderBatchId && item.senderItemId === attempt.senderItemId && item.payeeEmail === attempt.payeeEmail && item.amountCents === attempt.amountCents && item.errorCode !== "INVALID_PROVIDER_FEE";
}
async function settle(tx: LedgerTransaction, claim: typeof s.claims.$inferSelect, attempt: Attempt, item: PayoutItemResult) {
  if (!item.itemId) throw new Error("Independent payout item required");
  if (attempt.feeCents !== null && item.feeCents !== undefined && attempt.feeCents !== item.feeCents) throw new Error("Provider fee changed; manual review required");
  // Accounting-inspired demo model, pending nonprofit accountant review.
  const effectiveOn = attempt.settledOn ?? item.processedOn ?? new Date().toISOString().slice(0, 10);
  await postJournal(tx, { sourceType: "paypal_payout_item", sourceId: item.itemId, purpose: "settlement", effectiveOn, postings: [{ accountCode: "2010", subKey: claim.claimantId, debitCents: attempt.amountCents, creditCents: 0n }, { accountCode: "1010", debitCents: 0n, creditCents: attempt.amountCents }] });
  if (item.feeCents !== undefined && item.feeCents > 0n) {
    const [general] = await tx.select().from(s.funds).where(and(eq(s.funds.organizationId, claim.organizationId), eq(s.funds.id, "fund_g"), eq(s.funds.fundClass, "UNRESTRICTED")));
    if (!general) throw new Error("Default General fee fund is missing");
    await postJournal(tx, { sourceType: "paypal_payout_item", sourceId: item.itemId, purpose: "payout_fee", effectiveOn, postings: [{ accountCode: "5900", subKey: item.itemId, debitCents: item.feeCents, creditCents: 0n }, { accountCode: "1010", debitCents: 0n, creditCents: item.feeCents }] });
    await tx.insert(s.fundDebits).values({ fundId: general.id, amountCents: item.feeCents, sourceType: "paypal_payout_item", sourceId: item.itemId, purpose: "payout_fee", effectiveOn }).onConflictDoNothing();
    const [debit] = await tx.select().from(s.fundDebits).where(and(eq(s.fundDebits.sourceType, "paypal_payout_item"), eq(s.fundDebits.sourceId, item.itemId), eq(s.fundDebits.fundId, general.id), eq(s.fundDebits.purpose, "payout_fee")));
    if (debit?.amountCents !== item.feeCents) throw new Error("Fee debit differs from provider source");
  }
  await tx.update(s.disbursementAttempts).set({ state: "SETTLED", feeCents: item.feeCents ?? attempt.feeCents, settledOn: effectiveOn }).where(eq(s.disbursementAttempts.id, attempt.id));
  await tx.update(s.claims).set({ status: "PAID" }).where(and(eq(s.claims.id, claim.id), eq(s.claims.version, claim.version)));
  if (!(await reconcile(tx, claim.organizationId)).matches) throw new Error("Settlement failed ledger tie-out");
}
export async function refreshClaimPayout(db: AppDatabase, claimId: string, actorId: string, provider: PayoutTransport) {
  const before = await serializable(db, tx => attemptFor(tx, claimId, actorId));
  return refreshAttempt(db, before, provider, tx => attemptFor(tx, claimId, actorId));
}
export interface VerifiedPayoutEvent { eventId: string; eventType: string; resourceId: string; }
export async function refreshAttempt(db: AppDatabase, before: Awaited<ReturnType<typeof attemptFor>>, provider: PayoutTransport, reload: (tx: LedgerTransaction) => Promise<Awaited<ReturnType<typeof attemptFor>>>, event?: VerifiedPayoutEvent) {
  if (!before.attempt.payoutBatchId) return { state: before.attempt.state, notice: "MANUAL_RECONCILIATION_REQUIRED" };
  const batch = await provider.batch(before.attempt.payoutBatchId);
  if (batch.httpStatus !== 200 || batch.batchId !== before.attempt.payoutBatchId || batch.senderBatchId !== before.attempt.senderBatchId) throw new Error("Provider batch binding failed; no accounting change");
  const itemId = batch.itemIds.length === 1 ? batch.itemIds[0] : undefined;
  const item = itemId ? await provider.item(itemId) : undefined;
  return serializable(db, async tx => {
    const { claim, attempt } = await reload(tx);
    if (attempt.id !== before.attempt.id) throw new Error("Payout attempt changed during status retrieval");
    if (item && (!matchesItem(attempt, item) || item.itemId !== itemId || (attempt.payoutItemId && attempt.payoutItemId !== item.itemId))) throw new Error("Provider item binding failed; no accounting change");
    if (event?.eventType.startsWith("PAYMENT.PAYOUTS-ITEM.") && item?.itemId !== event.resourceId) throw new Error("Fetched item differs from verified event resource");
    if (event) {
      const [saved] = await tx.insert(s.providerEvents).values({ ...event, verificationStatus: "SUCCESS", processedAt: new Date() }).onConflictDoNothing({ target: s.providerEvents.eventId }).returning({ id: s.providerEvents.id });
      if (!saved) return { state: attempt.state, notice: "DUPLICATE_EVENT" };
    }
    const batchStatus = batch.batchStatus ?? "UNKNOWN_STATUS"; const itemStatus = item?.itemStatus;
    const status = itemStatus ?? batchStatus;
    let state: string; let claimStatus: typeof s.claims.$inferSelect.status;
    if (attempt.state === "MANUAL_REVIEW") return { state: "MANUAL_REVIEW", notice: "MANUAL_REVIEW_REQUIRED" };
    if ((attempt.state === "SETTLED" || claim.status === "PAID") && itemStatus !== "SUCCESS" && !manualItems.has(status)) return { state: "SETTLED", notice: "IGNORED_REGRESSIVE_STATUS" };
    if (item && attempt.feeCents !== null && item.feeCents !== undefined && attempt.feeCents !== item.feeCents) { state = "MANUAL_REVIEW"; claimStatus = "PAYOUT_ISSUE"; }
    else if (!knownBatches.has(batchStatus) || batch.itemIds.length > 1 || (itemStatus === "SUCCESS" && ["DENIED", "CANCELED"].includes(batchStatus))) { state = "UNKNOWN_STATUS"; claimStatus = "PAYOUT_PROCESSING"; }
    else if (itemStatus === "SUCCESS" && item) { await settle(tx, claim, attempt, item); state = "SETTLED"; claimStatus = "PAID"; }
    else if (manualItems.has(status)) { state = "MANUAL_REVIEW"; claimStatus = "PAYOUT_ISSUE"; }
    else if (attempt.state === "SETTLED" || claim.status === "PAID") return { state: "SETTLED", notice: "IGNORED_REGRESSIVE_STATUS" };
    else if (["DENIED", "CANCELED"].includes(batchStatus) || failedItems.has(status)) { state = "FAILED"; claimStatus = "PAYOUT_ISSUE"; }
    else if (heldItems.has(status)) { state = "HELD"; claimStatus = "PAYOUT_ISSUE"; }
    else if ((itemStatus && pendingItems.has(itemStatus)) || (!itemStatus && ["PENDING", "PROCESSING"].includes(batchStatus))) { state = "PENDING"; claimStatus = "PAYOUT_PROCESSING"; }
    else { state = "UNKNOWN_STATUS"; claimStatus = "PAYOUT_PROCESSING"; }
    await tx.update(s.disbursementAttempts).set({ state, batchStatus, itemStatus: itemStatus ?? null, payoutItemId: item?.itemId ?? attempt.payoutItemId, lastPolledAt: new Date(), lastHttpStatus: item?.httpStatus ?? batch.httpStatus, lastErrorCode: safeCode(item?.errorCode) ?? (state === "UNKNOWN_STATUS" ? "UNMAPPED_PROVIDER_STATUS" : null) }).where(eq(s.disbursementAttempts.id, attempt.id));
    await tx.update(s.claims).set({ status: claimStatus }).where(and(eq(s.claims.id, claim.id), eq(s.claims.version, claim.version)));
    return { state };
  });
}
