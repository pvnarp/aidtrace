// IAC-405 step 2 PR A (docs/plans/FUND_MODES_SCOPE.md section 4, docs/ASSUMPTIONS.md section 77): which "Human reviews" line a claim page shows. Read only.
//   MANUAL            the line as it always was, "n of 2". Also every claim with the flag off, no frozen decision, an Autopilot or Manual fund in the split, or a viewer who is not an approver of a
//                     claim still waiting.
//   ASSISTED_NO_HOLDS an Assisted decision with no holds: "n of 1, Assisted, no holds found". A waiting decision is recomputed now with the same function the recognition uses. A recognized
//                     decision shows it only when the audit record of that check (kind NO_HOLDS) exists, because a recognized decision no longer has live holds to compute.
//   ASSISTED_HOLD     an Assisted decision that has a hold, or whose checks have not finished: "n of 2", the same words as Manual.
// A claimant sees no live hold facts (the policy check evidence is approver-only), so a waiting claim reads as MANUAL to a claimant. A recognized claim's recorded fact is not hidden.
import { and, eq } from "drizzle-orm";
import * as s from "../../db/schema";
import type { PolicyReader } from "../policy/facts";
import { fundModesEnabled, type FlagEnv } from "./flag";
import { modeAtRecognition } from "./modes";
import { noHoldsFor } from "./no-holds";
import { autoRecognizedSent } from "./recorded-path";

export type ReviewLineMode = "MANUAL" | "ASSISTED_NO_HOLDS" | "ASSISTED_HOLD" | "AUTO_RECOGNIZED_SENT" | "AUTO_RECOGNIZED_PEOPLE";

export async function reviewLineMode(tx: PolicyReader, decision: { id: string; decisionHash: string; recognizedAt: Date | null; invalidatedAt: Date | null } | undefined,
  edges: readonly { fundId: string; amountCents: bigint }[], options: { live: boolean; env?: FlagEnv }): Promise<ReviewLineMode> {
  // IAC-405 PR P merge fix. A decision that an AUTO_RECOGNIZED record recognized reads from stored records only, with no flag check (the claim page shows its Autopilot trail the same way):
  //   AUTO_RECOGNIZED_SENT    no person has approved and a payout exists: "none required", the guardrail record binds the reference.
  //   AUTO_RECOGNIZED_PEOPLE  a person has begun the takeover, or the automatic payment has not gone out: the ordinary "n of 2" words, next to the takeover sentence of the trail.
  if (decision && !decision.invalidatedAt && decision.recognizedAt) {
    const [auto] = await tx.select({ id: s.automatedDecisions.id }).from(s.automatedDecisions).where(and(eq(s.automatedDecisions.decisionHash, decision.decisionHash), eq(s.automatedDecisions.kind, "AUTO_RECOGNIZED")));
    if (auto) {
      const [person] = await tx.select({ id: s.approvals.id }).from(s.approvals).where(eq(s.approvals.decisionHash, decision.decisionHash)).limit(1);
      const [paid] = await tx.select({ id: s.disbursements.id }).from(s.disbursements).where(eq(s.disbursements.decisionHash, decision.decisionHash)).limit(1);
      return autoRecognizedSent(Boolean(person), Boolean(paid)) ?"AUTO_RECOGNIZED_SENT" : "AUTO_RECOGNIZED_PEOPLE";
    }
  }
  if (!decision || decision.invalidatedAt || !fundModesEnabled(options.env)) return "MANUAL";
  if (decision.recognizedAt) {
    const [recorded] = await tx.select({ id: s.automatedDecisions.id }).from(s.automatedDecisions).where(and(eq(s.automatedDecisions.decisionHash, decision.decisionHash), eq(s.automatedDecisions.kind, "NO_HOLDS")));
    return recorded ? "ASSISTED_NO_HOLDS" : "MANUAL";
  }
  if (!options.live) return "MANUAL";
  if ((await modeAtRecognition(tx, decision.decisionHash, edges, options.env)) !== "ASSISTED") return "MANUAL";
  return (await noHoldsFor(tx, decision.decisionHash)).noHolds ? "ASSISTED_NO_HOLDS" : "ASSISTED_HOLD";
}
