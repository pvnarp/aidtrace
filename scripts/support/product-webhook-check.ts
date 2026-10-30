import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../../src/server/db";
import * as s from "../../db/schema";
import { seedFixture } from "../../db/fixture";
import { approveDecision, freezeDecision } from "../../src/ledger/service";
import { reconcile } from "../../src/ledger/reconcile";
import type { WebhookRegistration } from "../../src/paypal/adapter";

export const CHECK_CLAIM = "WH-001";
export function registeredWebhookMatches(value: WebhookRegistration, id: string, url: string) {
  return value.httpStatus === 200 && value.id === id && value.url === url && (value.eventTypes.includes("*") || value.eventTypes.includes("PAYMENT.PAYOUTS-ITEM.SUCCEEDED"));
}
export function checkDatabaseName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !/^aidtrace_product_webhook_[a-f0-9]{12}$/.test(name)) throw new Error("Dedicated webhook acceptance database required");
}
export async function assertCheckDatabase(db: AppDatabase) {
  const rows = await db.execute(sql`select current_database() as name`); checkDatabaseName(rows[0]?.name);
}
export async function prepareWebhookCheck(db: AppDatabase, payeeEmail: string, payeeAllowlist: string[]) {
  await assertCheckDatabase(db);
  if (!payeeEmail || payeeEmail.endsWith(".invalid") || !payeeAllowlist.includes(payeeEmail)) throw new Error("Configured sandbox recipient required");
  await seedFixture(db, { passwords: { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") }, payeeEmail, payeeAllowlist });
  const [template] = await db.select().from(s.claims).where(eq(s.claims.id, "C-104"));
  if (!template) throw new Error("Fixture template missing");
  // This extra synthetic expense lives only in the dedicated acceptance database.
  // Service-level actors below are not new human browser approvals.
  await db.transaction(async tx => {
    await tx.insert(s.claims).values({ ...template, id: CHECK_CLAIM, vendor: "One-dollar sandbox webhook acceptance", status: "DRAFT" });
    await tx.insert(s.claimLines).values({ claimId: CHECK_CLAIM, claimVersion: 1, id: "WH1", description: "Synthetic webhook acceptance expense", category: "participant_meals", budgetLine: "other", amountCents: 100n });
  });
  const decision = await freezeDecision(db, CHECK_CLAIM, "maria");
  if (decision.status !== "AWAITING_APPROVAL") throw new Error("Acceptance allocation failed");
  await approveDecision(db, decision.decisionId, "tara", decision.decisionHash);
  await approveDecision(db, decision.decisionId, "ben", decision.decisionHash);
  return readWebhookCheck(db);
}
export async function readWebhookCheck(db: AppDatabase) {
  await assertCheckDatabase(db);
  return db.transaction(async tx => {
    await tx.execute(sql`set transaction read only`);
    const [claim] = await tx.select({ id: s.claims.id, status: s.claims.status }).from(s.claims).where(eq(s.claims.id, CHECK_CLAIM));
    const [decision] = await tx.select({ decisionHash: s.allocationDecisions.decisionHash }).from(s.allocationDecisions).where(eq(s.allocationDecisions.claimId, CHECK_CLAIM));
    const [disbursement] = await tx.select({ id: s.disbursements.id }).from(s.disbursements).where(eq(s.disbursements.claimId, CHECK_CLAIM));
    const attempts = disbursement ? await tx.select({ state: s.disbursementAttempts.state, senderBatchId: s.disbursementAttempts.senderBatchId, batchId: s.disbursementAttempts.payoutBatchId, itemId: s.disbursementAttempts.payoutItemId, itemStatus: s.disbursementAttempts.itemStatus, feeCents: s.disbursementAttempts.feeCents, error: s.disbursementAttempts.lastErrorCode }).from(s.disbursementAttempts).where(eq(s.disbursementAttempts.disbursementId, disbursement.id)) : [];
    const events = await tx.select({ eventId: s.providerEvents.eventId, eventType: s.providerEvents.eventType, verificationStatus: s.providerEvents.verificationStatus, resourceId: s.providerEvents.resourceId, processedAt: s.providerEvents.processedAt }).from(s.providerEvents);
    const ledger = await reconcile(tx, "cedar-hollow");
    return { claim, decisionHash: decision?.decisionHash, attempts, events, ledger: { matches: ledger.matches, openPayableCents: ledger.openPayableCents, bookCashCents: ledger.bookCashCents }, providerRequestsMadeByStatus: 0 };
  });
}
export async function requireUnsentDollarClaim(db: AppDatabase) {
  await assertCheckDatabase(db);
  const status = await readWebhookCheck(db);
  const lines = await db.select({ amount: s.claimLines.amountCents }).from(s.claimLines).where(and(eq(s.claimLines.claimId, CHECK_CLAIM), eq(s.claimLines.claimVersion, 1)));
  if (status.claim?.status !== "APPROVED" || !status.decisionHash || status.attempts.length || lines.length !== 1 || lines[0]!.amount !== 100n || status.ledger.openPayableCents !== 100n) throw new Error("One unsent approved dollar obligation required; never resend an uncertain attempt");
  return status.decisionHash;
}
