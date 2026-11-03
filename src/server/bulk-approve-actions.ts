// IAC-405 step 2 PR A (docs/plans/FUND_MODES_SCOPE.md section 4, docs/ASSUMPTIONS.md section 77). The approver-only route that approves several Assisted claims at once. Fixed order of
// checks: the flag first (a flag-off instance answers 404 as if the route did not exist, before anything else is read), method, origin, session, approver role, content type, a bounded body,
// then the exact fields. The only field is `claim`, repeated, each value "<claim id>:<claim version>". A decision hash is never accepted: the server resolves it. At most 25 claims, and a longer
// list is refused whole. The answer is JSON built only from claim ids that passed the id pattern and the fixed sentences in src/fund-modes/bulk-reasons.ts, never from request text or an error.
// It imports no PayPal, payout or sweep module and has no send path: the only writer it reaches is the approval service in src/fund-modes/bulk-approve.ts.
import { bulkApprove, type BulkItem } from "../fund-modes/bulk-approve";
import { BULK_LIMIT, BULK_SAVED_TEXT, BULK_SKIP_TEXT } from "../fund-modes/bulk-reasons";
import { fundModesEnabled, type FlagEnv } from "../fund-modes/flag";
import { findSession, isSameOrigin, sessionToken } from "./auth";
import type { AppDatabase } from "./db";

export type BulkApproveRouteDeps = { db: AppDatabase; env?: FlagEnv };
export const BULK_BODY_LIMIT = 4096;
const CLAIM = /^([A-Za-z0-9_-]{1,64}):([1-9][0-9]{0,5})$/;
const FORM_TYPE = "application/x-www-form-urlencoded";
const mediaType = (request: Request): string => (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
const HEADERS = { "Cache-Control": "no-store" };
const text = (status: number, body: string, extra: Record<string, string> = {}) => new Response(body, { status, headers: { ...HEADERS, ...extra } });

export async function handleBulkApprove(request: Request, deps: BulkApproveRouteDeps): Promise<Response> {
  try {
    if (!fundModesEnabled(deps.env)) return text(404, "Not found");
    if (request.method !== "POST") return text(405, "Method not allowed", { Allow: "POST" });
    if (!isSameOrigin(request)) return text(403, "Request origin rejected");
    const user = await findSession(sessionToken(request), deps.db);
    if (!user) return text(401, "Sign in first");
    if (user.role !== "APPROVER") return text(403, "Approver access required");
    if (mediaType(request) !== FORM_TYPE) return text(415, "Form submission required");
    const declared = request.headers.get("content-length");
    if (declared !== null && (!/^[0-9]{1,12}$/.test(declared) || Number(declared) > BULK_BODY_LIMIT)) { await request.body?.cancel().catch(() => undefined); return text(/^[0-9]{1,12}$/.test(declared) ? 413 : 400, "Form too large"); }
    const reader = request.body?.getReader(); if (!reader) return text(400, "Missing form");
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > BULK_BODY_LIMIT) { await reader.cancel().catch(() => undefined); return text(413, "Form too large"); }
      chunks.push(value);
    }
    let form: URLSearchParams;
    try { form = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { return text(400, "Invalid claim list"); }
    // Exactly one kind of field. A hash, a mode, an action or anything else is refused, so a client has no way to name what the server decides.
    if ([...form.keys()].some(key => key !== "claim")) return text(400, "Invalid claim list");
    const values = form.getAll("claim");
    if (values.length === 0) return text(400, "Invalid claim list");
    if (values.length > BULK_LIMIT) return text(400, `At most ${BULK_LIMIT} claims at a time`);
    const items: BulkItem[] = [];
    for (const value of values) {
      const match = CLAIM.exec(value);
      if (!match) return text(400, "Invalid claim list");
      items.push({ claimId: match[1]!, claimVersion: Number(match[2]) });
    }
    if (new Set(items.map(item => item.claimId)).size !== items.length) return text(400, "Invalid claim list");
    const result = await bulkApprove(deps.db, user.id, items, { env: deps.env });
    return new Response(JSON.stringify({
      approved: result.approved, saved: result.saved.map(claimId => ({ claimId, text: BULK_SAVED_TEXT })),
      skipped: result.skipped.map(skip => ({ claimId: skip.claimId, reason: skip.reason, text: BULK_SKIP_TEXT[skip.reason] })),
    }), { status: 200, headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8" } });
  } catch { return text(500, "That request could not be completed"); }
}
