import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import * as s from "../db/schema";
import { recordDesignatedDonation } from "../src/ledger/donation";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { reconcile } from "../src/ledger/reconcile";
import { createApplicationSandboxPayments, type DonationObservation, type DonationOrderWriter, type DonationReader } from "../src/paypal/adapter";
import { DonationOrderError, captureDonationOrder, createDonationOrder, reconcileDonationOrder, type DonationOrderPayments } from "../src/donation/orders";

// IAC-379 step 1. The provider is always a stub written in this file: no network, no credentials, no PayPal.
// These tests prove our lifecycle wiring against a real isolated PostgreSQL, not PayPal behavior.
vi.mock("../src/ledger/donation", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/ledger/donation")>();
  return { ...actual, recordDesignatedDonation: vi.fn(actual.recordDesignatedDonation) };
});

const name = `aidtrace_iac379_test_${randomBytes(6).toString("hex")}`;
const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://aidtrace@db:5432/aidtrace"); adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 }); const url = new URL(adminUrl); url.pathname = `/${name}`;
const { db, client } = connectDatabase(url.toString()); let created = false; let sequence = 0;
const LIMIT = { maxDonationCents: 5000n };
const record = vi.mocked(recordDesignatedDonation);
beforeAll(async () => {
  await admin`create database ${admin(name)}`; created = true; await migrate(db, { migrationsFolder: "db/migrations" });
  await seedFixture(db, { passwords: { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") }, payeeEmail: "donation-test@example.invalid", payeeAllowlist: ["donation-test@example.invalid"] });
  await db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
}, 30_000);
afterAll(async () => { await client.end(); if (created) await admin`drop database ${admin(name)}`; await admin.end(); });
afterEach(() => { record.mockClear(); });

type Unit = { fundId?: string; amountCents?: bigint };
type Capture = DonationObservation["captures"][number];
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
// A scripted PayPal stand-in. `sideEffect` is what PayPal did; `response` is what our server heard back.
function makeProvider() {
  const serial = ++sequence;
  const world: { httpStatus: number; orderId?: string; intent: string; status: string; units: Unit[]; captures: Capture[] } = { httpStatus: 200, intent: "CAPTURE", status: "CREATED", units: [], captures: [] };
  const script = { sideEffect: "complete" as "complete" | "pending" | "declined" | "failed" | "none", response: "ok" as "ok" | "timeout" | "http500" | "instrument-declined" };
  const hooks: { gate?: Promise<void>; readDelayMs: number; atCreate?: (order: Parameters<DonationOrderWriter["createDonationOrder"]>[0]) => Promise<void> } = { readDelayMs: 0 };
  const sent: { orderId: string; requestId: string }[] = [];
  const amount = () => world.units[0]?.amountCents ?? 0n;
  const finish = (status: string) => {
    const gross = amount(); const fee = gross / 10n;
    world.captures = [{ captureId: `CAPTURE_${serial}`, status, amountCents: gross, ...(status === "COMPLETED" ? { grossCents: gross, feeCents: fee, netCents: gross - fee, effectiveOn: "2026-10-30" } : {}) }];
    world.status = status === "COMPLETED" || status === "PENDING" ? "COMPLETED" : "APPROVED";
  };
  const read = (): DonationObservation => ({ httpStatus: world.httpStatus, orderId: world.orderId, intent: world.intent, status: world.status, units: world.units.map(unit => ({ ...unit })), captures: world.captures.map(capture => ({ ...capture })) });
  const provider = {
    createDonationOrder: vi.fn<DonationOrderWriter["createDonationOrder"]>(async order => {
      await hooks.atCreate?.(order);
      world.orderId = `ORDER_${serial}`; world.units = [{ fundId: order.fundId, amountCents: order.amountCents }];
      return { httpStatus: 201, orderId: world.orderId, status: "CREATED", errorIssues: [] };
    }),
    donationOrder: vi.fn<DonationReader["donationOrder"]>(async () => { if (hooks.readDelayMs) await sleep(hooks.readDelayMs); return read(); }),
    captureDonationOrder: vi.fn<DonationOrderWriter["captureDonationOrder"]>(async (orderId, requestId) => {
      sent.push({ orderId, requestId });
      const gate = hooks.gate; hooks.gate = undefined; if (gate) await gate;
      if (world.captures.length === 0 && script.sideEffect !== "none") finish(script.sideEffect === "complete" ? "COMPLETED" : script.sideEffect === "pending" ? "PENDING" : script.sideEffect === "declined" ? "DECLINED" : "FAILED");
      if (script.response === "timeout") throw new Error("synthetic timeout");
      if (script.response === "http500") return { ...read(), httpStatus: 500, errorIssues: [] };
      if (script.response === "instrument-declined") return { httpStatus: 422, units: [], captures: [], errorCode: "UNPROCESSABLE_ENTITY", errorIssues: ["INSTRUMENT_DECLINED"] };
      return { ...read(), httpStatus: 201, errorIssues: [] };
    }),
  };
  return { world, script, hooks, sent, provider: provider satisfies DonationOrderPayments, mocks: provider, approve: () => { world.status = "APPROVED"; }, complete: () => finish("COMPLETED"), captureId: `CAPTURE_${serial}` };
}
type Harness = ReturnType<typeof makeProvider>;
async function newOrder(h: Harness, cents: bigint | number | string = 2500n, fundId = "fund_b") {
  const result = await createDonationOrder(db, h.provider, { fundId, amountCents: cents }, LIMIT);
  return { ...result, orderId: result.orderId! };
}
async function approvedOrder(h: Harness, cents: bigint = 2500n) { const order = await newOrder(h, cents); h.approve(); return order; }
const row = async (orderId: string) => { const [found] = await db.select().from(s.donationOrders).where(eq(s.donationOrders.orderId, orderId)); return found!; };
const journalCount = async () => (await db.select().from(s.journalEntries)).length;
const receipts = (orderId: string) => db.select().from(s.donationReceipts).where(eq(s.donationReceipts.orderId, orderId));
async function postingsFor(sourceId: string) {
  const out: unknown[] = [];
  for (const entry of (await db.select().from(s.journalEntries).where(eq(s.journalEntries.sourceId, sourceId))).sort((a, b) => a.purpose.localeCompare(b.purpose))) {
    out.push([entry.purpose, (await db.select().from(s.journalPostings).where(eq(s.journalPostings.entryId, entry.id))).map(p => [p.accountCode, p.debitCents, p.creditCents])]);
  }
  return out;
}
async function refused(work: PromiseLike<unknown>, pattern: RegExp) {
  const error = await Promise.resolve(work).then(() => undefined, (e: unknown) => e ?? new Error("rejected without a reason"));
  expect(error, "the database should have refused this statement").toBeDefined();
  const messages: string[] = [];
  for (let e: unknown = error; e && messages.length < 6; e = (e as { cause?: unknown }).cause) messages.push(String((e as Error).message ?? ""));
  expect(messages.join(" | ")).toMatch(pattern);
}
async function failure(work: Promise<unknown>) { try { await work; } catch (error) { return error as DonationOrderError; } throw new Error("expected a refusal"); }

describe("DON-01 creation persists first", () => {
  it("stores the order and both request IDs before the provider call, then attaches the provider order ID", async () => {
    const h = makeProvider(); let snapshot: typeof s.donationOrders.$inferSelect | undefined;
    h.hooks.atCreate = async order => { [snapshot] = await db.select().from(s.donationOrders).where(eq(s.donationOrders.createRequestId, order.requestId)); };
    const result = await createDonationOrder(db, h.provider, { fundId: "fund_b", amountCents: 2500n, displayName: "  Pat  " }, LIMIT);
    expect(snapshot).toMatchObject({ status: "CREATED", orderId: null, fundId: "fund_b", expectedAmountCents: 2500n, captureAttempts: 0, displayName: "Pat" });
    expect(snapshot!.captureRequestId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(snapshot!.captureRequestId).not.toBe(snapshot!.createRequestId);
    expect(h.mocks.createDonationOrder).toHaveBeenCalledTimes(1);
    expect(h.mocks.createDonationOrder.mock.calls[0]![0]).toEqual({ requestId: snapshot!.createRequestId, fundId: "fund_b", amountCents: 2500n });
    expect(result).toMatchObject({ status: "CREATED", orderId: h.world.orderId, posted: false });
    expect(await row(h.world.orderId!)).toMatchObject({ id: snapshot!.id, status: "CREATED", createRequestId: snapshot!.createRequestId, captureRequestId: snapshot!.captureRequestId });
  });
  it.each([[2500n, 2500n], [2500, 2500n], ["2500", 2500n], [1n, 1n], [5000n, 5000n]])("accepts %s as whole cents", async (input, expected) => {
    const h = makeProvider(); await newOrder(h, input);
    expect(h.mocks.createDonationOrder.mock.calls[0]![0].amountCents).toBe(expected);
  });
  it("uses a different request ID pair for every order", async () => {
    const a = makeProvider(); const b = makeProvider(); const first = await newOrder(a); const second = await newOrder(b);
    const rows = [await row(first.orderId), await row(second.orderId)];
    expect(new Set(rows.flatMap(r => [r.createRequestId, r.captureRequestId])).size).toBe(4);
  });
  it("leaves a CREATED row without a provider ID when the outcome is unknown, and FAILED on a definite 4xx", async () => {
    const h = makeProvider(); h.mocks.createDonationOrder.mockRejectedValueOnce(new Error("synthetic timeout"));
    expect((await failure(createDonationOrder(db, h.provider, { fundId: "fund_b", amountCents: 100n }, LIMIT))).code).toBe("CREATE_UNKNOWN");
    const [orphan] = await db.select().from(s.donationOrders).where(eq(s.donationOrders.createRequestId, h.mocks.createDonationOrder.mock.calls[0]![0].requestId));
    expect(orphan).toMatchObject({ status: "CREATED", orderId: null });
    const rejected = makeProvider(); rejected.mocks.createDonationOrder.mockResolvedValueOnce({ httpStatus: 400, errorCode: "INVALID_REQUEST", errorIssues: [] });
    expect((await failure(createDonationOrder(db, rejected.provider, { fundId: "fund_b", amountCents: 100n }, LIMIT))).code).toBe("CREATE_REJECTED");
    const [failed] = await db.select().from(s.donationOrders).where(eq(s.donationOrders.createRequestId, rejected.mocks.createDonationOrder.mock.calls[0]![0].requestId));
    expect(failed).toMatchObject({ status: "FAILED", orderId: null });
    const unknown5xx = makeProvider(); unknown5xx.mocks.createDonationOrder.mockResolvedValueOnce({ httpStatus: 500, errorIssues: [] });
    expect((await failure(createDonationOrder(db, unknown5xx.provider, { fundId: "fund_b", amountCents: 100n }, LIMIT))).code).toBe("CREATE_UNKNOWN");
    const odd = makeProvider(); odd.mocks.createDonationOrder.mockResolvedValueOnce({ httpStatus: 201, orderId: "ORDER_ODD", status: "COMPLETED", errorIssues: [] });
    expect((await failure(createDonationOrder(db, odd.provider, { fundId: "fund_b", amountCents: 100n }, LIMIT))).code).toBe("CREATE_UNKNOWN");
    expect((await db.select().from(s.donationOrders).where(eq(s.donationOrders.createRequestId, odd.mocks.createDonationOrder.mock.calls[0]![0].requestId)))[0]).toMatchObject({ status: "CREATED", orderId: null });
  });
});

describe("DON-08 service validation", () => {
  const rowCount = async () => (await db.select().from(s.donationOrders)).length;
  it.each([0n, -1n, 5001n, 0, -100, 12.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, "0", "-5", "12.5", "1e3", "05", "", " 100", "100 ", "0x10", "5001", "9".repeat(17), true, null, undefined, {}, [100]])("refuses amount %s without a row or a provider call", async amount => {
    const h = makeProvider(); const before = await rowCount();
    await expect(createDonationOrder(db, h.provider, { fundId: "fund_b", amountCents: amount }, LIMIT)).rejects.toBeInstanceOf(DonationOrderError);
    expect(h.mocks.createDonationOrder).not.toHaveBeenCalled(); expect(await rowCount()).toBe(before);
  });
  it("tracks the configured ceiling exactly: 5000 passes and 5001 does not", async () => {
    const h = makeProvider(); await newOrder(h, 5000n);
    expect((await failure(createDonationOrder(db, h.provider, { fundId: "fund_b", amountCents: 5001n }, LIMIT))).code).toBe("AMOUNT_OUT_OF_RANGE");
    expect((await failure(createDonationOrder(db, h.provider, { fundId: "fund_b", amountCents: 101n }, { maxDonationCents: 100n }))).code).toBe("AMOUNT_OUT_OF_RANGE");
    expect((await failure(createDonationOrder(db, h.provider, { fundId: "fund_b", amountCents: 1n }, { maxDonationCents: 0n }))).code).toBe("INVALID_REQUEST");
  });
  it.each(["fund_g", "fund_missing", "FUND_B", "", "fund b", 7, null, undefined])("accepts restricted funds only: refuses %s", async fundId => {
    const h = makeProvider(); const before = await rowCount();
    await expect(createDonationOrder(db, h.provider, { fundId, amountCents: 100n }, LIMIT)).rejects.toBeInstanceOf(DonationOrderError);
    expect(h.mocks.createDonationOrder).not.toHaveBeenCalled(); expect(await rowCount()).toBe(before);
  });
  it("validates the optional display name and stores no other donor field", async () => {
    const h = makeProvider(); const before = await rowCount();
    for (const bad of ["x".repeat(41), "line\nbreak", "tab\there", "zero​width", "‮flip", 5, {}]) await expect(createDonationOrder(db, h.provider, { fundId: "fund_b", amountCents: 100n, displayName: bad }, LIMIT)).rejects.toBeInstanceOf(DonationOrderError);
    expect(await rowCount()).toBe(before);
    const forty = await newOrder(makeProvider(), 100n); expect((await row(forty.orderId)).displayName).toBeNull();
    const named = makeProvider(); const ok = await createDonationOrder(db, named.provider, { fundId: "fund_b", amountCents: 100n, displayName: "x".repeat(40) }, LIMIT);
    expect((await row(ok.orderId!)).displayName).toBe("x".repeat(40));
    const blank = makeProvider(); const none = await createDonationOrder(db, blank.provider, { fundId: "fund_b", amountCents: 100n, displayName: "   " }, LIMIT);
    expect((await row(none.orderId!)).displayName).toBeNull();
  });
  it("stores no payer fields: the table has exactly the lifecycle columns", async () => {
    const columns = await db.execute(sql`select column_name from information_schema.columns where table_name = 'donation_orders' order by column_name`);
    expect([...columns].map(c => c.column_name)).toEqual(["capture_attempts", "capture_request_id", "create_request_id", "created_at", "display_name", "expected_amount_cents", "fund_id", "id", "lease_expires_at", "lease_token", "order_id", "status", "updated_at"]);
  });
  it("leaves donation_receipts exactly as migration 0006 defined it", async () => {
    const columns = await db.execute(sql`select column_name from information_schema.columns where table_name = 'donation_receipts' order by column_name`);
    expect([...columns].map(c => c.column_name)).toEqual(["capture_id", "effective_on", "expected_amount_cents", "fee_cents", "fund_id", "gross_cents", "net_cents", "order_id", "organization_id", "provider_status", "recorded_at", "recorded_by", "status"]);
  });
});

describe("DON-02 capture refuses unless the stored order is approved and bound", () => {
  const cases: [string, (h: Harness) => void][] = [
    ["wrong fund", h => { h.world.units[0]!.fundId = "fund_a"; }],
    ["wrong amount", h => { h.world.units[0]!.amountCents = 2499n; }],
    ["wrong currency (adapter parses a non-USD amount as undefined)", h => { h.world.units[0]!.amountCents = undefined; }],
    ["missing fund", h => { h.world.units[0]!.fundId = undefined; }],
    ["two units", h => { h.world.units.push({ ...h.world.units[0]! }); }],
    ["no unit", h => { h.world.units = []; }],
    ["intent AUTHORIZE", h => { h.world.intent = "AUTHORIZE"; }],
    ["a capture already present", h => { h.complete(); }],
    ["provider COMPLETED without a capture", h => { h.world.status = "COMPLETED"; }],
    ["provider VOIDED", h => { h.world.status = "VOIDED"; }],
    ["unparseable provider status", h => { h.world.status = ""; }],
  ];
  it.each(cases)("%s becomes MISMATCH for manual review, with no capture call and nothing posted", async (_label, tamper) => {
    const h = makeProvider(); const order = await approvedOrder(h); tamper(h); const before = await journalCount();
    const result = await captureDonationOrder(db, h.provider, order.orderId);
    expect(result).toMatchObject({ status: "MISMATCH", posted: false });
    expect(h.mocks.captureDonationOrder).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
    expect(await journalCount()).toBe(before); expect(await receipts(order.orderId)).toHaveLength(0);
    expect(await row(order.orderId)).toMatchObject({ status: "MISMATCH", leaseToken: null, captureAttempts: 0 });
    h.approve(); expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "MISMATCH", posted: false }); // final
    expect(h.mocks.captureDonationOrder).not.toHaveBeenCalled();
  });
  it.each(["CREATED", "PAYER_ACTION_REQUIRED"])("refuses a %s provider order without changing it, and captures once the donor approves", async status => {
    const h = makeProvider(); const order = await newOrder(h); h.world.status = status; const before = await journalCount();
    expect((await failure(captureDonationOrder(db, h.provider, order.orderId))).code).toBe("NOT_APPROVED");
    expect(h.mocks.captureDonationOrder).not.toHaveBeenCalled(); expect(await journalCount()).toBe(before);
    expect(await row(order.orderId)).toMatchObject({ status: "CREATED", leaseToken: null, leaseExpiresAt: null, captureAttempts: 0 });
    h.approve(); expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "COMPLETED", posted: true });
  });
  it("refuses an unreadable provider order without changing state", async () => {
    const h = makeProvider(); const order = await approvedOrder(h);
    h.mocks.donationOrder.mockRejectedValueOnce(new Error("synthetic timeout Bearer synthetic-token"));
    const error = await failure(captureDonationOrder(db, h.provider, order.orderId));
    expect(error.code).toBe("READ_FAILED"); expect(error.message).not.toMatch(/synthetic|Bearer/);
    h.world.httpStatus = 404; expect((await failure(captureDonationOrder(db, h.provider, order.orderId))).code).toBe("READ_FAILED");
    h.world.httpStatus = 200; const realId = h.world.orderId; h.world.orderId = "OTHER_ORDER";
    expect((await failure(captureDonationOrder(db, h.provider, order.orderId))).code).toBe("READ_FAILED");
    h.world.orderId = realId;
    expect(h.mocks.captureDonationOrder).not.toHaveBeenCalled();
    expect(await row(order.orderId)).toMatchObject({ status: "CREATED", leaseToken: null, captureAttempts: 0 });
  });
  it("selects the stored row by provider order ID only and never trusts a browser amount or fund", async () => {
    const h = makeProvider(); await approvedOrder(h);
    for (const bad of [undefined, null, "", "../x", "a".repeat(65), 5, { orderId: "x" }]) expect((await failure(captureDonationOrder(db, h.provider, bad))).code).toBe("INVALID_REQUEST");
    expect((await failure(captureDonationOrder(db, h.provider, "ORDER_DOES_NOT_EXIST"))).code).toBe("UNKNOWN_ORDER");
    expect((await failure(reconcileDonationOrder(db, h.provider, "ORDER_DOES_NOT_EXIST"))).code).toBe("UNKNOWN_ORDER");
    expect(h.mocks.donationOrder).not.toHaveBeenCalled(); expect(h.mocks.captureDonationOrder).not.toHaveBeenCalled();
    expect(captureDonationOrder.length).toBe(3); // (db, payments, orderId): no amount or fund parameter exists
  });
});

