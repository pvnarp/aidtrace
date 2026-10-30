import { randomBytes, randomUUID } from "node:crypto";
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
import { DONATION_MAX_CENTS, createApplicationSandboxPayments, type DonationObservation, type DonationOrderWriter, type DonationReader } from "../src/paypal/adapter";
import { DONATION_ABANDON_AFTER_MS, DonationOrderError, captureDonationOrder, createDonationOrder, expireDonationOrders, reconcileDonationOrder, resumeDonationOrder, type DonationOrderPayments } from "../src/donation/orders";

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
  // `creates` is what PayPal did with a create (it made the order); `answers` is what our server heard back, one per send.
  const createScript: { creates: boolean; answers: ("ok" | "timeout" | number)[] } = { creates: true, answers: [] };
  const createSent: Parameters<DonationOrderWriter["createDonationOrder"]>[0][] = []; const madeFor = new Set<string>();
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
      createSent.push({ ...order });
      // PayPal is idempotent per PayPal-Request-Id: a replay never makes a second order and answers with the first one.
      if (createScript.creates && !madeFor.has(order.requestId)) { madeFor.add(order.requestId); world.orderId = `ORDER_${serial}`; world.units = [{ fundId: order.fundId, amountCents: order.amountCents }]; }
      const answer = createScript.answers.shift() ?? "ok";
      if (answer === "timeout") throw new Error("synthetic timeout");
      if (typeof answer === "number") return { httpStatus: answer, errorIssues: [] };
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
  return { world, script, hooks, sent, createScript, createSent, provider: provider satisfies DonationOrderPayments, mocks: provider, approve: () => { world.status = "APPROVED"; }, complete: () => finish("COMPLETED"), captureId: `CAPTURE_${serial}` };
}
type Harness = ReturnType<typeof makeProvider>;
async function newOrder(h: Harness, cents: bigint | number | string = 2500n, fundId = "fund_b") {
  const result = await createDonationOrder(db, h.provider, { fundId, amountCents: cents });
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
async function orderAt(status: s.DonationOrderStatus, h: Harness = makeProvider()) {
  const order = await newOrder(h); const id = (await row(order.orderId)).id;
  const path: Record<s.DonationOrderStatus, [s.DonationOrderStatus, number][]> = {
    CREATED: [], APPROVED: [["APPROVED", 0]], CAPTURING: [["APPROVED", 0], ["CAPTURING", 1]], CAPTURE_UNKNOWN: [["APPROVED", 0], ["CAPTURING", 1], ["CAPTURE_UNKNOWN", 1]],
    PENDING: [["APPROVED", 0], ["CAPTURING", 1], ["PENDING", 1]], COMPLETED: [["APPROVED", 0], ["CAPTURING", 1], ["COMPLETED", 1]], FAILED: [["APPROVED", 0], ["CAPTURING", 1], ["FAILED", 1]], MISMATCH: [["MISMATCH", 0]],
    DECLINED: [["APPROVED", 0], ["CAPTURING", 1], ["DECLINED", 1]], EXPIRED: [["EXPIRED", 0]],
  };
  for (const [next, attempts] of path[status]) await db.update(s.donationOrders).set({ status: next, captureAttempts: attempts }).where(eq(s.donationOrders.id, id));
  return { id, orderId: order.orderId, h };
}
const byId = async (id: string) => (await db.select().from(s.donationOrders).where(eq(s.donationOrders.id, id)))[0]!;
// Test-only: switches the guard trigger off for one block so a CHECK constraint can be tested alone, or updated_at can be backdated
// (the trigger rewrites it on every update). Safe only because the tests in this file run one at a time against a throwaway database.
async function withoutGuard<T>(work: () => Promise<T>): Promise<T> {
  await db.execute(sql`alter table donation_orders disable trigger donation_order_guard`);
  try { return await work(); } finally { await db.execute(sql`alter table donation_orders enable trigger donation_order_guard`); }
}
const age = (id: string, ms: number) => withoutGuard(() => db.execute(sql`update donation_orders set updated_at = now() - ${ms}::double precision * interval '1 millisecond' where id = ${id}`));
const uuidArray = (ids: string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;
// A CREATED row with no provider order ID: the first create answer was lost, so the donor holds only the row id.
async function orphan(h: Harness, answers: ("ok" | "timeout" | number)[] = ["timeout"], cents = 100n) {
  h.createScript.answers = answers;
  const result = await createDonationOrder(db, h.provider, { fundId: "fund_b", amountCents: cents });
  expect(result).toMatchObject({ status: "CREATED", orderId: null, inProgress: true, reason: "CREATE_UNCONFIRMED" });
  return result;
}

describe("DON-01 creation persists first", () => {
  it("stores the order and both request IDs before the provider call, then attaches the provider order ID", async () => {
    const h = makeProvider(); let snapshot: typeof s.donationOrders.$inferSelect | undefined;
    h.hooks.atCreate = async order => { [snapshot] = await db.select().from(s.donationOrders).where(eq(s.donationOrders.createRequestId, order.requestId)); };
    const result = await createDonationOrder(db, h.provider, { fundId: "fund_b", amountCents: 2500n, displayName: "  Pat  " });
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
  it("DON-H-05 an unknown create returns a CREATED row without a provider ID and a replay handle, and a definite 4xx is FAILED and thrown", async () => {
    const h = makeProvider(); h.createScript.creates = false; h.createScript.answers = ["timeout"];
    const first = await createDonationOrder(db, h.provider, { fundId: "fund_b", amountCents: 100n });
    expect(first).toMatchObject({ status: "CREATED", orderId: null, inProgress: true, reason: "CREATE_UNCONFIRMED", posted: false });
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await db.select().from(s.donationOrders).where(eq(s.donationOrders.id, first.id)))[0]).toMatchObject({ status: "CREATED", orderId: null, createAttempts: 1, captureAttempts: 0, leaseToken: null, declinedCaptureRequestIds: [] });
    const rejected = makeProvider(); rejected.createScript.creates = false; rejected.createScript.answers = [400];
    expect((await failure(createDonationOrder(db, rejected.provider, { fundId: "fund_b", amountCents: 100n }))).code).toBe("CREATE_REJECTED");
    const [failed] = await db.select().from(s.donationOrders).where(eq(s.donationOrders.createRequestId, rejected.createSent[0]!.requestId));
    expect(failed).toMatchObject({ status: "FAILED", orderId: null });
    const odd = makeProvider(); odd.mocks.createDonationOrder.mockResolvedValueOnce({ httpStatus: 201, orderId: "ORDER_ODD", status: "COMPLETED", errorIssues: [] });
    const unusable = await createDonationOrder(db, odd.provider, { fundId: "fund_b", amountCents: 100n });
    expect(unusable).toMatchObject({ status: "CREATED", orderId: null, inProgress: true, reason: "CREATE_UNCONFIRMED" });
    expect((await db.select().from(s.donationOrders).where(eq(s.donationOrders.createRequestId, odd.mocks.createDonationOrder.mock.calls[0]![0].requestId)))[0]).toMatchObject({ status: "CREATED", orderId: null });
  });
  it.each([408, 409, 425, 429, 500, 502, 503, 504])("DON-H-05 HTTP %s on create is unknown: the row stays CREATED for a replay", async httpStatus => {
    const h = makeProvider(); h.createScript.creates = false; h.createScript.answers = [httpStatus];
    const result = await createDonationOrder(db, h.provider, { fundId: "fund_b", amountCents: 100n });
    expect(result).toMatchObject({ status: "CREATED", orderId: null, inProgress: true, reason: "CREATE_UNCONFIRMED" });
    expect((await db.select().from(s.donationOrders).where(eq(s.donationOrders.id, result.id)))[0]).toMatchObject({ status: "CREATED", orderId: null, createAttempts: 1 });
  });
  it.each([400, 401, 403, 404, 405, 415, 422])("DON-H-05 HTTP %s on create is a definite refusal: FAILED and CREATE_REJECTED", async httpStatus => {
    const h = makeProvider(); h.createScript.creates = false; h.createScript.answers = [httpStatus];
    expect((await failure(createDonationOrder(db, h.provider, { fundId: "fund_b", amountCents: 100n }))).code).toBe("CREATE_REJECTED");
    expect((await db.select().from(s.donationOrders).where(eq(s.donationOrders.createRequestId, h.createSent[0]!.requestId)))[0]).toMatchObject({ status: "FAILED", orderId: null, leaseToken: null });
  });
});

describe("DON-08 service validation", () => {
  const rowCount = async () => (await db.select().from(s.donationOrders)).length;
  it.each([0n, -1n, DONATION_MAX_CENTS + 1n, 0, -100, 12.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, "0", "-5", "12.5", "1e3", "05", "", " 100", "100 ", "0x10", "10000000000000", "9".repeat(17), true, null, undefined, {}, [100]])("refuses amount %s without a row or a provider call", async amount => {
    const h = makeProvider(); const before = await rowCount();
    await expect(createDonationOrder(db, h.provider, { fundId: "fund_b", amountCents: amount })).rejects.toBeInstanceOf(DonationOrderError);
    expect(h.mocks.createDonationOrder).not.toHaveBeenCalled(); expect(await rowCount()).toBe(before);
  });
  it("DON-H-04 has no business ceiling: USD 50.01, USD 1000 and the technical bound pass, one cent above the bound does not", async () => {
    for (const cents of [5001n, 25_000n, 100_000n, DONATION_MAX_CENTS]) { const h = makeProvider(); await newOrder(h, cents); expect(h.mocks.createDonationOrder.mock.calls[0]![0].amountCents).toBe(cents); }
    const maxed = makeProvider(); const big = await newOrder(maxed, "9999999999999"); expect((await row(big.orderId)).expectedAmountCents).toBe(DONATION_MAX_CENTS);
    const h = makeProvider(); const before = await rowCount();
    for (const over of [DONATION_MAX_CENTS + 1n, 10_000_000_000_000, 100_000_000_000_000n]) expect((await failure(createDonationOrder(db, h.provider, { fundId: "fund_b", amountCents: over }))).code).toBe("AMOUNT_OUT_OF_RANGE");
    for (const over of ["10000000000000", "9".repeat(14)]) expect((await failure(createDonationOrder(db, h.provider, { fundId: "fund_b", amountCents: over }))).code).toBe("INVALID_REQUEST");
    expect(h.mocks.createDonationOrder).not.toHaveBeenCalled(); expect(await rowCount()).toBe(before);
  });
  it.each(["fund_g", "fund_missing", "FUND_B", "", "fund b", 7, null, undefined])("accepts restricted funds only: refuses %s", async fundId => {
    const h = makeProvider(); const before = await rowCount();
    await expect(createDonationOrder(db, h.provider, { fundId, amountCents: 100n })).rejects.toBeInstanceOf(DonationOrderError);
    expect(h.mocks.createDonationOrder).not.toHaveBeenCalled(); expect(await rowCount()).toBe(before);
  });
  it("validates the optional display name and stores no other donor field", async () => {
    const h = makeProvider(); const before = await rowCount();
    for (const bad of ["x".repeat(41), "line\nbreak", "tab\there", "zero​width", "‮flip", 5, {}]) await expect(createDonationOrder(db, h.provider, { fundId: "fund_b", amountCents: 100n, displayName: bad })).rejects.toBeInstanceOf(DonationOrderError);
    expect(await rowCount()).toBe(before);
    const forty = await newOrder(makeProvider(), 100n); expect((await row(forty.orderId)).displayName).toBeNull();
    const named = makeProvider(); const ok = await createDonationOrder(db, named.provider, { fundId: "fund_b", amountCents: 100n, displayName: "x".repeat(40) });
    expect((await row(ok.orderId!)).displayName).toBe("x".repeat(40));
    const blank = makeProvider(); const none = await createDonationOrder(db, blank.provider, { fundId: "fund_b", amountCents: 100n, displayName: "   " });
    expect((await row(none.orderId!)).displayName).toBeNull();
  });
  it("stores no payer fields: the table has exactly the lifecycle columns", async () => {
    const columns = await db.execute(sql`select column_name from information_schema.columns where table_name = 'donation_orders' order by column_name`);
    expect([...columns].map(c => c.column_name)).toEqual(["capture_attempts", "capture_request_id", "create_attempts", "create_request_id", "created_at", "declined_capture_request_ids", "display_name", "expected_amount_cents", "fund_id", "id", "lease_expires_at", "lease_token", "order_id", "status", "updated_at"]);
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
  it("DON-H-18 an HTTP 422 INSTRUMENT_DECLINED becomes DECLINED (the donor may try again) and posts nothing", async () => {
    const h = makeProvider(); h.script.sideEffect = "none"; h.script.response = "instrument-declined"; const order = await approvedOrder(h); const before = await journalCount();
    expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "DECLINED", posted: false, reason: "INSTRUMENT_DECLINED" });
    expect(record).not.toHaveBeenCalled(); expect(await journalCount()).toBe(before); expect(h.sent).toHaveLength(1); expect(await row(order.orderId)).toMatchObject({ status: "DECLINED", captureAttempts: 1, leaseToken: null, leaseExpiresAt: null, declinedCaptureRequestIds: [] });
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
    expect((await createDonationOrder(db, h.provider, { fundId: "fund_b", amountCents: 100n })).reason).toBe("CREATE_UNCONFIRMED");
    const [orphan] = await db.select().from(s.donationOrders).where(eq(s.donationOrders.createRequestId, h.mocks.createDonationOrder.mock.calls[0]![0].requestId));
    await db.update(s.donationOrders).set({ orderId: "ORDER_ONCE" }).where(eq(s.donationOrders.id, orphan!.id));
    await refused(db.update(s.donationOrders).set({ orderId: "ORDER_TWICE" }).where(eq(s.donationOrders.id, orphan!.id)), /identity is immutable/);
    await refused(db.update(s.donationOrders).set({ status: "CAPTURING", captureAttempts: 1 }).where(eq(s.donationOrders.id, orphan!.id)), /Illegal donation order status transition/);
    const h2 = makeProvider(); h2.mocks.createDonationOrder.mockResolvedValueOnce({ httpStatus: 500, errorIssues: [] });
    expect((await createDonationOrder(db, h2.provider, { fundId: "fund_b", amountCents: 100n })).reason).toBe("CREATE_UNCONFIRMED");
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
    ["CREATED", "DECLINED"], ["APPROVED", "DECLINED"], ["CAPTURE_UNKNOWN", "DECLINED"], ["PENDING", "DECLINED"],
    ["PENDING", "EXPIRED"], ["CAPTURING", "EXPIRED"], ["CAPTURE_UNKNOWN", "EXPIRED"],
    ["DECLINED", "CAPTURING"], ["DECLINED", "CAPTURE_UNKNOWN"], ["DECLINED", "PENDING"], ["DECLINED", "COMPLETED"], ["DECLINED", "FAILED"], ["DECLINED", "CREATED"],
  ];
  it.each(illegal)("DON-H-26 refuses the transition %s to %s", async (from, to) => {
    const { id } = await orderAt(from);
    await refused(db.update(s.donationOrders).set({ status: to, captureAttempts: to === "CAPTURING" ? 2 : 1 }).where(eq(s.donationOrders.id, id)), /Illegal donation order status transition|attempt|check constraint/i);
    expect((await db.select().from(s.donationOrders).where(eq(s.donationOrders.id, id)))[0]!.status).toBe(from);
  });
  it.each(["COMPLETED", "FAILED", "MISMATCH", "EXPIRED"] as const)("freezes %s (DON-H-33 EXPIRED included): no status change and no other update", async final => {
    const { id } = await orderAt(final);
    for (const next of s.donationOrderStatuses.filter(status => status !== final)) await refused(db.update(s.donationOrders).set({ status: next }).where(eq(s.donationOrders.id, id)), /Final donation order states are immutable/);
    await refused(db.update(s.donationOrders).set({ updatedAt: new Date() }).where(eq(s.donationOrders.id, id)), /Final donation order states are immutable/);
    await refused(db.update(s.donationOrders).set({ leaseToken: "66666666-6666-4666-8666-666666666666", leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(s.donationOrders.id, id)), /Final donation order states are immutable|final_has_no_lease/);
  });
  it("DON-H-25 allows exactly the lifecycle's legal edges (DECLINED to APPROVED is covered by the rotation tests)", async () => {
    const edges: [s.DonationOrderStatus, s.DonationOrderStatus][] = [["CREATED", "APPROVED"], ["CREATED", "MISMATCH"], ["CREATED", "FAILED"], ["APPROVED", "CAPTURING"], ["APPROVED", "MISMATCH"],
      ["CAPTURING", "COMPLETED"], ["CAPTURING", "PENDING"], ["CAPTURING", "FAILED"], ["CAPTURING", "CAPTURE_UNKNOWN"], ["CAPTURING", "MISMATCH"],
      ["CAPTURE_UNKNOWN", "CAPTURING"], ["CAPTURE_UNKNOWN", "COMPLETED"], ["CAPTURE_UNKNOWN", "PENDING"], ["CAPTURE_UNKNOWN", "FAILED"], ["CAPTURE_UNKNOWN", "MISMATCH"],
      ["PENDING", "COMPLETED"], ["PENDING", "FAILED"], ["PENDING", "MISMATCH"],
      ["CREATED", "EXPIRED"], ["APPROVED", "EXPIRED"], ["CAPTURING", "DECLINED"], ["DECLINED", "MISMATCH"], ["DECLINED", "EXPIRED"]];
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
  // ---- IAC-391 guard tests: rotation, history, create attempts, insert rules, and each CHECK alone ----
  const rotationUpdate = (before: typeof s.donationOrders.$inferSelect, over: Partial<{ status: s.DonationOrderStatus; captureRequestId: string; history: string[]; attempts: number }> = {}) => ({
    status: over.status ?? "APPROVED", captureRequestId: over.captureRequestId ?? randomUUID(), captureAttempts: over.attempts ?? 0,
    declinedCaptureRequestIds: uuidArray(over.history ?? [...before.declinedCaptureRequestIds, before.captureRequestId]),
  }) as unknown as Partial<typeof s.donationOrders.$inferInsert>;
  async function declinedAgain(h: Harness) { // DECLINED in round one, rotated, then declined in round two: history holds one ID
    const first = await orderAt("DECLINED", h); const one = await byId(first.id);
    await db.update(s.donationOrders).set(rotationUpdate(one)).where(eq(s.donationOrders.id, first.id));
    await db.update(s.donationOrders).set({ status: "CAPTURING", captureAttempts: 1 }).where(eq(s.donationOrders.id, first.id));
    await db.update(s.donationOrders).set({ status: "DECLINED" }).where(eq(s.donationOrders.id, first.id));
    return first;
  }
  it("DON-H-25 DECLINED to APPROVED rotates the capture request ID, appends the old one to the history and resets attempts", async () => {
    const { id } = await orderAt("DECLINED"); const before = await byId(id); expect(before).toMatchObject({ status: "DECLINED", captureAttempts: 1, declinedCaptureRequestIds: [] });
    await db.update(s.donationOrders).set(rotationUpdate(before)).where(eq(s.donationOrders.id, id));
    const after = await byId(id);
    expect(after).toMatchObject({ status: "APPROVED", captureAttempts: 0, declinedCaptureRequestIds: [before.captureRequestId] });
    expect(after.captureRequestId).not.toBe(before.captureRequestId);
    // The next round can be sent, declined and rotated again, up to the two-ID history bound.
    await db.update(s.donationOrders).set({ status: "CAPTURING", captureAttempts: 1 }).where(eq(s.donationOrders.id, id));
    await db.update(s.donationOrders).set({ status: "DECLINED" }).where(eq(s.donationOrders.id, id));
    const round3 = await byId(id); await db.update(s.donationOrders).set(rotationUpdate(round3)).where(eq(s.donationOrders.id, id));
    expect((await byId(id)).declinedCaptureRequestIds).toEqual([before.captureRequestId, after.captureRequestId]);
  });
  it("DON-H-27 refuses a capture request ID change anywhere except DECLINED to APPROVED, and every malformed rotation", async () => {
    const approved = await orderAt("APPROVED"); const declined = await orderAt("DECLINED"); const capturing = await orderAt("CAPTURING");
    const dec = await byId(declined.id); const fresh = randomUUID();
    for (const target of [approved.id, capturing.id]) await refused(db.update(s.donationOrders).set({ captureRequestId: fresh }).where(eq(s.donationOrders.id, target)), /capture request ID changes only when a declined order is approved again/);
    await refused(db.update(s.donationOrders).set({ captureRequestId: fresh }).where(eq(s.donationOrders.id, declined.id)), /capture request ID changes only/); // DECLINED but not approved again
    await refused(db.update(s.donationOrders).set({ status: "CAPTURING", captureRequestId: fresh, captureAttempts: 2 }).where(eq(s.donationOrders.id, approved.id)), /capture request ID changes only|attempt/);
    await refused(db.update(s.donationOrders).set({ status: "MISMATCH", captureRequestId: fresh }).where(eq(s.donationOrders.id, declined.id)), /capture request ID changes only/);
    await refused(db.update(s.donationOrders).set({ status: "EXPIRED", captureRequestId: fresh }).where(eq(s.donationOrders.id, declined.id)), /capture request ID changes only/);
    const rotation = /approved again with a fresh capture request ID/;
    await refused(db.update(s.donationOrders).set(rotationUpdate(dec, { captureRequestId: dec.captureRequestId })).where(eq(s.donationOrders.id, declined.id)), rotation); // same ID reused
    await refused(db.update(s.donationOrders).set(rotationUpdate(dec, { history: [] })).where(eq(s.donationOrders.id, declined.id)), rotation); // old ID not appended
    await refused(db.update(s.donationOrders).set(rotationUpdate(dec, { history: [randomUUID()] })).where(eq(s.donationOrders.id, declined.id)), rotation); // wrong ID appended
    await refused(db.update(s.donationOrders).set(rotationUpdate(dec, { history: [dec.captureRequestId, randomUUID()] })).where(eq(s.donationOrders.id, declined.id)), rotation); // extra ID appended
    await refused(db.update(s.donationOrders).set(rotationUpdate(dec, { attempts: 1 })).where(eq(s.donationOrders.id, declined.id)), rotation); // attempts not reset
    await refused(db.update(s.donationOrders).set(rotationUpdate(dec, { captureRequestId: dec.createRequestId })).where(eq(s.donationOrders.id, declined.id)), /donation_order_request_ids_differ|history_distinct/); // the create ID
    const second = await declinedAgain(makeProvider()); const two = await byId(second.id); const earlier = two.declinedCaptureRequestIds[0]!;
    await refused(db.update(s.donationOrders).set(rotationUpdate(two, { captureRequestId: earlier })).where(eq(s.donationOrders.id, second.id)), /donation_order_history_distinct/); // a declined ID is never reused
    expect(await byId(declined.id)).toMatchObject({ status: "DECLINED", captureRequestId: dec.captureRequestId, declinedCaptureRequestIds: [] });
    expect(await byId(second.id)).toMatchObject({ status: "DECLINED", captureRequestId: two.captureRequestId });
  });
  it("DON-H-28 refuses a decline history edit and a fourth capture round", async () => {
    const approved = await orderAt("APPROVED"); const declined = await orderAt("DECLINED");
    for (const target of [approved.id, declined.id]) {
      await refused(db.update(s.donationOrders).set({ declinedCaptureRequestIds: uuidArray([randomUUID()]) }).where(eq(s.donationOrders.id, target)), /decline history changes only when a declined order is approved again/);
    }
    const two = await declinedAgain(makeProvider()); const round2 = await byId(two.id);
    await refused(db.update(s.donationOrders).set({ declinedCaptureRequestIds: uuidArray([]) }).where(eq(s.donationOrders.id, two.id)), /decline history changes only/); // removing an ID
    await db.update(s.donationOrders).set(rotationUpdate(round2)).where(eq(s.donationOrders.id, two.id)); // third round starts: history holds two IDs
    await db.update(s.donationOrders).set({ status: "CAPTURING", captureAttempts: 1 }).where(eq(s.donationOrders.id, two.id));
    await db.update(s.donationOrders).set({ status: "DECLINED" }).where(eq(s.donationOrders.id, two.id));
    const round3 = await byId(two.id); expect(round3.declinedCaptureRequestIds).toHaveLength(2);
    await refused(db.update(s.donationOrders).set(rotationUpdate(round3)).where(eq(s.donationOrders.id, two.id)), /donation_order_history_bound/); // a fourth round would hold three IDs
    expect(await byId(two.id)).toMatchObject({ status: "DECLINED", captureRequestId: round3.captureRequestId });
  });
  it("DON-H-29 moves the create attempt counter only while CREATED with no provider ID, by exactly one, and never past three", async () => {
    const h = makeProvider(); const lost = await orphan(h); const bump = (id: string, to: number) => db.update(s.donationOrders).set({ createAttempts: to }).where(eq(s.donationOrders.id, id));
    const counter = /create attempt counter changes only while CREATED with no provider ID, by exactly one/;
    await refused(bump(lost.id, 3), counter); // +2
    await refused(bump(lost.id, 0), counter);
    await bump(lost.id, 2); expect((await byId(lost.id)).createAttempts).toBe(2);
    await refused(bump(lost.id, 1), counter); // decrement
    await bump(lost.id, 3);
    await refused(bump(lost.id, 4), /donation_order_create_attempts/); // past three
    expect((await byId(lost.id)).createAttempts).toBe(3);
    const other = await orphan(makeProvider());
    await refused(db.update(s.donationOrders).set({ createAttempts: 2, orderId: "ORDER_WITH_BUMP" }).where(eq(s.donationOrders.id, other.id)), counter); // setting the order ID is not a send
    await refused(db.update(s.donationOrders).set({ createAttempts: 2, status: "FAILED" }).where(eq(s.donationOrders.id, other.id)), counter);
    for (const status of ["CREATED", "APPROVED", "DECLINED", "CAPTURING"] as const) { const { id } = await orderAt(status); await refused(bump(id, 2), counter); }
    expect((await byId(other.id)).createAttempts).toBe(1);
  });
  it("DON-H-31 refuses an insert that starts with a create attempt other than one, or with a decline history", async () => {
    const ok = { fundId: "fund_b", expectedAmountCents: 100n, createRequestId: randomUUID(), captureRequestId: randomUUID() };
    const rule = /starts as CREATED with no provider ID, capture attempt, lease or decline history, and one create attempt/;
    for (const createAttempts of [0, 2, 3, 4]) await refused(db.insert(s.donationOrders).values({ ...ok, createAttempts }), rule);
    await refused(db.insert(s.donationOrders).values({ ...ok, declinedCaptureRequestIds: [randomUUID()] }), rule);
    await refused(db.insert(s.donationOrders).values({ ...ok, expectedAmountCents: DONATION_MAX_CENTS + 1n }), /donation_order_expected_bound/);
    const [good] = await db.insert(s.donationOrders).values({ ...ok, expectedAmountCents: DONATION_MAX_CENTS }).returning();
    expect(good).toMatchObject({ status: "CREATED", createAttempts: 1, declinedCaptureRequestIds: [], expectedAmountCents: DONATION_MAX_CENTS });
  });
  it("DON-H-32 each new CHECK constraint refuses its own violation, tested alone with the guard trigger off", async () => {
    const created = await orderAt("CREATED"); const approved = await orderAt("APPROVED"); const capturing = await orderAt("CAPTURING"); const declined = await orderAt("DECLINED"); const lost = await orphan(makeProvider());
    const set = (id: string, change: Partial<typeof s.donationOrders.$inferInsert>) => db.update(s.donationOrders).set(change).where(eq(s.donationOrders.id, id));
    await withoutGuard(async () => {
      await refused(set(created.id, { expectedAmountCents: DONATION_MAX_CENTS + 1n }), /donation_order_expected_bound/);
      await set(created.id, { expectedAmountCents: DONATION_MAX_CENTS }); // exactly the bound is valid
      await refused(set(created.id, { status: "BOGUS" as s.DonationOrderStatus, captureAttempts: 1 }), /donation_order_status/); // attempts 1 keeps the other status checks quiet
      await refused(set(lost.id, { status: "APPROVED" }), /donation_order_id_required/); // APPROVED needs a provider order ID
      await set(lost.id, { status: "EXPIRED" }); // EXPIRED may lack one (and FAILED, per the existing rule)
      await refused(set(approved.id, { captureAttempts: 1 }), /donation_order_attempts_before_capture/);
      await refused(set(created.id, { captureAttempts: 1 }), /donation_order_attempts_before_capture/);
      await refused(set(capturing.id, { captureAttempts: 0 }), /donation_order_attempts_by_status/);
      await refused(set(declined.id, { captureAttempts: 0 }), /donation_order_attempts_by_status/);
      for (const attempts of [0, 4]) await refused(set(created.id, { createAttempts: attempts }), /donation_order_create_attempts/);
      await refused(set(created.id, { declinedCaptureRequestIds: [randomUUID(), randomUUID(), randomUUID()] }), /donation_order_history_bound/);
      const stored = await byId(created.id);
      await refused(set(created.id, { declinedCaptureRequestIds: [stored.captureRequestId] }), /donation_order_history_distinct/);
      await refused(set(created.id, { declinedCaptureRequestIds: [stored.createRequestId] }), /donation_order_history_distinct/);
      await set(created.id, { declinedCaptureRequestIds: [randomUUID(), randomUUID()] }); // two unrelated IDs are valid
      await refused(set(created.id, { status: "EXPIRED", leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) }), /donation_order_final_has_no_lease/);
    });
    expect((await db.execute(sql`select tgenabled from pg_trigger where tgname = 'donation_order_guard'`))[0]!.tgenabled).toBe("O"); // the guard is back on
  });
});

// IAC-391 service tests: stubbed provider only. They prove our wiring against a real isolated PostgreSQL, not PayPal behavior.
describe("IAC-391 resume an unknown create", () => {
  it("DON-H-06 a resume replays the SAME create request ID, counts the send before it, stores the order ID the first send made, and capture then completes", async () => {
    const h = makeProvider(); const lost = await orphan(h); const stored = await byId(lost.id);
    expect(h.world.orderId).toBeDefined(); // PayPal made the order; our server never heard the answer
    let snapshot: typeof s.donationOrders.$inferSelect | undefined;
    h.hooks.atCreate = async () => { snapshot = await byId(lost.id); };
    const resumed = await resumeDonationOrder(db, h.provider, lost.id);
    expect(resumed).toMatchObject({ id: lost.id, status: "CREATED", orderId: h.world.orderId, posted: false });
    expect(resumed.inProgress).toBeUndefined(); expect(resumed.reason).toBeUndefined();
    expect(h.createSent).toHaveLength(2); expect(h.createSent[1]).toEqual(h.createSent[0]);
    expect(h.createSent[0]).toEqual({ requestId: stored.createRequestId, fundId: "fund_b", amountCents: 100n });
    expect(snapshot).toMatchObject({ createAttempts: 2, orderId: null }); // committed before the send, with the lease live
    expect(snapshot!.leaseToken).not.toBeNull(); expect(snapshot!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await byId(lost.id)).toMatchObject({ orderId: h.world.orderId, createAttempts: 2, leaseToken: null, leaseExpiresAt: null, createRequestId: stored.createRequestId, captureRequestId: stored.captureRequestId });
    h.approve(); expect(await captureDonationOrder(db, h.provider, resumed.orderId!)).toMatchObject({ status: "COMPLETED", posted: true });
    expect(record).toHaveBeenCalledTimes(1); expect(h.createSent).toHaveLength(2);
  });
  it.each([400, 403, 404, 422])("DON-H-07 a replay answered HTTP %s is a definite refusal: FAILED, no further send", async httpStatus => {
    const h = makeProvider(); const lost = await orphan(h); h.createScript.answers = [httpStatus];
    expect(await resumeDonationOrder(db, h.provider, lost.id)).toMatchObject({ id: lost.id, status: "FAILED", orderId: null, posted: false });
    expect(await byId(lost.id)).toMatchObject({ status: "FAILED", orderId: null, createAttempts: 2, leaseToken: null, leaseExpiresAt: null });
    expect(await resumeDonationOrder(db, h.provider, lost.id)).toMatchObject({ status: "FAILED" }); expect(h.createSent).toHaveLength(2);
  });
  it("DON-H-08 three unknown sends end in RETRY_EXHAUSTED with no fourth send, and the row then expires", async () => {
    const h = makeProvider(); h.createScript.creates = false; const lost = await orphan(h, ["timeout", 503, "timeout"]);
    for (let send = 2; send <= 3; send++) {
      expect(await resumeDonationOrder(db, h.provider, lost.id)).toMatchObject({ status: "CREATED", orderId: null, inProgress: true, reason: "CREATE_UNCONFIRMED" });
      expect(await byId(lost.id)).toMatchObject({ createAttempts: send, leaseToken: null, status: "CREATED" });
    }
    expect(h.createSent).toHaveLength(3);
    const exhausted = await resumeDonationOrder(db, h.provider, lost.id);
    expect(exhausted).toMatchObject({ id: lost.id, status: "CREATED", orderId: null, reason: "RETRY_EXHAUSTED" }); expect(exhausted.inProgress).toBeUndefined();
    expect(h.createSent).toHaveLength(3); expect(await byId(lost.id)).toMatchObject({ status: "CREATED", createAttempts: 3, leaseToken: null, leaseExpiresAt: null });
    expect(await expireDonationOrders(db)).not.toContain(lost.id); // fresh: not yet abandoned
    expect(await expireDonationOrders(db, { abandonAfterMs: 0 })).toContain(lost.id);
    expect(await byId(lost.id)).toMatchObject({ status: "EXPIRED", orderId: null });
    expect(await resumeDonationOrder(db, h.provider, lost.id)).toMatchObject({ status: "EXPIRED" }); expect(h.createSent).toHaveLength(3);
  });
  it("DON-H-09 validates the row ID and leaves rows that are not an unconfirmed create untouched", async () => {
    const h = makeProvider();
    for (const bad of ["", "x", "../x", 5, null, undefined, {}, "ORDER_1", randomUUID() + "0"]) expect((await failure(resumeDonationOrder(db, h.provider, bad))).code).toBe("INVALID_REQUEST");
    expect((await failure(resumeDonationOrder(db, h.provider, randomUUID()))).code).toBe("UNKNOWN_ORDER");
    for (const status of ["CREATED", "APPROVED", "CAPTURING", "DECLINED", "COMPLETED", "FAILED", "MISMATCH", "EXPIRED"] as const) {
      const { id, h: own } = await orderAt(status); // every one of these already has a provider order ID or is final
      expect(await resumeDonationOrder(db, h.provider, id)).toMatchObject({ id, status, posted: false });
      expect((await byId(id)).createAttempts).toBe(1); expect(own.mocks.createDonationOrder).toHaveBeenCalledTimes(1); // only the original create: the resume sent nothing
    }
  });
  it("DON-H-10 skips a row whose lease is live, takes one whose lease expired, and concurrent resumes send one create", async () => {
    const h = makeProvider(); const lost = await orphan(h);
    await db.execute(sql`update donation_orders set lease_token = gen_random_uuid(), lease_expires_at = now() + interval '5 minutes' where id = ${lost.id}`);
    expect(await resumeDonationOrder(db, h.provider, lost.id)).toMatchObject({ status: "CREATED", orderId: null, inProgress: true });
    expect(h.createSent).toHaveLength(1); expect((await byId(lost.id)).createAttempts).toBe(1);
    await db.execute(sql`update donation_orders set lease_expires_at = now() - interval '1 second' where id = ${lost.id}`);
    expect(await resumeDonationOrder(db, h.provider, lost.id)).toMatchObject({ status: "CREATED", orderId: h.world.orderId });
    expect(h.createSent).toHaveLength(2);
    const racing = makeProvider(); const second = await orphan(racing);
    racing.hooks.atCreate = async () => { await sleep(60); };
    const results = await Promise.all([1, 2, 3, 4].map(() => resumeDonationOrder(db, racing.provider, second.id)));
    expect(racing.createSent).toHaveLength(2); // the original send plus exactly one resume
    expect(results.some(r => r.orderId === racing.world.orderId && !r.inProgress)).toBe(true); expect(results.every(r => r.orderId === racing.world.orderId || r.inProgress === true)).toBe(true);
    expect(await byId(second.id)).toMatchObject({ orderId: racing.world.orderId, createAttempts: 2, leaseToken: null });
  });
  it("DON-H-11 a conditional store that misses reports the current row instead of overwriting it, in create and in resume", async () => {
    const h = makeProvider();
    h.hooks.atCreate = async order => { await db.execute(sql`update donation_orders set order_id = 'ORDER_RACE_CREATE' where create_request_id = ${order.requestId}`); };
    const created = await createDonationOrder(db, h.provider, { fundId: "fund_b", amountCents: 100n });
    expect(created).toMatchObject({ status: "CREATED", orderId: "ORDER_RACE_CREATE" }); expect((await byId(created.id)).orderId).toBe("ORDER_RACE_CREATE");
    const r = makeProvider(); const lost = await orphan(r);
    r.hooks.atCreate = async order => { await db.execute(sql`update donation_orders set order_id = 'ORDER_RACE_RESUME' where create_request_id = ${order.requestId}`); };
    const resumed = await resumeDonationOrder(db, r.provider, lost.id);
    expect(resumed).toMatchObject({ id: lost.id, status: "CREATED", orderId: "ORDER_RACE_RESUME" });
    expect(await byId(lost.id)).toMatchObject({ orderId: "ORDER_RACE_RESUME", createAttempts: 2, leaseToken: null, leaseExpiresAt: null });
  });
  it("DON-H-12 through the real adapter: the replay carries the same PayPal-Request-Id and body, and the stored ID comes from the replay", async () => {
    const posts: { headers: Record<string, string>; body: string }[] = [];
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const target = String(input);
      if (target.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "synthetic-token-h12", expires_in: 3600 });
      if (target.endsWith("/v2/checkout/orders") && init?.method === "POST") {
        posts.push({ headers: (init.headers ?? {}) as Record<string, string>, body: String(init.body) });
        if (posts.length === 1) throw new Error("synthetic transport failure Bearer synthetic-token-h12");
        return Response.json({ id: "ORDER_H12", status: "CREATED", links: [] }, { status: 201 });
      }
      return Response.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 });
    });
    const adapter = createApplicationSandboxPayments({ baseUrl: "https://api-m.sandbox.paypal.com", clientId: "synthetic-client-h12", clientSecret: "synthetic-secret-h12", payeeAllowlist: [], maxDemoPayoutCents: 50000n }, false, request);
    const first = await createDonationOrder(db, adapter, { fundId: "fund_b", amountCents: 7777n });
    expect(first).toMatchObject({ status: "CREATED", orderId: null, inProgress: true, reason: "CREATE_UNCONFIRMED" });
    const resumed = await resumeDonationOrder(db, adapter, first.id);
    expect(resumed).toMatchObject({ status: "CREATED", orderId: "ORDER_H12" });
    expect(posts).toHaveLength(2); expect(posts[1]!.headers["PayPal-Request-Id"]).toBe(posts[0]!.headers["PayPal-Request-Id"]); expect(posts[1]!.body).toBe(posts[0]!.body);
    expect(posts[0]!.headers["PayPal-Request-Id"]).toBe((await byId(first.id)).createRequestId);
    expect(JSON.parse(posts[0]!.body)).toEqual({ intent: "CAPTURE", purchase_units: [{ custom_id: "fund_b", amount: { currency_code: "USD", value: "77.77" } }] });
    expect(JSON.stringify([first, resumed])).not.toMatch(/synthetic|Bearer/);
  });
});

