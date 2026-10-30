import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { AppDatabase } from "../server/db";
import * as s from "../../db/schema";
import { receiptContext, suggestReceipt, suggestionHash } from "../receipt/service";
import { budgetFor, digest, draftHash } from "../receipt/terms";
import { validateProposals, ReceiptAiError } from "../ai/receipt";
import type { AnyReceiptCategorizer } from "../ai/audit";
import { readSnapshot, type Snapshot } from "../ledger/snapshot";
import { allocate } from "../domain/allocate";
import type { ProposalResult, ProposalState } from "./types";

type Tx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];
type Run = typeof s.expenseProposals.$inferSelect;
type Review = Awaited<ReturnType<typeof receiptContext>>;
export type PreparationTerms = { reviewId: string; draftHash: string; suggestionHash: string; runHash: string };
const DEADLINE_MS = 65000;
const hashPattern = /^[a-f0-9]{64}$/;
async function boundedTransaction(tx: Tx) {
  await tx.execute(sql`set local statement_timeout = '2000ms'`);
  await tx.execute(sql`set local lock_timeout = '1000ms'`);
}
function stable(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(stable).sort().join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${stable(v)}`).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
export const proposalRunHash = (run?: Run) => digest(stable(run ? { id: run.id, state: run.state, result: run.result, snapshotDigest: run.snapshotDigest, completedAt: run.completedAt?.toISOString() ?? null } : null));
const snapshotHash = (snapshot: Snapshot) => digest(stable({ input: snapshot.input, payeeHash: digest(snapshot.claim.payeeEmail) }));
const editable = (v: Review) => v.actor.role === "CLAIMANT" && v.actor.id === v.claim.claimantId && v.canEdit && !v.confirmation;
async function current(tx: Tx, id: string, actor: string, edit = false) {
  const value = await receiptContext(tx, id, actor, edit);
  if (value.actor.role !== "CLAIMANT" || value.actor.id !== value.claim.claimantId) throw new Error("Claimant access required");
  return value;
}
const latest = async (tx: Tx, reviewId: string) => (await tx.select().from(s.expenseProposals).where(eq(s.expenseProposals.reviewId, reviewId)).orderBy(desc(s.expenseProposals.createdAt), desc(s.expenseProposals.id)).limit(1))[0];
function sameTerms(v: Review, run: Run) {
  return editable(v) && v.review.id === run.reviewId && v.review.sourceHash === run.sourceHash &&
    v.review.draftHash === run.draftHash && draftHash(v.claim, v.lines) === run.draftHash && digest(v.claim.payeeEmail) === run.payeeHash;
}
function evidence(v: Review) {
  if (v.suggestion?.status !== "READY") throw new Error("Suggestion is not ready");
  const proposals = validateProposals({ source: v.review.source, lines: v.lines.map(line => ({ id: line.id, description: line.description })) }, { proposals: v.suggestion.proposals?.map(p => ({ lineId: p.lineId, category: p.category, quote: p.quote })) });
  if (v.suggestion.audit?.sourceSha256 !== digest(v.review.source)) throw new Error("Suggestion source changed");
  return proposals;
}
function preview(v: Review, snapshot: Snapshot): { state: ProposalState; result: ProposalResult } {
  const proposals = evidence(v);
  const unknown = proposals.filter(p => p.category === "UNKNOWN");
  const steps: ProposalResult["steps"] = ["CATEGORIES_VALIDATED", "HUMAN_CONFIRMATION_REQUIRED"];
  if (unknown.length) return { state: "NEEDS_REVIEW", result: { summary: "UNRESOLVED_CATEGORIES", edges: [], generalCents: null, steps,
    issues: unknown.map(p => ({ lineId: p.lineId, code: "UNKNOWN", amountCents: v.lines.find(l => l.id === p.lineId)!.amountCents.toString() })) } };
  const lines = snapshot.input.lines.map(line => { const proposal = proposals.find(p => p.lineId === line.id)!; return { ...line, category: proposal.category, budgetLine: budgetFor(proposal.category) }; });
  const prohibited = lines.filter(line => snapshot.input.prohibitedCategories.includes(line.category));
  const base = { edges: [], generalCents: null, steps: ["CATEGORIES_VALIDATED", "POLICY_PREVIEWED", "HUMAN_CONFIRMATION_REQUIRED"] as ProposalResult["steps"] };
  if (prohibited.length) return { state: "POLICY_BLOCKED", result: { ...base, summary: "PROHIBITED_CATEGORY", issues: prohibited.map(line => ({ lineId: line.id, code: "PROHIBITED", amountCents: line.amountCents.toString() })) } };
  const result = allocate({ ...snapshot.input, lines });
  if (result.status === "INFEASIBLE") return { state: "POLICY_BLOCKED", result: { ...base, summary: "INSUFFICIENT_ELIGIBLE_CAPACITY", issues: result.unfunded.map(line => ({ lineId: line.lineId, code: "UNFUNDED", amountCents: line.amountCents.toString() })) } };
  return { state: "READY_FOR_REVIEW", result: { ...base, summary: "HUMAN_REVIEW_REQUIRED", issues: [], generalCents: result.unrestrictedCents.toString(), edges: result.edges.map(edge => ({ ...edge, amountCents: edge.amountCents.toString() })) } };
}
async function presented(tx: Tx, v: Review, run?: Run) {
  if (!run) return { run: null, runHash: proposalRunHash(), canPrepare: editable(v) };
  let state = run.state;
  if (!sameTerms(v, run)) state = "STALE";
  else if (state === "RUNNING" && run.deadlineAt.getTime() <= Date.now()) state = "UNAVAILABLE";
  else if (run.snapshotDigest && snapshotHash(await readSnapshot(tx, v.claim.id)) !== run.snapshotDigest) state = "STALE";
  if (run.suggestionDigest && suggestionHash(v.suggestion) !== run.suggestionDigest) state = "STALE";
  return { run: { id: run.id, state, errorCode: state === "UNAVAILABLE" && run.state === "RUNNING" ? "TIMEOUT" : run.errorCode,
    result: state === "STALE" ? null : run.result, suggestionId: run.suggestionId, createdAt: run.createdAt.toISOString(), deadlineAt: run.deadlineAt.toISOString() },
    runHash: proposalRunHash(run), canPrepare: editable(v) };
}
export async function readExpenseProposal(db: AppDatabase, id: string, actor: string) {
  return db.transaction(async tx => { const v = await current(tx, id, actor); return presented(tx, v, await latest(tx, v.review.id)); }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
export async function readExpenseReview(db: AppDatabase, id: string, actor: string) {
  return db.transaction(async tx => {
    const receipt = await current(tx, id, actor);
    const preparation = await presented(tx, receipt, await latest(tx, receipt.review.id));
    const funds = await tx.select({ id: s.funds.id, name: s.funds.name }).from(s.funds).where(eq(s.funds.organizationId, receipt.claim.organizationId));
    return { receipt, preparation, fundNames: Object.fromEntries(funds.map(fund => [fund.id, fund.name])) };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export async function prepareExpenseProposal(db: AppDatabase, id: string, actor: string, terms: PreparationTerms, categorize: AnyReceiptCategorizer) {
  if (!terms || !hashPattern.test(terms.draftHash) || !hashPattern.test(terms.suggestionHash) || !hashPattern.test(terms.runHash)) throw new Error("Invalid preparation terms");
  const key = digest(stable({ id, actor, ...terms }));
  const start = await db.transaction(async tx => {
    await boundedTransaction(tx);
    // This short admission transaction ends before inference. A durable partial index also
    // prevents overlapping preparation across processes or different reviews.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('aidtrace-expense-preparation')::bigint)`);
    const v = await current(tx, id, actor, true);
    if (!editable(v) || v.review.id !== terms.reviewId || v.review.draftHash !== terms.draftHash || draftHash(v.claim, v.lines) !== terms.draftHash) throw new Error("Preparation review is stale");
    const [replay] = await tx.select().from(s.expenseProposals).where(eq(s.expenseProposals.requestKey, key));
    if (replay) return { reused: true as const };
    const previous = await latest(tx, v.review.id);
    if (previous?.state === "RUNNING" && previous.deadlineAt.getTime() > Date.now()) return { reused: true as const };
    if (proposalRunHash(previous) !== terms.runHash || suggestionHash(v.suggestion) !== terms.suggestionHash) throw new Error("Preparation review is stale");
    const now = new Date();
    await tx.update(s.expenseProposals).set({ state: "UNAVAILABLE", errorCode: "TIMEOUT", completedAt: now }).where(and(eq(s.expenseProposals.state, "RUNNING"), lte(s.expenseProposals.deadlineAt, now)));
    const occupied = (await tx.select({ id: s.expenseProposals.id }).from(s.expenseProposals).where(eq(s.expenseProposals.state, "RUNNING")).limit(1)).length > 0;
    const suggestionBusy = v.suggestion?.status === "RUNNING" && now.getTime() - v.suggestion.requestedAt.getTime() < DEADLINE_MS;
    const [run] = await tx.insert(s.expenseProposals).values({ reviewId: v.review.id, claimId: id, claimVersion: v.claim.version,
      organizationId: v.claim.organizationId, actorId: actor, requestKey: key, sourceHash: v.review.sourceHash, draftHash: terms.draftHash,
      payeeHash: digest(v.claim.payeeEmail), state: occupied || suggestionBusy ? "UNAVAILABLE" : "RUNNING", errorCode: occupied || suggestionBusy ? "BUSY" : null,
      createdAt: now, deadlineAt: new Date(now.getTime() + DEADLINE_MS), completedAt: occupied || suggestionBusy ? now : null }).returning();
    return occupied || suggestionBusy ? { reused: true as const } : { reused: false as const, run: run! };
  });
  if (start.reused) return readExpenseProposal(db, id, actor);
  const run = start.run;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new ReceiptAiError("TIMEOUT")); }, Math.max(0, run.deadlineAt.getTime() - Date.now())); });
    await Promise.race([suggestReceipt(db, id, actor, terms.reviewId, terms.draftHash, input => categorize(input, controller.signal), terms.suggestionHash), timeout]);
    const prepared = await db.transaction(async tx => {
      await boundedTransaction(tx);
      const v = await current(tx, id, actor);
      if (!sameTerms(v, run)) return { state: "STALE" as const, errorCode: "STALE" };
      if (v.suggestion?.status !== "READY") return { state: "UNAVAILABLE" as const, errorCode: v.suggestion?.errorCode ?? "UNAVAILABLE" };
      const snapshot = await readSnapshot(tx, id);
      try { return { ...preview(v, snapshot), snapshotDigest: snapshotHash(snapshot), suggestionDigest: suggestionHash(v.suggestion), suggestionId: v.suggestion.id, errorCode: null }; }
      catch { return { state: "NEEDS_REVIEW" as const, errorCode: "VALIDATION" }; }
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    await db.transaction(async tx => {
      await boundedTransaction(tx);
      const v = await current(tx, id, actor, true);
      const [stored] = await tx.select().from(s.expenseProposals).where(eq(s.expenseProposals.id, run.id)).for("update");
      if (stored?.state !== "RUNNING") return;
      const now = new Date();
      const stale = !sameTerms(v, run) || ("snapshotDigest" in prepared && (prepared.snapshotDigest !== snapshotHash(await readSnapshot(tx, id)) || prepared.suggestionDigest !== suggestionHash(v.suggestion)));
      const expired = timedOut || now.getTime() >= run.deadlineAt.getTime();
      await tx.update(s.expenseProposals).set(stale ? { state: "STALE", errorCode: "STALE", completedAt: now } : expired ? { state: "UNAVAILABLE", errorCode: "TIMEOUT", completedAt: now } : { ...prepared, completedAt: now }).where(eq(s.expenseProposals.id, run.id));
    });
  } catch (error) {
    await db.transaction(async tx => {
      await boundedTransaction(tx);
      const v = await current(tx, id, actor);
      const stale = !sameTerms(v, run);
      await tx.update(s.expenseProposals).set({ state: stale ? "STALE" : "UNAVAILABLE", errorCode: stale ? "STALE" : error instanceof ReceiptAiError ? error.code : "UNAVAILABLE", completedAt: new Date() }).where(and(eq(s.expenseProposals.id, run.id), eq(s.expenseProposals.state, "RUNNING")));
    });
  } finally { if (timer) clearTimeout(timer); controller.abort(); }
  return readExpenseProposal(db, id, actor);
}
