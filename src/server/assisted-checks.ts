import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import { fundModesEnabled, type FlagEnv } from "../fund-modes/flag";
import { modeAtRecognition } from "../fund-modes/modes";
import { noHoldsFor, type NoHoldsOutcome } from "../fund-modes/no-holds";
import { readModelChecks } from "../policy/model-read";
import type { PolicyReader } from "../policy/facts";
import type { AppDatabase } from "./db";

// IAC-405 step 2 PR A (docs/plans/FUND_MODES_SCOPE.md section 4, docs/ASSUMPTIONS.md section 77): the Checks column of the approver queue. One read only transaction at repeatable read
// with SELECT statements only. For each claim of the queue whose frozen decision is Assisted it recomputes "no holds" from the stored runs of that exact hash, the same function the
// recognition uses, so the column and the approval cannot disagree about the rules. With the flag off it reads nothing and answers an empty map. It states no clearance: the three words
// are "No holds found", "N holds" and "Not checked yet". A claim of a Manual decision is absent from the answer, so the page treats it exactly as before.
export const CHECKS_NONE_FOUND = "No holds found";
export const CHECKS_NOT_YET = "Not checked yet";
export const holdsLabel = (count: number): string => `${count} ${count === 1 ? "hold" : "holds"}`;

export type AssistedChecks = {
  /** The claim version the checks were read for. A bulk request sends it back so a changed claim is refused. */
  claimVersion: number;
  checks: string;
  /** Only an Assisted claim with no holds that this approver may approve: not their own, and not already approved by them. */
  selectable: boolean;
  /** One approval recognizes a clean Assisted claim, so a clean claim with no approval yet reads "0 of 1". Any other claim keeps the loader's own words. */
  approvals: string | null;
};

// The reasons that mean there is no finished check to read (NOTHING_CHECKED is every pair skipped, for example a claim paid wholly by an unrestricted fund), as opposed to a finished check that found something.
const UNFINISHED = new Set<string>(["NOT_CURRENT", "NO_RULES_RUN", "RULES_UNFINISHED", "NO_MODEL_RUN", "MODEL_RUNNING", "NOTHING_CHECKED"]);

// The number of things the stored runs flagged: every rules HOLD flag and every rules entry that was not checked, plus every model line that is not OK and every pair that was not checked.
// A hold with no countable item (a model second step that answered OK after the first step objected, or a run that covers too little) counts as one, so "0 holds" is never shown.
async function countHolds(tx: PolicyReader, hash: string, outcome: Extract<NoHoldsOutcome, { noHolds: false }>, now: Date): Promise<number> {
  let count = 0;
  if (outcome.rulesRunId) {
    const rows = await tx.select({ entry: s.policyCheckResults.entry, severity: s.policyCheckResults.severity }).from(s.policyCheckResults).where(eq(s.policyCheckResults.runId, outcome.rulesRunId));
    count += rows.filter(row => (row.entry === "FLAG" && row.severity === "HOLD") || row.entry === "NOT_CHECKED").length;
  }
  if (outcome.modelRunId) {
    const model = await readModelChecks(tx, hash, now);
    if (model) for (const pair of model.pairs) count += pair.state === "NOT_CHECKED" ? 1 : pair.lines.filter(line => line.verdict !== "OK").length;
  }
  return Math.max(1, count);
}

export async function loadAssistedChecks(db: AppDatabase, actorId: string, claimIds: readonly string[], deps: { env?: FlagEnv; now?: Date } = {}): Promise<Map<string, AssistedChecks>> {
  const result = new Map<string, AssistedChecks>();
  if (!fundModesEnabled(deps.env) || claimIds.length === 0) return result;
  const now = deps.now ?? new Date();
  return db.transaction(async tx => {
    await tx.execute(sql`set transaction read only`);
    const [actor] = await tx.select({ id: s.users.id, organizationId: s.users.organizationId, role: s.users.role }).from(s.users).where(eq(s.users.id, actorId));
    if (!actor || actor.role !== "APPROVER") return result;
    const all = await tx.select().from(s.claims).where(and(eq(s.claims.organizationId, actor.organizationId), inArray(s.claims.id, [...claimIds])));
    const newest = new Map<string, (typeof all)[number]>();
    for (const row of all) { const seen = newest.get(row.id); if (!seen || row.version > seen.version) newest.set(row.id, row); }
    for (const claim of newest.values()) {
      if (claim.status !== "AWAITING_APPROVAL") continue;
      const [decision] = await tx.select({ id: s.allocationDecisions.id, hash: s.allocationDecisions.decisionHash }).from(s.allocationDecisions)
        .where(and(eq(s.allocationDecisions.claimId, claim.id), eq(s.allocationDecisions.claimVersion, claim.version), eq(s.allocationDecisions.organizationId, actor.organizationId), isNull(s.allocationDecisions.invalidatedAt), isNull(s.allocationDecisions.recognizedAt)))
        .orderBy(desc(s.allocationDecisions.frozenAt)).limit(1);
      if (!decision) continue;
      const edges = await tx.select({ fundId: s.allocationEdges.fundId, amountCents: s.allocationEdges.amountCents }).from(s.allocationEdges).where(eq(s.allocationEdges.decisionId, decision.id));
      if ((await modeAtRecognition(tx, decision.hash, edges, deps.env)) !== "ASSISTED") continue;
      const outcome = await noHoldsFor(tx, decision.hash, now);
      const approvers = await tx.select({ approverId: s.approvals.approverId }).from(s.approvals).where(eq(s.approvals.decisionHash, decision.hash));
      const mine = approvers.some(row => row.approverId === actor.id);
      if (outcome.noHolds) {
        result.set(claim.id, { claimVersion: claim.version, checks: CHECKS_NONE_FOUND, selectable: claim.claimantId !== actor.id && !mine, approvals: approvers.length === 0 ? "Approvals: 0 of 1" : null });
      } else if (UNFINISHED.has(outcome.reason)) {
        result.set(claim.id, { claimVersion: claim.version, checks: CHECKS_NOT_YET, selectable: false, approvals: null });
      } else {
        result.set(claim.id, { claimVersion: claim.version, checks: holdsLabel(await countHolds(tx, decision.hash, outcome, now)), selectable: false, approvals: null });
      }
    }
    return result;
  }, { isolationLevel: "repeatable read" });
}
