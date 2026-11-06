// IAC-405 step 1 piece G: reads a stored MODEL run for the claim view. Read-only. No clock except the display window below, no provider,
// no key, no AI module. The model wrote no quote: clause text is looked up here from fund_policy_clauses by the stored clause id, and the line
// description comes from the stored claim line. A missing answer is never read as OK.
import { and, asc, eq, inArray } from "drizzle-orm";
import * as s from "../../db/schema";
import type { ModelReasonCode, ModelVerdict } from "../../db/schema";
import type { PolicyReader } from "./facts";
import { MODEL_RUN_WINDOW_MS } from "./compliance";
import { boundedText } from "./text";

export type StoredModelLine = { lineId: string; description: string; verdict: ModelVerdict; clauseId: string | null; clauseText: string | null };
export type StoredModelPair = {
  fundId: string; fundName: string; policyVersion: number | null; state: "CHECKED" | "NOT_CHECKED" | "SKIPPED";
  // Set for NOT_CHECKED and SKIPPED pairs.
  reasonCode: ModelReasonCode | null;
  // The model id and effort that produced the lines (CHECKED) or that failed (NOT_CHECKED). Null for SKIPPED and NO_CLAUSES.
  model: string | null; effort: string | null; lines: StoredModelLine[];
  // The distinct model ids of this fund's stored CALL rows, first-seen order: every model that was sent a request for it. A request refused by the request limit stores no CALL row, so it is not here.
  called: string[];
};
export type ModelRunState = "RUNNING" | "DONE" | "INTERRUPTED";
// Hold when any line is CONFLICT or UNSURE or any pair is NOT_CHECKED, or the run never finished. NO_CONFLICT_FOUND needs a finished run, at least one
// checked pair and every line OK. NOTHING_CHECKED means every pair was skipped. None of these is an approval and none changes the Approve control.
export type ModelStatus = "RUNNING" | "HOLD" | "NO_CONFLICT_FOUND" | "NOTHING_CHECKED";
export type StoredModelRun = {
  id: string; startedAt: Date; model: string; effort: string; promptVersion: string; schemaVersion: string; clauseSetHash: string;
  state: ModelRunState; status: ModelStatus; pairs: StoredModelPair[];
  // The distinct model ids of every CALL row of the run in sequence order: every model that was sent a request. The "Powered by" line is built from this and nothing else.
  calledModels: string[];
};

/** Distinct model ids of CALL rows, first-seen order. */
export const calledModelsOf = (rows: readonly { entry: string; model: string | null }[]): string[] => [...new Set(rows.flatMap(row => row.entry === "CALL" && row.model ? [row.model] : []))];

export function modelStatusOf(state: ModelRunState, pairs: StoredModelPair[]): ModelStatus {
  if (state === "RUNNING") return "RUNNING";
  if (state === "INTERRUPTED") return "HOLD";
  if (pairs.some(pair => pair.state === "NOT_CHECKED" || pair.lines.some(line => line.verdict !== "OK"))) return "HOLD";
  return pairs.some(pair => pair.state === "CHECKED") ? "NO_CONFLICT_FOUND" : "NOTHING_CHECKED";
}

// A run row is written first and every result row, with the run end, in one later transaction. A run with no end row inside the window
// is still running. After the window it displays as not checked and holds. The window is two sequential 60 s calls plus margin.
export async function readModelChecks(tx: PolicyReader, decisionHash: string, now: Date = new Date()): Promise<StoredModelRun | null> {
  const [run] = await tx.select().from(s.policyCheckRuns).where(and(eq(s.policyCheckRuns.decisionHash, decisionHash), eq(s.policyCheckRuns.kind, "MODEL")));
  if (!run || !run.model || !run.effort || !run.promptVersion || !run.schemaVersion || !run.clauseSetHash) return null;
  const rows = await tx.select().from(s.policyModelResults).where(eq(s.policyModelResults.runId, run.id)).orderBy(asc(s.policyModelResults.sequence));
  const ended = rows.some(row => row.entry === "RUN_END");
  const state: ModelRunState = ended ? "DONE" : now.getTime() - run.startedAt.getTime() > MODEL_RUN_WINDOW_MS ? "INTERRUPTED" : "RUNNING";
  const fundIds = [...new Set(rows.flatMap(row => row.fundId ? [row.fundId] : []))];
  const funds = fundIds.length ? await tx.select({ id: s.funds.id, name: s.funds.name }).from(s.funds).where(inArray(s.funds.id, fundIds)) : [];
  const clauses = fundIds.length ? await tx.select().from(s.fundPolicyClauses).where(inArray(s.fundPolicyClauses.fundId, fundIds)) : [];
  const lineRows = await tx.select({ id: s.claimLines.id, description: s.claimLines.description }).from(s.claimLines)
    .where(and(eq(s.claimLines.claimId, run.claimId), eq(s.claimLines.claimVersion, run.claimVersion)));
  const description = new Map(lineRows.map(line => [line.id, boundedText(line.description, 200)]));
  const clauseText = (fundId: string, version: number | null, clauseId: string | null) => {
    if (clauseId === null || version === null) return null;
    const found = clauses.find(clause => clause.fundId === fundId && clause.policyVersion === version && clause.clauseId === clauseId);
    return found ? boundedText(found.text, 600) : null;
  };
  const order: string[] = [];
  for (const row of rows) if (row.fundId && !order.includes(row.fundId)) order.push(row.fundId);
  const pairs: StoredModelPair[] = order.map(fundId => {
    const mine = rows.filter(row => row.fundId === fundId);
    const version = mine.find(row => row.policyVersion !== null)?.policyVersion ?? null;
    const fundName = boundedText(funds.find(fund => fund.id === fundId)?.name ?? fundId, 120);
    const skipped = mine.find(row => row.entry === "SKIPPED");
    if (skipped) return { fundId, fundName, policyVersion: version, state: "SKIPPED", reasonCode: skipped.reasonCode, model: null, effort: null, lines: [], called: calledModelsOf(mine) };
    const lines = mine.filter(row => row.entry === "LINE");
    if (lines.length > 0) {
      const first = lines[0]!;
      return { fundId, fundName, policyVersion: version, state: "CHECKED", reasonCode: null, model: first.model, effort: first.effort, called: calledModelsOf(mine),
        lines: lines.map(row => ({ lineId: row.lineId!, description: description.get(row.lineId!) ?? row.lineId!, verdict: row.verdict!, clauseId: row.clauseId, clauseText: clauseText(fundId, version, row.clauseId) })) };
    }
    const failed = mine.find(row => row.entry === "NOT_CHECKED");
    // A pair with no outcome row cannot be written by the service. If one is ever read it is shown as not checked, never as OK.
    return { fundId, fundName, policyVersion: version, state: "NOT_CHECKED", reasonCode: failed?.reasonCode ?? "UNAVAILABLE", model: failed?.model ?? null, effort: failed?.effort ?? null, lines: [], called: calledModelsOf(mine) };
  });
  return { id: run.id, startedAt: run.startedAt, model: run.model, effort: run.effort, promptVersion: run.promptVersion, schemaVersion: run.schemaVersion,
    clauseSetHash: run.clauseSetHash, state, status: modelStatusOf(state, pairs), pairs, calledModels: calledModelsOf(rows) };
}
