import type { AppDatabase } from "./db";
import { desc, eq } from "drizzle-orm";
import { allocationDecisions, claims, users } from "../../db/schema";
import { findSession, isSameOrigin, sessionToken } from "./auth";
import { approveDecision, freezeDecision, rejectClaim } from "../ledger/service";
import { refreshClaimPayout, sendClaimPayout } from "../ledger/payout";
import { authorizePayoutRetry, sendAuthorizedPayoutRetry } from "../ledger/retry";
import type { PayoutTransport } from "../paypal/adapter";
import { claimFailureNotice } from "./claim-notices";

export async function handleClaimAction(request: Request, claimId: string, dependencies: { db: AppDatabase; provider: () => PayoutTransport; judgeSession?: boolean }) {
  if (!isSameOrigin(request)) return new Response("Request origin rejected", { status: 403 });
  const user = await findSession(sessionToken(request), dependencies.db);
  if (!user) return new Response("Sign in first", { status: 401 });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(claimId)) return new Response("Claim not found", { status: 404 });
  const [claim] = await dependencies.db.select().from(claims).where(eq(claims.id, claimId)).orderBy(desc(claims.version)).limit(1);
  const [actor] = await dependencies.db.select({ organizationId: users.organizationId }).from(users).where(eq(users.id, user.id));
  if (!claim || !actor || actor.organizationId !== claim.organizationId || (user.role === "CLAIMANT" && user.id !== claim.claimantId)) return new Response("Claim not found", { status: 404 });
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return new Response("Form submission required", { status: 415 });
  const reader = request.body?.getReader(); if (!reader) return new Response("Missing form", { status: 400 });
  const chunks: Uint8Array[] = []; let length = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    length += value.length;
    if (length > 8192) { await reader.cancel(); return new Response("Form too large", { status: 413 }); }
    chunks.push(value);
  }
  const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const action = body.get("action");
  if (dependencies.judgeSession && (!claimId.startsWith("R-") || ["send", "refresh", "retry", "authorize-retry"].includes(action ?? ""))) return new Response("This judging session cannot request or change a payment. Continue the unpaid receipt review.", { status: 403 });
  if ((action === "freeze" && user.role !== "CLAIMANT") || (action !== "freeze" && user.role !== "APPROVER")) return new Response("This action requires the appropriate signed-in role", { status: 403 });
  const redirect = (notice: string) => new Response(null, { status: 303, headers: { Location: `/claims/${claimId}?notice=${notice}`, "Cache-Control": "no-store" } });
  try {
    if (action === "freeze") {
      const result = await freezeDecision(dependencies.db, claimId, user.id);
      return redirect(result.status === "INFEASIBLE" ? "unfunded" : "frozen");
    }
    if (action === "approve") {
      const decisionId = body.get("decisionId") ?? ""; const hash = body.get("decisionHash") ?? "";
      if (!/^[a-f0-9-]{36}$/.test(decisionId) || !/^[a-f0-9]{64}$/.test(hash)) return new Response("Valid frozen decision required", { status: 400 });
      const [decision] = await dependencies.db.select({ claimId: allocationDecisions.claimId }).from(allocationDecisions).where(eq(allocationDecisions.id, decisionId));
      if (decision?.claimId !== claimId) return new Response("Decision does not belong to this claim", { status: 403 });
      const result = await approveDecision(dependencies.db, decisionId, user.id, hash);
      return redirect(result.status === "INVALIDATED" ? "invalidated" : result.status === "APPROVED" ? "approved" : "approval-saved");
    }
    if (action === "reject") { await rejectClaim(dependencies.db, claimId, user.id, body.get("reason") ?? ""); return redirect("rejected"); }
    if (action === "send") {
      if (body.get("confirmSandbox") !== "yes" || !/^[a-f0-9]{64}$/.test(body.get("decisionHash") ?? "")) return new Response("Explicit sandbox confirmation and current hash required", { status: 400 });
      const result = await sendClaimPayout(dependencies.db, claimId, user.id, body.get("decisionHash")!, dependencies.provider());
      return redirect(result.state === "UNKNOWN" ? "unknown" : result.state === "FUNDING_REJECTED" ? "funding" : "submitted");
    }
    if (action === "refresh") { const result = await refreshClaimPayout(dependencies.db, claimId, user.id, dependencies.provider()); return redirect(result.state === "UNKNOWN" ? "unknown" : "refreshed"); }
    if (action === "authorize-retry" || action === "retry") {
      const hash = body.get("decisionHash") ?? "";
      const id = body.get(action === "retry" ? "authorizationId" : "failedAttemptId") ?? "";
      if (!/^[a-f0-9]{64}$/.test(hash) || !/^[a-f0-9-]{36}$/.test(id) || body.get("confirmSandbox") !== "yes") return new Response("Bound retry and explicit confirmation required", { status: 400 });
      if (action === "authorize-retry") { await authorizePayoutRetry(dependencies.db, claimId, user.id, hash, id); return redirect("retry-authorized"); }
      const result = await sendAuthorizedPayoutRetry(dependencies.db, claimId, user.id, hash, id, dependencies.provider());
      return redirect(result.state === "UNKNOWN" ? "unknown" : result.state === "FUNDING_REJECTED" ? "funding" : "submitted");
    }
    return new Response("Unknown action", { status: 400 });
  } catch (error) { return redirect(claimFailureNotice(error)); }
}
