// IAC-405 step 2 PR F. The approver-only route that proposes and approves a fund's
// approval mode. Fixed order of checks: the flag first (a flag-off instance answers 404 as if the route did not exist, before anything else is read), method, origin, session, role, ids and the fund in the actor's
// organization, content type, bounded body, exact fields. A handler never answers with an error, a database message or request text: every redirect carries a code from
// src/server/rules-notices.ts. It imports no ledger, payout, PayPal or claim approval module: the only writer it reaches is src/fund-modes/change.ts.
import { and, eq } from "drizzle-orm";
import { funds, users } from "../../db/schema";
import { approveFundMode, proposeFundMode, type FundModeRefusal } from "../fund-modes/change";
import { fundModesEnabled, type FlagEnv } from "../fund-modes/flag";
import { findSession, isSameOrigin, sessionToken } from "./auth";
import type { AppDatabase } from "./db";
import { noticeQuery, type RulesNoticeCode } from "./rules-notices";

export type FundModeRouteDeps = { db: AppDatabase; env?: FlagEnv };
export const MODE_BODY_LIMIT = 2048;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const FORM_TYPE = "application/x-www-form-urlencoded";
const mediaType = (request: Request): string => (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
const HEADERS = { "Cache-Control": "no-store" };
const text = (status: number, body: string, extra: Record<string, string> = {}) => new Response(body, { status, headers: { ...HEADERS, ...extra } });

const refusalCode = (reason: FundModeRefusal): RulesNoticeCode => {
  switch (reason) {
    case "SAME_APPROVER": return "mode-same-approver";
    case "STALE_BASE": return "mode-stale";
    case "NO_CHANGE": return "mode-no-change";
    case "ALREADY_APPROVED": return "mode-done";
    case "GUARD_REFUSED": return "mode-guard";
    default: return "mode-failed";
  }
};

export async function handleFundMode(request: Request, fundId: string, deps: FundModeRouteDeps): Promise<Response> {
  try {
    if (!fundModesEnabled(deps.env)) return text(404, "Not found");
    if (request.method !== "POST") return text(405, "Method not allowed", { Allow: "POST" });
    if (!isSameOrigin(request)) return text(403, "Request origin rejected");
    const user = await findSession(sessionToken(request), deps.db);
    if (!user) return text(401, "Sign in first");
    if (user.role !== "APPROVER") return text(403, "Approver access required");
    if (!ID.test(fundId)) return text(404, "Fund not found");
    const [fund] = await deps.db.select({ id: funds.id }).from(funds).innerJoin(users, eq(users.organizationId, funds.organizationId)).where(and(eq(funds.id, fundId), eq(users.id, user.id)));
    if (!fund) return text(404, "Fund not found");
    const back = (code: RulesNoticeCode) => new Response(null, { status: 303, headers: { Location: `/funds/${fundId}/rules${noticeQuery(code)}#fund-mode-heading`, ...HEADERS } });
    if (mediaType(request) !== FORM_TYPE) return text(415, "Form submission required");
    const declared = request.headers.get("content-length");
    if (declared !== null && (!/^[0-9]{1,12}$/.test(declared) || Number(declared) > MODE_BODY_LIMIT)) { await request.body?.cancel().catch(() => undefined); return text(/^[0-9]{1,12}$/.test(declared) ? 413 : 400, "Form too large"); }
    const reader = request.body?.getReader(); if (!reader) return text(400, "Missing form");
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > MODE_BODY_LIMIT) { await reader.cancel().catch(() => undefined); return text(413, "Form too large"); }
      chunks.push(value);
    }
    let form: URLSearchParams;
    try { form = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { return text(400, "Invalid fund mode fields"); }
    const action = form.get("action");
    const keys = action === "propose" ? ["action", "mode"] : action === "approve" ? ["action", "proposalId"] : null;
    if (!keys || keys.some(key => form.getAll(key).length !== 1) || [...form.keys()].some(key => !keys.includes(key))) return text(400, "Invalid fund mode fields");
    const actor = { id: user.id }; const env = deps.env;
    try {
      if (action === "propose") {
        const result = await proposeFundMode(deps.db, actor, fundId, form.get("mode"), { env });
        if (result.status === "PROPOSED") return back("mode-proposed");
        if (result.reason === "NOT_FOUND") return text(404, "Fund not found");
        if (result.reason === "APPROVER_REQUIRED") return text(403, "Approver access required");
        return back(refusalCode(result.reason));
      }
      const result = await approveFundMode(deps.db, actor, form.get("proposalId")!, { env }, fundId);
      if (result.status === "APPROVED") return back("mode-approved");
      if (result.reason === "NOT_FOUND") return text(404, "Not found");
      if (result.reason === "APPROVER_REQUIRED") return text(403, "Approver access required");
      return back(refusalCode(result.reason));
    } catch { return back("mode-failed"); }
  } catch { return text(500, "That request could not be completed"); }
}
