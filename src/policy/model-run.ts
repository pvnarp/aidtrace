// IAC-405 step 1 piece G: the arm C compliance check (docs/plans/POLICY_CHECK_SCOPE.md section 3; docs/decisions.md decision 10).
// This is the only policy module that imports a provider, budget or client module. It writes policy_check_runs (kind MODEL) and
// policy_model_results only. It never changes a claim, an approval, a reservation or a journal entry, and no result blocks or grants anything.
//
// Per claim and fund pair, with only the lines that fund pays for:
//   1. Haiku 5.5 at low effort. Valid and every line OK: store those OK rows and stop.
//   2. Anything else escalates to Sonnet 5.5 at low effort and stores Sonnet's rows: a valid answer with a line that is not OK, and also a
//      Haiku call that timed out, threw, was refused by the request budget or came back invalid. That is how Run 5b scored the combination
//      (docs/plans/CREDIT_EVALS.md: "a call that is invalid, errored or missing holds", otherwise call the second arm).
//   3. Sonnet fails or is invalid: store NOT_CHECKED with Sonnet's reason code. Its budget slot is still spent. After a Haiku failure the
//      NOT_CHECKED row names Sonnet and its reason, and the Haiku CALL row keeps Haiku's reason.
//   A request-budget refusal at Haiku also escalates, and Sonnet's reserve is then refused too (NOT_CHECKED, LIMIT). No bypass exists.
// One attempt per decision hash: the run row is inserted first under an advisory lock and the unique (decision_hash, kind) constraint is the
// backstop, so a second press sends no request. The calls run outside any transaction. The result rows and the run end are written in one
// later transaction, so a run that never finished has no rows and displays as not checked (src/policy/model-read.ts).
import { and, eq, inArray, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { ModelReasonCode, PolicyModelEntry } from "../../db/schema";
import { createClaudeBudget, processClaudeBudget, type ClaudeBudget } from "../ai/budget";
import { CLAUDE_TIMEOUT_MS, claudeClientFor, type ClaudeMessagesClient } from "../ai/claude-client";
import { claudeAiStatus, type AiOffReason } from "../ai/provider";
import type { AppDatabase } from "../server/db";
import {
  COMPLIANCE_ARM, COMPLIANCE_EFFORT, COMPLIANCE_PROMPT_VERSION, COMPLIANCE_SCHEMA_VERSION, COMPLIANCE_STEPS, clauseSetHash, complianceRequest, complianceUserMessage,
  readComplianceEnvelope, requestDigest, sha256, validateComplianceLines, type ComplianceInput, type ComplianceStep, type ComplianceUsage, type LineVerdict,
} from "./compliance";
import { RECEIPT_CLAIM } from "./facts";
import { sqlState, type PolicyRefusal } from "./service";

type Env = Record<string, string | undefined>;
// Test seams. Production passes none: a real call uses the process environment, the process-wide budget and the fixed-endpoint client.
// An injected stub client gets a fresh budget unless a test passes one, as src/analytics/explain.ts does.
export type ModelRunDeps = { env?: Env; client?: ClaudeMessagesClient; budget?: ClaudeBudget; timeoutMs?: number };
export type ModelRunResult =
  | { status: "OFF"; reason: AiOffReason }
  | { status: "SKIPPED"; reason: "NO_RULES" | "NOT_RECEIPT_CLAIM" }
  | { status: "RAN"; runId: string; requests: number; checked: number; notChecked: number; skipped: number }
  | { status: "EXISTS"; runId: string }
  | { status: "REFUSED"; reason: PolicyRefusal };

type ResultRow = Omit<typeof s.policyModelResults.$inferInsert, "runId" | "sequence">;
const BLANK = { fundId: null, policyVersion: null, lineId: null, verdict: null, clauseId: null, model: null, effort: null, reasonCode: null, requestDigest: null, stopReason: null, inputTokens: null, outputTokens: null } as const;
const row = (entry: PolicyModelEntry, fields: Partial<ResultRow>): ResultRow => ({ ...BLANK, entry, ...fields });

// One fund the claim draws on. SKIPPED is the General fund (no clauses by design). NO_CLAUSES is a restricted fund with no recorded clauses at the
// frozen policy version. CHECK is the only kind that sends a request.
type Pair =
  | { kind: "CHECK"; fundId: string; policyVersion: number; input: ComplianceInput }
  | { kind: "SKIP_GENERAL"; fundId: string; policyVersion: number }
  | { kind: "NO_CLAUSES"; fundId: string; policyVersion: number };
const numeric = (a: string, b: string) => { const [x1, x2] = a.split(".").map(Number), [y1, y2] = b.split(".").map(Number); return x1! - y1! || x2! - y2!; };

type ReadResult =
  | { kind: "refused"; reason: PolicyRefusal }
  | { kind: "exists"; id: string }
  | { kind: "skipped"; reason: "NO_RULES" | "NOT_RECEIPT_CLAIM" }
  | { kind: "ready"; claimId: string; claimVersion: number; organizationId: string; pairs: Pair[]; clauses: { fundId: string; policyVersion: number; clauseId: string; text: string }[] };

async function readInputs(db: AppDatabase, decisionHash: string, actorId: string): Promise<ReadResult> {
  // One snapshot, read only: authorization, decision state, and every fact the request is built from.
  return db.transaction(async tx => {
    const [user] = await tx.select({ id: s.users.id, role: s.users.role, organizationId: s.users.organizationId }).from(s.users).where(eq(s.users.id, actorId));
    if (!user || user.role !== "APPROVER") return { kind: "refused" as const, reason: "APPROVER_REQUIRED" as const };
    const [decision] = await tx.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.decisionHash, decisionHash));
    if (!decision || decision.organizationId !== user.organizationId) return { kind: "refused" as const, reason: "NO_DECISION" as const };
    const [claim] = await tx.select().from(s.claims).where(and(eq(s.claims.id, decision.claimId), eq(s.claims.version, decision.claimVersion)));
    if (!claim || claim.claimantId === user.id) return { kind: "refused" as const, reason: "APPROVER_REQUIRED" as const };
    if (decision.invalidatedAt || decision.recognizedAt) return { kind: "refused" as const, reason: "STALE" as const };
    if (claim.status !== "AWAITING_APPROVAL") return { kind: "refused" as const, reason: "NOT_AWAITING" as const };
    const [existing] = await tx.select({ id: s.policyCheckRuns.id }).from(s.policyCheckRuns).where(and(eq(s.policyCheckRuns.decisionHash, decisionHash), eq(s.policyCheckRuns.kind, "MODEL")));
    if (existing) return { kind: "exists" as const, id: existing.id };
    const [rules] = await tx.select({ id: s.policyCheckRuns.id }).from(s.policyCheckRuns).where(and(eq(s.policyCheckRuns.decisionHash, decisionHash), eq(s.policyCheckRuns.kind, "RULES")));
    if (!rules) return { kind: "skipped" as const, reason: "NO_RULES" as const };
    // Only a claim with a confirmed receipt review. The fixture claim C-104 and any claim without a confirmation get rule flags only.
    const [confirmed] = RECEIPT_CLAIM.test(claim.id)
      ? await tx.select({ id: s.receiptConfirmations.id }).from(s.receiptConfirmations).innerJoin(s.receiptReviews, eq(s.receiptReviews.id, s.receiptConfirmations.reviewId))
        .where(and(eq(s.receiptReviews.claimId, claim.id), eq(s.receiptReviews.claimVersion, claim.version))).limit(1)
      : [];
    if (!confirmed) return { kind: "skipped" as const, reason: "NOT_RECEIPT_CLAIM" as const };

    const lines = await tx.select().from(s.claimLines).where(and(eq(s.claimLines.claimId, claim.id), eq(s.claimLines.claimVersion, claim.version)));
    const edges = await tx.select({ lineId: s.allocationEdges.lineId, fundId: s.allocationEdges.fundId, policyVersion: s.allocationEdges.policyVersion }).from(s.allocationEdges).where(eq(s.allocationEdges.decisionId, decision.id));
    const fundIds = [...new Set(edges.map(edge => edge.fundId))].sort();
    const funds = fundIds.length ? await tx.select({ id: s.funds.id, name: s.funds.name, fundClass: s.funds.fundClass }).from(s.funds).where(inArray(s.funds.id, fundIds)) : [];
    const clauseRows = fundIds.length ? await tx.select().from(s.fundPolicyClauses).where(inArray(s.fundPolicyClauses.fundId, fundIds)) : [];

    const pairs: Pair[] = [];
    const used: typeof clauseRows = [];
    for (const fundId of fundIds) {
      const fund = funds.find(item => item.id === fundId);
      const mine = edges.filter(edge => edge.fundId === fundId);
      const versions = [...new Set(mine.map(edge => edge.policyVersion))];
      const policyVersion = Math.max(...versions);
      if (!fund) continue;
      if (fund.fundClass === "UNRESTRICTED") { pairs.push({ kind: "SKIP_GENERAL", fundId, policyVersion }); continue; }
      // Mixed policy versions for one fund cannot be written by the freeze. If one is ever read, fail closed: not checked, never OK.
      const clauses = versions.length === 1 ? clauseRows.filter(clause => clause.fundId === fundId && clause.policyVersion === policyVersion).sort((a, b) => numeric(a.clauseId, b.clauseId)) : [];
      if (clauses.length === 0) { pairs.push({ kind: "NO_CLAUSES", fundId, policyVersion }); continue; }
      used.push(...clauses);
      const paid = new Set(mine.map(edge => edge.lineId));
      const input: ComplianceInput = {
        fundName: fund.name, clauses: clauses.map(clause => ({ id: clause.clauseId, text: clause.text })), vendor: claim.vendor, date: claim.incurredOn,
        lines: lines.filter(line => paid.has(line.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(line => ({ id: line.id, description: line.description, amountCents: Number(line.amountCents) })),
      };
      pairs.push({ kind: "CHECK", fundId, policyVersion, input });
    }
    return { kind: "ready" as const, claimId: claim.id, claimVersion: claim.version, organizationId: claim.organizationId, pairs,
      clauses: used.map(clause => ({ fundId: clause.fundId, policyVersion: clause.policyVersion, clauseId: clause.clauseId, text: clause.text })) };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

type Context = { client: ClaudeMessagesClient; budget: ClaudeBudget; timeoutMs: number; requests: { count: number } };
type StepResult = { ok: true; verdicts: LineVerdict[]; rows: ResultRow[] } | { ok: false; reason: Exclude<ModelReasonCode, "NO_CLAUSES" | "GENERAL_FUND">; rows: ResultRow[] };
const stopToken = (message: unknown) => {
  const stop = message && typeof message === "object" ? (message as { stop_reason?: unknown }).stop_reason : null;
  return typeof stop === "string" && /^[a-z_]{1,40}$/.test(stop) ? stop : null;
};
function callRow(pair: Pair, step: ComplianceStep, digest: string, reason: "TIMEOUT" | "UNAVAILABLE" | "INVALID" | null, stop: string | null, usage: ComplianceUsage | null): ResultRow {
  return row("CALL", { fundId: pair.fundId, policyVersion: pair.policyVersion, model: step.model, effort: step.effort, requestDigest: digest, reasonCode: reason, stopReason: stop, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null });
}
// One request. reserve() runs immediately before it and a failed call still counts. A refused reserve sends nothing and stores LIMIT.
async function callStep(pair: Extract<Pair, { kind: "CHECK" }>, step: ComplianceStep, context: Context): Promise<StepResult> {
  const request = complianceRequest(step.model, pair.input);
  const digest = requestDigest(request);
  if (!context.budget.reserve()) return { ok: false, reason: "LIMIT", rows: [] };
  context.requests.count += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.timeoutMs);
  let message: unknown;
  try {
    message = await context.client.messages.create(request, { timeout: context.timeoutMs, maxRetries: 0, signal: controller.signal });
  } catch {
    // Never keyed on error text. An abort is a timeout, anything else is unavailable.
    const reason = controller.signal.aborted ? "TIMEOUT" as const : "UNAVAILABLE" as const;
    return { ok: false, reason, rows: [callRow(pair, step, digest, reason, null, null)] };
  } finally { clearTimeout(timer); }
  const parsed = readComplianceEnvelope(step.model, message, value => validateComplianceLines(value, pair.input));
  const stop = stopToken(message);
  if (!parsed.ok) return { ok: false, reason: "INVALID", rows: [callRow(pair, step, digest, "INVALID", stop, parsed.usage)] };
  return { ok: true, verdicts: parsed.value, rows: [callRow(pair, step, digest, null, stop, parsed.usage)] };
}
const lineRows = (pair: Pair, step: ComplianceStep, verdicts: LineVerdict[]) => verdicts.map(item =>
  row("LINE", { fundId: pair.fundId, policyVersion: pair.policyVersion, model: step.model, effort: step.effort, lineId: item.lineId, verdict: item.verdict, clauseId: item.clauseId }));
const notChecked = (pair: Pair, reason: ModelReasonCode, step: ComplianceStep | null) =>
  row("NOT_CHECKED", { fundId: pair.fundId, policyVersion: pair.policyVersion, model: step?.model ?? null, effort: step?.effort ?? null, reasonCode: reason });

// Arm C for one pair. Pure routing over callStep: Sonnet is called unless Haiku returned a valid answer with every line OK. A Haiku failure
// (timeout, error, invalid answer or a refused reserve) escalates, as the Run 5b combination scored it.
async function runPair(pair: Pair, context: Context): Promise<ResultRow[]> {
  if (pair.kind === "SKIP_GENERAL") return [row("SKIPPED", { fundId: pair.fundId, policyVersion: pair.policyVersion, reasonCode: "GENERAL_FUND" })];
  if (pair.kind === "NO_CLAUSES") return [notChecked(pair, "NO_CLAUSES", null)];
  const [first, second] = COMPLIANCE_STEPS;
  const one = await callStep(pair, first, context);
  if (one.ok && one.verdicts.every(item => item.verdict === "OK")) return [...one.rows, ...lineRows(pair, first, one.verdicts)];
  const two = await callStep(pair, second, context);
  if (!two.ok) return [...one.rows, ...two.rows, notChecked(pair, two.reason, second)];
  return [...one.rows, ...two.rows, ...lineRows(pair, second, two.verdicts)];
}

// Run the arm C check for one frozen decision, after the rules. Safe to call twice and from two presses at once: there is one model attempt
// per decision hash. AI off stores nothing and sends nothing. Every failure is stored as NOT_CHECKED, never as OK.
export async function runModelCheck(db: AppDatabase, decisionHash: string, actor: { id: string }, deps: ModelRunDeps = {}): Promise<ModelRunResult> {
  if (!/^[a-f0-9]{64}$/.test(decisionHash)) return { status: "REFUSED", reason: "INVALID_REQUEST" };
  const read = await readInputs(db, decisionHash, actor.id);
  if (read.kind === "refused") return { status: "REFUSED", reason: read.reason };
  if (read.kind === "exists") return { status: "EXISTS", runId: read.id };
  if (read.kind === "skipped") return { status: "SKIPPED", reason: read.reason };

  const env = deps.env ?? process.env;
  const budget = deps.budget ?? (deps.client ? createClaudeBudget() : processClaudeBudget);
  const status = claudeAiStatus(env, "AI_COMPLIANCE_ENABLED", budget);
  if (!status.on) return { status: "OFF", reason: status.reason };
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) return { status: "OFF", reason: "NO_KEY" };

  // The exact requests are known before any call, so the run row can record their digest and the clause set it read.
  const checks = read.pairs.filter((pair): pair is Extract<Pair, { kind: "CHECK" }> => pair.kind === "CHECK");
  const plan = checks.map(pair => [pair.fundId, pair.policyVersion, ...COMPLIANCE_STEPS.map(step => requestDigest(complianceRequest(step.model, pair.input)))]);
  const runValues = {
    decisionHash, claimId: read.claimId, claimVersion: read.claimVersion, organizationId: read.organizationId, kind: "MODEL" as const, startedBy: actor.id,
    settingsVersions: {}, ruleSetVersion: COMPLIANCE_ARM, factsDigest: sha256(JSON.stringify(checks.map(pair => [pair.fundId, pair.policyVersion, complianceUserMessage(pair.input)]))),
    model: COMPLIANCE_STEPS.map(step => step.model).join(">"), effort: COMPLIANCE_EFFORT, promptVersion: COMPLIANCE_PROMPT_VERSION, schemaVersion: COMPLIANCE_SCHEMA_VERSION,
    clauseSetHash: clauseSetHash(read.clauses), requestDigest: sha256(JSON.stringify(plan)),
  };
  let runId: string;
  try {
    const created = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`policy-model:${decisionHash}`}, 405))`);
      const [existing] = await tx.select({ id: s.policyCheckRuns.id }).from(s.policyCheckRuns).where(and(eq(s.policyCheckRuns.decisionHash, decisionHash), eq(s.policyCheckRuns.kind, "MODEL")));
      if (existing) return { exists: true as const, id: existing.id };
      const [run] = await tx.insert(s.policyCheckRuns).values(runValues).returning({ id: s.policyCheckRuns.id });
      if (!run) throw new Error("Model check run was not created");
      return { exists: false as const, id: run.id };
    });
    if (created.exists) return { status: "EXISTS", runId: created.id };
    runId = created.id;
  } catch (error) {
    const state = sqlState(error);
    // 23514: a database guard refused (the decision was invalidated after the read, the actor lost the role, or the rules run is gone). 23505: a run exists.
    if (state === "23514") return { status: "REFUSED", reason: "STALE" };
    if (state === "23505") {
      const [existing] = await db.select({ id: s.policyCheckRuns.id }).from(s.policyCheckRuns).where(and(eq(s.policyCheckRuns.decisionHash, decisionHash), eq(s.policyCheckRuns.kind, "MODEL")));
      if (existing) return { status: "EXISTS", runId: existing.id };
    }
    throw error;
  }

  // Pairs run in parallel, each pair's two steps in sequence. Rows are stored in pair order, so the stored order never depends on timing.
  const context: Context = { client: deps.client ?? claudeClientFor(key, env), budget, timeoutMs: deps.timeoutMs ?? CLAUDE_TIMEOUT_MS, requests: { count: 0 } };
  const perPair = await Promise.all(read.pairs.map(pair => runPair(pair, context)));
  const rows = perPair.flat();
  await db.transaction(async tx => {
    let sequence = 0;
    for (const item of rows) { sequence += 1; await tx.insert(s.policyModelResults).values({ ...item, runId, sequence }); }
    await tx.insert(s.policyModelResults).values({ ...row("RUN_END", {}), runId, sequence: sequence + 1 });
  });
  const outcome = (rowsOfPair: ResultRow[]) => rowsOfPair.some(item => item.entry === "SKIPPED") ? "skipped" : rowsOfPair.some(item => item.entry === "NOT_CHECKED") ? "notChecked" : "checked";
  const tally = perPair.map(rowsOfPair => outcome(rowsOfPair));
  return { status: "RAN", runId, requests: context.requests.count, checked: tally.filter(item => item === "checked").length, notChecked: tally.filter(item => item === "notChecked").length, skipped: tally.filter(item => item === "skipped").length };
}
