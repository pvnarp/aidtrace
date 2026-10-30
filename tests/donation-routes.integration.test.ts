import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as s from "../db/schema";
import { closeDatabase } from "../src/server/db";
import { DONOR_MESSAGES, declinedMessage, handleDonationAction } from "../src/server/donation-actions";
import { donationMode, type DonationMode } from "../src/server/donation-mode";
import { POST as donationsRoute } from "../src/app/api/donations/route";
import { createDonationTestDatabase, makeDonationStub, type DonationStub } from "./support/donation-provider";

// IAC-379 step 3a, DON-09 and DON-12. Real isolated PostgreSQL, stubbed payments object only, no fetch, no network.
// These prove the AidTrace handler wiring and its fixed donor messages, not PayPal or PayPal SDK behavior.
const ORIGIN = "http://127.0.0.1:3100";
const SANDBOX = "https://api-m.sandbox.paypal.com";
let database: Awaited<ReturnType<typeof createDonationTestDatabase>>;
const savedEnv = { ...process.env };
beforeAll(async () => { database = await createDonationTestDatabase("aidtrace_don_routes"); process.env.APP_ORIGIN = ORIGIN; delete process.env.AIDTRACE_JUDGE_SESSION; }, 60_000);
afterAll(async () => { vi.unstubAllEnvs(); process.env = savedEnv; await closeDatabase(); await database.close(); });
const db = () => database.db;

function request(body: unknown, init: { origin?: string | null; type?: string | null; raw?: string; url?: string } = {}) {
  const headers = new Headers();
  if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  if (init.type !== null) headers.set("content-type", init.type ?? "application/json");
  return new Request(init.url ?? `${ORIGIN}/api/donations`, { method: "POST", headers, body: init.raw ?? JSON.stringify(body) });
}
async function act(stub: DonationStub, body: unknown, options: { mode?: DonationMode; origin?: string | null; type?: string | null; raw?: string; url?: string } = {}) {
  const factory = vi.fn(() => stub.payments);
  const response = await handleDonationAction(request(body, options), { db: db(), payments: factory, mode: options.mode ?? "KEYED" });
  return { status: response.status, body: await response.json() as Record<string, unknown>, factory, headers: response.headers };
}
const create = (stub: DonationStub, extra: Record<string, unknown> = {}) => act(stub, { action: "create", fundId: "fund_b", amountCents: "2500", ...extra });
const capture = (stub: DonationStub, id: string, orderId: string) => act(stub, { action: "capture", id, orderId });
async function readyOrder(stub: DonationStub, extra: Record<string, unknown> = {}) {
  const made = await create(stub, extra);
  expect(made.status).toBe(200);
  stub.approve();
  return { id: made.body.id as string, orderId: made.body.orderId as string };
}
const rowCount = async () => Number((await db().execute(sql`select count(*)::int as n from donation_orders`))[0]!.n);
const journalCount = async () => Number((await db().execute(sql`select count(*)::int as n from journal_entries`))[0]!.n);
const receiptCount = async (orderId: string) => (await db().select().from(s.donationReceipts).where(eq(s.donationReceipts.orderId, orderId))).length;
const byId = async (id: string) => (await db().select().from(s.donationOrders).where(eq(s.donationOrders.id, id)))[0]!;

