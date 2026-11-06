import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import * as s from "../db/schema";
import { approveDecision, freezeDecision } from "../src/ledger/service";
import { sendClaimPayout, refreshClaimPayout } from "../src/ledger/payout";
import { authorizePayoutRetry, sendAuthorizedPayoutRetry } from "../src/ledger/retry";
import { openHistoricalReviews, resolveHistoricalReview } from "../src/ledger/historical-review";
import { handlePayPalWebhook } from "../src/server/webhook-handler";
import { createPayPalAdapter, type PersistedPayout, type PayoutTransport, type WebhookVerifier } from "../src/paypal/adapter";

const name = `aidtrace_iac139_test_${randomBytes(6).toString("hex")}`;
const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://aidtrace@db:5432/aidtrace"); adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 }); const testUrl = new URL(adminUrl); testUrl.pathname = `/${name}`;
const { db, client } = connectDatabase(testUrl.toString()); let created = false; let serial = 0;
beforeAll(async () => {
  await admin`create database ${admin(name)}`; created = true; await migrate(db, { migrationsFolder: "db/migrations" });
  await seedFixture(db, { passwords: { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") }, payeeEmail: "retry-test@personal.example.com", payeeAllowlist: ["retry-test@personal.example.com"] });
}, 30_000);
afterAll(async () => { await client.end(); if (created) await admin`drop database ${admin(name)}`; await admin.end(); });
async function claim() {
  const id = `retry-${++serial}`; const [template] = await db.select().from(s.claims).where(eq(s.claims.id, "C-104"));
  await db.insert(s.claims).values({ ...template!, id, status: "DRAFT" });
  await db.insert(s.claimLines).values({ claimId: id, claimVersion: 1, id: "snack", description: "Isolated retry test", category: "participant_meals", budgetLine: "other", amountCents: 100n });
  const decision = await freezeDecision(db, id, "maria"); if (decision.status !== "AWAITING_APPROVAL") throw new Error("Expected allocation");
  await approveDecision(db, decision.decisionId, "tara", decision.decisionHash); await approveDecision(db, decision.decisionId, "ben", decision.decisionHash);
  return { id, hash: decision.decisionHash, decisionId: decision.decisionId };
}
const attempt = async (claimId: string) => {
  const [disbursement] = await db.select().from(s.disbursements).where(eq(s.disbursements.claimId, claimId));
  return (await db.select().from(s.disbursementAttempts).where(eq(s.disbursementAttempts.disbursementId, disbursement!.id)).orderBy(sql`${s.disbursementAttempts.attemptNumber} desc`))[0]!;
};
const journals = () => db.select().from(s.journalEntries).orderBy(s.journalEntries.id);
const recognition = (decisionId: string) => db.select().from(s.journalEntries).where(eq(s.journalEntries.sourceId, decisionId)).orderBy(s.journalEntries.id);
function transport() {
  const sent = new Map<string, PersistedPayout>();
  const state = { itemStatus: "FAILED", batchStatus: "SUCCESS", amountCents: 100n };
  const provider = {
    validatePayout: createPayPalAdapter({ baseUrl: "https://api-m.sandbox.paypal.com", clientId: "synthetic", clientSecret: "synthetic", payeeAllowlist: ["retry-test@personal.example.com"], maxDemoPayoutCents: 50000n }, vi.fn()).validatePayout,
    balance: vi.fn<PayoutTransport["balance"]>().mockResolvedValue({ readable: false }),
    send: vi.fn<PayoutTransport["send"]>(async payout => {
      const [saved] = await client`select state,sender_batch_id from disbursement_attempts where sender_batch_id=${payout.senderBatchId}`;
      expect(saved).toMatchObject({ state: "UNKNOWN", sender_batch_id: payout.senderBatchId });
      const id = `BATCH_${++serial}`; sent.set(id, payout); return { httpStatus: 201, batchId: id, batchStatus: "PENDING" };
    }),
    batch: vi.fn<PayoutTransport["batch"]>(async id => ({ httpStatus: 200, batchId: id, senderBatchId: sent.get(id)?.senderBatchId, batchStatus: state.batchStatus, itemIds: [`ITEM_${id}`] })),
    item: vi.fn<PayoutTransport["item"]>(async id => {
      const batchId = id.replace(/^ITEM_/, ""); const payout = sent.get(batchId);
      return { httpStatus: 200, itemId: id, batchId, senderBatchId: payout?.senderBatchId, senderItemId: payout?.senderItemId, payeeEmail: payout?.payeeEmail, amountCents: state.amountCents, itemStatus: state.itemStatus, feeCents: 0n };
    }),
    verifyWebhook: vi.fn<WebhookVerifier["verifyWebhook"]>().mockResolvedValue({ httpStatus: 200, verificationStatus: "SUCCESS" }),
  } satisfies PayoutTransport & WebhookVerifier;
  return { provider, state };
}
async function failed() { const c = await claim(); const stub = transport(); await sendClaimPayout(db, c.id, "tara", c.hash, stub.provider); await refreshClaimPayout(db, c.id, "ben", stub.provider); return { ...c, ...stub, old: await attempt(c.id) }; }
function webhook(stub: ReturnType<typeof transport>["provider"], body: unknown) {
  return handlePayPalWebhook(new Request("http://127.0.0.1:3100/api/webhooks/paypal", { method: "POST", headers: { "content-type": "application/json", "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test", "paypal-transmission-id": "test-transmission", "paypal-transmission-sig": "c3ludGhldGlj", "paypal-transmission-time": "2026-10-22T20:00:00Z" }, body: JSON.stringify(body) }), { db, provider: () => stub, webhookId: "TESTREGISTERED123" });
}
const event = (old: Awaited<ReturnType<typeof attempt>>, id = `WH-TEST-${++serial}`) => ({ id, event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", resource: { payout_batch_id: old.payoutBatchId, payout_item_id: old.payoutItemId ?? `ITEM_${old.payoutBatchId}`, transaction_status: "SUCCESS", amount: { value: "999999.00", currency: "USD" } } });

describe("IAC-139 PostgreSQL with explicitly stubbed PayPal", () => {
  it("LED-02: binds one retry to the unchanged claim and preserves recognition/approvals", async () => {
    const c = await failed(); const before = await recognition(c.decisionId); const approvals = await db.select().from(s.approvals).where(eq(s.approvals.decisionHash, c.hash));
    await expect(authorizePayoutRetry(db, c.id, "maria", c.hash, c.old.id)).rejects.toThrow("approver");
    await expect(authorizePayoutRetry(db, c.id, "tara", "0".repeat(64), c.old.id)).rejects.toThrow("decision");
    await expect(authorizePayoutRetry(db, c.id, "tara", c.hash, "00000000-0000-4000-8000-000000000000")).rejects.toThrow("current failed");
    const auth = await authorizePayoutRetry(db, c.id, "tara", c.hash, c.old.id);
    expect(auth.attemptNumber).toBe(2); expect(await recognition(c.decisionId)).toEqual(before);
    await expect(authorizePayoutRetry(db, c.id, "ben", c.hash, c.old.id)).rejects.toThrow("already authorized");
    await expect(db.update(s.retryAuthorizations).set({ amountCents: 99n }).where(eq(s.retryAuthorizations.id, auth.authorizationId))).rejects.toThrow();
    await expect(sendAuthorizedPayoutRetry(db, c.id, "ben", c.hash, "00000000-0000-4000-8000-000000000000", c.provider)).rejects.toThrow("authorization");
    const results = await Promise.allSettled([sendAuthorizedPayoutRetry(db, c.id, "ben", c.hash, auth.authorizationId, c.provider), sendAuthorizedPayoutRetry(db, c.id, "tara", c.hash, auth.authorizationId, c.provider)]);
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1); expect(c.provider.send).toHaveBeenCalledTimes(2);
    const next = await attempt(c.id); expect(next.attemptNumber).toBe(2); expect(next.senderBatchId).toBe(`AT-${next.disbursementId}-2`); expect(next.senderBatchId).not.toBe(c.old.senderBatchId);
    expect(next.amountCents).toBe(100n); expect(next.payeeEmail).toBe(c.old.payeeEmail);
    expect(await recognition(c.decisionId)).toEqual(before); expect(await db.select().from(s.approvals).where(eq(s.approvals.decisionHash, c.hash))).toEqual(approvals);
    await expect(sendAuthorizedPayoutRetry(db, c.id, "ben", c.hash, auth.authorizationId, c.provider)).rejects.toThrow("not retryable");
  });
  it.each(["UNCLAIMED", "ONHOLD", "PENDING", "REFUNDED", "REVERSED", "UNMAPPED_STATUS"])("LED-02: %s leaves the obligation open and forbids retry", async itemStatus => {
    const c = await claim(); const { provider, state } = transport(); state.itemStatus = itemStatus;
    await sendClaimPayout(db, c.id, "tara", c.hash, provider); const before = await journals(); await refreshClaimPayout(db, c.id, "ben", provider);
    await expect(authorizePayoutRetry(db, c.id, "tara", c.hash, (await attempt(c.id)).id)).rejects.toThrow("not retryable");
    expect(await journals()).toEqual(before); expect(provider.send).toHaveBeenCalledTimes(1);
  });
  it("LED-02: UNKNOWN never authorizes another sender ID", async () => {
    const c = await claim(); const { provider } = transport(); provider.send.mockRejectedValue(new Error("synthetic timeout"));
    await sendClaimPayout(db, c.id, "tara", c.hash, provider); const old = await attempt(c.id);
    await expect(authorizePayoutRetry(db, c.id, "ben", c.hash, old.id)).rejects.toThrow("not retryable");
    expect((await attempt(c.id)).senderBatchId).toBe(old.senderBatchId); expect(provider.send).toHaveBeenCalledTimes(1);
  });
  it.each(["RETURNED", "BLOCKED"])("LED-02: %s permits only a separately authorized retry", async itemStatus => {
    const c = await claim(); const { provider, state } = transport(); state.itemStatus = itemStatus;
    await sendClaimPayout(db, c.id, "tara", c.hash, provider); await refreshClaimPayout(db, c.id, "ben", provider);
    expect((await authorizePayoutRetry(db, c.id, "tara", c.hash, (await attempt(c.id)).id)).attemptNumber).toBe(2);
  });
  it("checks funding again and refuses a short balance without consuming the authorization", async () => {
    const c = await failed(); const auth = await authorizePayoutRetry(db, c.id, "tara", c.hash, c.old.id);
    c.provider.balance.mockResolvedValue({ readable: true, availableCents: 99n });
    await expect(sendAuthorizedPayoutRetry(db, c.id, "ben", c.hash, auth.authorizationId, c.provider)).rejects.toThrow("short");
    expect((await attempt(c.id)).attemptNumber).toBe(1); expect(c.provider.send).toHaveBeenCalledTimes(1);
  });
  it("database refuses an unauthorized new attempt", async () => {
    const c = await failed();
    await expect(db.insert(s.disbursementAttempts).values({ disbursementId: c.old.disbursementId, attemptNumber: 2, senderBatchId: `AT-${c.old.disbursementId}-2`, senderItemId: `AT-${c.old.disbursementId}-2-1`, amountCents: 100n, payeeEmail: c.old.payeeEmail, state: "UNKNOWN" })).rejects.toThrow();
  });
  it.each(["DENIED", "CANCELED", "INSUFFICIENT_FUNDS"])("LED-02: %s leaves recognition intact and allows separate authorization", async outcome => {
    const c = await claim(); const { provider } = transport();
    if (outcome === "INSUFFICIENT_FUNDS") provider.send.mockResolvedValue({ httpStatus: 400, errorCode: outcome });
    await sendClaimPayout(db, c.id, "tara", c.hash, provider);
    const before = await recognition(c.decisionId);
    if (outcome !== "INSUFFICIENT_FUNDS") {
      const old = await attempt(c.id); provider.batch.mockResolvedValue({ httpStatus: 200, batchId: old.payoutBatchId!, senderBatchId: old.senderBatchId, batchStatus: outcome, itemIds: [] });
      await refreshClaimPayout(db, c.id, "ben", provider);
    }
    expect((await authorizePayoutRetry(db, c.id, "tara", c.hash, (await attempt(c.id)).id)).attemptNumber).toBe(2);
    expect(await recognition(c.decisionId)).toEqual(before);
  });
  it("PAY-03: signature failure, simulator, unsupported and oversized events do not affect journals", async () => {
    const c = await failed(); const before = await journals();
    c.provider.verifyWebhook.mockResolvedValue({ httpStatus: 200, verificationStatus: "FAILURE" });
    expect((await webhook(c.provider, event(c.old))).status).toBe(400);
    expect((await webhook(c.provider, { ...event(c.old), simulator: true })).status).toBe(400);
    expect((await webhook(c.provider, { ...event(c.old), id: "SIMULATED-EVENT" })).status).toBe(400);
    expect((await webhook(c.provider, { ...event(c.old), event_type: "UNRECOGNIZED" })).status).toBe(400);
    expect((await webhook(c.provider, { ...event(c.old), padding: "a".repeat(65537) })).status).toBe(413);
    expect(c.provider.verifyWebhook).toHaveBeenCalledTimes(1); expect(await journals()).toEqual(before);
    expect((await db.select().from(s.providerEvents))).toHaveLength(0);
  });
  it("PAY-03: verified payload success cannot settle an independently pending item", async () => {
    const c = await failed(); c.state.itemStatus = "PENDING"; const before = await journals();
    expect((await webhook(c.provider, event(c.old))).status).toBe(204); expect(await journals()).toEqual(before);
    expect((await attempt(c.id)).state).toBe("PENDING");
  });
  it("PAY-03: verified completion fetches independently; concurrent and later replays post once", async () => {
    const c = await failed(); c.state.itemStatus = "SUCCESS"; const body = event(c.old); const before = (await journals()).length;
    const results = await Promise.all([webhook(c.provider, body), webhook(c.provider, body)]); expect(results.map(row => row.status)).toEqual([204, 204]);
    expect((await attempt(c.id)).state).toBe("SETTLED"); expect((await journals()).length).toBe(before + 1);
    const calls = c.provider.item.mock.calls.length; expect((await webhook(c.provider, body)).status).toBe(204); expect(c.provider.item).toHaveBeenCalledTimes(calls);
    expect((await db.select().from(s.providerEvents).where(eq(s.providerEvents.eventId, body.id)))).toHaveLength(1);
    await expect(db.delete(s.providerEvents).where(eq(s.providerEvents.eventId, body.id))).rejects.toThrow();
  });
  it("rejects a verified resource mismatch without recording or posting the event", async () => {
    const c = await failed(); c.state.itemStatus = "SUCCESS"; const body = event(c.old); body.resource.payout_item_id = "WRONG_ITEM";
    const before = await journals(); expect((await webhook(c.provider, body)).status).toBe(503); expect(await journals()).toEqual(before);
    expect((await db.select().from(s.providerEvents).where(eq(s.providerEvents.eventId, body.id)))).toHaveLength(0);
  });
  // Option A (November 5): a verified event for an earlier attempt after a retry is recorded for review and never overwrites the latest attempt.
  const claimRow = async (claimId: string) => (await db.select().from(s.claims).where(eq(s.claims.id, claimId)))[0]!;
  const reviewsOf = (disbursementId: string) => db.select().from(s.historicalEventReviews).where(eq(s.historicalEventReviews.disbursementId, disbursementId));
  const resolutionsOf = (reviewId: string) => db.select().from(s.historicalEventReviewResolutions).where(eq(s.historicalEventReviewResolutions.reviewId, reviewId));
  async function retried(options: { send?: "OK" | "UNKNOWN_WITH_BATCH" } = {}) {
    const c = await failed(); const auth = await authorizePayoutRetry(db, c.id, "tara", c.hash, c.old.id);
    if (options.send === "UNKNOWN_WITH_BATCH") { const original = c.provider.send.getMockImplementation()!; c.provider.send.mockImplementationOnce(async payout => ({ ...await original(payout), httpStatus: 500 })); }
    await sendAuthorizedPayoutRetry(db, c.id, "ben", c.hash, auth.authorizationId, c.provider);
    return c;
  }
  const NOTE = "Checked both attempts in the PayPal sandbox activity page.";
  it("HWR-01: an event for the old attempt after a retry leaves the latest attempt and claim as they were, adds one review, posts nothing, and a replay adds no second row", async () => {
    const c = await retried(); const latest = await attempt(c.id); const claimBefore = await claimRow(c.id); const before = await journals();
    expect(latest.attemptNumber).toBe(2); const body = event(c.old);
    expect((await webhook(c.provider, body)).status).toBe(204);
    expect(await attempt(c.id)).toEqual(latest); expect(await claimRow(c.id)).toEqual(claimBefore); expect(await journals()).toEqual(before);
    const rows = await reviewsOf(c.old.disbursementId); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ claimId: c.id, claimVersion: claimBefore.version, eventAttemptId: c.old.id, latestAttemptId: latest.id, latestStateAtEvent: latest.state });
    expect(await resolutionsOf(rows[0]!.id)).toHaveLength(0);
    expect((await webhook(c.provider, body)).status).toBe(204);
    expect(await reviewsOf(c.old.disbursementId)).toHaveLength(1); expect(await attempt(c.id)).toEqual(latest); expect(await journals()).toEqual(before);
    expect((await openHistoricalReviews(db, c.id)).map(row => row.eventAttemptNumber)).toEqual([1]);
  });
  it("HWR-02: a latest UNKNOWN attempt stays UNKNOWN after the historical event and a later refresh still polls it", async () => {
    const c = await retried({ send: "UNKNOWN_WITH_BATCH" }); const latest = await attempt(c.id); expect(latest.state).toBe("UNKNOWN"); expect(latest.payoutBatchId).toBeTruthy();
    const before = await journals(); expect((await webhook(c.provider, event(c.old))).status).toBe(204);
    expect(await attempt(c.id)).toEqual(latest); expect((await claimRow(c.id)).status).toBe("PAYOUT_PROCESSING"); expect(await journals()).toEqual(before);
    expect(await reviewsOf(c.old.disbursementId)).toHaveLength(1);
    c.state.itemStatus = "PENDING";
    expect((await refreshClaimPayout(db, c.id, "ben", c.provider)).state).toBe("PENDING");
    expect((await attempt(c.id)).state).toBe("PENDING"); expect(await journals()).toEqual(before);
  });
  it("HWR-03: a latest SETTLED attempt stays SETTLED and the claim stays PAID after the historical event, with journals unchanged and one open review", async () => {
    const c = await retried(); c.state.itemStatus = "SUCCESS"; await refreshClaimPayout(db, c.id, "ben", c.provider);
    const latest = await attempt(c.id); expect(latest.state).toBe("SETTLED"); expect((await claimRow(c.id)).status).toBe("PAID");
    const before = await journals(); expect((await webhook(c.provider, event(c.old))).status).toBe(204);
    expect(await attempt(c.id)).toEqual(latest); expect((await claimRow(c.id)).status).toBe("PAID"); expect(await journals()).toEqual(before);
    expect(await openHistoricalReviews(db, c.id)).toHaveLength(1);
  });
  it("HWR-04: a latest PENDING attempt takes the historical event unchanged, then settles normally with exactly one settlement entry", async () => {
    const c = await retried(); c.state.itemStatus = "PENDING"; await refreshClaimPayout(db, c.id, "ben", c.provider);
    const pending = await attempt(c.id); expect(pending.state).toBe("PENDING");
    const before = await journals(); expect((await webhook(c.provider, event(c.old))).status).toBe(204);
    expect(await attempt(c.id)).toEqual(pending); expect(await journals()).toEqual(before); expect(await openHistoricalReviews(db, c.id)).toHaveLength(1);
    c.state.itemStatus = "SUCCESS"; expect((await refreshClaimPayout(db, c.id, "ben", c.provider)).state).toBe("SETTLED");
    const after = await journals(); expect(after.length).toBe(before.length + 1);
    expect(after.filter(row => row.sourceType === "paypal_payout_item" && row.purpose === "settlement" && row.sourceId === `ITEM_${pending.payoutBatchId}`)).toHaveLength(1);
    expect((await claimRow(c.id)).status).toBe("PAID");
  });
  it("HWR-05: an open review blocks retry authorization until an approver records the reconciliation", async () => {
    const c = await retried(); await refreshClaimPayout(db, c.id, "ben", c.provider);
    const latest = await attempt(c.id); expect(latest).toMatchObject({ attemptNumber: 2, state: "FAILED" });
    expect((await webhook(c.provider, event(c.old))).status).toBe(204);
    const [review] = await reviewsOf(c.old.disbursementId); expect(review).toBeTruthy();
    await expect(authorizePayoutRetry(db, c.id, "tara", c.hash, latest.id)).rejects.toThrow("An open historical PayPal event review prevents retry; reconcile it first");
    await resolveHistoricalReview(db, review!.id, "ben", NOTE);
    expect(await openHistoricalReviews(db, c.id)).toHaveLength(0);
    expect((await authorizePayoutRetry(db, c.id, "tara", c.hash, latest.id)).attemptNumber).toBe(3);
  });
  it("HWR-05: sendAuthorizedPayoutRetry also refuses while a review is open", async () => {
    const c = await retried(); await refreshClaimPayout(db, c.id, "ben", c.provider);
    const auth = await authorizePayoutRetry(db, c.id, "tara", c.hash, (await attempt(c.id)).id);
    await webhook(c.provider, event(c.old)); const sends = c.provider.send.mock.calls.length;
    await expect(sendAuthorizedPayoutRetry(db, c.id, "ben", c.hash, auth.authorizationId, c.provider)).rejects.toThrow("open historical PayPal event review");
    expect(c.provider.send).toHaveBeenCalledTimes(sends);
  });
  it("HWR-06: resolution refuses a claimant, a non-approver, an approver of another organization, a short note, an overlong note and a second resolution, and writes nothing", async () => {
    const c = await retried(); await webhook(c.provider, event(c.old));
    const [review] = await reviewsOf(c.old.disbursementId); const claim = await claimRow(c.id);
    await db.insert(s.organizations).values({ id: "hwr-other", name: "Private other organization", prohibitedCategories: [], openingSourceType: "fixture_opening_balance" }).onConflictDoNothing();
    await db.insert(s.users).values([
      { id: "hwr-claimant2", organizationId: claim.organizationId, username: "hwr-claimant2", displayName: "Second Claimant", role: "CLAIMANT", passwordHash: "not-a-real-hash" },
      { id: "hwr-approver-other", organizationId: "hwr-other", username: "hwr-approver-other", displayName: "Other Approver", role: "APPROVER", passwordHash: "not-a-real-hash" },
    ]).onConflictDoNothing();
    const count = async () => (await db.select().from(s.historicalEventReviewResolutions)).length; const start = await count();
    await expect(resolveHistoricalReview(db, review!.id, claim.claimantId, NOTE)).rejects.toThrow("Independent authenticated approver required");
    await expect(resolveHistoricalReview(db, review!.id, "hwr-claimant2", NOTE)).rejects.toThrow("Independent authenticated approver required");
    await expect(resolveHistoricalReview(db, review!.id, "hwr-approver-other", NOTE)).rejects.toThrow("Independent authenticated approver required");
    await expect(resolveHistoricalReview(db, review!.id, "no-such-user", NOTE)).rejects.toThrow("Independent authenticated approver required");
    await expect(resolveHistoricalReview(db, review!.id, "ben", "too short")).rejects.toThrow("10 to 1000");
    await expect(resolveHistoricalReview(db, review!.id, "ben", `   ${"x".repeat(5)}   `)).rejects.toThrow("10 to 1000");
    await expect(resolveHistoricalReview(db, review!.id, "ben", "x".repeat(1001))).rejects.toThrow("10 to 1000");
    await expect(resolveHistoricalReview(db, "00000000-0000-4000-8000-000000000000", "ben", NOTE)).rejects.toThrow("not found");
    expect(await count()).toBe(start); expect(await openHistoricalReviews(db, c.id)).toHaveLength(1);
    await resolveHistoricalReview(db, review!.id, "ben", `  ${NOTE}  `);
    expect((await resolutionsOf(review!.id))[0]).toMatchObject({ resolvedBy: "ben", note: NOTE });
    await expect(resolveHistoricalReview(db, review!.id, "tara", NOTE)).rejects.toThrow("already resolved");
    expect(await count()).toBe(start + 1);
    // The reconciliation of the ledger supports one organization, so the extra rows are removed again before the next test.
    await db.delete(s.users).where(inArray(s.users.id, ["hwr-claimant2", "hwr-approver-other"])); await db.delete(s.organizations).where(eq(s.organizations.id, "hwr-other"));
  });
  it("HWR-06b: a claimant who holds the APPROVER role is still refused by the claimant check alone, and nothing is written", async () => {
    const c = await retried(); await webhook(c.provider, event(c.old));
    const [review] = await reviewsOf(c.old.disbursementId); const claim = await claimRow(c.id);
    const [original] = await db.select({ role: s.users.role }).from(s.users).where(eq(s.users.id, claim.claimantId));
    const count = async () => (await db.select().from(s.historicalEventReviewResolutions)).length; const start = await count();
    try {
      await db.update(s.users).set({ role: "APPROVER" }).where(eq(s.users.id, claim.claimantId));
      await expect(resolveHistoricalReview(db, review!.id, claim.claimantId, NOTE)).rejects.toThrow("Independent authenticated approver required");
      expect(await count()).toBe(start); expect(await openHistoricalReviews(db, c.id)).toHaveLength(1);
    } finally { await db.update(s.users).set({ role: original!.role }).where(eq(s.users.id, claim.claimantId)); }
    expect((await db.select({ role: s.users.role }).from(s.users).where(eq(s.users.id, claim.claimantId)))[0]!.role).toBe(original!.role);
  });
  it("HWR-07: both review tables are append-only (update, delete and truncate reject)", async () => {
    const c = await retried(); await webhook(c.provider, event(c.old));
    const [review] = await reviewsOf(c.old.disbursementId); await resolveHistoricalReview(db, review!.id, "ben", NOTE);
    const [resolution] = await resolutionsOf(review!.id);
    await expect(db.update(s.historicalEventReviews).set({ latestStateAtEvent: "SETTLED" }).where(eq(s.historicalEventReviews.id, review!.id))).rejects.toThrow();
    await expect(db.delete(s.historicalEventReviews).where(eq(s.historicalEventReviews.id, review!.id))).rejects.toThrow();
    await expect(db.update(s.historicalEventReviewResolutions).set({ note: "Rewritten note after the fact." }).where(eq(s.historicalEventReviewResolutions.id, resolution!.id))).rejects.toThrow();
    await expect(db.delete(s.historicalEventReviewResolutions).where(eq(s.historicalEventReviewResolutions.id, resolution!.id))).rejects.toThrow();
    await expect(client.unsafe("truncate historical_event_reviews cascade")).rejects.toThrow();
    await expect(client.unsafe("truncate historical_event_review_resolutions")).rejects.toThrow();
    expect(await reviewsOf(c.old.disbursementId)).toHaveLength(1); expect(await resolutionsOf(review!.id)).toHaveLength(1);
  });
});
