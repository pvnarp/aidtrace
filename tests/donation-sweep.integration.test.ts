import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as s from "../db/schema";
import { createDonationOrder, captureDonationOrder, reconcileDonationOrder } from "../src/donation/orders";
import { SWEEP_BATCH, runDonationSweep } from "../src/donation/sweep";
import { createDonationTestDatabase, makeDonationStub, type DonationStub } from "./support/donation-provider";

// IAC-379 step 3a, DON-12 worker sweep. Real isolated PostgreSQL, stubbed payments object, no fetch, no network.
let database: Awaited<ReturnType<typeof createDonationTestDatabase>>;
beforeAll(async () => { database = await createDonationTestDatabase("aidtrace_don_sweep"); }, 60_000);
afterAll(async () => { await database.close(); });
const db = () => database.db;
const hours = (n: number) => n * 60 * 60 * 1000;

// Test-only, on a throwaway database: the guard trigger rewrites updated_at on every update and refuses history edits, so
// it is switched off for one block to backdate rows or to retire rows earlier tests left open.
async function withoutGuard<T>(work: () => Promise<T>): Promise<T> {
  await db().execute(sql`alter table donation_orders disable trigger donation_order_guard`);
  try { return await work(); } finally { await db().execute(sql`alter table donation_orders enable trigger donation_order_guard`); }
}
const age = (id: string, ms: number) => withoutGuard(() => db().execute(sql`update donation_orders set updated_at = now() - ${ms}::double precision * interval '1 millisecond' where id = ${id}`));
beforeEach(async () => { await withoutGuard(() => db().execute(sql`update donation_orders set status = 'EXPIRED', lease_token = null, lease_expires_at = null where status not in ('COMPLETED','FAILED','MISMATCH','EXPIRED')`)); });
const byId = async (id: string) => (await db().select().from(s.donationOrders).where(eq(s.donationOrders.id, id)))[0]!;
const journalCount = async () => Number((await db().execute(sql`select count(*)::int as n from journal_entries`))[0]!.n);
const receiptCount = async () => Number((await db().execute(sql`select count(*)::int as n from donation_receipts`))[0]!.n);

async function orphan(stub: DonationStub) {
  stub.script.create = ["timeout"];
  const result = await createDonationOrder(db(), stub.payments, { fundId: "fund_b", amountCents: 500n });
  expect(result).toMatchObject({ status: "CREATED", orderId: null, reason: "CREATE_UNCONFIRMED" });
  return result.id;
}
// An order whose capture answer was lost: CAPTURE_UNKNOWN. `sideEffect` says whether PayPal actually captured it.
async function unknownCapture(stub: DonationStub, sideEffect: "timeout" | "timeout-complete") {
  const created = await createDonationOrder(db(), stub.payments, { fundId: "fund_b", amountCents: 2500n });
  stub.approve(); stub.script.capture = [sideEffect];
  const result = await captureDonationOrder(db(), stub.payments, created.orderId);
  expect(result).toMatchObject({ status: "CAPTURE_UNKNOWN", reason: "POST_UNCONFIRMED" });
  return { id: created.id, orderId: created.orderId! };
}
function recorder() { const lines: Record<string, unknown>[] = []; return { lines, log: (entry: Record<string, unknown>) => { lines.push(entry); } }; }

