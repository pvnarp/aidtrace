// IAC-405 step 1: the approver action "Run policy checks". It has its own route and does not touch src/server/claim-actions.ts.
// It imports no ledger, payout, retry or PayPal module. A run stores rule flags, then the arm C model check of piece G when AI_COMPLIANCE_ENABLED is on.
// The only AI-side import is src/policy/model-run. A run approves, rejects and pays nothing. The second action, run-model, runs the model check alone when the rules already ran.
import { desc, eq } from "drizzle-orm";
import { allocationDecisions, claims, users } from "../../db/schema";
import { findSession, isSameOrigin, sessionToken } from "./auth";
import type { AppDatabase } from "./db";
import { runModelCheck, type ModelRunDeps } from "../policy/model-run";
import { runPolicyChecks } from "../policy/service";

export async function handlePolicyChecks(request: Request, claimId: string, deps: { db: AppDatabase; model?: ModelRunDeps }) {
  const headers = { "Cache-Control": "no-store" };
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "POST" } });
  if (!isSameOrigin(request)) return new Response("Request origin rejected", { status: 403, headers });
  const user = await findSession(sessionToken(request), deps.db);
  if (!user) return new Response("Sign in first", { status: 401, headers });
  if (user.role !== "APPROVER") return new Response("Approver access required", { status: 403, headers });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(claimId)) return new Response("Claim not found", { status: 404, headers });
  const [claim] = await deps.db.select().from(claims).where(eq(claims.id, claimId)).orderBy(desc(claims.version)).limit(1);
  const [actor] = await deps.db.select({ organizationId: users.organizationId }).from(users).where(eq(users.id, user.id));
  // Another organization's claim looks the same as no claim.
  if (!claim || !actor || actor.organizationId !== claim.organizationId) return new Response("Claim not found", { status: 404, headers });
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return new Response("Form submission required", { status: 415, headers });
  const reader = request.body?.getReader(); if (!reader) return new Response("Missing form", { status: 400, headers });
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    bytes += value.length;
    if (bytes > 4096) { await reader.cancel(); return new Response("Form too large", { status: 413, headers }); }
    chunks.push(value);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const fields = ["action", "decisionHash"];
  const action = form.get("action");
  if ((action !== "run" && action !== "run-model") || fields.some(key => form.getAll(key).length !== 1) || [...form.keys()].some(key => !fields.includes(key))) return new Response("Invalid policy check fields", { status: 400, headers });
  const decisionHash = form.get("decisionHash")!;
  if (!/^[a-f0-9]{64}$/.test(decisionHash)) return new Response("Valid frozen decision required", { status: 400, headers });
  const [decision] = await deps.db.select({ claimId: allocationDecisions.claimId }).from(allocationDecisions).where(eq(allocationDecisions.decisionHash, decisionHash));
  if (decision?.claimId !== claimId) return new Response("Valid frozen decision required", { status: 400, headers });
  const redirect = (notice: string) => new Response(null, { status: 303, headers: { Location: `/claims/${claimId}?notice=${notice}`, ...headers } });
  // run-model: the rules already ran (for example with the model check off) and the model run is still absent. This path calls only runModelCheck. It stores no
  // rule row and no flag. runModelCheck keeps the guards: an approver who is not the claimant, an awaiting and current decision, a stored rule run first,
  // a confirmed receipt review, the advisory lock, and the refusal of a second MODEL run for the same decision (EXISTS).
  if (action === "run-model") {
    try {
      const model = await runModelCheck(deps.db, decisionHash, { id: user.id }, deps.model);
      if (model.status === "RAN") return redirect("policy-model-ran");
      if (model.status === "EXISTS") return redirect("policy-model-exists");
      if (model.status === "OFF") return redirect("policy-model-off");
      if (model.status === "REFUSED" && (model.reason === "STALE" || model.reason === "NOT_AWAITING")) return redirect("policy-stale");
      return redirect("policy-refused");
    } catch { return redirect("policy-refused"); }
  }
  try {
    const result = await runPolicyChecks(deps.db, decisionHash, { id: user.id });
    if (result.status === "REFUSED") return redirect(result.reason === "STALE" || result.reason === "NOT_AWAITING" ? "policy-stale" : "policy-refused");
    // The rules are stored. The model check follows in the same action and never changes the rule rows, the notice or the claim. A failure of the
    // model side stores NOT_CHECKED or nothing and is shown on the page. It is never read as OK, and it never turns a stored rule result into a refusal.
    try { await runModelCheck(deps.db, decisionHash, { id: user.id }, deps.model); } catch { /* the page shows the model check as not run or not finished */ }
    return redirect(result.status === "RAN" ? "policy-ran" : "policy-exists");
  } catch { return redirect("policy-refused"); }
}
