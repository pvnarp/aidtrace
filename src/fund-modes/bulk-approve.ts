// IAC-405 step 2 PR A. Approve several Assisted claims in one request. Each claim is decided on its own:
// one serializable transaction resolves the claim at the version the page showed, requires the Assisted mode, recomputes "no holds" from the stored runs of that exact decision
// hash and refuses the claimant, then the existing ledger function records the approval with the hash the server resolved (a client never sends a hash). approveDecision then
// recognizes inside its own transaction, which repeats the mode and hold checks, so a hold that lands between the two steps can only leave an ordinary single approval waiting
// for a second approver, never a recognition. One claim's refusal or failure never undoes another claim's approval. This module sends no payment and starts no check.
import { and, desc, eq, isNull } from "drizzle-orm";
import * as s from "../../db/schema";
import { approveDecision, serializable } from "../ledger/service";
import type { AppDatabase } from "../server/db";
import type { BulkOutcome, BulkSkipReason } from "./bulk-reasons";
import type { FlagEnv } from "./flag";
import { modeAtRecognition } from "./modes";
import { noHoldsFor } from "./no-holds";

export type BulkItem = { claimId: string; claimVersion: number };
type Ready = { ready: true; decisionId: string; hash: string };
type Refused = { ready: false; reason: BulkSkipReason };

// Reasons that mean there is no finished check to read, as opposed to a finished check that found a hold. NOTHING_CHECKED is every pair skipped, for example a claim paid wholly by an unrestricted fund, which has no clauses for the model to read.
const UNFINISHED = new Set(["NO_RULES_RUN", "RULES_UNFINISHED", "NO_MODEL_RUN", "MODEL_RUNNING", "NOTHING_CHECKED"]);

async function precheck(db: AppDatabase, actorId: string, item: BulkItem, env: FlagEnv | undefined): Promise<Ready | Refused> {
  return serializable(db, async (tx): Promise<Ready | Refused> => {
    const [actor] = await tx.select({ id: s.users.id, organizationId: s.users.organizationId, role: s.users.role }).from(s.users).where(eq(s.users.id, actorId));
    if (!actor || actor.role !== "APPROVER") return { ready: false, reason: "FAILED" };
    const [claim] = await tx.select().from(s.claims).where(eq(s.claims.id, item.claimId)).orderBy(desc(s.claims.version)).limit(1);
    if (!claim || claim.organizationId !== actor.organizationId) return { ready: false, reason: "NOT_FOUND" };
    if (claim.version !== item.claimVersion) return { ready: false, reason: "STALE_VERSION" };
    if (claim.status !== "AWAITING_APPROVAL") return { ready: false, reason: "NOT_WAITING" };
    const [decision] = await tx.select().from(s.allocationDecisions)
      .where(and(eq(s.allocationDecisions.claimId, claim.id), eq(s.allocationDecisions.claimVersion, claim.version), isNull(s.allocationDecisions.invalidatedAt), isNull(s.allocationDecisions.recognizedAt)))
      .orderBy(desc(s.allocationDecisions.frozenAt)).limit(1);
    if (!decision) return { ready: false, reason: "NOT_WAITING" };
    const edges = await tx.select({ fundId: s.allocationEdges.fundId, amountCents: s.allocationEdges.amountCents }).from(s.allocationEdges).where(eq(s.allocationEdges.decisionId, decision.id));
    if ((await modeAtRecognition(tx, decision.decisionHash, edges, env)) !== "ASSISTED") return { ready: false, reason: "NOT_ASSISTED" };
    const outcome = await noHoldsFor(tx, decision.decisionHash);
    if (!outcome.noHolds) return { ready: false, reason: outcome.reason === "NOT_CURRENT" ? "NOT_WAITING" : UNFINISHED.has(outcome.reason) ? "NOT_CHECKED" : "HOLD_FOUND" };
    if (claim.claimantId === actor.id) return { ready: false, reason: "OWN_CLAIM" };
    const mine = await tx.select({ id: s.approvals.id }).from(s.approvals).where(and(eq(s.approvals.decisionHash, decision.decisionHash), eq(s.approvals.approverId, actor.id)));
    if (mine.length > 0) return { ready: false, reason: "ALREADY_APPROVED" };
    return { ready: true, decisionId: decision.id, hash: decision.decisionHash };
  });
}

// The ledger throws plain sentences for refusals. Only their meaning is read here, and none of the text is passed on.
function failureReason(error: unknown): BulkSkipReason {
  const message = error instanceof Error ? error.message : "";
  if (/same approver cannot approve twice/i.test(message)) return "ALREADY_APPROVED";
  if (/already recognized/i.test(message)) return "NOT_WAITING";
  if (/invalidated|hash does not match/i.test(message)) return "CHANGED";
  return "FAILED";
}

// Claims are decided one after another in request order. The caller has already bounded the list and validated every id and version.
export async function bulkApprove(db: AppDatabase, actorId: string, items: readonly BulkItem[], deps: { env?: FlagEnv } = {}): Promise<BulkOutcome> {
  const outcome: BulkOutcome = { approved: [], saved: [], skipped: [] };
  for (const item of items) {
    const skip = (reason: BulkSkipReason) => outcome.skipped.push({ claimId: item.claimId, reason });
    try {
      const checked = await precheck(db, actorId, item, deps.env);
      if (!checked.ready) { skip(checked.reason); continue; }
      const result = await approveDecision(db, checked.decisionId, actorId, checked.hash, { env: deps.env });
      if (result.status === "APPROVED") outcome.approved.push(item.claimId);
      else if (result.status === "AWAITING_APPROVAL") outcome.saved.push(item.claimId);
      else skip("CHANGED");
    } catch (error) { skip(failureReason(error)); }
  }
  return outcome;
}
