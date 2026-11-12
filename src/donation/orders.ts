import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import * as s from "../../db/schema";
import type { DonationOrderStatus } from "../../db/schema";
import type { AppDatabase } from "../server/db";
import { DONATION_MAX_CENTS, type DonationObservation, type DonationOrderCreateResult, type DonationOrderWriter, type DonationReader } from "../paypal/adapter";
import { recordDesignatedDonation } from "../ledger/donation";

// IAC-379 step 1, hardened by IAC-391: server-authoritative donation order lifecycle.
// This module never writes journal entries. Every posting goes
// through recordDesignatedDonation, which is unchanged.
//
// Owner decision 8: gifts are recorded under seeded Tara's approver identity as a system attribution, exactly as
// scripts/record-donation.ts resolves it. This is NOT a Tara login session: no one is signed in as Tara, the donor
// approves nothing, and no claim, approval, freeze or confirmation is touched.
export const DONATION_RECORDING_ACTOR_ID = "tara";
// AidTrace policy, not PayPal behavior: an order nobody finished for this long, holding no live lease, may expire.
export const DONATION_ABANDON_AFTER_MS = 3 * 60 * 60 * 1000;

export type DonationOrderPayments = DonationOrderWriter & DonationReader;
export type DonationOrderErrorCode = "INVALID_REQUEST" | "AMOUNT_OUT_OF_RANGE" | "FUND_NOT_ELIGIBLE" | "CREATE_REJECTED" | "CREATE_UNKNOWN" | "UNKNOWN_ORDER" | "NOT_APPROVED" | "READ_FAILED" | "LEASE_LOST";
// Messages are fixed text. Provider responses, headers, tokens and underlying error messages are never copied in.
export class DonationOrderError extends Error {
  constructor(readonly code: DonationOrderErrorCode, message: string) { super(message); this.name = "DonationOrderError"; }
}
export type DonationOrderReason = "READ_FAILED" | "RECORD_FAILED" | "POST_UNCONFIRMED" | "UNEXPECTED_RESPONSE" | "RETRY_EXHAUSTED" | "CREATE_UNCONFIRMED" | "INSTRUMENT_DECLINED";
export interface DonationOrderResult {
  id: string; orderId: string | null; status: DonationOrderStatus;
  posted: boolean;          // true only for the call whose recordDesignatedDonation actually wrote the journal
  captureId?: string;
  inProgress?: boolean;     // another caller holds the lease, or the order is waiting for reconcile or for a create replay
  reason?: DonationOrderReason;
}

type OrderRow = typeof s.donationOrders.$inferSelect;
const FINAL: ReadonlySet<DonationOrderStatus> = new Set(["COMPLETED", "FAILED", "MISMATCH", "EXPIRED"]);
const RECONCILABLE: readonly DonationOrderStatus[] = ["CAPTURE_UNKNOWN", "PENDING", "CAPTURING"];
const CAPTURABLE: readonly DonationOrderStatus[] = ["CREATED", "APPROVED", "DECLINED"];
const MAX_CAPTURE_ATTEMPTS = 2; // the first send plus exactly one same-ID retry; the database enforces the same cap
const MAX_CREATE_ATTEMPTS = 3;  // create sends with the persisted create request ID; the database enforces the same cap
const MAX_DECLINED_ROUNDS = 2;  // declined rounds kept in the history; the third decline ends the order FAILED
// A create answer that proves nothing about whether PayPal made the order: it is replayed with the same request ID.
const UNKNOWN_CREATE_STATUSES: ReadonlySet<number> = new Set([408, 409, 425, 429]);
// A lease outlives the longest chain of four 15 second provider calls. A crashed caller is recoverable after it expires.
const LEASE = sql`now() + interval '5 minutes'`;
const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FUND_ID = /^[a-z0-9_-]{1,64}$/;
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Integer cents only. Accepts a bigint, a safe integer number or a plain digit string within 1..DONATION_MAX_CENTS.
// The bound is input validity, not a donation limit. Everything else is refused.
export function parseDonationCents(value: unknown): bigint {
  let cents: bigint;
  if (typeof value === "bigint") cents = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) cents = BigInt(value);
  else if (typeof value === "string" && /^[1-9][0-9]{0,12}$/.test(value)) cents = BigInt(value);
  else throw new DonationOrderError("INVALID_REQUEST", "Donation amount must be a whole number of cents");
  if (cents <= 0n || cents > DONATION_MAX_CENTS) throw new DonationOrderError("AMOUNT_OUT_OF_RANGE", "Donation amount is outside the allowed range");
  return cents;
}
function cleanDisplayName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new DonationOrderError("INVALID_REQUEST", "Display name must be text");
  const name = value.trim();
  if (!name) return null;
  if (Array.from(name).length > 40 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) throw new DonationOrderError("INVALID_REQUEST", "Display name must be at most 40 visible characters");
  return name;
}
function outcome(row: OrderRow, extra: Partial<Pick<DonationOrderResult, "posted" | "captureId" | "inProgress" | "reason">> = {}): DonationOrderResult {
  return { id: row.id, orderId: row.orderId, status: row.status, posted: false, ...extra };
}
function providerOrderId(row: OrderRow) {
  if (!row.orderId) throw new DonationOrderError("UNKNOWN_ORDER", "The donation order has no provider order ID yet");
  return row.orderId;
}
async function findByOrderId(db: AppDatabase, orderId: unknown) {
  if (typeof orderId !== "string" || !ORDER_ID.test(orderId)) throw new DonationOrderError("INVALID_REQUEST", "A valid provider order ID is required");
  const [row] = await db.select().from(s.donationOrders).where(eq(s.donationOrders.orderId, orderId));
  if (!row) throw new DonationOrderError("UNKNOWN_ORDER", "No stored donation order has that ID");
  return row;
}
async function busy(db: AppDatabase, id: string) {
  const [row] = await db.select().from(s.donationOrders).where(eq(s.donationOrders.id, id));
  if (!row) throw new DonationOrderError("UNKNOWN_ORDER", "No stored donation order has that ID");
  return outcome(row, { inProgress: !FINAL.has(row.status) });
}