describe("DON-03 outcomes per the section 3 table", () => {
  it("COMPLETED reaches recordDesignatedDonation once and posts the donation and the reported fee once", async () => {
    const h = makeProvider(); const order = await approvedOrder(h, 2500n); const before = await journalCount();
    const result = await captureDonationOrder(db, h.provider, order.orderId);
    expect(result).toMatchObject({ status: "COMPLETED", posted: true, captureId: h.captureId });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![1]).toBe("tara"); expect(record.mock.calls[0]![2]).toEqual({ orderId: order.orderId, captureId: h.captureId, fundId: "fund_b", amountCents: 2500n });
    expect(await journalCount()).toBe(before + 2);
    expect(await postingsFor(h.captureId)).toEqual([["donation", [["1010", 2500n, 0n], ["4100", 0n, 2500n]]], ["donation_fee", [["5900", 250n, 0n], ["1010", 0n, 250n]]]]);
    expect(await receipts(order.orderId)).toMatchObject([{ status: "COMPLETED", captureId: h.captureId, grossCents: 2500n, feeCents: 250n, netCents: 2250n, recordedBy: "tara" }]);
    expect((await db.select().from(s.fundCredits)).filter(c => !c.isOpening && c.sourceId === h.captureId)).toMatchObject([{ fundId: "fund_b", amountCents: 2500n }]);
    expect((await db.transaction(tx => reconcile(tx, "cedar-hollow"))).matches).toBe(true);
    expect(await row(order.orderId)).toMatchObject({ status: "COMPLETED", captureAttempts: 1, leaseToken: null, leaseExpiresAt: null });
    expect(h.sent).toEqual([{ orderId: order.orderId, requestId: (await row(order.orderId)).captureRequestId }]);
  });
  it("a replayed capture or reconcile returns COMPLETED without another provider call or posting", async () => {
    const h = makeProvider(); const order = await approvedOrder(h); await captureDonationOrder(db, h.provider, order.orderId);
    const before = await journalCount(); const reads = h.mocks.donationOrder.mock.calls.length;
    for (const again of [await captureDonationOrder(db, h.provider, order.orderId), await reconcileDonationOrder(db, h.provider, order.orderId)]) expect(again).toMatchObject({ status: "COMPLETED", posted: false });
    expect(record).toHaveBeenCalledTimes(1); expect(h.sent).toHaveLength(1); expect(h.mocks.donationOrder.mock.calls.length).toBe(reads); expect(await journalCount()).toBe(before);
  });
  it.each([["declined", "FAILED"], ["failed", "FAILED"]] as const)("a capture the provider reports as %s becomes FAILED and posts nothing", async (sideEffect, status) => {
    const h = makeProvider(); h.script.sideEffect = sideEffect; const order = await approvedOrder(h); const before = await journalCount();
    expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status, posted: false });
    expect(record).not.toHaveBeenCalled(); expect(await journalCount()).toBe(before); expect(await receipts(order.orderId)).toHaveLength(0);
    expect(await row(order.orderId)).toMatchObject({ status, leaseToken: null });
  });
  it("an HTTP 422 INSTRUMENT_DECLINED becomes FAILED and posts nothing", async () => {
    const h = makeProvider(); h.script.sideEffect = "none"; h.script.response = "instrument-declined"; const order = await approvedOrder(h); const before = await journalCount();
    expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "FAILED", posted: false });
    expect(record).not.toHaveBeenCalled(); expect(await journalCount()).toBe(before); expect(h.sent).toHaveLength(1);
  });
  it("PENDING posts nothing, then reconcile posts once after the provider completes it", async () => {
    const h = makeProvider(); h.script.sideEffect = "pending"; const order = await approvedOrder(h); const before = await journalCount();
    expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "PENDING", posted: false });
    expect(record).not.toHaveBeenCalled(); expect(await journalCount()).toBe(before); expect(await receipts(order.orderId)).toHaveLength(0);
    expect(await reconcileDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "PENDING", posted: false });
    expect(await journalCount()).toBe(before);
    h.complete();
    expect(await reconcileDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "COMPLETED", posted: true });
    expect(record).toHaveBeenCalledTimes(1); expect(await journalCount()).toBe(before + 2); expect(h.sent).toHaveLength(1);
  });
  it("a capture that later turns out FAILED while PENDING ends FAILED and posts nothing", async () => {
    const h = makeProvider(); h.script.sideEffect = "pending"; const order = await approvedOrder(h); await captureDonationOrder(db, h.provider, order.orderId);
    h.world.captures[0]!.status = "DECLINED"; const before = await journalCount();
    expect(await reconcileDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "FAILED" }); expect(await journalCount()).toBe(before);
  });
  it("a completed capture that differs from the stored amount is MISMATCH and posts nothing", async () => {
    const h = makeProvider(); h.script.sideEffect = "none"; const order = await approvedOrder(h); const before = await journalCount();
    const original = h.mocks.captureDonationOrder.getMockImplementation()!;
    h.mocks.captureDonationOrder.mockImplementationOnce(async (id, requestId) => { const result = await original(id, requestId); h.complete(); h.world.captures[0]!.amountCents = 2400n; h.world.captures[0]!.grossCents = 2400n; return result; });
    expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "MISMATCH", posted: false });
    expect(record).not.toHaveBeenCalled(); expect(await journalCount()).toBe(before);
  });
  it("a COMPLETED capture the ledger refuses stays CAPTURE_UNKNOWN with nothing posted, and reconcile posts once after the cause is gone", async () => {
    const h = makeProvider(); const order = await approvedOrder(h); const before = await journalCount();
    record.mockRejectedValueOnce(new Error("synthetic ledger refusal"));
    expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "CAPTURE_UNKNOWN", posted: false, reason: "RECORD_FAILED" });
    expect(await journalCount()).toBe(before);
    expect(await reconcileDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "COMPLETED", posted: true });
    expect(h.sent).toHaveLength(1); expect(await journalCount()).toBe(before + 2);
  });
  it("capture and reconcile never run while the order has no stored approval or is in a state they do not own", async () => {
    const h = makeProvider(); const order = await newOrder(h); const before = await journalCount();
    expect(await reconcileDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "CREATED", posted: false });
    expect(h.mocks.donationOrder).not.toHaveBeenCalled(); expect(await journalCount()).toBe(before);
  });
});