describe("DON-12 the sweep expires abandoned orders and reconciles unknown captures", () => {
  it("expires an old CREATED row with no provider call, in either mode", async () => {
    const stub = makeDonationStub(); const old = await orphan(stub); await age(old, hours(4));
    const fresh = await orphan(makeDonationStub());
    const factory = vi.fn(() => stub.payments); const callsBefore = [...stub.calls]; const { lines, log } = recorder();
    const report = await runDonationSweep(db(), { mode: "KEYLESS", payments: factory, log });
    expect(report).toMatchObject({ mode: "KEYLESS", expired: 1, considered: 0, reconciled: 0, failed: 0 });
    expect(await byId(old)).toMatchObject({ status: "EXPIRED", leaseToken: null }); expect(await byId(fresh)).toMatchObject({ status: "CREATED" });
    expect(factory).not.toHaveBeenCalled(); expect(stub.calls).toEqual(callsBefore);
    expect(lines.some(line => String(line.note).includes("reconcile skipped"))).toBe(true);
    const keyedOld = await orphan(stub); await age(keyedOld, hours(4));
    expect(await runDonationSweep(db(), { mode: "KEYED", payments: () => stub.payments })).toMatchObject({ expired: 1 });
    expect(await byId(keyedOld)).toMatchObject({ status: "EXPIRED" });
  });

  it("skips a leased row and never expires or reconciles a money-bearing row", async () => {
    const stub = makeDonationStub();
    const leased = await orphan(stub); await age(leased, hours(4));
    await db().update(s.donationOrders).set({ leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(s.donationOrders.id, leased));
    const unknown = await unknownCapture(makeDonationStub(), "timeout"); await age(unknown.id, hours(48));
    const pendingStub = makeDonationStub(); const pendingOrder = await createDonationOrder(db(), pendingStub.payments, { fundId: "fund_b", amountCents: 700n });
    pendingStub.approve(); pendingStub.script.capture = ["pending"]; await captureDonationOrder(db(), pendingStub.payments, pendingOrder.orderId);
    expect(await byId(pendingOrder.id)).toMatchObject({ status: "PENDING" }); await age(pendingOrder.id, hours(48));
    const factory = vi.fn(() => stub.payments);
    const report = await runDonationSweep(db(), { mode: "KEYLESS", payments: factory });
    expect(report.expired).toBe(0); expect(factory).not.toHaveBeenCalled();
    expect(await byId(leased)).toMatchObject({ status: "CREATED" }); expect(await byId(unknown.id)).toMatchObject({ status: "CAPTURE_UNKNOWN" }); expect(await byId(pendingOrder.id)).toMatchObject({ status: "PENDING" });
  });

  it("reconciles a CAPTURE_UNKNOWN row exactly once, reading the order first, then does nothing on the next pass", async () => {
    const stub = makeDonationStub(); const row = await unknownCapture(stub, "timeout-complete");
    const journalBefore = await journalCount(); const sentBefore = stub.sentRequestIds.length; stub.calls.length = 0;
    const factory = vi.fn(() => stub.payments); const { lines, log } = recorder();
    const report = await runDonationSweep(db(), { mode: "KEYED", payments: factory, log });
    expect(report).toMatchObject({ mode: "KEYED", expired: 0, considered: 1, reconciled: 1, failed: 0 });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(stub.calls[0]).toBe("read"); expect(stub.calls).not.toContain("capture"); expect(stub.sentRequestIds).toHaveLength(sentBefore);
    expect(await byId(row.id)).toMatchObject({ status: "COMPLETED", leaseToken: null });
    expect(await receiptCount()).toBeGreaterThan(0); const posted = await journalCount(); expect(posted).toBeGreaterThan(journalBefore);
    expect(lines.find(line => line.event === "reconciled")).toMatchObject({ status: "COMPLETED", posted: 1, reason: null });
    const callsAfterFirst = [...stub.calls];
    expect(await runDonationSweep(db(), { mode: "KEYED", payments: factory })).toMatchObject({ considered: 0, reconciled: 0 });
    expect(stub.calls).toEqual(callsAfterFirst); expect(await journalCount()).toBe(posted);
  });

  it("leaves the single same-ID retry to orders.ts: read first, one re-send with the stored capture request ID", async () => {
    const stub = makeDonationStub(); const row = await unknownCapture(stub, "timeout");
    const stored = await byId(row.id); expect(stub.sentRequestIds).toEqual([stored.captureRequestId]);
    stub.calls.length = 0; stub.script.capture = ["timeout"]; // the re-send is lost too
    const first = await runDonationSweep(db(), { mode: "KEYED", payments: () => stub.payments });
    expect(first).toMatchObject({ considered: 1, reconciled: 1 });
    expect(stub.calls.slice(0, 2)).toEqual(["read", "capture"]);
    expect(stub.sentRequestIds).toEqual([stored.captureRequestId, stored.captureRequestId]);
    expect(await byId(row.id)).toMatchObject({ status: "CAPTURE_UNKNOWN", captureAttempts: 2 });
    // Two sends is the cap: the next pass reads, finds no capture and stops with no third send.
    stub.calls.length = 0;
    await runDonationSweep(db(), { mode: "KEYED", payments: () => stub.payments });
    expect(stub.calls).toEqual(["read"]); expect(stub.sentRequestIds).toHaveLength(2);
    expect(await byId(row.id)).toMatchObject({ status: "CAPTURE_UNKNOWN", captureAttempts: 2 });
  });

  it("does not stop the pass when one row fails, and logs only the error class", async () => {
    const stub = makeDonationStub(); const first = await unknownCapture(stub, "timeout-complete");
    const otherStub = makeDonationStub(); const second = await unknownCapture(otherStub, "timeout-complete");
    await age(first.id, hours(2)); // the older row is tried first
    const { lines, log } = recorder();
    const reconcile = vi.fn(async (...args: Parameters<typeof reconcileDonationOrder>) => {
      if (args[2] === first.orderId) throw new Error(`SECRET_DETAIL ${first.orderId}`);
      return reconcileDonationOrder(args[0], otherStub.payments, args[2]);
    });
    const report = await runDonationSweep(db(), { mode: "KEYED", payments: () => stub.payments, log, reconcile });
    expect(report).toMatchObject({ considered: 2, reconciled: 1, failed: 1 });
    expect(reconcile.mock.calls.map(call => call[2])).toEqual([first.orderId, second.orderId]);
    expect(await byId(first.id)).toMatchObject({ status: "CAPTURE_UNKNOWN" }); expect(await byId(second.id)).toMatchObject({ status: "COMPLETED" });
    expect(lines.find(line => line.event === "row-failed")).toEqual({ event: "row-failed", row: first.id.slice(-6), order: first.orderId.slice(-6), error: "Error" });
    expect(JSON.stringify(lines)).not.toContain("SECRET_DETAIL");
  });

  it("logs counts and IDs masked to six characters, never full IDs, capture IDs or provider text", async () => {
    const stub = makeDonationStub(); const row = await unknownCapture(stub, "timeout-complete");
    const old = await orphan(makeDonationStub()); await age(old, hours(5)); const { lines, log } = recorder();
    await runDonationSweep(db(), { mode: "KEYED", payments: () => stub.payments, log });
    const text = JSON.stringify(lines);
    for (const secret of [row.id, row.orderId, old, stub.captureId, "CAPTURE_", "ORDER_"]) expect(text).not.toContain(secret);
    expect(lines).toContainEqual({ event: "expired", row: old.slice(-6) });
    expect(lines.find(line => line.event === "reconciled")).toMatchObject({ row: row.id.slice(-6), order: row.orderId.slice(-6) });
    expect(lines.at(-1)).toEqual({ event: "pass", mode: "KEYED", expired: 1, considered: 1, reconciled: 1, failed: 0 });
  });

  it("bounds a pass to a batch, oldest first", async () => {
    expect(SWEEP_BATCH).toBe(25);
    const stub = makeDonationStub(); const first = await unknownCapture(stub, "timeout-complete"); const second = await unknownCapture(makeDonationStub(), "timeout-complete");
    await age(second.id, hours(1)); // the second row is now the older one
    const reconcile = vi.fn(async (...args: Parameters<typeof reconcileDonationOrder>) => ({ id: "x", orderId: args[2] as string, status: "CAPTURE_UNKNOWN" as const, posted: false }));
    const report = await runDonationSweep(db(), { mode: "KEYED", payments: () => stub.payments, batch: 1, reconcile });
    expect(report.considered).toBe(1); expect(reconcile.mock.calls.map(call => call[2])).toEqual([second.orderId]); expect(first.orderId).not.toBe(second.orderId);
  });

  it("does not consider a CAPTURE_UNKNOWN row while another worker holds a live lease, and takes it once the lease expires", async () => {
    const stub = makeDonationStub(); const row = await unknownCapture(stub, "timeout-complete");
    await db().update(s.donationOrders).set({ leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(s.donationOrders.id, row.id));
    stub.calls.length = 0; const factory = vi.fn(() => stub.payments);
    expect(await runDonationSweep(db(), { mode: "KEYED", payments: factory })).toMatchObject({ considered: 0, reconciled: 0 });
    expect(stub.calls).toEqual([]); expect(await byId(row.id)).toMatchObject({ status: "CAPTURE_UNKNOWN" });
    await db().update(s.donationOrders).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(s.donationOrders.id, row.id));
    expect(await runDonationSweep(db(), { mode: "KEYED", payments: factory })).toMatchObject({ considered: 1, reconciled: 1 });
    expect(await byId(row.id)).toMatchObject({ status: "COMPLETED" });
  });
});