// Lease and conditional-update primitives. Each is one statement, so PostgreSQL row locking decides the winner:
// a concurrent UPDATE waits, re-evaluates its WHERE clause on the committed row, and matches nothing if it lost.
// A stale CAPTURING row (lease expired) is converted to CAPTURE_UNKNOWN by the same statement that claims it.
async function claim(db: AppDatabase, id: string, statuses: readonly DonationOrderStatus[], extra?: SQL) {
  const leaseToken = randomUUID();
  const [row] = await db.update(s.donationOrders).set({
    leaseToken, leaseExpiresAt: LEASE,
    status: sql`case when ${s.donationOrders.status} = 'CAPTURING' then 'CAPTURE_UNKNOWN' else ${s.donationOrders.status} end`,
  }).where(and(eq(s.donationOrders.id, id), inArray(s.donationOrders.status, [...statuses]), or(isNull(s.donationOrders.leaseExpiresAt), lt(s.donationOrders.leaseExpiresAt, sql`now()`)), extra)).returning();
  return row ? { row, token: leaseToken } : undefined;
}

// Moves a leased row from its current status to `to` (the same status just releases the lease). Only the lease holder
// can do this. Intermediate steps keep the lease; stopping states clear it. `attempt` records one capture send.
async function advance(db: AppDatabase, row: OrderRow, token: string, to: DonationOrderStatus, options: { keepLease?: boolean; attempt?: boolean } = {}) {
  const [next] = await db.update(s.donationOrders).set({
    status: to,
    ...(options.attempt ? { captureAttempts: row.captureAttempts + 1 } : {}),
    ...(options.keepLease ? { leaseExpiresAt: LEASE } : { leaseToken: null, leaseExpiresAt: null }),
  }).where(and(eq(s.donationOrders.id, row.id), eq(s.donationOrders.status, row.status), eq(s.donationOrders.captureAttempts, row.captureAttempts), eq(s.donationOrders.leaseToken, token))).returning();
  if (!next) throw new DonationOrderError("LEASE_LOST", "The donation order changed under this caller; no further action was taken");
  return next;
}
// A caller that cannot decide stops without a verdict. CAPTURING becomes CAPTURE_UNKNOWN; other statuses are unchanged.
async function park(db: AppDatabase, row: OrderRow, token: string, reason: DonationOrderReason) {
  return outcome(await advance(db, row, token, row.status === "CAPTURING" ? "CAPTURE_UNKNOWN" : row.status), { reason });
}

