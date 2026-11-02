import { eq } from "drizzle-orm";
import * as s from "../../db/schema";
import type { DonationOrderStatus } from "../../db/schema";
import { maskTail } from "../donation/display";
import { issueGiftLink } from "../donation/gift-link";
import { DonationOrderError, captureDonationOrder, createDonationOrder, resumeDonationOrder, type DonationOrderErrorCode, type DonationOrderPayments, type DonationOrderResult } from "../donation/orders";
import { isSameOrigin } from "./auth";
import type { AppDatabase } from "./db";
import type { DonationMode } from "./donation-mode";

// IAC-379 step 3a: the donor-facing JSON handler (DONATION_LOOP_SCOPE.md sections 3 and 7 to 9). Anyone may give, so
// there is no session. Every response uses fixed text: provider text, headers and error messages are never copied in.
// The server decides the mode. A KEYLESS session refuses every action before the payments factory is even called.
const MAX_BODY_BYTES = 2048;
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DECLINED_ROUNDS = 2; // mirrors orders.ts: the third decline ends the order
const SHAPES: Record<string, { required: string[]; optional: string[] }> = {
  create: { required: ["fundId", "amountCents"], optional: ["displayName"] },
  capture: { required: ["id", "orderId"], optional: [] },
  resume: { required: ["id"], optional: [] },
};

export type DonationMessageKey = "CREATED" | "COMPLETED" | "PENDING" | "CONFIRMING" | "CREATE_UNCONFIRMED" | "DECLINED" | "CLOSED_AFTER_DECLINES" | "NOT_COMPLETED" | "MISMATCH";
export const DONOR_MESSAGES = {
  KEYLESS: "Donations are not available in this session. No order was created, nothing was captured.",
  CREATED: "Your order is ready. Approve it with PayPal to continue. Nothing is charged until you approve.",
  COMPLETED: "Thank you. Your gift is recorded.",
  PENDING: "PayPal is still processing this payment. Nothing is recorded until it completes.",
  CONFIRMING: "We are confirming this payment with PayPal. Please do not pay again.",
  CREATE_UNCONFIRMED: "We could not confirm the order with PayPal yet.",
  CLOSED_AFTER_DECLINES: "PayPal declined this payment three times, so this donation is closed. Nothing was charged through AidTrace. You can start a new donation.",
  NOT_COMPLETED: "This donation did not complete and nothing was recorded. You can start a new donation.",
  MISMATCH: "This payment did not match the donation AidTrace expected, so nothing was recorded. Please do not pay again. A person needs to review it.",
  UNEXPECTED: "Something went wrong on our side. If you already approved a payment in PayPal, please do not pay again.",
} as const;
export const declinedMessage = (attemptsLeft: number) =>
  `PayPal declined this payment, so it did not go through. You can try again, or use a different card or PayPal account. ${attemptsLeft} ${attemptsLeft === 1 ? "attempt" : "attempts"} left.`;
const ERROR_RESPONSES: Record<DonationOrderErrorCode, readonly [number, string]> = {
  INVALID_REQUEST: [400, "That request was not valid. Nothing was recorded."],
  AMOUNT_OUT_OF_RANGE: [400, "Enter an amount greater than zero and within the supported range. Nothing was created."],
  FUND_NOT_ELIGIBLE: [400, "Donations are accepted for restricted funds only. Choose a listed fund. Nothing was created."],
  CREATE_REJECTED: [409, "PayPal did not accept this order, so nothing was created. You can try again."],
  CREATE_UNKNOWN: [409, "We could not create the order. Nothing was recorded. You can try again."],
  UNKNOWN_ORDER: [404, "We could not find that donation. Nothing was recorded."],
  NOT_APPROVED: [409, "PayPal does not show this payment as approved yet, so nothing was captured. Approve it in PayPal and try again."],
  READ_FAILED: [409, "We could not read this payment from PayPal, so nothing was captured. Please try again."],
  LEASE_LOST: [409, "This donation is being updated elsewhere. Please wait a moment and check again. Please do not pay again."],
};

// What the browser may see: the row id, the status, a message key with its fixed text, attempts left, and a capture ID
// masked to its last six characters only when the ledger evidence recorded one. The full PayPal order ID is returned
// only while an order is ready to approve, because the SDK needs it to open the popup.
export interface DonationView {
  id: string; status: DonationOrderStatus; messageKey: DonationMessageKey; message: string;
  orderId?: string; attemptsLeft?: number; captureTail?: string; retry?: boolean; restart?: boolean;
  // IAC-413: the one-time private gift link token, present only in the response that issued it, and the link state. The token is
  // never stored or logged by the server and is not repeated by a later response (SHOWN_BEFORE carries no token).
  giftToken?: string; giftLinkState?: "ISSUED" | "SHOWN_BEFORE";
}
const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const refuse = (status: number, error: string) => respond({ error }, status);

