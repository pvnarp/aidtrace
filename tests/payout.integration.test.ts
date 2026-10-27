import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { authenticate } from "../src/server/auth";
import { seedFixture } from "../db/fixture";
import * as s from "../db/schema";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { approveDecision, freezeDecision } from "../src/ledger/service";
import { sendClaimPayout, refreshClaimPayout } from "../src/ledger/payout";
import { reconcile } from "../src/ledger/reconcile";
import { handleClaimAction } from "../src/server/claim-actions";
import { loadClaimView } from "../src/server/claim-view";
import { readGateAEvidence } from "../src/server/gate-a-evidence";
import { createPayPalAdapter, type PersistedPayout, type PayoutItemResult, type PayoutTransport } from "../src/paypal/adapter";

const databaseName = `aidtrace_iac136_test_${randomBytes(6).toString("hex")}`;
const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://aidtrace@db:5432/aidtrace"); adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 }); const testUrl = new URL(adminUrl); testUrl.pathname = `/${databaseName}`;
const { db, client } = connectDatabase(testUrl.toString());
const passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
let created = false; let serial = 0;
const cookies: Record<string, string> = {};
const journalCount = async () => (await db.select().from(s.journalEntries)).length;
const claimRow = async (id: string) => (await db.select().from(s.claims).where(eq(s.claims.id, id)))[0]!;
async function recognizedClaim(prefix: string) {
  const id = `${prefix}-${++serial}`; const original = await claimRow("C-104");
  await db.insert(s.claims).values({ ...original, id, status: "DRAFT" });
  await db.insert(s.claimLines).values({ claimId: id, claimVersion: 1, id: "test-line", description: "Payout test only", category: "hospitality", budgetLine: "hospitality", amountCents: 100n });
  const frozen = await freezeDecision(db, id, "maria"); if (frozen.status !== "AWAITING_APPROVAL") throw new Error("Test must be funded");
  await approveDecision(db, frozen.decisionId, "tara", frozen.decisionHash); await approveDecision(db, frozen.decisionId, "ben", frozen.decisionHash);
  return { id, hash: frozen.decisionHash };
}
function transport() {
  const number = ++serial; let sent: PersistedPayout | undefined;
  const itemPatch: Partial<PayoutItemResult> = {};
  const validatePayout = createPayPalAdapter({ baseUrl: "https://api-m.sandbox.paypal.com", clientId: "synthetic", clientSecret: "synthetic", payeeAllowlist: ["payout-test@personal.example.com"], maxDemoPayoutCents: 50000n }, vi.fn()).validatePayout;
  const provider = {
    validatePayout: vi.fn(validatePayout),
    balance: vi.fn<PayoutTransport["balance"]>().mockResolvedValue({ readable: false }),
    send: vi.fn<PayoutTransport["send"]>(async payout => {
      sent = payout;
      // Independent connection observes the committed IDs before any simulated request.
      const [stored] = await client`select state,sender_batch_id,sender_item_id from disbursement_attempts where sender_batch_id=${payout.senderBatchId}`;
      expect(stored).toMatchObject({ state: "UNKNOWN", sender_batch_id: payout.senderBatchId, sender_item_id: payout.senderItemId });
      return { httpStatus: 201, batchId: `BATCH_${number}`, batchStatus: "PENDING" };
    }),
    batch: vi.fn<PayoutTransport["batch"]>(async () => ({ httpStatus: 200, batchId: `BATCH_${number}`, senderBatchId: sent?.senderBatchId, batchStatus: "SUCCESS", itemIds: [`ITEM_${number}`] })),
    item: vi.fn<PayoutTransport["item"]>(async () => ({ httpStatus: 200, itemId: `ITEM_${number}`, batchId: `BATCH_${number}`, senderBatchId: sent?.senderBatchId, senderItemId: sent?.senderItemId, payeeEmail: sent?.payeeEmail, amountCents: sent?.amountCents, itemStatus: "SUCCESS", feeCents: 25n, processedOn: "2026-10-22", ...itemPatch })),
  } satisfies PayoutTransport;
  return { provider, itemPatch, itemId: `ITEM_${number}` };
}
function action(user: string | undefined, body: Record<string, string>, origin = "http://127.0.0.1:3100", provider: PayoutTransport = transport().provider) {
  return handleClaimAction(new Request("http://127.0.0.1:3100/api/claims/C-104/actions", { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded", ...(user ? { cookie: cookies[user]! } : {}) }, body: new URLSearchParams(body) }), "C-104", { db, provider: () => provider });
}
beforeAll(async () => {
  await admin`create database ${admin(databaseName)}`; created = true;
  await migrate(db, { migrationsFolder: "db/migrations" }); await migrate(db, { migrationsFolder: "db/migrations" });
  await seedFixture(db, { passwords, payeeEmail: "payout-test@personal.example.com", payeeAllowlist: ["payout-test@personal.example.com"] });
  await db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  process.env.APP_ORIGIN = "http://127.0.0.1:3100";
  for (const user of ["maria", "tara", "ben"] as const) { const session = await authenticate(user, passwords[user], db); cookies[user] = `aidtrace_session=${session!.token}`; }
}, 30_000);
afterAll(async () => { await client.end(); if (created) await admin`drop database ${admin(databaseName)}`; await admin.end(); });

describe("IAC-136 HTTP-to-ledger journey with stubbed provider", () => {
  it("reports draft readiness without private fields, mutations or provider verification claims", async () => {
    const before = await journalCount(); const summary = await readGateAEvidence(db);
    expect(summary).toMatchObject({ source: "LOCAL_APPLICATION_DATABASE", providerRequestsMade: 0, claim: { status: "DRAFT" }, payout: null, approvedBy: [], nextStep: "MARIA_FREEZE_ALLOCATION" });
    const text = JSON.stringify(summary);
    expect(text).not.toContain("payout-test@personal.example.com");
    for (const password of Object.values(passwords)) expect(text).not.toContain(password);
    expect(text).not.toContain("passwordHash"); expect(text).not.toContain("payeeEmail");
    expect(await journalCount()).toBe(before);
  });
  it("enforces session, origin and server role before financial actions or provider access", async () => {
    const { provider } = transport();
    expect((await action(undefined, { action: "freeze" }, undefined, provider)).status).toBe(401);
    expect((await action("maria", { action: "freeze" }, "https://untrusted.example", provider)).status).toBe(403);
    expect((await action("maria", { action: "send", role: "APPROVER", confirmSandbox: "yes", decisionHash: "0".repeat(64) }, undefined, provider)).status).toBe(403);
    expect((await action("tara", { action: "freeze" }, undefined, provider)).status).toBe(403);
    expect(provider.balance).not.toHaveBeenCalled(); expect(provider.send).not.toHaveBeenCalled();
  });
  it("walks Maria freeze, Tara approval, Ben approval and explicit sandbox send", async () => {
    const preview = await loadClaimView(db, "C-104", "maria");
    expect(preview.generalCents).toBe(7000n); expect(preview.comparison?.unrestrictedCents).toBe("20000");
    expect((await action("maria", { action: "freeze" })).headers.get("location")).toContain("notice=frozen");
    const [decision] = await db.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.claimId, "C-104"));
    const form = { action: "approve", decisionId: decision!.id, decisionHash: decision!.decisionHash };
    expect((await action("tara", form)).headers.get("location")).toContain("approval-saved");
    expect((await action("ben", form)).headers.get("location")).toContain("notice=approved");
    expect((await claimRow("C-104")).status).toBe("APPROVED");
    const view = await loadClaimView(db, "C-104", "ben");
    expect(view.comparison?.unrestrictedCents).toBe("20000"); expect(view.generalCents).toBe(7000n);
    const { provider } = primary;
    expect((await action("ben", { action: "send", decisionHash: decision!.decisionHash }, undefined, provider)).status).toBe(400);
    const before = await journalCount();
    expect((await action("ben", { action: "send", decisionHash: decision!.decisionHash, confirmSandbox: "yes" }, undefined, provider)).headers.get("location")).toContain("notice=submitted");
    expect((await claimRow("C-104")).status).toBe("PAYOUT_PROCESSING"); expect(await journalCount()).toBe(before);
    const [attempt] = await db.select().from(s.disbursementAttempts);
    expect(attempt!.senderBatchId).toBe(`AT-${attempt!.disbursementId}-1`); expect(attempt!.senderItemId).toBe(`${attempt!.senderBatchId}-1`);
    expect(provider.send).toHaveBeenCalledTimes(1);
  });
  const primary = transport();
  it("LED-03: independent item success twice posts one settlement and one exact reported fee", async () => {
    const before = await journalCount();
    expect((await action("tara", { action: "refresh" }, undefined, primary.provider)).status).toBe(303);
    expect((await claimRow("C-104")).status).toBe("PAID");
    expect(primary.provider.batch).toHaveBeenCalledTimes(1); expect(primary.provider.item).toHaveBeenCalledTimes(1);
    await action("ben", { action: "refresh" }, undefined, primary.provider);
    expect(await journalCount()).toBe(before + 2);
    const entries = await db.select().from(s.journalEntries).where(eq(s.journalEntries.sourceId, primary.itemId));
    expect(entries.map(row => row.purpose).sort()).toEqual(["payout_fee", "settlement"]);
    expect(entries.every(row => row.effectiveOn === "2026-10-22")).toBe(true);
    const fees = await db.select().from(s.fundDebits).where(eq(s.fundDebits.purpose, "payout_fee"));
    expect(fees.map(row => row.amountCents)).toEqual([25n]);
    const report = await db.transaction(tx => reconcile(tx, "cedar-hollow"));
    expect(report).toMatchObject({ matches: true, openPayableCents: 0n, restrictedCents: 7000n, generalCents: 92975n, bookCashCents: 99975n });
    const summary = await readGateAEvidence(db);
    expect(summary).toMatchObject({ source: "LOCAL_APPLICATION_DATABASE", providerRequestsMade: 0, claim: { status: "PAID" }, approvedBy: ["ben", "tara"], recognized: true, payout: { itemId: primary.itemId, itemStatus: "SUCCESS", feeCents: "25" }, ledger: { matches: true, openPayableCents: "0", settlementEntries: 1, feeEntries: 1 }, nextStep: "OWNER_REVIEW_AND_RECORD_DEMO" });
    await expect(db.update(s.disbursementAttempts).set({ senderBatchId: "changed" })).rejects.toThrow();
    await expect(db.delete(s.disbursements)).rejects.toThrow();
  });
  it("ignores regressive pending after settlement and keeps refund/reversal in manual review", async () => {
    primary.itemPatch.itemStatus = "PENDING";
    expect((await refreshClaimPayout(db, "C-104", "tara", primary.provider)).state).toBe("SETTLED");
    expect((await claimRow("C-104")).status).toBe("PAID");
    const before = await journalCount(); primary.itemPatch.itemStatus = "REVERSED";
    expect((await refreshClaimPayout(db, "C-104", "ben", primary.provider)).state).toBe("MANUAL_REVIEW");
    primary.itemPatch.itemStatus = "SUCCESS";
    expect((await refreshClaimPayout(db, "C-104", "ben", primary.provider)).state).toBe("MANUAL_REVIEW");
    expect((await claimRow("C-104")).status).toBe("PAYOUT_ISSUE"); expect(await journalCount()).toBe(before);
  });
  it("refuses a readable short balance without persisting an attempt or making a POST", async () => {
    const claim = await recognizedClaim("short-balance"); const { provider } = transport();
    provider.balance.mockResolvedValue({ readable: true, availableCents: 99n });
    await expect(sendClaimPayout(db, claim.id, "tara", claim.hash, provider)).rejects.toThrow("balance is short");
    expect(provider.send).not.toHaveBeenCalled(); expect((await claimRow(claim.id)).status).toBe("APPROVED");
    expect((await db.select().from(s.disbursements).where(eq(s.disbursements.claimId, claim.id))).length).toBe(0);
  });
  it("allows only one send when two approving signers submit concurrently", async () => {
    const claim = await recognizedClaim("double-send"); const { provider } = transport();
    const results = await Promise.allSettled([sendClaimPayout(db, claim.id, "tara", claim.hash, provider), sendClaimPayout(db, claim.id, "ben", claim.hash, provider)]);
    expect(results.filter(result => result.status === "fulfilled").length).toBe(1);
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect((await db.select().from(s.disbursements).where(eq(s.disbursements.claimId, claim.id))).length).toBe(1);
  });
  it("settles simultaneous status checks once and posts nothing for a zero fee", async () => {
    const claim = await recognizedClaim("concurrent-status"); const { provider, itemPatch, itemId } = transport(); itemPatch.feeCents = 0n;
    await sendClaimPayout(db, claim.id, "tara", claim.hash, provider); const before = await journalCount();
    await Promise.all([refreshClaimPayout(db, claim.id, "tara", provider), refreshClaimPayout(db, claim.id, "ben", provider)]);
    expect(await journalCount()).toBe(before + 1);
    expect((await db.select().from(s.journalEntries).where(eq(s.journalEntries.sourceId, itemId))).map(row => row.purpose)).toEqual(["settlement"]);
  });
  it("does not mark paid from batch SUCCESS when no independently fetched item exists", async () => {
    const claim = await recognizedClaim("batch-only"); const { provider } = transport();
    await sendClaimPayout(db, claim.id, "tara", claim.hash, provider);
    const original = await provider.batch("unused"); provider.batch.mockResolvedValue({ ...original, itemIds: [] });
    const before = await journalCount();
    expect((await refreshClaimPayout(db, claim.id, "ben", provider)).state).toBe("UNKNOWN_STATUS");
    expect((await claimRow(claim.id)).status).toBe("PAYOUT_PROCESSING"); expect(await journalCount()).toBe(before);
  });
  it("keeps a timeout UNKNOWN and prevents a fresh sender ID", async () => {
    const claim = await recognizedClaim("timeout"); const { provider } = transport();
    provider.send.mockRejectedValue(new Error("synthetic network timeout"));
    expect((await sendClaimPayout(db, claim.id, "tara", claim.hash, provider)).state).toBe("UNKNOWN");
    const before = (await db.select().from(s.disbursementAttempts)).length;
    await expect(sendClaimPayout(db, claim.id, "ben", claim.hash, provider)).rejects.toThrow("approved claim");
    expect((await db.select().from(s.disbursementAttempts)).length).toBe(before); expect(provider.send).toHaveBeenCalledTimes(1);
    expect((await refreshClaimPayout(db, claim.id, "tara", provider)).notice).toBe("MANUAL_RECONCILIATION_REQUIRED");
    expect(provider.batch).not.toHaveBeenCalled();
  });
  it.each([500, 400])("preserves returned IDs on ambiguous HTTP %s without interpreting them as settlement", async httpStatus => {
    const claim = await recognizedClaim("ambiguous-response"); const { provider, itemId } = transport();
    const originalSend = provider.send.getMockImplementation()!;
    provider.send.mockImplementation(async payout => ({ ...await originalSend(payout), httpStatus, itemId, ...(httpStatus === 400 ? { batchId: undefined, errorCode: "INSUFFICIENT_FUNDS" } : {}) }));
    const before = await journalCount();
    expect((await sendClaimPayout(db, claim.id, "tara", claim.hash, provider)).state).toBe("UNKNOWN");
    const [disbursement] = await db.select().from(s.disbursements).where(eq(s.disbursements.claimId, claim.id));
    const [attempt] = await db.select().from(s.disbursementAttempts).where(eq(s.disbursementAttempts.disbursementId, disbursement!.id));
    if (httpStatus === 500) expect(attempt!.payoutBatchId).toBeTruthy(); else expect(attempt!.payoutBatchId).toBeNull();
    expect(attempt!.payoutItemId).toBe(itemId);
    expect((await claimRow(claim.id)).status).toBe("PAYOUT_PROCESSING"); expect(await journalCount()).toBe(before);
    await expect(sendClaimPayout(db, claim.id, "ben", claim.hash, provider)).rejects.toThrow();
  });
  it("leaves an insufficient-funds rejection open and requires a separate future retry authorization", async () => {
    const claim = await recognizedClaim("insufficient"); const { provider } = transport(); const before = await journalCount();
    provider.send.mockResolvedValue({ httpStatus: 400, errorCode: "INSUFFICIENT_FUNDS" });
    expect((await sendClaimPayout(db, claim.id, "tara", claim.hash, provider)).state).toBe("FUNDING_REJECTED");
    expect((await claimRow(claim.id)).status).toBe("PAYOUT_ISSUE"); expect(await journalCount()).toBe(before);
    await expect(sendClaimPayout(db, claim.id, "tara", claim.hash, provider)).rejects.toThrow();
    expect(provider.send).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["PENDING", "PENDING", "PAYOUT_PROCESSING"], ["UNCLAIMED", "HELD", "PAYOUT_ISSUE"], ["ONHOLD", "HELD", "PAYOUT_ISSUE"],
    ["FAILED", "FAILED", "PAYOUT_ISSUE"], ["RETURNED", "FAILED", "PAYOUT_ISSUE"], ["BLOCKED", "FAILED", "PAYOUT_ISSUE"],
    ["REFUNDED", "MANUAL_REVIEW", "PAYOUT_ISSUE"], ["REVERSED", "MANUAL_REVIEW", "PAYOUT_ISSUE"], ["NEW_PROVIDER_STATUS", "UNKNOWN_STATUS", "PAYOUT_PROCESSING"],
  ])("maps item %s conservatively without settlement", async (itemStatus, expected, claimStatus) => {
    const claim = await recognizedClaim(itemStatus); const { provider, itemPatch } = transport(); itemPatch.itemStatus = itemStatus;
    await sendClaimPayout(db, claim.id, "tara", claim.hash, provider); const before = await journalCount();
    expect((await refreshClaimPayout(db, claim.id, "ben", provider)).state).toBe(expected);
    expect((await claimRow(claim.id)).status).toBe(claimStatus); expect(await journalCount()).toBe(before);
  });
  it.each(["DENIED", "CANCELED"])("maps terminal batch %s without trusting batch success as item success", async batchStatus => {
    const claim = await recognizedClaim(batchStatus); const { provider } = transport();
    await sendClaimPayout(db, claim.id, "tara", claim.hash, provider);
    const original = await provider.batch("unused"); provider.batch.mockResolvedValue({ ...original, batchStatus, itemIds: [] });
    const before = await journalCount(); expect((await refreshClaimPayout(db, claim.id, "ben", provider)).state).toBe("FAILED");
    expect(provider.item).not.toHaveBeenCalled(); expect(await journalCount()).toBe(before);
  });
  it("rejects item amount/recipient/batch/ID mismatches without ledger effects", async () => {
    const claim = await recognizedClaim("binding"); const { provider, itemPatch } = transport();
    await sendClaimPayout(db, claim.id, "tara", claim.hash, provider); const before = await journalCount();
    for (const patch of [{ amountCents: 99n }, { payeeEmail: "wrong@example.invalid" }, { senderItemId: "wrong" }, { batchId: "wrong" }, { itemId: "wrong" }]) {
      Object.assign(itemPatch, patch);
      await expect(refreshClaimPayout(db, claim.id, "ben", provider)).rejects.toThrow("binding");
      for (const key of Object.keys(itemPatch)) delete itemPatch[key as keyof PayoutItemResult];
    }
    expect(await journalCount()).toBe(before); expect((await claimRow(claim.id)).status).toBe("PAYOUT_PROCESSING");
  });
  it("posts a late reported fee once and preserves the first settlement date", async () => {
    const claim = await recognizedClaim("late-fee"); const { provider, itemPatch, itemId } = transport();
    itemPatch.feeCents = undefined; itemPatch.processedOn = undefined;
    await sendClaimPayout(db, claim.id, "tara", claim.hash, provider); const before = await journalCount();
    await refreshClaimPayout(db, claim.id, "ben", provider);
    itemPatch.feeCents = 2n; itemPatch.processedOn = "2026-10-20";
    await refreshClaimPayout(db, claim.id, "ben", provider); await refreshClaimPayout(db, claim.id, "ben", provider);
    expect(await journalCount()).toBe(before + 2);
    const entries = await db.select().from(s.journalEntries).where(eq(s.journalEntries.sourceId, itemId));
    expect(new Set(entries.map(row => row.effectiveOn))).toEqual(new Set([new Date().toISOString().slice(0, 10)]));
    itemPatch.feeCents = 3n;
    expect((await refreshClaimPayout(db, claim.id, "ben", provider)).state).toBe("MANUAL_REVIEW");
    expect(await journalCount()).toBe(before + 2);
  });
  it("rejects an approval decision belonging to another claim at the HTTP boundary", async () => {
    const claim = await recognizedClaim("cross-claim");
    const [decision] = await db.select().from(s.allocationDecisions).where(and(eq(s.allocationDecisions.claimId, claim.id), eq(s.allocationDecisions.decisionHash, claim.hash)));
    expect((await action("tara", { action: "approve", decisionId: decision!.id, decisionHash: claim.hash })).status).toBe(403);
  });
});