describe("IAC-391 expire abandoned orders", () => {
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  it("DON-H-13 expires idle CREATED, APPROVED and DECLINED rows after the window, with no provider call, keeping the order ID", async () => {
    const h = makeProvider(); const lost = await orphan(h); const created = await orderAt("CREATED"); const approved = await orderAt("APPROVED"); const declined = await orderAt("DECLINED");
    const ids = [lost.id, created.id, approved.id, declined.id]; const sends = h.mocks.createDonationOrder.mock.calls.length; const others = [created.h, approved.h, declined.h];
    const fresh = await expireDonationOrders(db); for (const id of ids) expect(fresh).not.toContain(id); // just touched: inside the window
    for (const id of ids) await age(id, FOUR_HOURS);
    const expired = await expireDonationOrders(db); for (const id of ids) expect(expired).toContain(id);
    for (const id of ids) expect(await byId(id)).toMatchObject({ status: "EXPIRED", leaseToken: null, leaseExpiresAt: null });
    expect((await byId(lost.id)).orderId).toBeNull(); expect((await byId(approved.id)).orderId).toBe(approved.orderId);
    expect(h.mocks.createDonationOrder).toHaveBeenCalledTimes(sends); for (const p of [h, ...others]) { expect(p.mocks.donationOrder).not.toHaveBeenCalled(); expect(p.mocks.captureDonationOrder).not.toHaveBeenCalled(); }
    expect(await captureDonationOrder(db, approved.h.provider, approved.orderId)).toMatchObject({ status: "EXPIRED", posted: false }); // capture never reads or sends for an expired row
    expect(approved.h.mocks.donationOrder).not.toHaveBeenCalled(); expect(approved.h.mocks.captureDonationOrder).not.toHaveBeenCalled(); expect(await expireDonationOrders(db)).not.toContain(approved.id);
  });
  it("DON-H-14 skips a row with a live lease and includes one whose lease already expired", async () => {
    const live = await orphan(makeProvider()); const stale = await orphan(makeProvider());
    await db.execute(sql`update donation_orders set lease_token = gen_random_uuid(), lease_expires_at = now() + interval '5 minutes' where id = ${live.id}`);
    await db.execute(sql`update donation_orders set lease_token = gen_random_uuid(), lease_expires_at = now() - interval '1 second' where id = ${stale.id}`);
    await age(live.id, FOUR_HOURS); await age(stale.id, FOUR_HOURS);
    const expired = await expireDonationOrders(db);
    expect(expired).not.toContain(live.id); expect(expired).toContain(stale.id);
    expect(await byId(live.id)).toMatchObject({ status: "CREATED" }); expect((await byId(live.id)).leaseToken).not.toBeNull();
    expect(await byId(stale.id)).toMatchObject({ status: "EXPIRED", leaseToken: null, leaseExpiresAt: null });
  });
  it("DON-H-15 never expires CAPTURING, CAPTURE_UNKNOWN or PENDING, nor a final row, however old", async () => {
    const kept = [] as { id: string; status: s.DonationOrderStatus }[];
    for (const status of ["CAPTURING", "CAPTURE_UNKNOWN", "PENDING", "COMPLETED", "FAILED", "MISMATCH", "EXPIRED"] as const) { const { id } = await orderAt(status); await age(id, FOUR_HOURS); kept.push({ id, status }); }
    const expired = await expireDonationOrders(db, { abandonAfterMs: 0 });
    for (const { id, status } of kept) { expect(expired).not.toContain(id); expect((await byId(id)).status).toBe(status); }
  });
  it("DON-H-16 the default window is three hours, and bad options are refused", async () => {
    expect(DONATION_ABANDON_AFTER_MS).toBe(10_800_000);
    const inside = await orphan(makeProvider()); const outside = await orphan(makeProvider());
    await age(inside.id, DONATION_ABANDON_AFTER_MS - 60_000); await age(outside.id, DONATION_ABANDON_AFTER_MS + 60_000);
    const expired = await expireDonationOrders(db);
    expect(expired).not.toContain(inside.id); expect(expired).toContain(outside.id);
    expect((await byId(inside.id)).status).toBe("CREATED");
    for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, "5", {}]) expect((await failure(expireDonationOrders(db, { abandonAfterMs: bad as number }))).code).toBe("INVALID_REQUEST");
    expect((await byId(inside.id)).status).toBe("CREATED");
  });
  it("DON-H-17 concurrent expiry calls return disjoint ID sets that together cover every row", async () => {
    const rows = [] as string[]; for (let i = 0; i < 6; i++) { const lost = await orphan(makeProvider()); await age(lost.id, FOUR_HOURS); rows.push(lost.id); }
    const results = await Promise.all([1, 2, 3, 4].map(() => expireDonationOrders(db)));
    const all = results.flat(); expect(new Set(all).size).toBe(all.length);
    for (const id of rows) { expect(all).toContain(id); expect((await byId(id)).status).toBe("EXPIRED"); }
  });
});