async function present(db: AppDatabase, result: DonationOrderResult, action: "create" | "capture" | "resume"): Promise<DonationView> {
  const base = { id: result.id, status: result.status };
  const view = (messageKey: DonationMessageKey, message: string, extra: Partial<DonationView> = {}): DonationView => ({ ...base, messageKey, message, ...extra });
  const confirming = () => view("CONFIRMING", DONOR_MESSAGES.CONFIRMING);
  // Declined rounds come from the stored history, never from the browser.
  const declinedRounds = async () => (await db.select({ history: s.donationOrders.declinedCaptureRequestIds }).from(s.donationOrders).where(eq(s.donationOrders.id, result.id)))[0]?.history.length ?? 0;
  switch (result.status) {
    case "COMPLETED": {
      let captureId = result.captureId;
      if (!captureId && result.orderId) captureId = (await db.select({ captureId: s.donationReceipts.captureId }).from(s.donationReceipts).where(eq(s.donationReceipts.orderId, result.orderId)))[0]?.captureId ?? undefined;
      const captureTail = maskTail(captureId);
      // IAC-413 (docs/plans/DONOR_TRAIL_SCOPE.md section 5.3): the private gift link is issued here, in the route layer, after the
      // capture is recorded. issueGiftLink never throws and never logs, so a refusal leaves the donation response unchanged.
      const link = captureId ? await issueGiftLink(db, captureId) : null;
      return view("COMPLETED", DONOR_MESSAGES.COMPLETED, {
        ...(captureTail ? { captureTail } : {}),
        ...(link ? { giftLinkState: link.state, ...(link.state === "ISSUED" ? { giftToken: link.token } : {}) } : {}),
      });
    }
    case "PENDING": return view("PENDING", DONOR_MESSAGES.PENDING);
    case "DECLINED": {
      if (result.inProgress) return confirming();
      const attemptsLeft = Math.max(0, MAX_DECLINED_ROUNDS - await declinedRounds());
      return view("DECLINED", declinedMessage(attemptsLeft), { attemptsLeft, restart: true });
    }
    case "FAILED":
      // The closing wording needs proof of three declined rounds: this call ended on a decline and the stored history holds two.
      if (result.reason === "INSTRUMENT_DECLINED" && await declinedRounds() >= MAX_DECLINED_ROUNDS) return view("CLOSED_AFTER_DECLINES", DONOR_MESSAGES.CLOSED_AFTER_DECLINES);
      return view("NOT_COMPLETED", DONOR_MESSAGES.NOT_COMPLETED);
    case "EXPIRED": return view("NOT_COMPLETED", DONOR_MESSAGES.NOT_COMPLETED);
    case "MISMATCH": return view("MISMATCH", DONOR_MESSAGES.MISMATCH);
    case "CREATED":
      if (action !== "capture" && result.orderId) return view("CREATED", DONOR_MESSAGES.CREATED, { orderId: result.orderId });
      if (action !== "capture") return view("CREATE_UNCONFIRMED", DONOR_MESSAGES.CREATE_UNCONFIRMED, { retry: result.reason !== "RETRY_EXHAUSTED" });
      return confirming();
    default: return confirming(); // APPROVED, CAPTURING, CAPTURE_UNKNOWN: the outcome is not decided
  }
}

async function readJson(request: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) return { ok: false, response: refuse(415, "A JSON request is required.") };
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, response: refuse(400, "That request was not valid. Nothing was recorded.") };
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > MAX_BODY_BYTES) { await reader.cancel(); return { ok: false, response: refuse(413, "That request was too large.") }; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return { ok: false, response: refuse(400, "That request was not valid. Nothing was recorded.") }; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, response: refuse(400, "That request was not valid. Nothing was recorded.") };
  return { ok: true, body: body as Record<string, unknown> };
}

export async function handleDonationAction(request: Request, deps: { db: AppDatabase; payments: () => DonationOrderPayments; mode: DonationMode }) {
  let sameOrigin = false;
  try { sameOrigin = isSameOrigin(request); } catch { sameOrigin = false; } // an unset or unexpected APP_ORIGIN refuses everything
  if (!sameOrigin) return refuse(403, "Request origin rejected.");
  if (deps.mode !== "KEYED") return refuse(403, DONOR_MESSAGES.KEYLESS);
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const { body } = parsed;
  const shape = typeof body.action === "string" && Object.hasOwn(SHAPES, body.action) ? SHAPES[body.action] : undefined;
  const keys = Object.keys(body);
  if (!shape || shape.required.some(key => !keys.includes(key)) || keys.some(key => key !== "action" && !shape.required.includes(key) && !shape.optional.includes(key))) return refuse(400, "That request was not valid. Nothing was recorded.");
  const action = body.action as "create" | "capture" | "resume";
  try {
    if (action === "create") {
      if (typeof body.fundId !== "string" || typeof body.amountCents !== "string" || !/^[0-9]{1,13}$/.test(body.amountCents) || (body.displayName !== undefined && typeof body.displayName !== "string")) return refuse(400, "That request was not valid. Nothing was created.");
      const result = await createDonationOrder(deps.db, deps.payments(), { fundId: body.fundId, amountCents: body.amountCents, displayName: body.displayName });
      return respond(await present(deps.db, result, action));
    }
    if (typeof body.id !== "string" || !ROW_ID.test(body.id)) return refuse(400, "That request was not valid. Nothing was recorded.");
    if (action === "resume") return respond(await present(deps.db, await resumeDonationOrder(deps.db, deps.payments(), body.id), action));
    if (typeof body.orderId !== "string" || !ORDER_ID.test(body.orderId)) return refuse(400, "That request was not valid. Nothing was recorded.");
    // The row id and the provider order ID must name the same stored row, so a browser cannot capture another donor's order.
    const [row] = await deps.db.select({ orderId: s.donationOrders.orderId }).from(s.donationOrders).where(eq(s.donationOrders.id, body.id));
    if (!row || row.orderId !== body.orderId) return refuse(404, ERROR_RESPONSES.UNKNOWN_ORDER[1]);
    return respond(await present(deps.db, await captureDonationOrder(deps.db, deps.payments(), body.orderId), action));
  } catch (error) {
    if (error instanceof DonationOrderError) { const [status, message] = ERROR_RESPONSES[error.code]; return refuse(status, message); }
    return refuse(500, DONOR_MESSAGES.UNEXPECTED);
  }
}