describe("DON-04 unknown outcomes, reconcile and concurrency", () => {
  it("a timeout is CAPTURE_UNKNOWN with nothing posted, and capture never re-captures from that state", async () => {
    const h = makeProvider(); h.script.sideEffect = "none"; h.script.response = "timeout"; const order = await approvedOrder(h); const before = await journalCount();
    expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "CAPTURE_UNKNOWN", posted: false, reason: "POST_UNCONFIRMED" });
    expect(await row(order.orderId)).toMatchObject({ status: "CAPTURE_UNKNOWN", captureAttempts: 1, leaseToken: null });
    h.script.response = "ok"; h.script.sideEffect = "complete";
    expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "CAPTURE_UNKNOWN", posted: false });
    expect(h.sent).toHaveLength(1); expect(record).not.toHaveBeenCalled(); expect(await journalCount()).toBe(before);
  });
  it("PayPal captured but the response was lost: reconcile reads the order, records once and never POSTs again", async () => {
    const h = makeProvider(); h.script.response = "timeout"; const order = await approvedOrder(h); const before = await journalCount();
    expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "CAPTURE_UNKNOWN" });
    expect(await journalCount()).toBe(before); expect(record).not.toHaveBeenCalled();
    expect(await reconcileDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "COMPLETED", posted: true, captureId: h.captureId });
    expect(h.sent).toHaveLength(1); expect(record).toHaveBeenCalledTimes(1); expect(await journalCount()).toBe(before + 2);
    expect(await reconcileDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "COMPLETED", posted: false });
    expect(record).toHaveBeenCalledTimes(1); expect(await journalCount()).toBe(before + 2);
    expect(await row(order.orderId)).toMatchObject({ captureAttempts: 1 });
  });
  it("an HTTP 500 after the capture is also CAPTURE_UNKNOWN and recovers by reading the order", async () => {
    const h = makeProvider(); h.script.response = "http500"; const order = await approvedOrder(h); const before = await journalCount();
    expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "CAPTURE_UNKNOWN", posted: false });
    expect(await journalCount()).toBe(before);
    expect(await reconcileDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "COMPLETED", posted: true });
    expect(h.sent).toHaveLength(1);
  });
  it("an unparseable capture response leaves CAPTURE_UNKNOWN and posts nothing", async () => {
    const h = makeProvider(); const order = await approvedOrder(h); const before = await journalCount();
    // First read (pre-capture) is a clean APPROVED order; the read after the POST is unparseable.
    h.mocks.donationOrder.mockResolvedValueOnce({ httpStatus: 200, orderId: h.world.orderId, intent: "CAPTURE", status: "APPROVED", units: [{ fundId: "fund_b", amountCents: 2500n }], captures: [] })
      .mockResolvedValueOnce({ httpStatus: 200, orderId: undefined, intent: undefined, status: undefined, units: [], captures: [] });
    expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "CAPTURE_UNKNOWN", posted: false, reason: "UNEXPECTED_RESPONSE" });
    expect(await journalCount()).toBe(before); expect(record).not.toHaveBeenCalled();
  });
  it("still APPROVED with no capture: reconcile re-sends exactly once with the SAME persisted capture request ID, then never again", async () => {
    const h = makeProvider(); h.script.sideEffect = "none"; h.script.response = "timeout"; const order = await approvedOrder(h); const before = await journalCount();
    await captureDonationOrder(db, h.provider, order.orderId);
    const stored = await row(order.orderId);
    expect(await reconcileDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "CAPTURE_UNKNOWN", posted: false, reason: "POST_UNCONFIRMED" });
    expect(h.sent).toEqual([{ orderId: order.orderId, requestId: stored.captureRequestId }, { orderId: order.orderId, requestId: stored.captureRequestId }]);
    expect(await row(order.orderId)).toMatchObject({ status: "CAPTURE_UNKNOWN", captureAttempts: 2, captureRequestId: stored.captureRequestId, createRequestId: stored.createRequestId });
    expect(await reconcileDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "CAPTURE_UNKNOWN", posted: false, reason: "RETRY_EXHAUSTED" });
    expect(h.sent).toHaveLength(2); expect(await journalCount()).toBe(before);
    h.script.sideEffect = "complete"; h.complete(); // PayPal finished it meanwhile: still no POST, read and record only
    expect(await reconcileDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "COMPLETED", posted: true });
    expect(h.sent).toHaveLength(2); expect(record).toHaveBeenCalledTimes(1); expect(await journalCount()).toBe(before + 2);
  });
  it("the single re-send can succeed and posts once", async () => {
    const h = makeProvider(); h.script.sideEffect = "none"; h.script.response = "timeout"; const order = await approvedOrder(h); const before = await journalCount();
    await captureDonationOrder(db, h.provider, order.orderId);
    h.script.sideEffect = "complete"; h.script.response = "ok";
    expect(await reconcileDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "COMPLETED", posted: true });
    expect(h.sent).toHaveLength(2); expect(h.sent[1]!.requestId).toBe(h.sent[0]!.requestId); expect(record).toHaveBeenCalledTimes(1); expect(await journalCount()).toBe(before + 2);
    expect(await row(order.orderId)).toMatchObject({ status: "COMPLETED", captureAttempts: 2 });
  });
  it("a reconcile read failure keeps CAPTURE_UNKNOWN and sends nothing", async () => {
    const h = makeProvider(); h.script.response = "timeout"; const order = await approvedOrder(h); await captureDonationOrder(db, h.provider, order.orderId);
    h.mocks.donationOrder.mockRejectedValueOnce(new Error("synthetic timeout"));
    expect(await reconcileDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "CAPTURE_UNKNOWN", posted: false, reason: "READ_FAILED" });
    expect(h.sent).toHaveLength(1); expect(await row(order.orderId)).toMatchObject({ status: "CAPTURE_UNKNOWN", leaseToken: null });
  });
  it("concurrent captures send one POST, record once and post once", async () => {
    const h = makeProvider(); h.hooks.readDelayMs = 25; const order = await approvedOrder(h); const before = await journalCount();
    const results = await Promise.all([1, 2, 3, 4].map(() => captureDonationOrder(db, h.provider, order.orderId)));
    expect(results.filter(r => r.posted)).toHaveLength(1); expect(h.sent).toHaveLength(1); expect(record).toHaveBeenCalledTimes(1);
    expect(await journalCount()).toBe(before + 2); expect(await receipts(order.orderId)).toHaveLength(1);
    expect(await row(order.orderId)).toMatchObject({ status: "COMPLETED", captureAttempts: 1 });
    for (const result of results.filter(r => !r.posted)) expect(["CREATED", "APPROVED", "CAPTURING", "COMPLETED"]).toContain(result.status);
  });
  it("concurrent reconcile calls record once through the lease, not only through the ledger backstop", async () => {
    const h = makeProvider(); h.script.response = "timeout"; const order = await approvedOrder(h); const before = await journalCount();
    await captureDonationOrder(db, h.provider, order.orderId); h.hooks.readDelayMs = 25; record.mockClear();
    const results = await Promise.all([1, 2, 3].map(() => reconcileDonationOrder(db, h.provider, order.orderId)));
    expect(results.filter(r => r.posted)).toHaveLength(1); expect(record).toHaveBeenCalledTimes(1); expect(h.sent).toHaveLength(1);
    expect(await journalCount()).toBe(before + 2);
    expect(results.filter(r => !r.posted).every(r => r.inProgress === true || r.status === "COMPLETED")).toBe(true);
  });
  it("concurrent capture and reconcile on a CAPTURE_UNKNOWN order post once and never POST again", async () => {
    const h = makeProvider(); h.script.response = "timeout"; const order = await approvedOrder(h); const before = await journalCount();
    await captureDonationOrder(db, h.provider, order.orderId); h.hooks.readDelayMs = 25; record.mockClear();
    const results = await Promise.all([captureDonationOrder(db, h.provider, order.orderId), reconcileDonationOrder(db, h.provider, order.orderId), reconcileDonationOrder(db, h.provider, order.orderId), captureDonationOrder(db, h.provider, order.orderId)]);
    expect(results.filter(r => r.posted)).toHaveLength(1); expect(h.sent).toHaveLength(1); expect(record).toHaveBeenCalledTimes(1); expect(await journalCount()).toBe(before + 2);
  });
  it("two orders for the same fund settle independently under concurrency", async () => {
    const a = makeProvider(); const b = makeProvider(); const first = await approvedOrder(a, 1000n); const second = await approvedOrder(b, 700n); const before = await journalCount();
    const results = await Promise.all([captureDonationOrder(db, a.provider, first.orderId), captureDonationOrder(db, b.provider, second.orderId)]);
    expect(results.map(r => [r.status, r.posted])).toEqual([["COMPLETED", true], ["COMPLETED", true]]); expect(await journalCount()).toBe(before + 4);
    expect((await db.transaction(tx => reconcile(tx, "cedar-hollow"))).matches).toBe(true);
  });
  it("a crashed capture is recoverable only after its lease expires, and a stale caller cannot overwrite the recovery", async () => {
    const h = makeProvider(); let release!: () => void; h.hooks.gate = new Promise<void>(resolve => { release = resolve; });
    const order = await approvedOrder(h); const before = await journalCount();
    const stale = captureDonationOrder(db, h.provider, order.orderId); const staleOutcome = stale.then(() => undefined, (e: unknown) => e);
    for (let waited = 0; h.sent.length === 0 && waited < 100; waited++) await sleep(20);
    expect(h.sent).toHaveLength(1);
    expect(await row(order.orderId)).toMatchObject({ status: "CAPTURING", captureAttempts: 1 });
    const reads = h.mocks.donationOrder.mock.calls.length;
    expect(await reconcileDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "CAPTURING", inProgress: true, posted: false }); // lease still live
    expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "CAPTURING", posted: false });
    expect(h.mocks.donationOrder.mock.calls.length).toBe(reads); expect(h.sent).toHaveLength(1);
    await db.execute(sql`update donation_orders set lease_expires_at = now() - interval '1 second' where order_id = ${order.orderId}`);
    const recovered = await reconcileDonationOrder(db, h.provider, order.orderId); // PayPal never saw the first POST, so one same-ID retry
    expect(recovered).toMatchObject({ status: "COMPLETED", posted: true });
    expect(h.sent).toHaveLength(2); expect(h.sent[1]!.requestId).toBe(h.sent[0]!.requestId);
    release();
    const error = await staleOutcome;
    expect(error).toBeInstanceOf(DonationOrderError); expect((error as DonationOrderError).code).toBe("LEASE_LOST");
    expect(await journalCount()).toBe(before + 2); expect(await receipts(order.orderId)).toHaveLength(1);
    expect(await row(order.orderId)).toMatchObject({ status: "COMPLETED", captureAttempts: 2, leaseToken: null });
  });
});