type Verdict = { kind: "COMPLETED"; captureId: string } | { kind: "PENDING" | "FAILED" | "MISMATCH" | "NO_CAPTURE" | "UNKNOWN" };
// The order binding the server stored, never anything the browser sent: intent, one unit, fund, exact USD cents.
function bindingMismatch(row: OrderRow, observation: DonationObservation) {
  const unit = observation.units[0];
  return observation.intent !== "CAPTURE" || observation.units.length !== 1 || unit?.fundId !== row.fundId || unit.amountCents !== row.expectedAmountCents;
}
function interpret(row: OrderRow, observation: DonationObservation): Verdict {
  if (observation.httpStatus !== 200 || observation.orderId !== row.orderId) return { kind: "UNKNOWN" };
  if (bindingMismatch(row, observation) || observation.captures.length > 1) return { kind: "MISMATCH" };
  const capture = observation.captures[0];
  if (!capture) return observation.status === "APPROVED" ? { kind: "NO_CAPTURE" } : { kind: "UNKNOWN" };
  if (capture.amountCents !== undefined && capture.amountCents !== row.expectedAmountCents) return { kind: "MISMATCH" };
  if (capture.status === "COMPLETED") return capture.captureId && capture.amountCents === row.expectedAmountCents ? { kind: "COMPLETED", captureId: capture.captureId } : { kind: "UNKNOWN" };
  if (capture.status === "PENDING") return { kind: "PENDING" };
  if (capture.status === "DECLINED" || capture.status === "FAILED") return { kind: "FAILED" };
  return { kind: "UNKNOWN" };
}

// Read the order, decide, apply. Used after a capture response and by reconcile. The capture response body itself is
// never trusted for a verdict: the order is re-read. `allowRetry` permits one same-ID re-send, from reconcile only.
async function settle(db: AppDatabase, payments: DonationOrderPayments, row: OrderRow, token: string, allowRetry: boolean): Promise<DonationOrderResult> {
  let observation: DonationObservation;
  try { observation = await payments.donationOrder(providerOrderId(row)); }
  catch { return park(db, row, token, "READ_FAILED"); }
  const verdict = interpret(row, observation);
  switch (verdict.kind) {
    case "MISMATCH": return outcome(await advance(db, row, token, "MISMATCH"));
    case "FAILED": return outcome(await advance(db, row, token, "FAILED"));
    case "PENDING": return outcome(await advance(db, row, token, "PENDING"));
    case "UNKNOWN": return park(db, row, token, "UNEXPECTED_RESPONSE");
    case "NO_CAPTURE": {
      // Still APPROVED with no capture. Only a stored CAPTURE_UNKNOWN row may be re-sent, once, with the same capture request ID.
      if (row.status !== "CAPTURE_UNKNOWN" || !allowRetry) return park(db, row, token, "POST_UNCONFIRMED");
      if (row.captureAttempts >= MAX_CAPTURE_ATTEMPTS) return park(db, row, token, "RETRY_EXHAUSTED");
      return sendCapture(db, payments, await advance(db, row, token, "CAPTURING", { keepLease: true, attempt: true }), token);
    }
    case "COMPLETED": {
      let recorded: Awaited<ReturnType<typeof recordDesignatedDonation>>;
      try {
        recorded = await recordDesignatedDonation(db, DONATION_RECORDING_ACTOR_ID, { orderId: providerOrderId(row), captureId: verdict.captureId, fundId: row.fundId, amountCents: row.expectedAmountCents }, payments);
      } catch { return park(db, row, token, "RECORD_FAILED"); }
      if (recorded.status === "COMPLETED") return outcome(await advance(db, row, token, "COMPLETED"), { posted: recorded.posted, captureId: verdict.captureId });
      return outcome(await advance(db, row, token, "PENDING")); // the ledger's own independent read saw a pending capture
    }
  }
}

// One capture POST for a row already persisted as CAPTURING with its attempt counted. The persisted capture_request_id
// is the only ID sent in this round. A definitive 422 INSTRUMENT_DECLINED ends the round: the order stays open (DECLINED)
// so the donor can approve another payment option, until the history already holds two declined rounds, which makes
// this the third decline and ends the order FAILED.
async function sendCapture(db: AppDatabase, payments: DonationOrderPayments, row: OrderRow, token: string): Promise<DonationOrderResult> {
  let response: Awaited<ReturnType<DonationOrderPayments["captureDonationOrder"]>>;
  try { response = await payments.captureDonationOrder(providerOrderId(row), row.captureRequestId); }
  catch { return park(db, row, token, "POST_UNCONFIRMED"); } // timeout or transport failure: outcome unknown, nothing posted
  if (response.httpStatus === 422 && response.errorIssues.includes("INSTRUMENT_DECLINED")) {
    return outcome(await advance(db, row, token, row.declinedCaptureRequestIds.length >= MAX_DECLINED_ROUNDS ? "FAILED" : "DECLINED"), { reason: "INSTRUMENT_DECLINED" });
  }
  if (response.httpStatus >= 200 && response.httpStatus < 300) return settle(db, payments, row, token, false);
  return park(db, row, token, "POST_UNCONFIRMED"); // 5xx or any other answer cannot prove that nothing was captured
}

