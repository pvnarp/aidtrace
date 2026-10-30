import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import * as s from "../db/schema";
import { approveDecision, freezeDecision } from "../src/ledger/service";
import { sendClaimPayout, refreshClaimPayout } from "../src/ledger/payout";
import { authorizePayoutRetry, sendAuthorizedPayoutRetry } from "../src/ledger/retry";
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
  it("flags historical-attempt delivery after a retry for manual reconciliation without posting", async () => {
    const c = await failed(); const auth = await authorizePayoutRetry(db, c.id, "tara", c.hash, c.old.id);
    await sendAuthorizedPayoutRetry(db, c.id, "ben", c.hash, auth.authorizationId, c.provider);
    const before = await journals(); expect((await webhook(c.provider, event(c.old))).status).toBe(204);
    expect((await attempt(c.id)).state).toBe("MANUAL_REVIEW"); expect(await journals()).toEqual(before);
  });
});