describe("Database guards", () => {
  async function orderAt(status: s.DonationOrderStatus) {
    const h = makeProvider(); const order = await newOrder(h); const id = (await row(order.orderId)).id;
    const path: Record<s.DonationOrderStatus, [s.DonationOrderStatus, number][]> = {
      CREATED: [], APPROVED: [["APPROVED", 0]], CAPTURING: [["APPROVED", 0], ["CAPTURING", 1]], CAPTURE_UNKNOWN: [["APPROVED", 0], ["CAPTURING", 1], ["CAPTURE_UNKNOWN", 1]],
      PENDING: [["APPROVED", 0], ["CAPTURING", 1], ["PENDING", 1]], COMPLETED: [["APPROVED", 0], ["CAPTURING", 1], ["COMPLETED", 1]], FAILED: [["APPROVED", 0], ["CAPTURING", 1], ["FAILED", 1]], MISMATCH: [["MISMATCH", 0]],
    };
    for (const [next, attempts] of path[status]) await db.update(s.donationOrders).set({ status: next, captureAttempts: attempts }).where(eq(s.donationOrders.id, id));
    return { id, orderId: order.orderId };
  }
  it("refuses delete and truncate", async () => {
    const { id } = await orderAt("CREATED");
    await refused(db.delete(s.donationOrders).where(eq(s.donationOrders.id, id)), /preserved/);
    await refused(db.execute(sql`truncate donation_orders`), /Immutable accounting or approval record/);
    expect(await db.select().from(s.donationOrders).where(eq(s.donationOrders.id, id))).toHaveLength(1);
  });
  it("refuses changes to identity columns, and to the order ID once set", async () => {
    const { id } = await orderAt("APPROVED");
    const changes: Partial<typeof s.donationOrders.$inferInsert>[] = [{ fundId: "fund_a" }, { expectedAmountCents: 1n }, { createRequestId: "33333333-3333-4333-8333-333333333333" }, { captureRequestId: "44444444-4444-4444-8444-444444444444" },
      { orderId: "ORDER_CHANGED" }, { orderId: null as unknown as string }, { displayName: "Changed" }, { createdAt: new Date("2020-01-01T00:00:00Z") }, { id: "55555555-5555-4555-8555-555555555555" }];
    for (const change of changes) await refused(db.update(s.donationOrders).set(change).where(eq(s.donationOrders.id, id)), /identity is immutable/);
  });
  it("sets the provider order ID once, only while CREATED", async () => {
    const h = makeProvider(); h.mocks.createDonationOrder.mockResolvedValueOnce({ httpStatus: 500, errorIssues: [] });
    await failure(createDonationOrder(db, h.provider, { fundId: "fund_b", amountCents: 100n }, LIMIT));
    const [orphan] = await db.select().from(s.donationOrders).where(eq(s.donationOrders.createRequestId, h.mocks.createDonationOrder.mock.calls[0]![0].requestId));
    await db.update(s.donationOrders).set({ orderId: "ORDER_ONCE" }).where(eq(s.donationOrders.id, orphan!.id));
    await refused(db.update(s.donationOrders).set({ orderId: "ORDER_TWICE" }).where(eq(s.donationOrders.id, orphan!.id)), /identity is immutable/);
    await refused(db.update(s.donationOrders).set({ status: "CAPTURING", captureAttempts: 1 }).where(eq(s.donationOrders.id, orphan!.id)), /Illegal donation order status transition/);
    const h2 = makeProvider(); h2.mocks.createDonationOrder.mockResolvedValueOnce({ httpStatus: 500, errorIssues: [] });
    await failure(createDonationOrder(db, h2.provider, { fundId: "fund_b", amountCents: 100n }, LIMIT));
    const [second] = await db.select().from(s.donationOrders).where(eq(s.donationOrders.createRequestId, h2.mocks.createDonationOrder.mock.calls[0]![0].requestId));
    await refused(db.update(s.donationOrders).set({ orderId: "ORDER_ONCE" }).where(eq(s.donationOrders.id, second!.id)), /unique|duplicate/i);
    await refused(db.update(s.donationOrders).set({ orderId: "bad id!" }).where(eq(s.donationOrders.id, second!.id)), /donation_order_id_format/);
  });
  const illegal: [s.DonationOrderStatus, s.DonationOrderStatus][] = [
    ["CREATED", "COMPLETED"], ["CREATED", "CAPTURING"], ["CREATED", "PENDING"], ["CREATED", "CAPTURE_UNKNOWN"],
    ["APPROVED", "COMPLETED"], ["APPROVED", "CAPTURE_UNKNOWN"], ["APPROVED", "PENDING"], ["APPROVED", "FAILED"], ["APPROVED", "CREATED"],
    ["CAPTURING", "APPROVED"], ["CAPTURING", "CREATED"],
    ["CAPTURE_UNKNOWN", "APPROVED"], ["CAPTURE_UNKNOWN", "CREATED"],
    ["PENDING", "CAPTURE_UNKNOWN"], ["PENDING", "CAPTURING"], ["PENDING", "APPROVED"], ["PENDING", "CREATED"],
  ];
  it.each(illegal)("refuses the transition %s to %s", async (from, to) => {
    const { id } = await orderAt(from);
    await refused(db.update(s.donationOrders).set({ status: to, captureAttempts: to === "CAPTURING" ? 2 : 1 }).where(eq(s.donationOrders.id, id)), /Illegal donation order status transition|attempt|check constraint/i);
    expect((await db.select().from(s.donationOrders).where(eq(s.donationOrders.id, id)))[0]!.status).toBe(from);
  });
  it.each(["COMPLETED", "FAILED", "MISMATCH"] as const)("freezes %s: no status change and no other update", async final => {
    const { id } = await orderAt(final);
    for (const next of s.donationOrderStatuses.filter(status => status !== final)) await refused(db.update(s.donationOrders).set({ status: next }).where(eq(s.donationOrders.id, id)), /Final donation order states are immutable/);
    await refused(db.update(s.donationOrders).set({ updatedAt: new Date() }).where(eq(s.donationOrders.id, id)), /Final donation order states are immutable/);
    await refused(db.update(s.donationOrders).set({ leaseToken: "66666666-6666-4666-8666-666666666666", leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(s.donationOrders.id, id)), /Final donation order states are immutable|final_has_no_lease/);
  });
  it("allows exactly the lifecycle's legal edges", async () => {
    const edges: [s.DonationOrderStatus, s.DonationOrderStatus][] = [["CREATED", "APPROVED"], ["CREATED", "MISMATCH"], ["CREATED", "FAILED"], ["APPROVED", "CAPTURING"], ["APPROVED", "MISMATCH"],
      ["CAPTURING", "COMPLETED"], ["CAPTURING", "PENDING"], ["CAPTURING", "FAILED"], ["CAPTURING", "CAPTURE_UNKNOWN"], ["CAPTURING", "MISMATCH"],
      ["CAPTURE_UNKNOWN", "CAPTURING"], ["CAPTURE_UNKNOWN", "COMPLETED"], ["CAPTURE_UNKNOWN", "PENDING"], ["CAPTURE_UNKNOWN", "FAILED"], ["CAPTURE_UNKNOWN", "MISMATCH"],
      ["PENDING", "COMPLETED"], ["PENDING", "FAILED"], ["PENDING", "MISMATCH"]];
    for (const [from, to] of edges) {
      const { id } = await orderAt(from); const before = (await db.select().from(s.donationOrders).where(eq(s.donationOrders.id, id)))[0]!;
      const attempts = to === "CAPTURING" ? before.captureAttempts + 1 : before.captureAttempts;
      await db.update(s.donationOrders).set({ status: to, captureAttempts: attempts }).where(eq(s.donationOrders.id, id));
      expect((await db.select().from(s.donationOrders).where(eq(s.donationOrders.id, id)))[0]).toMatchObject({ status: to, captureAttempts: attempts });
    }
  });
  it("counts every send and allows one retry at most", async () => {
    const approved = await orderAt("APPROVED");
    await refused(db.update(s.donationOrders).set({ status: "CAPTURING" }).where(eq(s.donationOrders.id, approved.id)), /exactly one capture attempt|check constraint/i);
    await refused(db.update(s.donationOrders).set({ status: "CAPTURING", captureAttempts: 2 }).where(eq(s.donationOrders.id, approved.id)), /exactly one capture attempt/);
    await refused(db.update(s.donationOrders).set({ captureAttempts: 1 }).where(eq(s.donationOrders.id, approved.id)), /counter changes only/);
    const unknown = await orderAt("CAPTURE_UNKNOWN");
    await db.update(s.donationOrders).set({ status: "CAPTURING", captureAttempts: 2 }).where(eq(s.donationOrders.id, unknown.id));
    await db.update(s.donationOrders).set({ status: "CAPTURE_UNKNOWN" }).where(eq(s.donationOrders.id, unknown.id));
    await refused(db.update(s.donationOrders).set({ status: "CAPTURING", captureAttempts: 3 }).where(eq(s.donationOrders.id, unknown.id)), /donation_order_attempts/);
    await refused(db.update(s.donationOrders).set({ captureAttempts: 1 }).where(eq(s.donationOrders.id, unknown.id)), /counter changes only/);
  });
  it("refuses invalid inserts", async () => {
    const ok = { fundId: "fund_b", expectedAmountCents: 100n, createRequestId: "77777777-7777-4777-8777-777777777777", captureRequestId: "88888888-8888-4888-8888-888888888888" };
    const bad: [Partial<typeof s.donationOrders.$inferInsert>, RegExp][] = [
      [{ status: "COMPLETED" }, /starts as CREATED/], [{ status: "CAPTURING", captureAttempts: 1, orderId: "ORDER_X" }, /starts as CREATED/], [{ orderId: "ORDER_INSERT" }, /starts as CREATED/],
      [{ captureAttempts: 1 }, /starts as CREATED/], [{ leaseToken: "99999999-9999-4999-8999-999999999999", leaseExpiresAt: new Date(Date.now() + 1000) }, /starts as CREATED/],
      [{ fundId: "fund_g" }, /restricted funds only/], [{ expectedAmountCents: 0n }, /donation_order_expected_positive/], [{ expectedAmountCents: -1n }, /donation_order_expected_positive/],
      [{ captureRequestId: ok.createRequestId }, /donation_order_request_ids_differ/], [{ displayName: "x".repeat(41) }, /donation_order_display_name/], [{ displayName: " padded" }, /donation_order_display_name/], [{ displayName: "" }, /donation_order_display_name/],
      [{ status: "BOGUS" as s.DonationOrderStatus }, /starts as CREATED/], // the guard trigger fires before the CHECK
    ];
    for (const [override, pattern] of bad) await refused(db.insert(s.donationOrders).values({ ...ok, ...override }), pattern);
    // A request ID can never be reused by another order, in either column.
    const existing = await row((await orderAt("CREATED")).orderId);
    await refused(db.insert(s.donationOrders).values({ ...ok, createRequestId: existing.createRequestId }), /unique|duplicate/i);
    await refused(db.insert(s.donationOrders).values({ ...ok, captureRequestId: existing.captureRequestId }), /unique|duplicate/i);
    expect((await db.select().from(s.donationOrders).where(eq(s.donationOrders.createRequestId, ok.createRequestId)))).toHaveLength(0);
  });
  it("keeps the lease columns paired and the lease off final rows", async () => {
    const { id } = await orderAt("APPROVED");
    await refused(db.update(s.donationOrders).set({ leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }).where(eq(s.donationOrders.id, id)), /donation_order_lease_pair/);
    await db.update(s.donationOrders).set({ leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(s.donationOrders.id, id));
    await refused(db.update(s.donationOrders).set({ status: "MISMATCH" }).where(eq(s.donationOrders.id, id)), /donation_order_final_has_no_lease/);
  });
});

describe("DON-08 end to end through the real adapter with a stub fetch", () => {
  const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map(name => vi.spyOn(console, name).mockImplementation(() => undefined));
  afterEach(() => consoleSpies.forEach(spy => spy.mockClear()));
  const payer = { email_address: "payer.private@example.com", payer_id: "PAYERPRIVATE9", name: { given_name: "Privateer" }, address: { address_line_1: "99 Hidden Lane", country_code: "US" } };
  const card = { card: { last_digits: "LASTDIGITS77", brand: "VISA" } }; // a sentinel no UUID or numeric ID can contain by chance
  it("creates, approves, captures and records through stubbed Orders v2 with persisted request IDs and no payer data stored", async () => {
    const calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
    const state = { orderId: "ORDER_E2E", status: "CREATED", captured: false };
    let order: { fund: string; cents: bigint } | undefined;
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const target = String(input); const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ method: init?.method ?? "GET", url: target, headers, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      if (target.endsWith("/v1/oauth2/token")) return json({ access_token: "synthetic-token-e2e", expires_in: 3600 });
      const amountText = order ? `${order.cents / 100n}.${(order.cents % 100n).toString().padStart(2, "0")}` : "0.00";
      const view = () => ({ id: state.orderId, intent: "CAPTURE", status: state.status, payer, payment_source: card, links: [{ href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER_E2E", rel: "approve" }],
        purchase_units: [{ custom_id: order?.fund, amount: { currency_code: "USD", value: amountText }, shipping: { address: payer.address },
          ...(state.captured ? { payments: { captures: [{ id: "CAPTURE_E2E", status: "COMPLETED", amount: { currency_code: "USD", value: amountText }, update_time: "2026-10-30T20:00:00Z",
            seller_receivable_breakdown: { gross_amount: { currency_code: "USD", value: amountText }, paypal_fee: { currency_code: "USD", value: "1.20" }, net_amount: { currency_code: "USD", value: `${(order!.cents - 120n) / 100n}.${((order!.cents - 120n) % 100n).toString().padStart(2, "0")}` } } }] } } : {}) }] });
      if (target.endsWith("/v2/checkout/orders") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)); order = { fund: body.purchase_units[0].custom_id, cents: BigInt(body.purchase_units[0].amount.value.replace(".", "")) };
        return json(view(), 201);
      }
      if (target.endsWith("/capture")) { state.captured = true; state.status = "COMPLETED"; return json(view(), 201); }
      if (target.endsWith(`/v2/checkout/orders/${state.orderId}`)) return json(view());
      return json({ name: "RESOURCE_NOT_FOUND" }, 404);
    });
    const adapter = createApplicationSandboxPayments({ baseUrl: "https://api-m.sandbox.paypal.com", clientId: "synthetic-client-e2e", clientSecret: "synthetic-secret-e2e", payeeAllowlist: [], maxDemoPayoutCents: 50000n, maxDemoDonationCents: 5000n }, false, request);
    const before = await journalCount();
    const createdOrder = await createDonationOrder(db, adapter, { fundId: "fund_b", amountCents: 2500n, displayName: "Casey" }, LIMIT);
    expect(createdOrder.orderId).toBe("ORDER_E2E"); state.status = "APPROVED"; // the donor approves in the PayPal popup
    const captured = await captureDonationOrder(db, adapter, "ORDER_E2E");
    expect(captured).toMatchObject({ status: "COMPLETED", posted: true, captureId: "CAPTURE_E2E" });
    expect(await journalCount()).toBe(before + 2);
    expect(await postingsFor("CAPTURE_E2E")).toEqual([["donation", [["1010", 2500n, 0n], ["4100", 0n, 2500n]]], ["donation_fee", [["5900", 120n, 0n], ["1010", 0n, 120n]]]]);
    const stored = await row("ORDER_E2E");
    const posts = calls.filter(c => c.method === "POST" && !c.url.endsWith("/token"));
    expect(posts.map(c => c.url)).toEqual(["https://api-m.sandbox.paypal.com/v2/checkout/orders", "https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER_E2E/capture"]);
    expect(posts[0]!.headers["PayPal-Request-Id"]).toBe(stored.createRequestId); expect(posts[1]!.headers["PayPal-Request-Id"]).toBe(stored.captureRequestId);
    expect(JSON.parse(posts[0]!.body!)).toEqual({ intent: "CAPTURE", purchase_units: [{ custom_id: "fund_b", amount: { currency_code: "USD", value: "25.00" } }] });
    expect(calls.every(c => c.url.startsWith("https://api-m.sandbox.paypal.com/"))).toBe(true);
    const everything = JSON.stringify([await db.select().from(s.donationOrders), await db.select().from(s.donationReceipts), captured, createdOrder], (_k, v) => typeof v === "bigint" ? v.toString() : v);
    for (const forbidden of ["payer.private@example.com", "PAYERPRIVATE9", "Privateer", "Hidden Lane", "LASTDIGITS77", "last_digits", "VISA", "checkoutnow", "synthetic-token-e2e", "synthetic-secret-e2e"]) expect(everything).not.toContain(forbidden);
    const journalText = JSON.stringify([await db.select().from(s.journalEntries), await db.select().from(s.journalPostings)], (_k, v) => typeof v === "bigint" ? v.toString() : v);
    for (const forbidden of ["payer.private@example.com", "PAYERPRIVATE9", "Privateer", "Hidden Lane", "LASTDIGITS77", "last_digits"]) expect(journalText).not.toContain(forbidden);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
  it("surfaces no secret or payer text in errors or results when the transport fails", async () => {
    const leaky = new Error("boom Authorization: Bearer synthetic-token-leak for payer.private@example.com");
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: "synthetic-token-leak", expires_in: 3600 })).mockRejectedValue(leaky);
    const adapter = createApplicationSandboxPayments({ baseUrl: "https://api-m.sandbox.paypal.com", clientId: "c", clientSecret: "synthetic-secret-leak", payeeAllowlist: [], maxDemoPayoutCents: 50000n }, false, request);
    const error = await failure(createDonationOrder(db, adapter, { fundId: "fund_b", amountCents: 100n }, LIMIT));
    expect(error.code).toBe("CREATE_UNKNOWN"); expect(`${error.message} ${error.stack?.split("\n")[0]}`).not.toMatch(/synthetic|Bearer|payer\.private/);
    const [orphan] = (await db.select().from(s.donationOrders)).filter(r => r.orderId === null && r.status === "CREATED").slice(-1);
    expect(orphan).toBeDefined();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