describe("IAC-391 decline and try again", () => {
  const declineOnce = async (h: Harness, order: { orderId: string }) => {
    h.script.sideEffect = "none"; h.script.response = "instrument-declined";
    const result = await captureDonationOrder(db, h.provider, order.orderId); expect(result).toMatchObject({ status: "DECLINED", reason: "INSTRUMENT_DECLINED" }); return result;
  };
  const succeedNext = (h: Harness) => { h.script.response = "ok"; h.script.sideEffect = "complete"; };
  it("DON-H-19 decline, the donor approves again, capture completes with a fresh request ID and exactly one journal posting", async () => {
    const h = makeProvider(); const order = await approvedOrder(h); const before = await journalCount(); const first = (await row(order.orderId)).captureRequestId;
    await declineOnce(h, order); expect(record).not.toHaveBeenCalled();
    succeedNext(h); h.approve();
    expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "COMPLETED", posted: true, captureId: h.captureId });
    const done = await row(order.orderId);
    expect(done).toMatchObject({ status: "COMPLETED", captureAttempts: 1, declinedCaptureRequestIds: [first], leaseToken: null, leaseExpiresAt: null }); expect(done.captureRequestId).not.toBe(first);
    expect(h.sent.map(x => x.requestId)).toEqual([first, done.captureRequestId]);
    expect(record).toHaveBeenCalledTimes(1); expect(await journalCount()).toBe(before + 2); expect(await receipts(order.orderId)).toHaveLength(1);
    expect((await db.transaction(tx => reconcile(tx, "cedar-hollow"))).matches).toBe(true);
    expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "COMPLETED", posted: false }); expect(h.sent).toHaveLength(2); expect(await journalCount()).toBe(before + 2);
  });
  it("DON-H-20 the third decline ends the order FAILED: three distinct IDs, a two ID history, and nothing more is sent", async () => {
    const h = makeProvider(); const order = await approvedOrder(h); const before = await journalCount(); const first = (await row(order.orderId)).captureRequestId;
    await declineOnce(h, order);
    expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "DECLINED", reason: "INSTRUMENT_DECLINED" }); // second decline, after re-approval
    const second = await row(order.orderId); expect(second).toMatchObject({ status: "DECLINED", declinedCaptureRequestIds: [first], captureAttempts: 1 });
    const third = await captureDonationOrder(db, h.provider, order.orderId);
    expect(third).toMatchObject({ status: "FAILED", posted: false, reason: "INSTRUMENT_DECLINED" });
    const failed = await row(order.orderId);
    expect(failed).toMatchObject({ status: "FAILED", declinedCaptureRequestIds: [first, second.captureRequestId], captureAttempts: 1, leaseToken: null, leaseExpiresAt: null });
    expect(new Set([first, second.captureRequestId, failed.captureRequestId]).size).toBe(3);
    expect(h.sent.map(x => x.requestId)).toEqual([first, second.captureRequestId, failed.captureRequestId]);
    const reads = h.mocks.donationOrder.mock.calls.length; succeedNext(h); h.approve();
    expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "FAILED", posted: false });
    expect(await reconcileDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "FAILED" });
    expect(h.sent).toHaveLength(3); expect(h.mocks.donationOrder.mock.calls.length).toBe(reads); expect(record).not.toHaveBeenCalled(); expect(await journalCount()).toBe(before); expect(await receipts(order.orderId)).toHaveLength(0);
  });
  it.each(["CREATED", "PAYER_ACTION_REQUIRED"])("DON-H-21 a capture after a decline without a new approval (provider order %s) is NOT_APPROVED and the row stays DECLINED", async status => {
    const h = makeProvider(); const order = await approvedOrder(h); await declineOnce(h, order); const declined = await row(order.orderId);
    h.world.status = status; succeedNext(h); const reads = h.mocks.donationOrder.mock.calls.length;
    expect((await failure(captureDonationOrder(db, h.provider, order.orderId))).code).toBe("NOT_APPROVED");
    expect(h.mocks.donationOrder.mock.calls.length).toBe(reads + 1); expect(h.sent).toHaveLength(1);
    expect(await row(order.orderId)).toMatchObject({ status: "DECLINED", captureRequestId: declined.captureRequestId, declinedCaptureRequestIds: [], captureAttempts: 1, leaseToken: null, leaseExpiresAt: null });
    h.approve(); expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "COMPLETED", posted: true }); expect(h.sent).toHaveLength(2);
  });
  it("DON-H-22 a CAPTURE_UNKNOWN re-send inside round two uses round two's request ID, never round one's", async () => {
    const h = makeProvider(); const order = await approvedOrder(h); const first = (await row(order.orderId)).captureRequestId; await declineOnce(h, order);
    h.script.sideEffect = "none"; h.script.response = "timeout"; // round two: the answer is lost and PayPal did nothing
    expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "CAPTURE_UNKNOWN", reason: "POST_UNCONFIRMED" });
    const round2 = await row(order.orderId); expect(round2).toMatchObject({ captureAttempts: 1, declinedCaptureRequestIds: [first] }); expect(round2.captureRequestId).not.toBe(first);
    succeedNext(h);
    expect(await reconcileDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "COMPLETED", posted: true });
    expect(h.sent.map(x => x.requestId)).toEqual([first, round2.captureRequestId, round2.captureRequestId]);
    expect(await row(order.orderId)).toMatchObject({ status: "COMPLETED", captureAttempts: 2, captureRequestId: round2.captureRequestId, declinedCaptureRequestIds: [first] }); expect(record).toHaveBeenCalledTimes(1);
  });
  it("DON-H-23 concurrent captures after a re-approval send at most one capture for that round", async () => {
    const h = makeProvider(); h.hooks.readDelayMs = 25; const order = await approvedOrder(h); const before = await journalCount(); const first = (await row(order.orderId)).captureRequestId;
    await declineOnce(h, order); succeedNext(h); h.approve();
    const results = await Promise.all([1, 2, 3, 4].map(() => captureDonationOrder(db, h.provider, order.orderId)));
    expect(h.sent).toHaveLength(2); expect(h.sent[0]!.requestId).toBe(first); expect(h.sent[1]!.requestId).not.toBe(first);
    expect(results.filter(r => r.posted)).toHaveLength(1); expect(record).toHaveBeenCalledTimes(1); expect(await journalCount()).toBe(before + 2);
    expect(await row(order.orderId)).toMatchObject({ status: "COMPLETED", captureAttempts: 1, declinedCaptureRequestIds: [first], leaseToken: null });
  });
  it.each<[string, (h: Harness) => void]>([
    ["a wrong amount", (h: Harness) => { h.world.units[0]!.amountCents = 2499n; }],
    ["a capture that already exists", (h: Harness) => { h.complete(); }],
  ])("DON-H-24 after a decline, %s on the provider order is MISMATCH with no new capture sent", async (_label, tamper) => {
    const h = makeProvider(); const order = await approvedOrder(h); await declineOnce(h, order); const declined = await row(order.orderId); const before = await journalCount();
    tamper(h);
    expect(await captureDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "MISMATCH", posted: false });
    expect(h.sent).toHaveLength(1); expect(record).not.toHaveBeenCalled(); expect(await journalCount()).toBe(before);
    expect(await row(order.orderId)).toMatchObject({ status: "MISMATCH", captureRequestId: declined.captureRequestId, declinedCaptureRequestIds: [], leaseToken: null });
  });
  it("DON-H-24 reconcile does not own DECLINED: it reads nothing and sends nothing", async () => {
    const h = makeProvider(); const order = await approvedOrder(h); await declineOnce(h, order); const reads = h.mocks.donationOrder.mock.calls.length;
    expect(await reconcileDonationOrder(db, h.provider, order.orderId)).toMatchObject({ status: "DECLINED", posted: false });
    expect(h.mocks.donationOrder.mock.calls.length).toBe(reads); expect(h.sent).toHaveLength(1); expect((await row(order.orderId)).status).toBe("DECLINED");
  });
  it("DON-H-30 expiry never touches CAPTURING, CAPTURE_UNKNOWN or PENDING at the service, and the database refuses it directly", async () => {
    for (const status of ["CAPTURING", "CAPTURE_UNKNOWN", "PENDING"] as const) {
      const { id } = await orderAt(status); await age(id, 4 * 60 * 60 * 1000);
      expect(await expireDonationOrders(db, { abandonAfterMs: 0 })).not.toContain(id);
      await refused(db.update(s.donationOrders).set({ status: "EXPIRED" }).where(eq(s.donationOrders.id, id)), /Illegal donation order status transition/);
      expect((await byId(id)).status).toBe(status);
    }
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
    const adapter = createApplicationSandboxPayments({ baseUrl: "https://api-m.sandbox.paypal.com", clientId: "synthetic-client-e2e", clientSecret: "synthetic-secret-e2e", payeeAllowlist: [], maxDemoPayoutCents: 50000n }, false, request);
    const before = await journalCount();
    const createdOrder = await createDonationOrder(db, adapter, { fundId: "fund_b", amountCents: 2500n, displayName: "Casey" });
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
    const result = await createDonationOrder(db, adapter, { fundId: "fund_b", amountCents: 100n });
    expect(result).toMatchObject({ status: "CREATED", orderId: null, inProgress: true, reason: "CREATE_UNCONFIRMED" });
    expect(JSON.stringify(result, (_k, v) => typeof v === "bigint" ? v.toString() : v)).not.toMatch(/synthetic|Bearer|payer\.private|boom/);
    const [orphan] = (await db.select().from(s.donationOrders)).filter(r => r.orderId === null && r.status === "CREATED").slice(-1);
    expect(orphan).toBeDefined();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
