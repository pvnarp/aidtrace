// IAC-405 step 1: the approver action "Run policy checks". It has its own route and does not touch src/server/claim-actions.ts.
// It imports no ledger, payout, retry, PayPal or AI module. A run stores flags. It approves, rejects and pays nothing.
import { desc, eq } from "drizzle-orm";
import { allocationDecisions, claims, users } from "../../db/schema";
import { findSession, isSameOrigin, sessionToken } from "./auth";
import type { AppDatabase } from "./db";
import { runPolicyChecks } from "../policy/service";

export async function handlePolicyChecks(request: Request, claimId: string, deps: { db: AppDatabase }) {
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
  if (form.get("action") !== "run" || fields.some(key => form.getAll(key).length !== 1) || [...form.keys()].some(key => !fields.includes(key))) return new Response("Invalid policy check fields", { status: 400, headers });
  const decisionHash = form.get("decisionHash")!;
  if (!/^[a-f0-9]{64}$/.test(decisionHash)) return new Response("Valid frozen decision required", { status: 400, headers });
  const [decision] = await deps.db.select({ claimId: allocationDecisions.claimId }).from(allocationDecisions).where(eq(allocationDecisions.decisionHash, decisionHash));
  if (decision?.claimId !== claimId) return new Response("Valid frozen decision required", { status: 400, headers });
  const redirect = (notice: string) => new Response(null, { status: 303, headers: { Location: `/claims/${claimId}?notice=${notice}`, ...headers } });
  try {
    const result = await runPolicyChecks(deps.db, decisionHash, { id: user.id });
    if (result.status === "RAN") return redirect("policy-ran");
    if (result.status === "EXISTS") return redirect("policy-exists");
    return redirect(result.reason === "STALE" || result.reason === "NOT_AWAITING" ? "policy-stale" : "policy-refused");
  } catch { return redirect("policy-refused"); }
}
