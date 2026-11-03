// IAC-405 step 2 PR F (docs/plans/FUND_MODES_SCOPE.md section 2.2; docs/ASSUMPTIONS.md section 76). "No holds", derived on the server from the stored runs of one
// exact decision hash, inside the recognizing transaction, never cached and never shown as a clearance. A decision has no holds only when:
//   1. a RULES run exists, ended with RUN_END, has no HOLD flag and no NOT_CHECKED entry (notes are allowed);
//   2. a MODEL run exists, finished, with at least one checked pair and every line OK (the app's NO_CONFLICT_FOUND). A CONFLICT, UNSURE or NOT_CHECKED
//      line, a run still going or interrupted, and a run where every pair was skipped are holds. A keyless instance stores no model run at all, so its
//      reason is NO_MODEL_RUN and it never has "no holds";
//   3. the model run covers the decision: a pair for every fund with a nonzero edge, and a stored line for every paid line of a checked fund;
//   4. no pair was escalated: the model first step answered validly with a line that was not OK and the second step was called. Only the second step's
//      line rows are stored, so a second step that clears a line the first step objected to must not remove that objection (MODEL_ESCALATED). A first
//      step that failed (a timeout, an error, an invalid answer) is not an objection, and a second step that then answers all OK is not a hold;
//   5. the decision is current: not invalidated and not recognized.
// Either an APPROVER run or a SWEEP run counts, because a run is the same stored fact whoever started it. The AI can add a hold and can never remove one:
// nothing here reads a model answer as a reason to skip a rule flag. Read-only.
import { and, asc, eq } from "drizzle-orm";
import * as s from "../../db/schema";
import type { PolicyReader } from "../policy/facts";
import { readModelChecks } from "../policy/model-read";
import { payingFunds } from "./modes";

export const HOLD_REASONS = ["NOT_CURRENT", "NO_RULES_RUN", "RULES_UNFINISHED", "RULES_HOLD", "RULES_NOT_CHECKED", "NO_MODEL_RUN", "MODEL_RUNNING", "MODEL_HOLD", "NOTHING_CHECKED", "MODEL_INCOMPLETE", "MODEL_ESCALATED"] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];
export type RunSummary = { rulesRunId: string | null; modelRunId: string | null; ruleSetVersion: string | null; model: string | null; promptVersion: string | null; rulesTrigger: string | null; modelTrigger: string | null };
export type NoHoldsOutcome =
  | { noHolds: true; rulesNotes: number; checkedPairs: number; okLines: number; rulesRunId: string; modelRunId: string; ruleSetVersion: string; model: string; promptVersion: string; rulesTrigger: string; modelTrigger: string }
  | ({ noHolds: false; reason: HoldReason } & RunSummary);

const none: RunSummary = { rulesRunId: null, modelRunId: null, ruleSetVersion: null, model: null, promptVersion: null, rulesTrigger: null, modelTrigger: null };