// Classify a create answer. A capture needs a stored provider order ID, so any answer that does not prove PayPal made no
// order (a transport failure, 5xx, 408, 409, 425, 429, or a 2xx that is not a usable CREATED order) is replayed with the
// same request ID instead of abandoned. Every other 4xx is a definite refusal.
type CreateVerdict = { kind: "CREATED"; orderId: string } | { kind: "REJECTED" | "UNKNOWN" };
function createVerdict(created: DonationOrderCreateResult): CreateVerdict {
  if ((created.httpStatus === 200 || created.httpStatus === 201) && created.orderId && ORDER_ID.test(created.orderId) && created.status === "CREATED") return { kind: "CREATED", orderId: created.orderId };
  if (created.httpStatus >= 400 && created.httpStatus < 500 && !UNKNOWN_CREATE_STATUSES.has(created.httpStatus)) return { kind: "REJECTED" };
  return { kind: "UNKNOWN" };
}
const CREATE_UNCONFIRMED = { inProgress: true, reason: "CREATE_UNCONFIRMED" } as const;

// Step 2 and 1 of the scope table: validate, persist the row with a fresh create_request_id (create_attempts starts at 1),
// then call the adapter. An unknown outcome is returned, not thrown: the row id is the handle for resumeDonationOrder.
export async function createDonationOrder(
  db: AppDatabase, payments: DonationOrderWriter,
  input: { fundId: unknown; amountCents: unknown; displayName?: unknown },
): Promise<DonationOrderResult> {
  if (typeof input.fundId !== "string" || !FUND_ID.test(input.fundId)) throw new DonationOrderError("INVALID_REQUEST", "A valid fund ID is required");
  const amountCents = parseDonationCents(input.amountCents);
  const displayName = cleanDisplayName(input.displayName);
  // Refuse before taking money anything recordDesignatedDonation would later refuse: a restricted fund in the recording approver's organization.
  const [actor] = await db.select().from(s.users).where(eq(s.users.id, DONATION_RECORDING_ACTOR_ID));
  const [fund] = await db.select().from(s.funds).where(eq(s.funds.id, input.fundId));
  if (!actor || actor.role !== "APPROVER" || !fund || fund.organizationId !== actor.organizationId || fund.fundClass !== "RESTRICTED") throw new DonationOrderError("FUND_NOT_ELIGIBLE", "Donations are accepted for restricted funds only");
  const [row] = await db.insert(s.donationOrders).values({ fundId: fund.id, expectedAmountCents: amountCents, createRequestId: randomUUID(), captureRequestId: randomUUID(), displayName }).returning();
  if (!row) throw new DonationOrderError("CREATE_UNKNOWN", "The donation order was not persisted");
  // The row above is committed before the provider call. The adapter receives the persisted values, not the inputs.
  let created: DonationOrderCreateResult;
  try { created = await payments.createDonationOrder({ requestId: row.createRequestId, fundId: row.fundId, amountCents: row.expectedAmountCents }); }
  catch { return outcome(row, CREATE_UNCONFIRMED); }
  const verdict = createVerdict(created);
  if (verdict.kind === "CREATED") {
    const [stored] = await db.update(s.donationOrders).set({ orderId: verdict.orderId }).where(and(eq(s.donationOrders.id, row.id), eq(s.donationOrders.status, "CREATED"), isNull(s.donationOrders.orderId))).returning();
    return stored ? outcome(stored) : busy(db, row.id); // a concurrent resume or expiry already decided this row: report its current state
  }
  if (verdict.kind === "REJECTED") {
    await db.update(s.donationOrders).set({ status: "FAILED" }).where(and(eq(s.donationOrders.id, row.id), eq(s.donationOrders.status, "CREATED"), isNull(s.donationOrders.orderId)));
    throw new DonationOrderError("CREATE_REJECTED", "The provider rejected the donation order");
  }
  return outcome(row, CREATE_UNCONFIRMED);
}