describe("DON-09 a keyless session refuses every donation action", () => {
  it("returns 403 with a fixed message for create, capture and resume, and never touches payments or the database", async () => {
    const stub = makeDonationStub(); const before = await rowCount();
    for (const body of [
      { action: "create", fundId: "fund_b", amountCents: "2500" },
      { action: "capture", id: randomUUID(), orderId: "ORDER_1" },
      { action: "resume", id: randomUUID() },
    ]) {
      const result = await act(stub, body, { mode: "KEYLESS" });
      expect(result.status).toBe(403);
      expect(result.body).toEqual({ error: DONOR_MESSAGES.KEYLESS });
      expect(result.factory).not.toHaveBeenCalled();
    }
    expect(stub.calls).toEqual([]); expect(await rowCount()).toBe(before);
  });
  it("cannot be switched to keyed by the request: not by a body field, query string, header or cookie", async () => {
    const stub = makeDonationStub();
    const headers = new Headers({ origin: ORIGIN, "content-type": "application/json", "x-donation-mode": "KEYED", cookie: "mode=KEYED; donation_mode=KEYED" });
    const response = await handleDonationAction(new Request(`${ORIGIN}/api/donations?mode=KEYED&keyed=1`, { method: "POST", headers, body: JSON.stringify({ action: "create", fundId: "fund_b", amountCents: "2500", mode: "KEYED", keyed: true }) }), { db: db(), payments: () => stub.payments, mode: "KEYLESS" });
    expect(response.status).toBe(403); expect(stub.calls).toEqual([]);
  });
  it("answers 403 for a bad origin before anything else, in either mode", async () => {
    const stub = makeDonationStub();
    for (const mode of ["KEYED", "KEYLESS"] as const) expect((await act(stub, { action: "resume", id: randomUUID() }, { mode, origin: "https://evil.example" })).status).toBe(403);
    expect(stub.calls).toEqual([]);
  });
  it("treats a judge session as keyless even with sandbox credentials present, through the real route", async () => {
    expect(donationMode({ AIDTRACE_JUDGE_SESSION: "true", PAYPAL_BASE_URL: SANDBOX, PAYPAL_CLIENT_ID: "e2e-fake-client-id", PAYPAL_CLIENT_SECRET: "e2e-fake-secret" })).toBe("KEYLESS");
    vi.stubEnv("AIDTRACE_JUDGE_SESSION", "true"); vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3190");
    vi.stubEnv("PAYPAL_BASE_URL", SANDBOX); vi.stubEnv("PAYPAL_CLIENT_ID", "e2e-fake-client-id"); vi.stubEnv("PAYPAL_CLIENT_SECRET", "e2e-fake-secret");
    const before = await rowCount();
    try {
      const response = await donationsRoute(request({ action: "create", fundId: "fund_b", amountCents: "2500" }, { origin: "http://127.0.0.1:3190", url: "http://127.0.0.1:3190/api/donations" }));
      // A 500 here would mean the real getPayments() was called: it throws in a judge session.
      expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: DONOR_MESSAGES.KEYLESS });
    } finally { vi.unstubAllEnvs(); process.env.APP_ORIGIN = ORIGIN; delete process.env.AIDTRACE_JUDGE_SESSION; }
    expect(await rowCount()).toBe(before);
  });
  it("refuses everything when APP_ORIGIN is not an allowed local origin", async () => {
    const stub = makeDonationStub(); vi.stubEnv("APP_ORIGIN", "https://example.com");
    try { expect((await act(stub, { action: "resume", id: randomUUID() })).status).toBe(403); } finally { vi.unstubAllEnvs(); process.env.APP_ORIGIN = ORIGIN; }
  });
});