// strict is for Autopilot recognition only (IAC-405 PR P review item 6): every paying fund must have a CHECKED pair, except the General fund, whose pair is SKIPPED with the reason GENERAL_FUND.
// Assisted and the sweep callers pass nothing and keep the rule above, where an unchecked pair beside a checked one only skips the line coverage check.
export async function noHoldsFor(tx: PolicyReader, decisionHash: string, now: Date = new Date(), options: { strict?: boolean } = {}): Promise<NoHoldsOutcome> {
  const [decision] = await tx.select({ id: s.allocationDecisions.id, invalidatedAt: s.allocationDecisions.invalidatedAt, recognizedAt: s.allocationDecisions.recognizedAt }).from(s.allocationDecisions).where(eq(s.allocationDecisions.decisionHash, decisionHash));
  if (!decision || decision.invalidatedAt || decision.recognizedAt) return { noHolds: false, reason: "NOT_CURRENT", ...none };
  const [rules] = await tx.select({ id: s.policyCheckRuns.id, ruleSetVersion: s.policyCheckRuns.ruleSetVersion, trigger: s.policyCheckRuns.trigger }).from(s.policyCheckRuns)
    .where(and(eq(s.policyCheckRuns.decisionHash, decisionHash), eq(s.policyCheckRuns.kind, "RULES")));
  if (!rules) return { noHolds: false, reason: "NO_RULES_RUN", ...none };
  const summary: RunSummary = { ...none, rulesRunId: rules.id, ruleSetVersion: rules.ruleSetVersion, rulesTrigger: rules.trigger };
  const rows = await tx.select({ entry: s.policyCheckResults.entry, severity: s.policyCheckResults.severity }).from(s.policyCheckResults).where(eq(s.policyCheckResults.runId, rules.id));
  if (!rows.some(row => row.entry === "RUN_END")) return { noHolds: false, reason: "RULES_UNFINISHED", ...summary };
  if (rows.some(row => row.entry === "FLAG" && row.severity === "HOLD")) return { noHolds: false, reason: "RULES_HOLD", ...summary };
  if (rows.some(row => row.entry === "NOT_CHECKED")) return { noHolds: false, reason: "RULES_NOT_CHECKED", ...summary };
  const model = await readModelChecks(tx, decisionHash, now);
  if (!model) return { noHolds: false, reason: "NO_MODEL_RUN", ...summary };
  const [modelRow] = await tx.select({ trigger: s.policyCheckRuns.trigger }).from(s.policyCheckRuns).where(eq(s.policyCheckRuns.id, model.id));
  if (!modelRow) return { noHolds: false, reason: "NO_MODEL_RUN", ...summary };
  const withModel: RunSummary = { ...summary, modelRunId: model.id, model: model.model, promptVersion: model.promptVersion, modelTrigger: modelRow.trigger };
  if (model.status === "RUNNING") return { noHolds: false, reason: "MODEL_RUNNING", ...withModel };
  if (model.status === "HOLD") return { noHolds: false, reason: "MODEL_HOLD", ...withModel };
  if (model.status === "NOTHING_CHECKED") return { noHolds: false, reason: "NOTHING_CHECKED", ...withModel };

  // Coverage: the stored run must speak for every fund that pays any part of this decision, and for every paid line of a fund it checked.
  const edges = await tx.select({ fundId: s.allocationEdges.fundId, lineId: s.allocationEdges.lineId, amountCents: s.allocationEdges.amountCents }).from(s.allocationEdges).where(eq(s.allocationEdges.decisionId, decision.id));
  for (const fundId of payingFunds(edges)) {
    const pair = model.pairs.find(item => item.fundId === fundId);
    if (!pair) return { noHolds: false, reason: "MODEL_INCOMPLETE", ...withModel };
    if (options.strict && pair.state !== "CHECKED") {
      const [fund] = pair.state === "SKIPPED" && pair.reasonCode === "GENERAL_FUND" ? await tx.select({ fundClass: s.funds.fundClass }).from(s.funds).where(eq(s.funds.id, fundId)) : [];
      if (fund?.fundClass !== "UNRESTRICTED") return { noHolds: false, reason: "MODEL_INCOMPLETE", ...withModel };
    }
    if (pair.state !== "CHECKED") continue;
    const stored = new Set(pair.lines.map(line => line.lineId));
    if (edges.some(edge => edge.fundId === fundId && edge.amountCents > 0n && !stored.has(edge.lineId))) return { noHolds: false, reason: "MODEL_INCOMPLETE", ...withModel };
  }

  // Escalation: a first step CALL row with no reason code (it answered validly, so it found a line that was not OK) followed by a second step CALL row of the same fund.
  const calls = await tx.select({ fundId: s.policyModelResults.fundId, model: s.policyModelResults.model, reasonCode: s.policyModelResults.reasonCode }).from(s.policyModelResults)
    .where(and(eq(s.policyModelResults.runId, model.id), eq(s.policyModelResults.entry, "CALL"))).orderBy(asc(s.policyModelResults.sequence));
  // By position, never by model name: stored names may differ from today COMPLIANCE_STEPS.
  const firstCall = new Map<string, string | null>();
  let escalated = false;
  for (const call of calls) {
    const key = call.fundId ?? "";
    if (!firstCall.has(key)) firstCall.set(key, call.reasonCode);
    else if (firstCall.get(key) === null) escalated = true;
  }
  if (escalated) {
    return { noHolds: false, reason: "MODEL_ESCALATED", ...withModel };
  }

  const checked = model.pairs.filter(pair => pair.state === "CHECKED");
  return { noHolds: true, rulesNotes: rows.filter(row => row.entry === "FLAG").length, checkedPairs: checked.length, okLines: checked.reduce((sum, pair) => sum + pair.lines.length, 0),
    rulesRunId: rules.id, modelRunId: model.id, ruleSetVersion: rules.ruleSetVersion, model: model.model, promptVersion: model.promptVersion, rulesTrigger: rules.trigger, modelTrigger: modelRow.trigger };
}
