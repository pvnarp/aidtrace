// IAC-384 (docs/plans/CLAUDE_AI_SCOPE.md feature A2, docs/ASSUMPTIONS.md section 83). POST /api/receipts/photo-text: one receipt photo as a raw body, one hosted AI read, a JSON transcript.
// Checks run in one fixed order: flag, method, origin, session, role, per-user rate limit, byte bound, magic bytes, AI status and budget, model call. A failing check never reaches a later one.
// The photo is read into memory, hashed, sent as base64 and dropped: nothing here stores it, logs it or returns it. Nothing here imports PayPal, the ledger, a claim approval or a payout module.
// Every refusal body is a fixed sentence. A handler never answers with an error, a stack, a library message or a model answer.
import { eq } from "drizzle-orm";
import { users } from "../../db/schema";
import type { AppDatabase } from "./db";
import { findSession, isSameOrigin, sessionToken } from "./auth";
import { receiptPhotoEnabled, receiptPhotoStatus } from "../ai/provider";
import { PHOTO_MAX_BYTES, PHOTO_MAX_LINES, afterSubtotal, readReceiptPhoto, sniffPhotoType, type Arithmetic, type PhotoReadOptions, type Transcript } from "../ai/claude-photo";
import { CLAUDE_NAMES } from "../ai/audit";
import type { ClaudeBudget } from "../ai/budget";
import { processPhotoRateLimiter, type PhotoRateLimiter } from "./receipt-photo-rate-limit";
import { recordPhotoRead } from "../receipt/photo-reads";
import { centsOfInput, photoContentDigest } from "../receipt/photo-digest";
import { PHOTO_FAILED, PHOTO_READ_NOTICE, centsToInput, photoAfterSubtotal, photoMismatch, photoSubtotalMismatch } from "../app/receipts/photo-copy";
import { aiModelLabel } from "../app/shell-copy";
import { poweredByLine } from "../app/ai-disclosure";

export type PhotoRouteDeps = { db: AppDatabase; env?: Record<string, string | undefined>; client?: PhotoReadOptions["client"]; budget?: ClaudeBudget; photoBudget?: ClaudeBudget; rate?: PhotoRateLimiter };

const HEADERS = { "Cache-Control": "no-store" };
const json = (status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", ...HEADERS, ...extra } });
const refuse = (status: number, message: string, extra: Record<string, string> = {}) => json(status, { ok: false, message }, extra);
const failed = (status: number) => json(status, { ok: false, message: PHOTO_FAILED });
const mediaType = (request: Request): string => (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();

type Body = { ok: true; bytes: Uint8Array } | { ok: false; status: 400 | 413 };
// Reads at most `limit` bytes. A declared length over the limit is refused before the body is read, and a body that outgrows the limit while streaming is cancelled at once.
// No body at all reads as empty bytes, which the magic check then refuses.
async function readBounded(request: Request, limit: number): Promise<Body> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^[0-9]{1,12}$/.test(declared)) { await request.body?.cancel().catch(() => undefined); return { ok: false, status: 400 }; }
    if (Number(declared) > limit) { await request.body?.cancel().catch(() => undefined); return { ok: false, status: 413 }; }
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: true, bytes: new Uint8Array(0) };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel().catch(() => undefined); return { ok: false, status: 413 }; }
    chunks.push(value);
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

// The values the draft form takes, built on the server so the browser only copies them in. The receipt text is plain: one line per item with its amount, then the subtotal, tax and total.
// A printed tax becomes a last line "Tax" when a line is free, because the form requires the total to equal the line amounts. The arithmetic result is shown either way.
export function photoPrefill(transcript: Transcript) {
  const lines = transcript.lines.map(line => ({ description: line.text, amount: centsToInput(line.amountCents) }));
  if (transcript.taxCents !== null && transcript.taxCents > 0 && lines.length < PHOTO_MAX_LINES) lines.push({ description: "Tax", amount: centsToInput(transcript.taxCents) });
  const text = [...transcript.lines.map(line => `${line.text} $${centsToInput(line.amountCents)}`),
    ...(transcript.subtotalCents === null ? [] : [`Subtotal $${centsToInput(transcript.subtotalCents)}`]),
    ...(transcript.taxCents === null ? [] : [`Tax $${centsToInput(transcript.taxCents)}`]), `Total $${centsToInput(transcript.totalCents)}`].join("\n");
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(transcript.datePrinted) && Number.isFinite(Date.parse(transcript.datePrinted)) && new Date(transcript.datePrinted).toISOString().slice(0, 10) === transcript.datePrinted ? transcript.datePrinted : null;
  return { vendor: transcript.vendor, incurredOn: iso, lines, total: centsToInput(transcript.totalCents), source: text };
}
// A hand-added amount after the subtotal gets a neutral note instead of the subtotal warning (ASSUMPTIONS section 87). The stored arithmetic result is not touched.
function afterNote(transcript: Transcript, result: Arithmetic): string | null {
  const after = afterSubtotal(transcript, result);
  return after ? photoAfterSubtotal(transcript.subtotalCents!, after.printedCount, after.afterCents, transcript.totalCents) : null;
}
function arithmeticMessage(result: Arithmetic): string | null {
  if (result.ok) return null;
  if (!result.linesPlusTaxMatchesTotal) return photoMismatch(result.linesCents + result.taxCents, result.totalCents);
  return photoSubtotalMismatch(result.linesCents, result.subtotalCents!);
}

