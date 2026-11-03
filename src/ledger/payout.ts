import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import type { PayoutTransport, PayoutItemResult } from "../paypal/adapter";
import { postJournal, type LedgerTransaction } from "./journal";
import { reconcile } from "./reconcile";
import { lockClaimRowOrgFirst, serializable } from "./service";

import { recordAutopilot } from "../fund-modes/automated";
import { automationAllowed, automationState } from "../fund-modes/automation-state";
import { fundAutopilotEnabled, type FlagEnv } from "../fund-modes/flag";
import { g3FundDay, g4ClaimantWeek } from "../fund-modes/guardrails";
import { modeAtRecognition } from "../fund-modes/modes";
import { tripOnUnknownSend } from "../fund-modes/switch";

type Attempt = typeof s.disbursementAttempts.$inferSelect;
const knownBatches = new Set(["SUCCESS", "PENDING", "PROCESSING", "DENIED", "CANCELED"]);
const pendingItems = new Set(["PENDING"]);
const heldItems = new Set(["UNCLAIMED", "ONHOLD"]);
const failedItems = new Set(["FAILED", "RETURNED", "BLOCKED"]);
const manualItems = new Set(["REFUNDED", "REVERSED"]);

// The organization lock and the latest claim row lock, in the order every ledger transaction takes them. No actor is checked here: context() adds the human check, and the automated
// send (IAC-405 PR P, docs/ASSUMPTIONS.md section 78) takes this alone because it has no signer and records an automated decision instead.
async function lockedClaim(tx: LedgerTransaction, claimId: string) {
  const [claim] = await tx.select().from(s.claims).where(eq(s.claims.id, claimId)).orderBy(desc(s.claims.version)).limit(1);
  if (!claim) throw new Error("Claim not found");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${claim.organizationId})::bigint)`);
  await tx.execute(sql`select id from claims where id=${claim.id} and version=${claim.version} for update`);
  return claim;
}
async function context(tx: LedgerTransaction, claimId: string, actorId: string) {
  const claim = await lockedClaim(tx, claimId);
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
// The shared prepare core of both sends: it persists the disbursement, the UNKNOWN attempt (sender_batch_id AT-<disbursementId>-1), the origin (a human signer or an automated send record,
// exactly one) and the PAYOUT_PROCESSING status, all before any POST. Same checks, same order, as the human send always had. The caller holds the locks inside a serializable transaction.
type Origin = { signedBy: string; automatedDecisionId?: undefined } | { signedBy?: undefined; automatedDecisionId: string };
async function persistPayout(tx: LedgerTransaction, claim: typeof s.claims.$inferSelect, expectedHash: string, provider: PayoutTransport, balance: Awaited<ReturnType<PayoutTransport["balance"]>>, origin: Origin) {
  const existing = await tx.select().from(s.disbursements).where(and(eq(s.disbursements.claimId, claim.id), eq(s.disbursements.claimVersion, claim.version)));
  if (existing.length) throw new Error("A payout already exists; refresh or resolve it without sending again");
  const lines = await tx.select().from(s.claimLines).where(and(eq(s.claimLines.claimId, claim.id), eq(s.claimLines.claimVersion, claim.version)));
  const amountCents = lines.reduce((sum, line) => sum + line.amountCents, 0n);
  provider.validatePayout(claim.payeeEmail, amountCents);
  if (claim.payeeIsPlaceholder) throw new Error("A real sandbox recipient is required");
  if (balance.readable && (balance.availableCents === undefined || balance.availableCents < amountCents)) throw new Error("Readable provider balance is short; fund the sandbox account first");
  const disbursementId = randomUUID(); const senderBatchId = `AT-${disbursementId}-1`; const senderItemId = `${senderBatchId}-1`;
  await tx.insert(s.disbursements).values({ id: disbursementId, claimId: claim.id, claimVersion: claim.version, decisionHash: expectedHash, payeeEmail: claim.payeeEmail, amountCents });
  await tx.insert(s.disbursementOrigins).values({ disbursementId, signedBy: origin.signedBy ?? null, automatedDecisionId: origin.automatedDecisionId ?? null });
  const [attempt] = await tx.insert(s.disbursementAttempts).values({ disbursementId, attemptNumber: 1, senderBatchId, senderItemId, amountCents, payeeEmail: claim.payeeEmail, state: "UNKNOWN", providerBalanceCents: balance.readable ? balance.availableCents : null, providerBalanceAsOf: balance.asOf }).returning();
  await tx.update(s.claims).set({ status: "PAYOUT_PROCESSING" }).where(and(eq(s.claims.id, claim.id), eq(s.claims.version, claim.version)));
  if (!attempt) throw new Error("Attempt was not persisted");
  return attempt;
}
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
    // Item 10: an auto-recognized decision holds no approval of its own, so a person sends it only after two approvers took it over (approveAutoRecognized).
    const [autoRecognized] = await tx.select({ id: s.automatedDecisions.id }).from(s.automatedDecisions).where(and(eq(s.automatedDecisions.decisionHash, expectedHash), eq(s.automatedDecisions.kind, "AUTO_RECOGNIZED")));
    if (autoRecognized && new Set(approvals.map(row => row.approverId)).size < 2) throw new Error("Two approvers must take over this claim before it is sent");
    return persistPayout(tx, claim, expectedHash, provider, balance, { signedBy: actorId });
  });
  return transmitPrepared(db, claimId, actorId, prepared, provider);
}

// IAC-405 step 3 PR P (docs/plans/FUND_MODES_SCOPE.md section 5 items 2 and 3; docs/ASSUMPTIONS.md section 78). The automated send. Called only by the policy sweep. Same order as the human send:
// validate, read the balance, then persist the disbursement and the UNKNOWN attempt before the POST. Inside the persisting transaction, under the organization advisory lock, it checks again
// that the second flag is on, that the effective mode is still Autopilot (a fund moved to Manual or Assisted after recognition blocks the send), that the kill switch is ON with no unresolved
// automated attempt, and the G3 and G4 caps with this claim's amounts. A blocked send writes nothing and the claim waits (for the next pass, or for a person). MAX_DEMO_PAYOUT_CENTS caps the
// send through provider.validatePayout. An UNKNOWN result stays UNKNOWN, trips the switch, and is never retried here: only a person's retry authorization retries (docs/SPEC.md section 9).
export type AutomatedSendDeps = { env?: FlagEnv; now?: Date };
export type AutomatedSendBlock = "FLAG_OFF" | "NOT_APPROVED" | "NO_DECISION" | "NOT_AUTOMATED" | "MODE_CHANGED" | "SWITCH_OFF" | "UNKNOWN_OUTSTANDING" | "G3_FUND_DAY_CAP" | "G4_CLAIMANT_WEEK_CAP" | "PAYOUT_REFUSED" | "BALANCE_UNAVAILABLE" | "BALANCE_SHORT" | "HUMAN_TAKEOVER";
export type AutomatedSendResult = { status: "SENT"; state: "SUBMITTED" | "FUNDING_REJECTED" | "UNKNOWN"; switchTripped: boolean } | { status: "BLOCKED"; reason: AutomatedSendBlock } | { status: "ALREADY_SENT" };
const blocked = (reason: AutomatedSendBlock) => ({ blocked: reason }) as const;
export async function sendAutomatedPayout(db: AppDatabase, claimId: string, expectedHash: string, provider: PayoutTransport, deps: AutomatedSendDeps = {}): Promise<AutomatedSendResult> {
  if (!fundAutopilotEnabled(deps.env)) return { status: "BLOCKED", reason: "FLAG_OFF" };
  const [located] = await db.select({ organizationId: s.claims.organizationId }).from(s.claims).where(eq(s.claims.id, claimId)).limit(1);
  if (!located) return { status: "BLOCKED", reason: "NOT_APPROVED" };
  const first = await serializable(db, async tx => {
    const claim = await lockClaimRowOrgFirst(tx, located.organizationId, claimId);
    if (claim.status !== "APPROVED") return blocked("NOT_APPROVED");
    const lines = await tx.select().from(s.claimLines).where(and(eq(s.claimLines.claimId, claim.id), eq(s.claimLines.claimVersion, claim.version)));
    try { provider.validatePayout(claim.payeeEmail, lines.reduce((sum, row) => sum + row.amountCents, 0n)); } catch { return blocked("PAYOUT_REFUSED"); }
    return null;
  });
  if (first) return { status: "BLOCKED", reason: first.blocked };
  let balance: Awaited<ReturnType<PayoutTransport["balance"]>>;
  try { balance = await provider.balance(); } catch { return { status: "BLOCKED", reason: "BALANCE_UNAVAILABLE" }; }
  const prepared = await serializable(db, async tx => {
    const claim = await lockClaimRowOrgFirst(tx, located.organizationId, claimId);
    if (claim.status !== "APPROVED") return blocked("NOT_APPROVED");
    const decisions = await tx.select().from(s.allocationDecisions).where(and(eq(s.allocationDecisions.claimId, claim.id), eq(s.allocationDecisions.claimVersion, claim.version)));
    const recognized = decisions.filter(row => row.recognizedAt && !row.invalidatedAt);
    if (recognized.length !== 1 || recognized[0]!.decisionHash !== expectedHash) return blocked("NO_DECISION");
    const decision = recognized[0]!;
    // Item 10: once any person has begun to take this claim over, automation never sends it. Checked here, under the organization lock the takeover approval also takes.
    const [takeover] = await tx.select({ id: s.approvals.id }).from(s.approvals).where(eq(s.approvals.decisionHash, expectedHash)).limit(1);
    if (takeover) return blocked("HUMAN_TAKEOVER");
    const [auto] = await tx.select().from(s.automatedDecisions).where(and(eq(s.automatedDecisions.decisionHash, expectedHash), eq(s.automatedDecisions.kind, "AUTO_RECOGNIZED")));
    if (!auto || !auto.rulesRunId || !auto.modelRunId || !auto.ruleSetVersion || !auto.model || !auto.promptVersion) return blocked("NOT_AUTOMATED");
    const existing = await tx.select({ id: s.disbursements.id }).from(s.disbursements).where(and(eq(s.disbursements.claimId, claim.id), eq(s.disbursements.claimVersion, claim.version)));
    if (existing.length) return { already: true } as const;
    const edges = await tx.select({ fundId: s.allocationEdges.fundId, lineId: s.allocationEdges.lineId, amountCents: s.allocationEdges.amountCents }).from(s.allocationEdges).where(eq(s.allocationEdges.decisionId, decision.id));
    if ((await modeAtRecognition(tx, expectedHash, edges, deps.env)) !== "AUTOPILOT") return blocked("MODE_CHANGED");
    const state = await automationState(tx, claim.organizationId);
    if (!automationAllowed(state)) return blocked(state.on ? "UNKNOWN_OUTSTANDING" : "SWITCH_OFF");
    // The switch as committed now, through another connection: this snapshot may predate an OFF that committed while the lock was awaited (review item 4).
    const fresh = await automationState(db, claim.organizationId);
    if (!automationAllowed(fresh)) return blocked(fresh.on ? "UNKNOWN_OUTSTANDING" : "SWITCH_OFF");
    const now = deps.now ?? new Date();
    const lines = await tx.select().from(s.claimLines).where(and(eq(s.claimLines.claimId, claim.id), eq(s.claimLines.claimVersion, claim.version)));
    const claimCents = lines.reduce((sum, line) => sum + line.amountCents, 0n);
    const g3 = await g3FundDay(tx, edges, now, expectedHash);
    if (!g3.pass) return blocked("G3_FUND_DAY_CAP");
    const g4 = await g4ClaimantWeek(tx, claim, claimCents, now, expectedHash);
    if (!g4.pass) return blocked("G4_CLAIMANT_WEEK_CAP");
    try { provider.validatePayout(claim.payeeEmail, claimCents); } catch { return blocked("PAYOUT_REFUSED"); }
    if (claim.payeeIsPlaceholder) return blocked("PAYOUT_REFUSED");
    if (balance.readable && (balance.availableCents === undefined || balance.availableCents < claimCents)) return blocked("BALANCE_SHORT");
    const sendId = await recordAutopilot(tx, expectedHash, "AUTO_SENT", { rulesRunId: auto.rulesRunId, modelRunId: auto.modelRunId, ruleSetVersion: auto.ruleSetVersion, model: auto.model, promptVersion: auto.promptVersion },
      { sendChecks: { mode: "AUTOPILOT", switchOn: true, unresolvedAutomatedAttempts: false, G3: g3, G4: g4 }, claimCents: claimCents.toString(), recognizedBy: auto.id });
    const attempt = await persistPayout(tx, claim, expectedHash, provider, balance, { automatedDecisionId: sendId });
    return { attempt, organizationId: claim.organizationId } as const;
  }).catch((error: unknown) => { if (["23505", "23514", "40001"].includes(codeOf(error) ?? "")) return blocked("PAYOUT_REFUSED"); throw error; });
  if ("blocked" in prepared) return { status: "BLOCKED", reason: prepared.blocked };
  if ("already" in prepared) return { status: "ALREADY_SENT" };
  const result = await transmitPrepared(db, claimId, null, prepared.attempt, provider);
  let switchTripped = false;
  if (result.state === "UNKNOWN") { try { await tripOnUnknownSend(db, prepared.organizationId, expectedHash); switchTripped = true; } catch { switchTripped = false; } }
  return { status: "SENT", state: result.state as "SUBMITTED" | "FUNDING_REJECTED" | "UNKNOWN", switchTripped };
}
function codeOf(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
}
// actorId is null only for the automated send (sendAutomatedPayout), which has no signer. A human send passes its approver and keeps the independent approver check.
export async function transmitPrepared(db: AppDatabase, claimId: string, actorId: string | null, prepared: Attempt, provider: PayoutTransport) {
  const locked = (tx: LedgerTransaction) => actorId === null ? lockedClaim(tx, claimId) : context(tx, claimId, actorId);
  // Commit sender IDs and UNKNOWN before any POST. A crash cannot authorize a fresh send.
  let result: Awaited<ReturnType<PayoutTransport["send"]>>;
  try { result = await provider.send(prepared); }
  catch {
    await serializable(db, async tx => {
      await locked(tx);
      await tx.update(s.disbursementAttempts).set({ lastErrorCode: "SEND_OUTCOME_UNKNOWN" }).where(eq(s.disbursementAttempts.id, prepared.id));
    });
    return { state: "UNKNOWN" as const };
  }
  return serializable(db, async tx => {
    const claim = await locked(tx);
    const batchCreated = result.httpStatus === 201 && Boolean(result.batchId);
    const fundingRejected = !result.batchId && !result.itemId && result.httpStatus >= 400 && result.httpStatus < 500 && result.errorCode === "INSUFFICIENT_FUNDS";
    const state = batchCreated ? "SUBMITTED" : fundingRejected ? "FUNDING_REJECTED" : "UNKNOWN";
    // Preserve returned IDs even on an ambiguous HTTP result. IDs alone never settle a claim.
    await tx.update(s.disbursementAttempts).set({ state, payoutBatchId: result.batchId ?? null, payoutItemId: result.itemId ?? null, batchStatus: result.batchStatus ?? null, lastHttpStatus: result.httpStatus, lastErrorCode: safeCode(result.errorCode) ?? (state === "UNKNOWN" ? "SEND_OUTCOME_UNKNOWN" : null) }).where(eq(s.disbursementAttempts.id, prepared.id));
    // An automated send whose result is stored as known leaves a confirmation in the same transaction (review item 8). A crash or a database error before this point leaves none, which blocks automation.
    if (actorId === null && state !== "UNKNOWN") {
      const [sent] = await tx.select().from(s.automatedDecisions).innerJoin(s.disbursements, eq(s.disbursements.decisionHash, s.automatedDecisions.decisionHash))
        .where(and(eq(s.disbursements.id, prepared.disbursementId), eq(s.automatedDecisions.kind, "AUTO_SENT")));
      if (sent && sent.automated_decisions.rulesRunId && sent.automated_decisions.modelRunId && sent.automated_decisions.ruleSetVersion && sent.automated_decisions.model && sent.automated_decisions.promptVersion) {
        const a = sent.automated_decisions;
        await recordAutopilot(tx, a.decisionHash, "AUTO_SEND_CONFIRMED", { rulesRunId: a.rulesRunId!, modelRunId: a.modelRunId!, ruleSetVersion: a.ruleSetVersion!, model: a.model!, promptVersion: a.promptVersion! }, { state });
      }
    }
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
