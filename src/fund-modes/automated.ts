// IAC-405 step 2 PR F. The audit record of a check outcome. It is never an approval: it is written to automated_decisions and never to
// approvals, and recognition never counts it. This release writes NO_HOLDS (by the Assisted recognition that used it) and HELD (by the sweep). The inputs object holds
// only closed codes and counts, never request text, model text or a key.
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import type { NoHoldsOutcome } from "./no-holds";

type Tx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];
export type AutomatedWriter = Pick<Tx, "insert">;

export async function recordNoHolds(tx: AutomatedWriter, decisionHash: string, outcome: Extract<NoHoldsOutcome, { noHolds: true }>, approvals: number): Promise<void> {
  await tx.insert(s.automatedDecisions).values({
    decisionHash, kind: "NO_HOLDS", rulesRunId: outcome.rulesRunId, modelRunId: outcome.modelRunId, ruleSetVersion: outcome.ruleSetVersion, model: outcome.model, promptVersion: outcome.promptVersion,
    inputs: { approvals, rulesNotes: outcome.rulesNotes, checkedPairs: outcome.checkedPairs, okLines: outcome.okLines, rulesTrigger: outcome.rulesTrigger, modelTrigger: outcome.modelTrigger },
  });
}

export async function recordHeld(tx: AutomatedWriter, decisionHash: string, outcome: Extract<NoHoldsOutcome, { noHolds: false }>): Promise<void> {
  await tx.insert(s.automatedDecisions).values({
    decisionHash, kind: "HELD", rulesRunId: outcome.rulesRunId, modelRunId: outcome.modelRunId, ruleSetVersion: outcome.ruleSetVersion, model: outcome.model, promptVersion: outcome.promptVersion,
    inputs: { reason: outcome.reason, rulesTrigger: outcome.rulesTrigger, modelTrigger: outcome.modelTrigger },
  });
}

// IAC-405 step 3 PR P. The Autopilot records. Each carries the stored guardrail results as its inputs and the run ids, rule set, model and prompt version of the
// "no holds" outcome it rests on. AUTO_RECOGNIZED stands in for the human approvals of a decision recognized with none, and migration 0020 refuses it unless every guardrail is stored as passing.
// GUARDRAIL_REFUSED and AUDIT_SAMPLED route the decision to people for good. AUTO_SENT is written in the transaction that persists the disbursement. None of them is an approval.
export async function recordAutopilot(tx: AutomatedWriter, decisionHash: string, kind: "AUTO_RECOGNIZED" | "GUARDRAIL_REFUSED" | "AUDIT_SAMPLED" | "AUTO_SENT" | "AUTO_SEND_CONFIRMED", outcome: { rulesRunId: string; modelRunId: string; ruleSetVersion: string; model: string; promptVersion: string }, inputs: Record<string, unknown>): Promise<string> {
  const [row] = await tx.insert(s.automatedDecisions).values({
    decisionHash, kind, rulesRunId: outcome.rulesRunId, modelRunId: outcome.modelRunId, ruleSetVersion: outcome.ruleSetVersion, model: outcome.model, promptVersion: outcome.promptVersion, inputs,
  }).returning({ id: s.automatedDecisions.id });
  if (!row) throw new Error("Automated record was not written");
  return row.id;
}