// One create replay costs one counted send, committed before the send and keeping the lease.
async function countCreateSend(db: AppDatabase, row: OrderRow, token: string) {
  const [next] = await db.update(s.donationOrders).set({ createAttempts: row.createAttempts + 1, leaseExpiresAt: LEASE })
    .where(and(eq(s.donationOrders.id, row.id), eq(s.donationOrders.status, "CREATED"), isNull(s.donationOrders.orderId), eq(s.donationOrders.createAttempts, row.createAttempts), eq(s.donationOrders.leaseToken, token))).returning();
  if (!next) throw new DonationOrderError("LEASE_LOST", "The donation order changed under this caller; no further action was taken");
  return next;
}
async function releaseLease(db: AppDatabase, id: string, token: string) {
  await db.update(s.donationOrders).set({ leaseToken: null, leaseExpiresAt: null }).where(and(eq(s.donationOrders.id, id), eq(s.donationOrders.leaseToken, token)));
}

// Reconcile an unknown create. `id` is the row id returned by createDonationOrder. The create is replayed with the same
// persisted request ID, fund and amount, under the row lease, at most three sends in total. A replay with the same
// PayPal-Request-Id returns the latest status of the earlier request, so it can reveal the order the first send made.
// An order whose ID is never stored is unreachable and can never be charged: capture selects rows by stored order ID.
export async function resumeDonationOrder(db: AppDatabase, payments: DonationOrderWriter, id: unknown): Promise<DonationOrderResult> {
  if (typeof id !== "string" || !ROW_ID.test(id)) throw new DonationOrderError("INVALID_REQUEST", "A valid donation order ID is required");
  const [found] = await db.select().from(s.donationOrders).where(eq(s.donationOrders.id, id));
  if (!found) throw new DonationOrderError("UNKNOWN_ORDER", "No stored donation order has that ID");
  if (found.status !== "CREATED" || found.orderId !== null) return outcome(found);
  const held = await claim(db, found.id, ["CREATED"], isNull(s.donationOrders.orderId));
  if (!held) return busy(db, found.id);
  const { token } = held;
  if (held.row.createAttempts >= MAX_CREATE_ATTEMPTS) return outcome(await advance(db, held.row, token, "CREATED"), { reason: "RETRY_EXHAUSTED" }); // stays CREATED until it expires
  const row = await countCreateSend(db, held.row, token);
  let created: DonationOrderCreateResult;
  try { created = await payments.createDonationOrder({ requestId: row.createRequestId, fundId: row.fundId, amountCents: row.expectedAmountCents }); }
  catch { return outcome(await advance(db, row, token, "CREATED"), CREATE_UNCONFIRMED); }
  const verdict = createVerdict(created);
  if (verdict.kind === "UNKNOWN") return outcome(await advance(db, row, token, "CREATED"), CREATE_UNCONFIRMED);
  const [decided] = await db.update(s.donationOrders).set(verdict.kind === "CREATED" ? { orderId: verdict.orderId, leaseToken: null, leaseExpiresAt: null } : { status: "FAILED", leaseToken: null, leaseExpiresAt: null })
    .where(and(eq(s.donationOrders.id, row.id), eq(s.donationOrders.status, "CREATED"), isNull(s.donationOrders.orderId), eq(s.donationOrders.leaseToken, token))).returning();
  if (!decided) { await releaseLease(db, row.id, token); return busy(db, row.id); }
  return outcome(decided);
}

// Expire orders nobody finished. AidTrace policy, not PayPal behavior. One statement, so row locking decides every race.
// Only states that cannot hold a capture sent with the current request ID qualify: CREATED, APPROVED (a capture would
// have moved the row to CAPTURING first) and DECLINED (PayPal refused it). Rows with a live lease are skipped.
// CAPTURING, CAPTURE_UNKNOWN and PENDING never expire here: money may have moved, so only reconcile may decide them.
// No provider call is made.
export async function expireDonationOrders(db: AppDatabase, options: { abandonAfterMs?: number } = {}): Promise<string[]> {
  const abandonAfterMs = options.abandonAfterMs ?? DONATION_ABANDON_AFTER_MS;
  if (typeof abandonAfterMs !== "number" || !Number.isSafeInteger(abandonAfterMs) || abandonAfterMs < 0) throw new DonationOrderError("INVALID_REQUEST", "A non-negative whole number of milliseconds is required");
  const expired = await db.update(s.donationOrders).set({ status: "EXPIRED", leaseToken: null, leaseExpiresAt: null }).where(and(
    inArray(s.donationOrders.status, ["CREATED", "APPROVED", "DECLINED"]),
    or(isNull(s.donationOrders.leaseExpiresAt), lt(s.donationOrders.leaseExpiresAt, sql`now()`)),
    lt(s.donationOrders.updatedAt, sql`now() - ${abandonAfterMs}::double precision * interval '1 millisecond'`),
  )).returning({ id: s.donationOrders.id });
  return expired.map(expiredRow => expiredRow.id);
}