export async function handlePhotoText(request: Request, deps: PhotoRouteDeps): Promise<Response> {
  try {
    const env = deps.env ?? process.env;
    if (!receiptPhotoEnabled(env)) return new Response("Not found", { status: 404, headers: HEADERS });
    if (request.method !== "POST") return refuse(405, "Method not allowed", { Allow: "POST" });
    if (!isSameOrigin(request)) return refuse(403, "Request origin rejected");
    const user = await findSession(sessionToken(request), deps.db);
    if (!user) return refuse(401, "Sign in first");
    if (user.role !== "CLAIMANT") return refuse(403, "Claimant access required");
    if (!(deps.rate ?? processPhotoRateLimiter).take(user.id)) return refuse(429, "Too many photo reads this hour. Type the receipt instead.", { "Retry-After": "3600" });
    const body = await readBounded(request, PHOTO_MAX_BYTES);
    if (!body.ok) return refuse(body.status, body.status === 413 ? "That photo is over 3.75 MB. Type the receipt instead." : "Invalid length");
    const type = sniffPhotoType(body.bytes);
    if (!type || mediaType(request) !== type) return refuse(415, "A JPEG, PNG or WebP photo is required");
    const status = receiptPhotoStatus(env, deps.budget);
    if (!status.on) return failed(503);
    const result = await readReceiptPhoto(body.bytes, type, { env, client: deps.client, budget: deps.budget, photoBudget: deps.photoBudget });
    if (result.status === "UNAVAILABLE") return failed(503);
    const [owner] = await deps.db.select({ organizationId: users.organizationId }).from(users).where(eq(users.id, user.id));
    if (!owner) return failed(500);
    const prefill = result.outcome === "READ" ? photoPrefill(result.transcript) : null;
    // The digest of exactly what the form is pre-filled with, so a later save can tell whether the person changed it. Only the digest is stored.
    const prefillSha256 = prefill ? photoContentDigest({ vendor: prefill.vendor, lines: prefill.lines.map(line => ({ description: line.description, amountCents: centsOfInput(line.amount) ?? 0n })), totalCents: centsOfInput(prefill.total) ?? 0n, source: prefill.source }) : null;
    const readId = await recordPhotoRead(deps.db, { id: user.id, organizationId: owner.organizationId }, result.facts, result.outcome, result.outcome === "READ" ? result.arithmetic.ok : null, prefillSha256);
    if (result.outcome !== "READ") return failed(result.outcome === "FAILED" ? 502 : 422);
    const note = afterNote(result.transcript, result.arithmetic);
    return json(200, { ok: true, readId, model: aiModelLabel(CLAUDE_NAMES[result.facts.model]), poweredBy: poweredByLine([result.facts.model]), notice: PHOTO_READ_NOTICE, mismatch: note === null ? arithmeticMessage(result.arithmetic) : null, note,
      arithmetic: { ok: result.arithmetic.ok, linesCents: result.arithmetic.linesCents, taxCents: result.arithmetic.taxCents, totalCents: result.arithmetic.totalCents },
      transcript: { vendor: result.transcript.vendor, datePrinted: result.transcript.datePrinted, lines: result.transcript.lines, subtotalCents: result.transcript.subtotalCents, taxCents: result.transcript.taxCents, totalCents: result.transcript.totalCents },
      prefill });
  } catch { return failed(500); }
}
