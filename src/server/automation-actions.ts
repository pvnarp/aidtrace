// IAC-405 step 3 PR P (docs/ASSUMPTIONS.md section 78). The approver-only routes for the automation kill switch (guardrail G8): propose on, confirm on, turn off (fund rules page), and
// "Disagree" with an automated payment (claim page). Same fixed order of checks as src/server/fund-mode-actions.ts, with the second flag first: an instance without FUND_AUTOPILOT_ENABLED answers 404
// as if the route did not exist. A handler never answers with an error, a database message or request text: every redirect carries a code from src/server/rules-notices.ts or none at all.
// It imports no module of the money path, no provider module and no sweep module: the only writers it reaches are in src/fund-modes/switch.ts.
import { and, eq } from "drizzle-orm";
import { claims, funds, users } from "../../db/schema";
import { fundAutopilotEnabled, type FlagEnv } from "../fund-modes/flag";
import { confirmAutomationOn, proposeAutomationOn, recordDisagreement, turnAutomationOff, type SwitchRefusal } from "../fund-modes/switch";
import { findSession, isSameOrigin, sessionToken } from "./auth";
import type { AppDatabase } from "./db";
import { noticeQuery, type RulesNoticeCode } from "./rules-notices";

export type AutomationRouteDeps = { db: AppDatabase; env?: FlagEnv };
export const AUTOMATION_BODY_LIMIT = 2048;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const FORM_TYPE = "application/x-www-form-urlencoded";
const HEADERS = { "Cache-Control": "no-store" };
const text = (status: number, body: string, extra: Record<string, string> = {}) => new Response(body, { status, headers: { ...HEADERS, ...extra } });
const mediaType = (request: Request): string => (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();

const refusalCode = (reason: SwitchRefusal): RulesNoticeCode => {
  switch (reason) {
    case "SAME_APPROVER": return "switch-same-approver";
    case "STALE_PROPOSAL": case "ALREADY_ON": case "ALREADY_OFF": return "switch-stale";
    case "GUARD_REFUSED": return "switch-guard";
    default: return "switch-failed";
  }
};

// Reads a bounded urlencoded form with exactly the named fields, each once. Returns a Response for any refusal.
async function readForm(request: Request, allowed: (action: string | null) => string[] | null): Promise<URLSearchParams | Response> {
  if (mediaType(request) !== FORM_TYPE) return text(415, "Form submission required");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^[0-9]{1,12}$/.test(declared) || Number(declared) > AUTOMATION_BODY_LIMIT)) { await request.body?.cancel().catch(() => undefined); return text(/^[0-9]{1,12}$/.test(declared) ? 413 : 400, "Form too large"); }
  const reader = request.body?.getReader(); if (!reader) return text(400, "Missing form");
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    bytes += value.length;
    if (bytes > AUTOMATION_BODY_LIMIT) { await reader.cancel().catch(() => undefined); return text(413, "Form too large"); }
    chunks.push(value);
  }
  let form: URLSearchParams;
  try { form = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { return text(400, "Invalid automation fields"); }
  const keys = allowed(form.get("action"));
  if (!keys || keys.some(key => form.getAll(key).length !== 1) || [...form.keys()].some(key => !keys.includes(key))) return text(400, "Invalid automation fields");
  return form;
}

export async function handleFundAutomation(request: Request, fundId: string, deps: AutomationRouteDeps): Promise<Response> {
  try {
    if (!fundAutopilotEnabled(deps.env)) return text(404, "Not found");
    if (request.method !== "POST") return text(405, "Method not allowed", { Allow: "POST" });
    if (!isSameOrigin(request)) return text(403, "Request origin rejected");
    const user = await findSession(sessionToken(request), deps.db);
    if (!user) return text(401, "Sign in first");
    if (user.role !== "APPROVER") return text(403, "Approver access required");
    if (!ID.test(fundId)) return text(404, "Fund not found");
    const [fund] = await deps.db.select({ id: funds.id }).from(funds).innerJoin(users, eq(users.organizationId, funds.organizationId)).where(and(eq(funds.id, fundId), eq(users.id, user.id)));
    if (!fund) return text(404, "Fund not found");
    const back = (code: RulesNoticeCode) => new Response(null, { status: 303, headers: { Location: `/funds/${fundId}/rules${noticeQuery(code)}#automation-heading`, ...HEADERS } });
    const form = await readForm(request, action => action === "propose" || action === "off" ? ["action"] : action === "confirm" ? ["action", "proposal"] : null);
    if (form instanceof Response) return form;
    const actor = { id: user.id }; const env = deps.env; const action = form.get("action");
    try {
      if (action === "propose") {
        const result = await proposeAutomationOn(deps.db, actor, { env });
        if (result.status === "PROPOSED") return back("switch-proposed");
        return result.reason === "APPROVER_REQUIRED" ? text(403, "Approver access required") : back(refusalCode(result.reason));
      }
      if (action === "confirm") {
        const raw = form.get("proposal")!;
        const result = /^[0-9]{1,9}$/.test(raw) ? await confirmAutomationOn(deps.db, actor, Number(raw), { env }) : null;
        if (!result) return text(400, "Invalid automation fields");
        if (result.status === "ON") return back("switch-on");
        if (result.reason === "NOT_FOUND") return text(404, "Not found");
        return result.reason === "APPROVER_REQUIRED" ? text(403, "Approver access required") : back(refusalCode(result.reason));
      }
      const result = await turnAutomationOff(deps.db, actor, { env });
      if (result.status === "OFF") return back("switch-off");
      return result.reason === "APPROVER_REQUIRED" ? text(403, "Approver access required") : back(refusalCode(result.reason));
    } catch { return back("switch-failed"); }
  } catch { return text(500, "That request could not be completed"); }
}

// "Disagree" with an automated payment. It turns automation off and reverses nothing.
export async function handleClaimDisagree(request: Request, claimId: string, deps: AutomationRouteDeps): Promise<Response> {
  try {
    if (!fundAutopilotEnabled(deps.env)) return text(404, "Not found");
    if (request.method !== "POST") return text(405, "Method not allowed", { Allow: "POST" });
    if (!isSameOrigin(request)) return text(403, "Request origin rejected");
    const user = await findSession(sessionToken(request), deps.db);
    if (!user) return text(401, "Sign in first");
    if (user.role !== "APPROVER") return text(403, "Approver access required");
    if (!ID.test(claimId)) return text(404, "Claim not found");
    const [claim] = await deps.db.select({ id: claims.id }).from(claims).innerJoin(users, eq(users.organizationId, claims.organizationId)).where(and(eq(claims.id, claimId), eq(users.id, user.id))).limit(1);
    if (!claim) return text(404, "Claim not found");
    const form = await readForm(request, action => action === "disagree" ? ["action"] : null);
    if (form instanceof Response) return form;
    const back = new Response(null, { status: 303, headers: { Location: `/claims/${claimId}#autopilot-heading`, ...HEADERS } });
    try {
      const result = await recordDisagreement(deps.db, { id: user.id }, claimId, { env: deps.env });
      if (result.status === "OFF") return back;
      if (result.reason === "APPROVER_REQUIRED" || result.reason === "CLAIMANT") return text(403, "Approver access required");
      if (result.reason === "NOT_FOUND" || result.reason === "NOT_AUTOMATED") return text(404, "Not found");
      return back; // already off: the page shows the state
    } catch { return text(500, "That request could not be completed"); }
  } catch { return text(500, "That request could not be completed"); }
}