// A donor re-approved a declined order: one statement starts the next capture round. The old ID joins the append-only
// history, a fresh ID replaces it and the attempt counter resets. The lease holder keeps the lease and the guard trigger
// refuses any other change to the capture request ID or the history.
async function startNextRound(db: AppDatabase, row: OrderRow, token: string) {
  const [next] = await db.update(s.donationOrders).set({
    status: "APPROVED", captureAttempts: 0, captureRequestId: randomUUID(), leaseExpiresAt: LEASE,
    declinedCaptureRequestIds: sql`${s.donationOrders.declinedCaptureRequestIds} || ${s.donationOrders.captureRequestId}`,
  }).where(and(eq(s.donationOrders.id, row.id), eq(s.donationOrders.status, "DECLINED"), eq(s.donationOrders.captureAttempts, row.captureAttempts), eq(s.donationOrders.leaseToken, token), eq(s.donationOrders.captureRequestId, row.captureRequestId))).returning();
  if (!next) throw new DonationOrderError("LEASE_LOST", "The donation order changed under this caller; no further action was taken");
  return next;
}

// Steps 4 and 5. `orderId` comes from the browser's onApprove, so it only selects a stored row. Fund, amount and
// currency come from the stored expectation. No provider call is made unless this caller wins the lease.
// A DECLINED row is capturable only after the donor approves again: the order is read first, and only an APPROVED
// order with no capture and a matching binding starts the next round.
export async function captureDonationOrder(db: AppDatabase, payments: DonationOrderPayments, orderId: unknown): Promise<DonationOrderResult> {
  const stored = await findByOrderId(db, orderId);
  if (!CAPTURABLE.includes(stored.status)) return outcome(stored); // never a second capture from here; use reconcile
  const held = await claim(db, stored.id, CAPTURABLE);
  if (!held) return busy(db, stored.id);
  const { token } = held; let row = held.row;
  let observation: DonationObservation;
  try { observation = await payments.donationOrder(providerOrderId(row)); }
  catch { await advance(db, row, token, row.status); throw new DonationOrderError("READ_FAILED", "The provider order could not be read; nothing was captured"); }
  if (observation.httpStatus !== 200 || observation.orderId !== row.orderId) {
    await advance(db, row, token, row.status); throw new DonationOrderError("READ_FAILED", "The provider order could not be read; nothing was captured");
  }
  // Any binding difference, an existing capture or an unexpected provider status needs a person. CREATED or PAYER_ACTION_REQUIRED
  // only means the donor has not approved yet, so the row stays as it was and the donor may still approve.
  if (bindingMismatch(row, observation) || observation.captures.length > 0 || (observation.status !== "APPROVED" && observation.status !== "CREATED" && observation.status !== "PAYER_ACTION_REQUIRED")) return outcome(await advance(db, row, token, "MISMATCH"));
  if (observation.status !== "APPROVED") { await advance(db, row, token, row.status); throw new DonationOrderError("NOT_APPROVED", "The donor has not approved this order; nothing was captured"); }
  if (row.status === "CREATED") row = await advance(db, row, token, "APPROVED", { keepLease: true });
  else if (row.status === "DECLINED") row = await startNextRound(db, row, token);
  row = await advance(db, row, token, "CAPTURING", { keepLease: true, attempt: true }); // committed before the POST
  return sendCapture(db, payments, row, token);
}

// Resolve CAPTURE_UNKNOWN, PENDING and a crashed CAPTURING row. Read the order first. Record only through the ledger.
// A still-APPROVED order with no capture gets exactly one re-send with the same persisted capture_request_id.
export async function reconcileDonationOrder(db: AppDatabase, payments: DonationOrderPayments, orderId: unknown): Promise<DonationOrderResult> {
  const stored = await findByOrderId(db, orderId);
  if (!RECONCILABLE.includes(stored.status)) return outcome(stored);
  const held = await claim(db, stored.id, RECONCILABLE);
  if (!held) return busy(db, stored.id);
  return settle(db, payments, held.row, held.token, true);
}