describe("DON-12 the keyed handler runs the order lifecycle with fixed donor messages", () => {
  it("creates, approves and captures COMPLETED through the handler, and posts exactly once", async () => {
    const stub = makeDonationStub(); const journalBefore = await journalCount();
    const made = await create(stub, { displayName: "  Pat  " });
    expect(made.status).toBe(200); expect(made.headers.get("cache-control")).toBe("no-store");
    expect(made.body).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), status: "CREATED", messageKey: "CREATED", message: DONOR_MESSAGES.CREATED, orderId: stub.world.orderId });
    expect(stub.payments.createDonationOrder).toHaveBeenCalledTimes(1);
    expect(stub.payments.createDonationOrder.mock.calls[0]![0]).toMatchObject({ fundId: "fund_b", amountCents: 2500n });
    expect(await byId(made.body.id as string)).toMatchObject({ displayName: "Pat", expectedAmountCents: 2500n, status: "CREATED" });
    stub.approve();
    const done = await capture(stub, made.body.id as string, made.body.orderId as string);
    expect(done.status).toBe(200);
    const tail = stub.captureId.slice(-6);
    expect(done.body).toEqual({ id: made.body.id, status: "COMPLETED", messageKey: "COMPLETED", message: "Thank you. Your gift is recorded.", captureTail: tail });
    expect(JSON.stringify(done.body)).not.toContain(stub.captureId);
    expect(await receiptCount(made.body.orderId as string)).toBe(1);
    const posted = await journalCount(); expect(posted).toBeGreaterThan(journalBefore);
    // Replaying the capture reports the recorded gift and posts nothing again. The masked ID comes from the ledger evidence.
    const again = await capture(stub, made.body.id as string, made.body.orderId as string);
    expect(again.body).toMatchObject({ messageKey: "COMPLETED", message: "Thank you. Your gift is recorded.", captureTail: tail });
    expect(await journalCount()).toBe(posted); expect(await receiptCount(made.body.orderId as string)).toBe(1);
    expect(stub.payments.captureDonationOrder).toHaveBeenCalledTimes(1);
  });

  it("refuses a cross-origin request, a wrong content type, an oversize body, bad JSON, unknown and extra keys", async () => {
    const stub = makeDonationStub(); const before = await rowCount();
    const good = { action: "create", fundId: "fund_b", amountCents: "2500" };
    expect((await act(stub, good, { origin: "https://evil.example" })).status).toBe(403);
    expect((await act(stub, good, { origin: null })).status).toBe(403);
    expect((await act(stub, good, { type: "text/plain" })).status).toBe(415);
    expect((await act(stub, good, { type: null })).status).toBe(415);
    expect((await act(stub, good, { raw: JSON.stringify({ ...good, displayName: "x".repeat(3000) }) })).status).toBe(413);
    expect((await act(stub, good, { raw: "{not json" })).status).toBe(400);
    expect((await act(stub, good, { raw: "[]" })).status).toBe(400);
    expect((await act(stub, good, { raw: "null" })).status).toBe(400);
    expect((await act(stub, { ...good, extra: 1 })).status).toBe(400);
    expect((await act(stub, { ...good, mode: "KEYED" })).status).toBe(400);
    expect((await act(stub, { action: "create", fundId: "fund_b" })).status).toBe(400);
    expect((await act(stub, { action: "resume", id: randomUUID(), displayName: "Pat" })).status).toBe(400);
    expect((await act(stub, { action: "capture", id: randomUUID() })).status).toBe(400);
    expect((await act(stub, { action: "refund", id: randomUUID() })).status).toBe(400);
    expect((await act(stub, { action: "toString" })).status).toBe(400);
    expect((await act(stub, { fundId: "fund_b", amountCents: "2500" })).status).toBe(400);
    expect((await act(stub, { ...good, amountCents: 2500 })).status).toBe(400);
    expect((await act(stub, { ...good, amountCents: "12.50" })).status).toBe(400);
    expect((await act(stub, { ...good, displayName: 7 })).status).toBe(400);
    expect(stub.calls).toEqual([]); expect(await rowCount()).toBe(before);
    const rejected = await act(stub, { ...good, extra: 1 });
    expect(rejected.factory).not.toHaveBeenCalled();
  });

  it("refuses a row id paired with another row's order ID, and malformed or unknown IDs", async () => {
    const stub = makeDonationStub(); const first = await readyOrder(stub);
    const other = makeDonationStub(); const second = await readyOrder(other);
    expect(second.orderId).not.toBe(first.orderId);
    const calls = [...stub.calls, ...other.calls];
    const crossed = await capture(stub, first.id, second.orderId);
    expect(crossed.status).toBe(404); expect(crossed.body).toEqual({ error: "We could not find that donation. Nothing was recorded." });
    expect((await capture(stub, randomUUID(), first.orderId)).status).toBe(404);
    expect((await capture(stub, first.id, "ORDER_DOES_NOT_EXIST")).status).toBe(404);
    expect((await capture(stub, "not-a-row-id", first.orderId)).status).toBe(400);
    expect((await capture(stub, first.id, "bad id!")).status).toBe(400);
    expect([...stub.calls, ...other.calls]).toEqual(calls); // nothing was read or captured
    expect(await byId(first.id)).toMatchObject({ status: "CREATED" }); expect(await byId(second.id)).toMatchObject({ status: "CREATED" });
    expect((await act(stub, { action: "resume", id: randomUUID() })).status).toBe(404);
  });

  it("maps a decline to the owner wording with 2 attempts left, then completes after the donor approves again", async () => {
    const stub = makeDonationStub(); const order = await readyOrder(stub); const journalBefore = await journalCount();
    stub.script.capture = ["decline"];
    const declined = await capture(stub, order.id, order.orderId);
    expect(declined.status).toBe(200);
    expect(declined.body).toEqual({ id: order.id, status: "DECLINED", messageKey: "DECLINED", message: "PayPal declined this payment, so it did not go through. You can try again, or use a different card or PayPal account. 2 attempts left.", attemptsLeft: 2, restart: true });
    expect(await journalCount()).toBe(journalBefore); expect(await byId(order.id)).toMatchObject({ status: "DECLINED", declinedCaptureRequestIds: [] });
    stub.script.capture = ["complete"]; stub.approve();
    const done = await capture(stub, order.id, order.orderId);
    expect(done.body).toMatchObject({ status: "COMPLETED", messageKey: "COMPLETED", message: "Thank you. Your gift is recorded.", captureTail: stub.captureId.slice(-6) });
    expect((await byId(order.id)).declinedCaptureRequestIds).toHaveLength(1);
    expect(await receiptCount(order.orderId)).toBe(1); expect(await journalCount()).toBeGreaterThan(journalBefore);
  });

  it("says 1 attempt left after the second decline and the exact closing wording after the third, from stored state", async () => {
    const stub = makeDonationStub(); const order = await readyOrder(stub); const journalBefore = await journalCount();
    stub.script.capture = ["decline", "decline", "decline"];
    const first = await capture(stub, order.id, order.orderId); stub.approve();
    const second = await capture(stub, order.id, order.orderId); stub.approve();
    expect(first.body.message).toBe(declinedMessage(2)); expect(first.body.message).toMatch(/2 attempts left\.$/);
    expect(second.body).toMatchObject({ messageKey: "DECLINED", attemptsLeft: 1, restart: true });
    expect(second.body.message).toBe("PayPal declined this payment, so it did not go through. You can try again, or use a different card or PayPal account. 1 attempt left.");
    const third = await capture(stub, order.id, order.orderId);
    expect(third.status).toBe(200);
    expect(third.body).toEqual({ id: order.id, status: "FAILED", messageKey: "CLOSED_AFTER_DECLINES", message: "PayPal declined this payment three times, so this donation is closed. Nothing was charged through AidTrace. You can start a new donation." });
    expect(stub.sentRequestIds).toHaveLength(3); expect(new Set(stub.sentRequestIds).size).toBe(3);
    expect(await journalCount()).toBe(journalBefore); expect(await receiptCount(order.orderId)).toBe(0);
    // A later read of the closed order has no proof of three declines in hand, so it gets the neutral wording.
    const later = await capture(stub, order.id, order.orderId);
    expect(later.body).toMatchObject({ status: "FAILED", messageKey: "NOT_COMPLETED", message: DONOR_MESSAGES.NOT_COMPLETED });
  });

  it("does not use the three-decline wording for any other failure", async () => {
    const stub = makeDonationStub(); const order = await readyOrder(stub);
    // The first two rounds were declined, but the third round fails some other way: the stored history alone is not proof.
    stub.script.capture = ["decline", "decline"];
    await capture(stub, order.id, order.orderId); stub.approve(); await capture(stub, order.id, order.orderId); stub.approve();
    stub.script.capture = ["pending"];
    stub.payments.captureDonationOrder.mockImplementationOnce(async (_orderId, requestId) => {
      stub.calls.push("capture"); stub.sentRequestIds.push(requestId);
      stub.world.captures = [{ captureId: "CAP_FAILED", status: "FAILED", amountCents: 2500n }]; stub.world.status = "APPROVED";
      return { httpStatus: 201, orderId: stub.world.orderId, intent: "CAPTURE", status: "APPROVED", units: stub.world.units, captures: stub.world.captures, errorIssues: [] };
    });
    const failed = await capture(stub, order.id, order.orderId);
    expect(failed.body).toMatchObject({ status: "FAILED", messageKey: "NOT_COMPLETED", message: DONOR_MESSAGES.NOT_COMPLETED });
    expect(failed.body.message).not.toMatch(/three times/);
  });

  it("returns CREATE_UNCONFIRMED with a retry, and resume then returns the order the first send made", async () => {
    const stub = makeDonationStub(); stub.script.create = ["timeout"];
    const unconfirmed = await create(stub);
    expect(unconfirmed.status).toBe(200);
    expect(unconfirmed.body).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), status: "CREATED", messageKey: "CREATE_UNCONFIRMED", message: "We could not confirm the order with PayPal yet.", retry: true });
    expect(unconfirmed.body).not.toHaveProperty("orderId");
    const resumed = await act(stub, { action: "resume", id: unconfirmed.body.id });
    expect(resumed.body).toEqual({ id: unconfirmed.body.id, status: "CREATED", messageKey: "CREATED", message: DONOR_MESSAGES.CREATED, orderId: stub.world.orderId });
    expect(stub.payments.createDonationOrder).toHaveBeenCalledTimes(2);
    expect(stub.payments.createDonationOrder.mock.calls[1]![0]).toEqual(stub.payments.createDonationOrder.mock.calls[0]![0]); // same persisted request ID, fund and amount
    stub.approve();
    expect((await capture(stub, unconfirmed.body.id as string, stub.world.orderId!)).body).toMatchObject({ messageKey: "COMPLETED" });
  });

  it("stops offering Try again after the third create send", async () => {
    const stub = makeDonationStub(); stub.script.create = ["timeout", "timeout", "timeout", "timeout"];
    const first = await create(stub); const id = first.body.id as string;
    expect((await act(stub, { action: "resume", id })).body).toMatchObject({ messageKey: "CREATE_UNCONFIRMED", retry: true });
    expect((await act(stub, { action: "resume", id })).body).toMatchObject({ messageKey: "CREATE_UNCONFIRMED", retry: true });
    const exhausted = await act(stub, { action: "resume", id });
    expect(exhausted.body).toMatchObject({ messageKey: "CREATE_UNCONFIRMED", retry: false });
    expect(stub.payments.createDonationOrder).toHaveBeenCalledTimes(3);
  });

  it("maps pending, unknown and mismatch results to their fixed messages", async () => {
    const pending = makeDonationStub(); const p = await readyOrder(pending); pending.script.capture = ["pending"];
    expect((await capture(pending, p.id, p.orderId)).body).toEqual({ id: p.id, status: "PENDING", messageKey: "PENDING", message: "PayPal is still processing this payment. Nothing is recorded until it completes." });
    const unknown = makeDonationStub(); const u = await readyOrder(unknown); unknown.script.capture = ["timeout"];
    const unknownResult = await capture(unknown, u.id, u.orderId);
    expect(unknownResult.body).toEqual({ id: u.id, status: "CAPTURE_UNKNOWN", messageKey: "CONFIRMING", message: "We are confirming this payment with PayPal. Please do not pay again." });
    expect(JSON.stringify(unknownResult.body)).not.toContain(u.orderId); expect(JSON.stringify(unknownResult.body)).not.toContain(unknown.captureId);
    const mismatch = makeDonationStub(); const m = await readyOrder(mismatch); mismatch.world.units = [{ fundId: "fund_b", amountCents: 1n }];
    const mismatched = await capture(mismatch, m.id, m.orderId);
    expect(mismatched.body).toMatchObject({ status: "MISMATCH", messageKey: "MISMATCH", message: DONOR_MESSAGES.MISMATCH });
    expect(mismatched.body.message).toMatch(/nothing was recorded/);
    expect(await receiptCount(m.orderId)).toBe(0);
  });

  it("maps lifecycle errors to 400, 404 or 409 with fixed text and never copies provider text", async () => {
    const stub = makeDonationStub(); const before = await rowCount();
    expect((await create(stub, { fundId: "fund_g" })).status).toBe(400);
    expect((await create(stub, { fundId: "nope" })).body).toEqual({ error: "Donations are accepted for restricted funds only. Choose a listed fund. Nothing was created." });
    expect((await create(stub, { amountCents: "0" })).status).toBe(400);
    expect((await create(stub, { amountCents: "99999999999999" })).status).toBe(400);
    expect((await create(stub, { displayName: "x".repeat(41) })).status).toBe(400);
    expect(await rowCount()).toBe(before); expect(stub.calls).toEqual([]);
    stub.script.create = [{ httpStatus: 400, errorCode: "SECRET_PROVIDER_CODE", errorIssues: ["SECRET_PROVIDER_ISSUE"] }];
    const rejected = await create(stub);
    expect(rejected.status).toBe(409); expect(JSON.stringify(rejected.body)).not.toMatch(/SECRET_PROVIDER|400/);
    expect(rejected.body).toEqual({ error: "PayPal did not accept this order, so nothing was created. You can try again." });
    const notApproved = makeDonationStub(); const made = await create(notApproved);
    const early = await capture(notApproved, made.body.id as string, made.body.orderId as string);
    expect(early.status).toBe(409); expect(early.body).toEqual({ error: "PayPal does not show this payment as approved yet, so nothing was captured. Approve it in PayPal and try again." });
    expect(notApproved.payments.captureDonationOrder).not.toHaveBeenCalled();
  });

  it("returns a fixed 500 message for an unexpected failure without leaking its text", async () => {
    const stub = makeDonationStub(); stub.payments.donationOrder.mockRejectedValueOnce(new Error("SECRET_INTERNAL_DETAIL"));
    const order = await readyOrder(stub);
    const failing = await act(stub, { action: "capture", id: order.id, orderId: order.orderId }, {});
    expect(failing.status).toBe(409); expect(failing.body).toEqual({ error: "We could not read this payment from PayPal, so nothing was captured. Please try again." });
    expect(JSON.stringify(failing.body)).not.toContain("SECRET_INTERNAL_DETAIL");
    const boom = await handleDonationAction(request({ action: "resume", id: order.id }), { db: db(), payments: () => { throw new Error("SECRET_INTERNAL_DETAIL"); }, mode: "KEYED" });
    expect(boom.status).toBe(500); const text = JSON.stringify(await boom.json());
    expect(text).not.toContain("SECRET_INTERNAL_DETAIL"); expect(text).toContain(DONOR_MESSAGES.UNEXPECTED);
  });
});
