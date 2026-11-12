import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import * as s from "../db/schema";
import { approveDecision, freezeDecision } from "../src/ledger/service";
import { priorityCostsFor } from "../src/domain/model";
import { sha256 } from "../src/policy/compliance";
import { sqlState } from "../src/policy/service";
import { approveDraft, createDraft, editDraft, readDraft, withdrawDraft, type DraftServiceDeps } from "../src/rules-draft/drafts";
import { validateDraft } from "../src/rules-draft/draft-validate";
import { stubClient } from "./support/claude-stub";
import { createPolicyDatabase, financialHash, receiptClaim, tableHash, type PolicyDatabase } from "./support/policy-db";
import { AGREEMENT, GRANT, RULE_ENV, answerWithAllThresholds, answerWithThresholds, draftMessage, flatAnswer, goodAnswer, unsureList } from "./support/rules-draft";

// IAC-440 Package A, DR-22 to DR-37 on real Postgres with a stubbed model. The service is the only writer of the draft
// tables and the only path to a bound policy. Every model call here goes to a stub that this file defines: no network, no key, no real model.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: PolicyDatabase;
const open: PolicyDatabase[] = [];
beforeEach(async () => { ctx = await createPolicyDatabase("aidtrace_rdraft"); open.push(ctx); }, 60_000);
afterEach(async () => { vi.restoreAllMocks(); while (open.length) await open.pop()!.close(); }, 60_000);

const TARA = { id: "tara" }, BEN = { id: "ben" }, MARIA = { id: "maria" }, OLGA = { id: "olga" };
const FUND = "fund_a";
const stubFor = (answer: unknown, over: Record<string, unknown> = {}) => stubClient(() => draftMessage(answer, "claude-sonnet-5-5", over));
const deps = (client: DraftServiceDeps["client"]): DraftServiceDeps => ({ env: RULE_ENV, client });

// Pastes the agreement as an approver with a stub model that returns `answer`. The stub counts the calls it received.
async function draftOf(actor = TARA, answer: unknown = goodAnswer(), over: { text?: string; fundId?: string; response?: Record<string, unknown> } = {}) {
  const stub = stubFor(answer, over.response);
  const result = await createDraft(ctx.db, actor, over.fundId ?? FUND, over.text ?? AGREEMENT, deps(stub.client));
  return { result, calls: stub.calls };
}
async function draftId(actor = TARA, answer: unknown = goodAnswer(), over: { text?: string; fundId?: string } = {}) {
  const { result } = await draftOf(actor, answer, over);
  if (result.status !== "DRAFTED") throw new Error(`Expected a drafted rule set, got ${JSON.stringify(result)}`);
  return result.draftId;
}
// A draft with a different value in it, so two drafts of one base differ.
// The summary differs, not a cap: a cap other than $300.00 would need its own quote, and the support check downgrades one that does not state it.
const otherAnswer = () => { const answer = goodAnswer(); answer.summary = "Pays robot kits and classroom supplies for the afterschool program."; return answer; };
async function bindDraft(id: string, first = TARA, second = BEN) {
  const one = await approveDraft(ctx.db, first, id);
  const two = await approveDraft(ctx.db, second, id);
  return { one, two };
}
const count = async (table: string, where = "true") => Number((await ctx.client.unsafe(`select count(*)::int as n from ${table} where ${where}`))[0]!.n);
const stateOf = async (work: () => PromiseLike<unknown>) => { try { await work(); return "OK"; } catch (error) { return sqlState(error) ?? `ERR ${String(error)}`; } };
const currentVersion = async (fundId = FUND) => (await ctx.db.select({ v: s.funds.currentPolicyVersion }).from(s.funds).where(eq(s.funds.id, fundId)))[0]!.v;
const events = (id: string) => ctx.db.select().from(s.policyDraftEvents).where(eq(s.policyDraftEvents.draftId, id)).orderBy(asc(s.policyDraftEvents.recordedAt));
async function addOtherOrganization() {
  await ctx.db.insert(s.organizations).values({ id: "other-org", name: "Other Org", prohibitedCategories: [], openingSourceType: "fixture_opening_balance" });
  await ctx.db.insert(s.users).values({ id: "olga", organizationId: "other-org", username: "olga", displayName: "Olga", role: "APPROVER", passwordHash: "not-a-real-hash", isFixture: false });
}
const WATCHED = ["funds", "fund_policy_versions", "fund_budget_lines", "fund_check_settings", "fund_policy_clauses", "policy_drafts", "policy_draft_events"];
const hashes = async () => Object.fromEntries(await Promise.all(WATCHED.map(async table => [table, await tableHash(ctx.client, table)])));

describe("DR-22 only an approver of the fund organization may draft, edit, approve, withdraw or read", () => {
  it("refuses a claimant at every entry and sends no model request and writes no row", async () => {
    const id = await draftId();
    const before = await hashes();
    const stub = stubFor(goodAnswer());
    expect(await createDraft(ctx.db, MARIA, FUND, AGREEMENT, deps(stub.client))).toEqual({ status: "REFUSED", reason: "APPROVER_REQUIRED" });
    expect(stub.calls).toHaveLength(0);
    expect(await editDraft(ctx.db, MARIA, id, { summary: "Changed." })).toMatchObject({ status: "REFUSED", reason: "APPROVER_REQUIRED" });
    expect(await approveDraft(ctx.db, MARIA, id)).toMatchObject({ status: "REFUSED", reason: "APPROVER_REQUIRED" });
    expect(await withdrawDraft(ctx.db, MARIA, id)).toMatchObject({ status: "REFUSED", reason: "APPROVER_REQUIRED" });
    expect(await readDraft(ctx.db, MARIA, id)).toMatchObject({ status: "REFUSED", reason: "APPROVER_REQUIRED" });
    expect(await hashes()).toEqual(before);
  });
  it("a claimant learns nothing from bad input or an unknown draft: the answer is the same refusal", async () => {
    const stub = stubFor(goodAnswer());
    for (const text of ["", "   ", "x".repeat(20_001), "nul\u0000"]) expect(await createDraft(ctx.db, MARIA, FUND, text, deps(stub.client)), JSON.stringify(text.slice(0, 5))).toEqual({ status: "REFUSED", reason: "APPROVER_REQUIRED" });
    expect(await createDraft(ctx.db, MARIA, "no-such-fund", AGREEMENT, deps(stub.client))).toEqual({ status: "REFUSED", reason: "APPROVER_REQUIRED" });
    expect(await approveDraft(ctx.db, MARIA, "00000000-0000-4000-8000-000000000000")).toMatchObject({ reason: "APPROVER_REQUIRED" });
    expect(await approveDraft(ctx.db, MARIA, "not-a-uuid")).toMatchObject({ reason: "INVALID_REQUEST" });
    expect(stub.calls).toHaveLength(0);
  });
  it("refuses an unknown user, a missing actor and an oversize actor id as not an approver", async () => {
    const stub = stubFor(goodAnswer());
    for (const actor of [{ id: "nobody" }, { id: "" }, { id: "x".repeat(101) }, undefined, null, { id: 7 }] as never[]) {
      expect(await createDraft(ctx.db, actor, FUND, AGREEMENT, deps(stub.client)), JSON.stringify(actor)).toEqual({ status: "REFUSED", reason: "APPROVER_REQUIRED" });
    }
    expect(stub.calls).toHaveLength(0); expect(await count("policy_drafts")).toBe(0);
  });
  it("an approver of another organization sees every fund and draft as not found and writes nothing", async () => {
    await addOtherOrganization();
    const id = await draftId();
    const before = await hashes();
    const stub = stubFor(goodAnswer());
    expect(await createDraft(ctx.db, OLGA, FUND, AGREEMENT, deps(stub.client))).toEqual({ status: "REFUSED", reason: "NOT_FOUND" });
    expect(stub.calls).toHaveLength(0);
    for (const result of [await editDraft(ctx.db, OLGA, id, { summary: "x" }), await approveDraft(ctx.db, OLGA, id), await withdrawDraft(ctx.db, OLGA, id), await readDraft(ctx.db, OLGA, id)]) expect(result).toEqual({ status: "REFUSED", reason: "NOT_FOUND" });
    expect(await hashes()).toEqual(before);
  });
  it("refuses an unrestricted fund and an unknown fund", async () => {
    const stub = stubFor(goodAnswer());
    expect(await createDraft(ctx.db, TARA, "fund_g", AGREEMENT, deps(stub.client))).toEqual({ status: "REFUSED", reason: "FUND_NOT_RESTRICTED" });
    expect(await createDraft(ctx.db, TARA, "no-such-fund", AGREEMENT, deps(stub.client))).toEqual({ status: "REFUSED", reason: "NOT_FOUND" });
    expect(stub.calls).toHaveLength(0);
  });
  it("refuses blank, NUL and oversize text from an approver before any request", async () => {
    const stub = stubFor(goodAnswer());
    for (const text of ["", "  \n ", "x".repeat(20_001), "nul\u0000"]) expect(await createDraft(ctx.db, TARA, FUND, text, deps(stub.client))).toEqual({ status: "REFUSED", reason: "INVALID_REQUEST" });
    expect(stub.calls).toHaveLength(0);
  });
});

describe("DR-23 createDraft stores a drafted rule set, a refusal, or nothing", () => {
  it("stores a DRAFTED row with the grant text, its hash, the model, effort, versions, digest, stop reason and token counts", async () => {
    const { result, calls } = await draftOf();
    expect(result).toMatchObject({ status: "DRAFTED", complete: true, missing: [] }); expect(calls).toHaveLength(1);
    const read = await readDraft(ctx.db, TARA, (result as { draftId: string }).draftId);
    expect(read.status).toBe("OK"); if (read.status !== "OK") return;
    expect(read.view).toMatchObject({ state: "OPEN", outcome: "DRAFTED", basePolicyVersion: 1, currentPolicyVersion: 1, inputText: AGREEMENT, inputSha256: sha256(AGREEMENT), draftedBy: "tara", parentDraftId: null, approvals: [], boundPolicyVersion: null, refusal: null });
    expect(read.view.model).toMatchObject({ model: "claude-sonnet-5-5", effort: "medium", promptVersion: "rules-draft-v3", schemaVersion: "rules-draft-schema-v3", stopReason: "end_turn", inputTokens: 812, outputTokens: 57 });
    expect(read.view.model!.requestDigest).toMatch(/^[a-f0-9]{64}$/); expect(read.view.analysis).toEqual({ complete: true, missing: [], carried: expect.any(Array), quoteUnsupported: [], changesPayOrder: false });
    expect(await count("policy_draft_events")).toBe(0);
  });
  it("stores a draft with an UNSURE required field as incomplete and names what is missing", async () => {
    const answer = goodAnswer(); answer.periodEnd = { status: "UNSURE", value: null, clauseId: null, quote: null };
    expect((await draftOf(TARA, answer)).result).toMatchObject({ status: "DRAFTED", complete: false, missing: ["periodEnd"] });
  });
  it("stores a REFUSED row, with the reason and no draft, when the answer breaks a rule, and never shows it as a draft", async () => {
    const answer = goodAnswer(); answer.allowedCategories.value = ["robot_kits_parts", "alcohol"];
    const { result } = await draftOf(TARA, answer);
    expect(result).toMatchObject({ status: "DRAFT_REFUSED", reason: "PROHIBITED_CATEGORY", path: "allowedCategories" });
    const id = (result as { draftId: string }).draftId;
    const view = await readDraft(ctx.db, TARA, id);
    expect(view.status === "OK" && view.view).toMatchObject({ state: "REFUSED", outcome: "REFUSED", draft: null, analysis: null, refusal: { reason: "PROHIBITED_CATEGORY", path: "allowedCategories" } });
    const [row] = await ctx.db.select().from(s.policyDrafts).where(eq(s.policyDrafts.id, id));
    expect(row).toMatchObject({ outcome: "REFUSED", draft: null, refusalReason: "PROHIBITED_CATEGORY", inputText: AGREEMENT });
  });
  it("stores a REFUSED row for a max_tokens stop, a tool block and invalid JSON, with the stop reason recorded", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["STOP_REASON", { stop_reason: "max_tokens" }],
      ["TOOL_BLOCK", { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "approve", input: {} }] }],
      ["JSON", { content: [{ type: "text", text: "not json" }] }],
    ];
    for (const [code, response] of cases) {
      const { result } = await draftOf(TARA, goodAnswer(), { response });
      expect(result, code).toMatchObject({ status: "DRAFT_REFUSED", reason: code, path: "response" });
    }
    expect(await count("policy_drafts", "outcome = 'REFUSED'")).toBe(3); expect(await count("policy_drafts", "outcome = 'DRAFTED'")).toBe(0);
    expect(await count("policy_drafts", "stop_reason = 'max_tokens'")).toBe(1);
  });
  it("stores nothing and returns unavailable when AI is off, keyless, over budget, failing or timed out", async () => {
    const stub = stubFor(goodAnswer());
    expect(await createDraft(ctx.db, TARA, FUND, AGREEMENT, { env: { ANTHROPIC_API_KEY: "k" }, client: stub.client })).toEqual({ status: "UNAVAILABLE", reason: "SWITCHED_OFF" });
    expect(await createDraft(ctx.db, TARA, FUND, AGREEMENT, { env: { AI_RULE_DRAFTS_ENABLED: "true" }, client: stub.client })).toEqual({ status: "UNAVAILABLE", reason: "NO_KEY" });
    expect(stub.calls).toHaveLength(0);
    const failing = stubClient(() => { throw new Error("boom"); });
    expect(await createDraft(ctx.db, TARA, FUND, AGREEMENT, deps(failing.client))).toEqual({ status: "UNAVAILABLE", reason: "ERROR" });
    expect(await count("policy_drafts")).toBe(0);
  });
  it("sends the grant text, the catalogs of the organization and the prohibited list, and nothing about a claim, a fund id or a person", async () => {
    const stub = stubFor(goodAnswer());
    await createDraft(ctx.db, TARA, FUND, AGREEMENT, deps(stub.client));
    const body = stub.calls[0]![0] as { messages: { content: string }[]; system: string; model: string };
    const sent = JSON.parse(body.messages[0]!.content) as { agreement: string; programs: string[]; prohibited: string[]; categories: string[] };
    expect(sent.agreement).toBe(AGREEMENT); expect(sent.programs).toEqual(["robotics"]); expect(sent.prohibited).toEqual(["alcohol", "gift_cards"]); expect(sent.categories).toEqual(GRANT.categories.filter(category => !sent.prohibited.includes(category)));
    const wire = JSON.stringify(body);
    for (const forbidden of ["fund_a", "fund_b", "fund_g", "C-104", "maria", "tara", "ben", "cedar-hollow", "payee", "RULE_ENV", "test-key-not-real"]) expect(wire.includes(forbidden), forbidden).toBe(false);
    expect(body.model).toBe("claude-sonnet-5-5");
  });
  it("runs a Haiku arm when the caller chooses one, and records it", async () => {
    const stub = stubClient(() => draftMessage(goodAnswer(), "claude-haiku-5-5"));
    const result = await createDraft(ctx.db, TARA, FUND, AGREEMENT, { ...deps(stub.client), arm: { model: "claude-haiku-5-5", effort: "low" } });
    expect(result.status).toBe("DRAFTED"); expect(await count("policy_drafts", "model = 'claude-haiku-5-5' and effort = 'low'")).toBe(1);
  });
});

describe("DR-24 both draft tables refuse UPDATE, DELETE and TRUNCATE", () => {
  it("refuses every change to a stored draft and event with the immutable-record error, and the rows stay as they were", async () => {
    const id = await draftId(); await approveDraft(ctx.db, TARA, id);
    const before = await hashes();
    for (const sql of [
      "update policy_drafts set outcome = 'DRAFTED'", "update policy_drafts set input_text = 'x'", "delete from policy_drafts", "truncate policy_drafts cascade",
      "update policy_draft_events set kind = 'WITHDRAWN'", "update policy_draft_events set actor_id = 'ben'", "delete from policy_draft_events", "truncate policy_draft_events",
    ]) {
      await expect(ctx.client.unsafe(sql), sql).rejects.toMatchObject({ code: "23514", message: "Immutable accounting or approval record" });
    }
    // A plain TRUNCATE of the draft table is refused earlier still, by the foreign keys of the event table and of the parent link (0A000), before any trigger runs.
    // The CASCADE form above is the one that reaches the guard, so it is the proof that the no-truncate trigger on policy_drafts exists.
    await expect(ctx.client.unsafe("truncate policy_drafts"), "truncate policy_drafts").rejects.toMatchObject({ code: "0A000" });
    expect(await hashes()).toEqual(before);
  });
  it("refuses the same through the drizzle client the service uses", async () => {
    const id = await draftId(); await approveDraft(ctx.db, TARA, id);
    expect(await stateOf(() => ctx.db.update(s.policyDrafts).set({ draftedBy: "ben" }).where(eq(s.policyDrafts.id, id)))).toBe("23514");
    expect(await stateOf(() => ctx.db.delete(s.policyDrafts).where(eq(s.policyDrafts.id, id)))).toBe("23514");
    expect(await stateOf(() => ctx.db.update(s.policyDraftEvents).set({ kind: "WITHDRAWN" }).where(eq(s.policyDraftEvents.draftId, id)))).toBe("23514");
    expect(await stateOf(() => ctx.db.delete(s.policyDraftEvents).where(eq(s.policyDraftEvents.draftId, id)))).toBe("23514");
  });
});

describe("DR-25 approvals: two distinct approvers, the second binds, and the drafter may be one of them", () => {
  it("records the first approval without binding anything", async () => {
    const id = await draftId(); const before = await hashes();
    expect(await approveDraft(ctx.db, TARA, id)).toEqual({ status: "APPROVED", approvals: 1 });
    const after = await hashes();
    for (const table of ["funds", "fund_policy_versions", "fund_budget_lines", "fund_check_settings", "fund_policy_clauses"]) expect(after[table], table).toEqual(before[table]);
    expect(await currentVersion()).toBe(1); expect(await count("policy_draft_events", "kind = 'APPROVED'")).toBe(1); expect(await count("policy_draft_events", "kind = 'BOUND'")).toBe(0);
  });
  it("refuses the same person as both approvals, and one person who drafted and approved still needs a second person", async () => {
    const id = await draftId(TARA);
    expect(await approveDraft(ctx.db, TARA, id)).toMatchObject({ status: "APPROVED" });
    expect(await approveDraft(ctx.db, TARA, id)).toEqual({ status: "REFUSED", reason: "SAME_APPROVER" });
    expect(await approveDraft(ctx.db, TARA, id)).toEqual({ status: "REFUSED", reason: "SAME_APPROVER" });
    expect(await count("policy_draft_events", "kind = 'APPROVED'")).toBe(1); expect(await currentVersion()).toBe(1);
  });
  it("binds on the second distinct approval, with the drafter as first or second approver", async () => {
    // The drafter approves first, then a second person approves and binds version 2.
    const first = await draftId(TARA);
    expect((await bindDraft(first, TARA, BEN)).two).toEqual({ status: "BOUND", approvals: 2, policyVersion: 2, priorityVersion: null, invalidatedDecisions: 0 });
    // The other order on the next base: the drafter approves second and binds version 3.
    const reverse = await draftId(BEN);
    expect(await approveDraft(ctx.db, TARA, reverse)).toEqual({ status: "APPROVED", approvals: 1 });
    expect(await approveDraft(ctx.db, BEN, reverse)).toEqual({ status: "BOUND", approvals: 2, policyVersion: 3, priorityVersion: null, invalidatedDecisions: 0 });
    expect((await ctx.db.select().from(s.fundPolicyVersions).where(and(eq(s.fundPolicyVersions.fundId, FUND), eq(s.fundPolicyVersions.version, 3))))[0]).toMatchObject({ approvedBy: "ben" });
  });
  it("binds every row in one step: version N+1 approved by the binding approver, budget lines, clauses, the pointer and the BOUND event", async () => {
    const id = await draftId(TARA);
    const { two } = await bindDraft(id, TARA, BEN);
    expect(two).toEqual({ status: "BOUND", approvals: 2, policyVersion: 2, priorityVersion: null, invalidatedDecisions: 0 });
    const [version] = await ctx.db.select().from(s.fundPolicyVersions).where(and(eq(s.fundPolicyVersions.fundId, FUND), eq(s.fundPolicyVersions.version, 2)));
    expect(version).toMatchObject({ approvedBy: "ben", programs: ["robotics"], allowedCategories: ["robot_kits_parts", "classroom_supplies"], periodStart: "2026-09-01", periodEnd: "2027-06-30", breadth: 2 });
    expect(version!.summary).toBe(goodAnswer().summary);
    expect(await ctx.db.select().from(s.fundBudgetLines).where(and(eq(s.fundBudgetLines.fundId, FUND), eq(s.fundBudgetLines.policyVersion, 2)))).toEqual([{ fundId: FUND, policyVersion: 2, budgetLine: "supplies", capCents: 30000n }]);
    const clauses = await ctx.db.select().from(s.fundPolicyClauses).where(and(eq(s.fundPolicyClauses.fundId, FUND), eq(s.fundPolicyClauses.policyVersion, 2))).orderBy(asc(s.fundPolicyClauses.clauseId));
    expect(clauses.map(clause => clause.clauseId)).toEqual(["1.1", "1.2", "1.3"]); for (const clause of clauses) expect(AGREEMENT.includes(clause.text)).toBe(true);
    expect(await currentVersion()).toBe(2);
    const log = await events(id);
    expect(log.map(event => event.kind).sort()).toEqual(["APPROVED", "APPROVED", "BOUND"]);
    expect(log.find(event => event.kind === "BOUND")).toMatchObject({ actorId: "ben", boundPolicyVersion: 2 });
    // The first version is untouched, and no check settings version was written because the draft states no threshold.
    expect(await count("fund_policy_versions", `fund_id = '${FUND}' and version = 1`)).toBe(1); expect(await count("fund_check_settings", `fund_id = '${FUND}'`)).toBe(1);
    expect((await readDraft(ctx.db, TARA, id)) as unknown).toMatchObject({ status: "OK", view: { state: "BOUND", boundPolicyVersion: 2 } });
  });
  it("writes a new check settings version that carries forward every threshold the draft leaves UNSURE", async () => {
    const id = await draftId(TARA, answerWithThresholds());
    expect((await bindDraft(id)).two).toMatchObject({ status: "BOUND" });
    const rows = await ctx.db.select().from(s.fundCheckSettings).where(eq(s.fundCheckSettings.fundId, FUND)).orderBy(asc(s.fundCheckSettings.version));
    expect(rows.map(row => row.version)).toEqual([1, 2]);
    expect(rows[1]).toMatchObject({ approvedBy: "ben", claimLimitCents: 120000n, suppliesLimitCents: 25000n, equipmentLimitCents: 50000n, staleReceiptDays: 60, duplicateWindowDays: 90, splitWindowDays: 3 });
    expect(rows[0]).toMatchObject({ claimLimitCents: 100000n });
  });
  it("refuses a draft with thresholds when the fund has no settings to carry forward, before any approval is recorded", async () => {
    await ctx.db.insert(s.funds).values({ id: "fund_x", organizationId: "cedar-hollow", name: "Fund X", fundClass: "RESTRICTED", currentPolicyVersion: 1 });
    await ctx.db.insert(s.fundPolicyVersions).values({ fundId: "fund_x", version: 1, approvedBy: "tara", programs: ["robotics"], allowedCategories: ["books"], periodStart: "2026-01-01", periodEnd: "2026-12-31", breadth: 1, summary: "Books." });
    const partial = await draftId(TARA, answerWithThresholds(), { fundId: "fund_x" });
    expect(await approveDraft(ctx.db, TARA, partial)).toEqual({ status: "REFUSED", reason: "THRESHOLDS_INCOMPLETE" });
    expect(await count("policy_draft_events")).toBe(0);
    // All six thresholds quoted from the agreement, so each one passes the mechanical support check and none is downgraded to UNSURE.
    const complete = await draftId(TARA, answerWithAllThresholds(), { fundId: "fund_x" });
    expect((await bindDraft(complete)).two).toMatchObject({ status: "BOUND", policyVersion: 2 });
    expect((await ctx.db.select().from(s.fundCheckSettings).where(eq(s.fundCheckSettings.fundId, "fund_x")))).toMatchObject([{ version: 1, claimLimitCents: 100000n }]);
  });
  it("cannot approve an incomplete draft, a refused draft, a withdrawn draft or a bound draft", async () => {
    const answer = goodAnswer(); answer.caps.supplies = { status: "UNSURE", value: null, clauseId: null, quote: null };
    const incomplete = await draftId(TARA, answer);
    expect(await approveDraft(ctx.db, TARA, incomplete)).toEqual({ status: "REFUSED", reason: "INCOMPLETE", missing: ["caps.supplies"] });
    const refusedAnswer = goodAnswer(); refusedAnswer.breadth = 9;
    const refused = (await draftOf(TARA, refusedAnswer)).result as { draftId: string };
    expect(await approveDraft(ctx.db, TARA, refused.draftId)).toEqual({ status: "REFUSED", reason: "NOT_DRAFTED" });
    const withdrawn = await draftId(TARA, otherAnswer());
    expect(await withdrawDraft(ctx.db, BEN, withdrawn)).toEqual({ status: "WITHDRAWN" });
    expect(await approveDraft(ctx.db, TARA, withdrawn)).toEqual({ status: "REFUSED", reason: "WITHDRAWN" });
    const bound = await draftId(TARA);
    await bindDraft(bound);
    expect(await approveDraft(ctx.db, BEN, bound)).toEqual({ status: "REFUSED", reason: "BOUND" });
    expect(await count("policy_draft_events", `draft_id = '${incomplete}' or draft_id = '${refused.draftId}' or draft_id = '${withdrawn}'`)).toBe(1);
  });
});

describe("DR-26 an edit is a new immutable row that needs its own two approvals", () => {
  it("stores the edit with the parent and the changed field names, and leaves the parent row untouched", async () => {
    const parent = await draftId(TARA);
    const [before] = await ctx.db.select().from(s.policyDrafts).where(eq(s.policyDrafts.id, parent));
    const edited = await editDraft(ctx.db, BEN, parent, { caps: { supplies: 25000 }, summary: "Pays robot kits and classroom supplies." });
    expect(edited).toMatchObject({ status: "EDITED", changedFields: ["caps.supplies", "summary"], complete: true, missing: [] });
    const child = (edited as { draftId: string }).draftId;
    const [row] = await ctx.db.select().from(s.policyDrafts).where(eq(s.policyDrafts.id, child));
    expect(row).toMatchObject({ parentDraftId: parent, changedFields: ["caps.supplies", "summary"], draftedBy: "ben", outcome: "DRAFTED", model: null, requestDigest: null, inputText: AGREEMENT, basePolicyVersion: 1 });
    expect((row!.draft as { caps: { supplies: unknown } }).caps.supplies).toEqual({ status: "EDITED", value: 25000, clauseId: null, quote: null });
    expect((await ctx.db.select().from(s.policyDrafts).where(eq(s.policyDrafts.id, parent)))[0]).toEqual(before);
  });
  it("resets approvals: an approval of the parent does not count for the edit, and the edit binds only on its own two", async () => {
    const parent = await draftId(TARA);
    expect(await approveDraft(ctx.db, TARA, parent)).toMatchObject({ status: "APPROVED" });
    const child = ((await editDraft(ctx.db, BEN, parent, { caps: { supplies: 25000 } })) as { draftId: string }).draftId;
    expect(await events(child)).toEqual([]);
    expect(await approveDraft(ctx.db, BEN, child)).toEqual({ status: "APPROVED", approvals: 1 });
    expect(await currentVersion()).toBe(1);
    expect(await approveDraft(ctx.db, TARA, child)).toEqual({ status: "BOUND", approvals: 2, policyVersion: 2, priorityVersion: null, invalidatedDecisions: 0 });
    expect((await ctx.db.select().from(s.fundBudgetLines).where(and(eq(s.fundBudgetLines.fundId, FUND), eq(s.fundBudgetLines.policyVersion, 2))))[0]).toMatchObject({ capCents: 25000n });
    // The parent had one approval; it can no longer bind because the base moved.
    expect(await approveDraft(ctx.db, BEN, parent)).toEqual({ status: "REFUSED", reason: "STALE_BASE" });
  });
  it("an edit of an edit works and keeps the chain, a rejected edit stores nothing and a no-change edit is rejected", async () => {
    const parent = await draftId(TARA);
    const child = ((await editDraft(ctx.db, TARA, parent, { caps: { supplies: 25000 } })) as { draftId: string }).draftId;
    const grandchild = await editDraft(ctx.db, BEN, child, { periodEnd: "2027-05-31" });
    expect(grandchild).toMatchObject({ status: "EDITED", changedFields: ["periodEnd"] });
    const rows = await count("policy_drafts");
    for (const [fields, reason] of [
      [{ allowedCategories: ["robot_kits_parts", "alcohol"] }, "PROHIBITED_CATEGORY"], [{ periodEnd: "2026-01-01" }, "DATE_ORDER"], [{ caps: { supplies: 0 } }, "MONEY_INVALID"], [{ caps: { supplies: 25000 } }, "NO_CHANGE"],
      [{ programs: ["chess"] }, "PROGRAM_UNKNOWN"], [{ unknownField: 1 }, "SHAPE"],
    ] as [unknown, string][]) expect(await editDraft(ctx.db, BEN, child, fields), JSON.stringify(fields)).toMatchObject({ status: "INVALID_EDIT", reason });
    expect(await count("policy_drafts")).toBe(rows);
  });
  it("cannot edit a refused, withdrawn, bound or stale draft", async () => {
    const refusedAnswer = goodAnswer(); refusedAnswer.breadth = 9;
    const refused = (await draftOf(TARA, refusedAnswer)).result as { draftId: string };
    expect(await editDraft(ctx.db, TARA, refused.draftId, { summary: "x" })).toEqual({ status: "REFUSED", reason: "NOT_DRAFTED" });
    const withdrawn = await draftId(TARA); await withdrawDraft(ctx.db, TARA, withdrawn);
    expect(await editDraft(ctx.db, TARA, withdrawn, { summary: "x" })).toEqual({ status: "REFUSED", reason: "WITHDRAWN" });
    const stale = await draftId(TARA, otherAnswer()); const bound = await draftId(TARA);
    await bindDraft(bound);
    expect(await editDraft(ctx.db, TARA, bound, { summary: "x" })).toEqual({ status: "REFUSED", reason: "BOUND" });
    expect(await editDraft(ctx.db, TARA, stale, { summary: "x" })).toEqual({ status: "REFUSED", reason: "STALE_BASE" });
  });
});

describe("DR-27 withdraw", () => {
  it("lets any approver of the organization withdraw an open draft, including one with a first approval, and then no approval counts", async () => {
    const id = await draftId(TARA);
    await approveDraft(ctx.db, TARA, id);
    expect(await withdrawDraft(ctx.db, BEN, id)).toEqual({ status: "WITHDRAWN" });
    expect(await approveDraft(ctx.db, BEN, id)).toEqual({ status: "REFUSED", reason: "WITHDRAWN" });
    expect(await withdrawDraft(ctx.db, BEN, id)).toEqual({ status: "REFUSED", reason: "WITHDRAWN" });
    expect(await currentVersion()).toBe(1); expect((await readDraft(ctx.db, TARA, id))).toMatchObject({ status: "OK", view: { state: "WITHDRAWN" } });
  });
  it("cannot withdraw a refused or a bound draft, and a stale draft can still be withdrawn", async () => {
    const refusedAnswer = goodAnswer(); refusedAnswer.breadth = 9;
    const refused = (await draftOf(TARA, refusedAnswer)).result as { draftId: string };
    expect(await withdrawDraft(ctx.db, TARA, refused.draftId)).toEqual({ status: "REFUSED", reason: "NOT_DRAFTED" });
    const stale = await draftId(TARA, otherAnswer()); const bound = await draftId(TARA);
    await bindDraft(bound);
    expect(await withdrawDraft(ctx.db, TARA, bound)).toEqual({ status: "REFUSED", reason: "BOUND" });
    expect(await withdrawDraft(ctx.db, BEN, stale)).toEqual({ status: "WITHDRAWN" });
  });
});

describe("DR-28 a stale base is refused at every step", () => {
  it("refuses the first and the second approval of a draft whose base version moved, and reads it as STALE", async () => {
    const a = await draftId(TARA), b = await draftId(BEN, otherAnswer());
    expect(await approveDraft(ctx.db, TARA, a)).toMatchObject({ status: "APPROVED" });
    expect((await bindDraft(b)).two).toMatchObject({ status: "BOUND", policyVersion: 2 });
    const rows = await hashes();
    expect(await approveDraft(ctx.db, BEN, a)).toEqual({ status: "REFUSED", reason: "STALE_BASE" });
    const c = await draftId(BEN, goodAnswer()).catch(error => String(error)); // a new draft on version 2 is fine
    expect(typeof c === "string" && c.startsWith("Error")).toBe(false);
    expect((await readDraft(ctx.db, TARA, a))).toMatchObject({ status: "OK", view: { state: "STALE", basePolicyVersion: 1, currentPolicyVersion: 2 } });
    const after = await hashes();
    for (const table of ["funds", "fund_policy_versions", "fund_budget_lines", "fund_check_settings", "fund_policy_clauses", "policy_draft_events"]) expect(after[table], table).toEqual(rows[table]);
  });
  it("refuses a draft whose base moves while the model request is running, and stores nothing for it", async () => {
    const other = await draftId(BEN, otherAnswer());
    const stub = stubClient(async () => { await bindDraft(other); return draftMessage(goodAnswer()); });
    const before = await count("policy_drafts");
    expect(await createDraft(ctx.db, TARA, FUND, AGREEMENT, deps(stub.client))).toEqual({ status: "REFUSED", reason: "STALE_BASE" });
    expect(await count("policy_drafts")).toBe(before); expect(await currentVersion()).toBe(2);
  });
  it("the database refuses a draft against an old base, an approval of a stale draft and a binding of a stale one, even without the service", async () => {
    const a = await draftId(TARA), b = await draftId(BEN, otherAnswer());
    await bindDraft(b);
    const valid = validateDraft(goodAnswer(), GRANT, "MODEL"); if (!valid.ok) throw new Error("fixture");
    const row = { fundId: FUND, basePolicyVersion: 1, inputSha256: sha256(AGREEMENT), inputText: AGREEMENT, outcome: "DRAFTED" as const, draft: valid.draft, model: "claude-sonnet-5-5", effort: "medium", promptVersion: "p", schemaVersion: "s", requestDigest: "a".repeat(64), draftedBy: "tara" };
    expect(await stateOf(() => ctx.db.insert(s.policyDrafts).values(row))).toBe("23514");
    expect(await stateOf(() => ctx.db.insert(s.policyDraftEvents).values({ draftId: a, kind: "APPROVED", actorId: "ben" }))).toBe("23514");
    expect(await stateOf(() => ctx.db.insert(s.policyDraftEvents).values({ draftId: a, kind: "BOUND", actorId: "ben", boundPolicyVersion: 2 }))).toBe("23514");
  });
});

describe("DR-29 a failure in the middle of a bind leaves no partial row", () => {
  const forceFailure = async (table: string, when = "true") => {
    await ctx.client.unsafe(`create function zz_force_failure() returns trigger language plpgsql as $$ begin raise exception 'forced failure for the test' using errcode = 'P0001'; end; $$`);
    await ctx.client.unsafe(`create trigger zz_force_failure before insert on ${table} for each row when (${when}) execute function zz_force_failure()`);
  };
  const clearFailure = async (table: string) => { await ctx.client.unsafe(`drop trigger zz_force_failure on ${table}`); await ctx.client.unsafe("drop function zz_force_failure()"); };

  it("rolls back the version, budget lines, settings, pointer and even the second approval when the clause insert fails, then binds cleanly on retry", async () => {
    const id = await draftId(TARA, answerWithThresholds());
    expect(await approveDraft(ctx.db, TARA, id)).toMatchObject({ status: "APPROVED" });
    const baseline = await hashes();
    await forceFailure("fund_policy_clauses");
    await expect(approveDraft(ctx.db, BEN, id)).rejects.toThrow();
    expect(await hashes()).toEqual(baseline);
    expect(await currentVersion()).toBe(1); expect(await count("fund_policy_versions", `fund_id = '${FUND}' and version = 2`)).toBe(0);
    expect(await count("policy_draft_events", `draft_id = '${id}'`)).toBe(1);
    await clearFailure("fund_policy_clauses");
    expect(await approveDraft(ctx.db, BEN, id)).toEqual({ status: "BOUND", approvals: 2, policyVersion: 2, priorityVersion: null, invalidatedDecisions: 0 });
    expect(await count("fund_policy_clauses", `fund_id = '${FUND}' and policy_version = 2`)).toBe(4); expect(await count("fund_check_settings", `fund_id = '${FUND}'`)).toBe(2);
  });
  it("rolls back every earlier row when the very last write, the BOUND event, fails", async () => {
    const id = await draftId(TARA, answerWithThresholds());
    await approveDraft(ctx.db, TARA, id);
    const baseline = await hashes();
    await forceFailure("policy_draft_events", "new.kind = 'BOUND'");
    await expect(approveDraft(ctx.db, BEN, id)).rejects.toThrow();
    expect(await hashes()).toEqual(baseline);
    expect(await currentVersion()).toBe(1);
  });
  it("rolls back when the budget line insert fails, the first write after the version", async () => {
    const id = await draftId(TARA); await approveDraft(ctx.db, TARA, id);
    const baseline = await hashes();
    await forceFailure("fund_budget_lines");
    await expect(approveDraft(ctx.db, BEN, id)).rejects.toThrow();
    expect(await hashes()).toEqual(baseline);
  });
  it("a database guard refusing a write inside the bind rolls back whole and reports GUARD_REFUSED without database text", async () => {
    const id = await draftId(TARA, answerWithThresholds()); await approveDraft(ctx.db, TARA, id);
    const baseline = await hashes();
    // A test-only trigger raises the guard's own error class (23514) on the clause insert, the way an existing guard would.
    await ctx.client.unsafe(`create function zz_force_guard() returns trigger language plpgsql as $$ begin raise exception 'forced guard refusal' using errcode = '23514'; end; $$`);
    await ctx.client.unsafe("create trigger zz_force_guard before insert on fund_policy_clauses for each row execute function zz_force_guard()");
    const refused = await approveDraft(ctx.db, BEN, id);
    expect(refused).toEqual({ status: "REFUSED", reason: "GUARD_REFUSED" });
    expect(JSON.stringify(refused)).not.toMatch(/forced|23514|zz_force/);
    expect(await hashes()).toEqual(baseline);
    await ctx.client.unsafe("drop trigger zz_force_guard on fund_policy_clauses"); await ctx.client.unsafe("drop function zz_force_guard()");
    expect(await approveDraft(ctx.db, BEN, id)).toEqual({ status: "BOUND", approvals: 2, policyVersion: 2, priorityVersion: null, invalidatedDecisions: 0 });
  });
  it("an approver demoted between the first and second approval is refused by the service and nothing is written", async () => {
    const id = await draftId(TARA); await approveDraft(ctx.db, TARA, id);
    const baseline = await hashes();
    await ctx.client.unsafe("update users set role = 'CLAIMANT' where id = 'ben'");
    expect(await approveDraft(ctx.db, BEN, id)).toEqual({ status: "REFUSED", reason: "APPROVER_REQUIRED" });
    expect(await hashes()).toEqual(baseline);
  });
});

describe("DR-30 the database is a second barrier behind the service", () => {
  const draftRow = async (over: Partial<typeof s.policyDrafts.$inferInsert> = {}) => {
    const valid = validateDraft(goodAnswer(), GRANT, "MODEL"); if (!valid.ok) throw new Error("fixture");
    return { fundId: FUND, basePolicyVersion: 1, inputSha256: sha256(AGREEMENT), inputText: AGREEMENT, outcome: "DRAFTED" as const, draft: valid.draft, model: "claude-sonnet-5-5", effort: "medium", promptVersion: "p", schemaVersion: "s", requestDigest: "a".repeat(64), draftedBy: "tara", ...over };
  };
  it("refuses a draft row by a claimant, by an approver of another organization, on an unrestricted fund, with a wrong hash, blank or oversize text, or the wrong shape", async () => {
    await addOtherOrganization();
    const insert = (over: Partial<typeof s.policyDrafts.$inferInsert>) => stateOf(async () => ctx.db.insert(s.policyDrafts).values(await draftRow(over)));
    expect(await insert({})).toBe("OK");
    expect(await insert({ draftedBy: "maria" })).toBe("23514");
    expect(await insert({ draftedBy: "olga" })).toBe("23514");
    expect(await insert({ fundId: "fund_g" })).toBe("23514");
    expect(await insert({ inputSha256: "0".repeat(64) })).toBe("23514");
    expect(await insert({ inputText: "x".repeat(20_001), inputSha256: sha256("x".repeat(20_001)) })).toBe("23514");
    expect(await insert({ inputText: " \n ", inputSha256: sha256(" \n ") })).toBe("23514");
    expect(await insert({ draft: null })).toBe("23514");
    expect(await insert({ outcome: "REFUSED", refusalReason: "X1", refusalPath: "draft" })).toBe("23514");
    expect(await insert({ outcome: "BOUND" as never })).toBe("23514");
    expect(await insert({ requestDigest: "not-a-digest" })).toBe("23514");
    expect(await insert({ parentDraftId: "00000000-0000-4000-8000-000000000000", changedFields: ["x"], model: null, effort: null, promptVersion: null, schemaVersion: null, requestDigest: null })).toBe("23514"); // the guard refuses a missing parent before the foreign key is checked
  });
  it("refuses an event by a claimant, by another organization's approver, on a refused draft, after a withdrawal, a duplicate approval, or a binding that skips a rule", async () => {
    await addOtherOrganization();
    const id = await draftId(TARA);
    const refusedAnswer = goodAnswer(); refusedAnswer.breadth = 9;
    const refused = (await draftOf(TARA, refusedAnswer)).result as { draftId: string };
    const add = (draftId: string, kind: "APPROVED" | "BOUND" | "WITHDRAWN", actorId: string, boundPolicyVersion: number | null = null) => stateOf(() => ctx.db.insert(s.policyDraftEvents).values({ draftId, kind, actorId, boundPolicyVersion }));
    expect(await add(id, "APPROVED", "maria")).toBe("23514");
    expect(await add(id, "APPROVED", "olga")).toBe("23514");
    expect(await add(refused.draftId, "APPROVED", "tara")).toBe("23514");
    expect(await add(id, "REJECTED" as never, "tara")).toBe("23514");
    expect(await add(id, "APPROVED", "tara", 2)).toBe("23514");
    expect(await add(id, "BOUND", "tara", null)).toBe("23514");
    expect(await add(id, "BOUND", "tara", 2)).toBe("23514");
    expect(await add(id, "APPROVED", "tara")).toBe("OK");
    expect(await add(id, "APPROVED", "tara")).toBe("23505");
    expect(await add(id, "BOUND", "tara", 2)).toBe("23514");
    expect(await add(id, "APPROVED", "ben")).toBe("OK");
    // Two distinct approvals exist, but no version row exists for the pointer: the binding is refused.
    expect(await add(id, "BOUND", "ben", 2)).toBe("23514");
    expect(await add(id, "WITHDRAWN", "ben")).toBe("OK");
    expect(await add(id, "APPROVED", "ben")).toBe("23514");
    expect(await add(id, "WITHDRAWN", "tara")).toBe("23514");
    expect(await currentVersion()).toBe(1);
  });
  it("refuses a BOUND event by an approver who did not approve, and one for a version that is not base plus one", async () => {
    const id = await draftId(TARA);
    await approveDraft(ctx.db, TARA, id); await approveDraft(ctx.db, BEN, id);
    expect(await currentVersion()).toBe(2);
    // The draft is bound by the service. A second BOUND event is refused because a bound draft takes no more events.
    expect(await stateOf(() => ctx.db.insert(s.policyDraftEvents).values({ draftId: id, kind: "BOUND", actorId: "ben", boundPolicyVersion: 2 }))).toBe("23514");
  });
});

describe("DR-31 the bind and the guards do not weaken any existing guard", () => {
  it("the existing policy tables still refuse direct changes after a bind: versions are immutable and settings must be in order", async () => {
    const id = await draftId(TARA, answerWithThresholds()); await bindDraft(id);
    expect(await stateOf(() => ctx.db.update(s.fundPolicyVersions).set({ summary: "changed" }).where(eq(s.fundPolicyVersions.fundId, FUND)))).toBe("23514");
    expect(await stateOf(() => ctx.db.delete(s.fundPolicyVersions).where(eq(s.fundPolicyVersions.fundId, FUND)))).toBe("23514");
    expect(await stateOf(() => ctx.db.insert(s.fundCheckSettings).values({ fundId: FUND, version: 5, approvedBy: "tara", suppliesLimitCents: 1n, equipmentLimitCents: 1n, claimLimitCents: 1n, staleReceiptDays: 1, duplicateWindowDays: 1, splitWindowDays: 1 }))).toBe("23514");
    expect(await stateOf(() => ctx.db.insert(s.fundCheckSettings).values({ fundId: FUND, version: 3, approvedBy: "maria", suppliesLimitCents: 1n, equipmentLimitCents: 1n, claimLimitCents: 1n, staleReceiptDays: 1, duplicateWindowDays: 1, splitWindowDays: 1 }))).toBe("23514");
    expect(await stateOf(() => ctx.db.insert(s.fundPolicyClauses).values({ fundId: FUND, policyVersion: 9, clauseId: "1.1", text: "x" }))).toBe("23514"); // the existing clause guard: the version must exist
  });
});

describe("DR-32 a bound version reaches allocation only for claims prepared after it", () => {
  const edgesOf = (decisionId: string) => ctx.db.select().from(s.allocationEdges).where(eq(s.allocationEdges.decisionId, decisionId));
  it("keeps version N in the edges of a claim frozen before the bind, invalidates its approval, and allocates a claim prepared after the bind under N+1", async () => {
    const early = await receiptClaim(ctx.db, { vendor: "Early shop" });
    const early1 = await edgesOf(early.decisionId);
    expect(early1.length).toBeGreaterThan(0); for (const edge of early1) expect(edge.policyVersion).toBe(1);
    expect(early1.some(edge => edge.fundId === FUND)).toBe(true);
    const frozen = await tableHash(ctx.client, "allocation_edges");

    const id = await draftId(TARA);
    expect((await bindDraft(id)).two).toMatchObject({ status: "BOUND", policyVersion: 2 });
    // The frozen edges are immutable rows: the bind changed none of them.
    expect((await edgesOf(early.decisionId))).toEqual(early1); expect(await tableHash(ctx.client, "allocation_edges")).toEqual(frozen);

    // An approval of the early claim now meets a changed policy. The existing ledger check invalidates it rather than recognizing it under a policy it was not frozen against.
    const approval = await approveDecision(ctx.db, early.decisionId, "tara", early.hash);
    expect(approval).toMatchObject({ status: "INVALIDATED" });
    for (const edge of await edgesOf(early.decisionId)) expect(edge.policyVersion).toBe(1);

    const late = await receiptClaim(ctx.db, { vendor: "Late shop", lines: [
      { description: "Robot servo kit late", amount: "150.00", category: "robot_kits_parts" }, { description: "Classroom markers late", amount: "100.00", category: "classroom_supplies" }, { description: "Pizza party late", amount: "50.00", category: "participant_meals" },
    ] });
    const lateEdges = await edgesOf(late.decisionId);
    const lateFundA = lateEdges.filter(edge => edge.fundId === FUND);
    expect(lateFundA.length).toBeGreaterThan(0); for (const edge of lateFundA) expect(edge.policyVersion).toBe(2);
    for (const edge of lateEdges.filter(edge => edge.fundId !== FUND)) expect(edge.policyVersion).toBe(1);
  });
  it("a claim that was invalidated by the bind allocates under N+1 when it is frozen again", async () => {
    const early = await receiptClaim(ctx.db, { vendor: "Early shop" });
    await bindDraft(await draftId(TARA));
    expect(await approveDecision(ctx.db, early.decisionId, "tara", early.hash)).toMatchObject({ status: "INVALIDATED" });
    const again = await freezeDecision(ctx.db, early.id, "maria");
    expect(again.status).toBe("AWAITING_APPROVAL"); if (again.status !== "AWAITING_APPROVAL") return;
    expect(again.decisionId).not.toBe(early.decisionId);
    const fundA = (await edgesOf(again.decisionId)).filter(edge => edge.fundId === FUND);
    expect(fundA.length).toBeGreaterThan(0); for (const edge of fundA) expect(edge.policyVersion).toBe(2);
  });
});

describe("DR-33 the draft workflow never touches money, claims, approvals of claims or the solver", () => {
  it("leaves all twenty-three financial tables and the solver priority byte-identical through draft, edit, approve, bind, withdraw and every refusal", async () => {
    await receiptClaim(ctx.db, { vendor: "Baseline shop" });
    const financial = await financialHash(ctx.client); const solver = await tableHash(ctx.client, "solver_priority_versions"); const claims = await tableHash(ctx.client, "claims");
    const a = await draftId(TARA); const b = await draftId(BEN, otherAnswer());
    await editDraft(ctx.db, TARA, a, { caps: { supplies: 26000 } });
    await approveDraft(ctx.db, MARIA, a); await withdrawDraft(ctx.db, BEN, b);
    await bindDraft(a); await approveDraft(ctx.db, TARA, b);
    expect(await financialHash(ctx.client)).toBe(financial);
    expect(await tableHash(ctx.client, "solver_priority_versions")).toEqual(solver); expect(await tableHash(ctx.client, "claims")).toEqual(claims);
  });
});

describe("DR-34 readDraft derives the state from events and refuses a claimant", () => {
  it("reads OPEN, then a first approval, then BOUND with the bound version, and REFUSED for a refused answer", async () => {
    const id = await draftId(TARA);
    const state = async () => { const read = await readDraft(ctx.db, BEN, id); return read.status === "OK" ? read.view : null; };
    expect(await state()).toMatchObject({ state: "OPEN", approvals: [] });
    await approveDraft(ctx.db, TARA, id);
    expect(await state()).toMatchObject({ state: "OPEN", approvals: [{ actorId: "tara" }] });
    await approveDraft(ctx.db, BEN, id);
    expect(await state()).toMatchObject({ state: "BOUND", boundPolicyVersion: 2, approvals: [{ actorId: expect.any(String) }, { actorId: expect.any(String) }] });
    const refusedAnswer = goodAnswer(); refusedAnswer.breadth = 9;
    const refused = (await draftOf(BEN, refusedAnswer)).result as { draftId: string };
    expect((await readDraft(ctx.db, BEN, refused.draftId))).toMatchObject({ status: "OK", view: { state: "REFUSED" } });
    expect(await readDraft(ctx.db, BEN, "not-a-uuid")).toEqual({ status: "REFUSED", reason: "INVALID_REQUEST" });
    expect(await readDraft(ctx.db, BEN, "00000000-0000-4000-8000-000000000000")).toEqual({ status: "REFUSED", reason: "NOT_FOUND" });
  });
});

describe("DR-35 concurrent approvals bind exactly once", () => {
  it("two approvers approving at the same moment give one first approval and one binding, never two versions", async () => {
    const id = await draftId(TARA);
    const results = await Promise.all([approveDraft(ctx.db, TARA, id), approveDraft(ctx.db, BEN, id)]);
    expect(results.map(result => result.status).sort()).toEqual(["APPROVED", "BOUND"]);
    expect(await currentVersion()).toBe(2); expect(await count("fund_policy_versions", `fund_id = '${FUND}'`)).toBe(2); expect(await count("policy_draft_events", "kind = 'BOUND'")).toBe(1);
  });
  it("two drafts of one base racing to bind: one wins, the other is stale, and the pointer moves once", async () => {
    const a = await draftId(TARA), b = await draftId(BEN, otherAnswer());
    const results = await Promise.all([approveDraft(ctx.db, TARA, a), approveDraft(ctx.db, BEN, a), approveDraft(ctx.db, TARA, b), approveDraft(ctx.db, BEN, b)]);
    expect(results.filter(result => result.status === "BOUND")).toHaveLength(1);
    expect(await currentVersion()).toBe(2); expect(await count("fund_policy_versions", `fund_id = '${FUND}'`)).toBe(2); expect(await count("policy_draft_events", "kind = 'BOUND'")).toBe(1);
    for (const result of results) if (result.status === "REFUSED") expect(["STALE_BASE", "SAME_APPROVER"]).toContain(result.reason);
  });
});

describe("DR-36 a draft is re-checked against the catalogs as they are at approval", () => {
  it("refuses an approval when the organization has since prohibited a category the draft allows", async () => {
    const id = await draftId(TARA);
    await ctx.db.update(s.organizations).set({ prohibitedCategories: ["alcohol", "gift_cards", "classroom_supplies"] }).where(eq(s.organizations.id, "cedar-hollow"));
    expect(await approveDraft(ctx.db, TARA, id)).toEqual({ status: "REFUSED", reason: "DRAFT_INVALID", detail: "PROHIBITED_CATEGORY" });
    expect(await count("policy_draft_events")).toBe(0);
  });
});

// IAC-440 Package A, November 1 fixes (DR-51 to DR-60). Real Postgres, stubbed model.
const ORG = "cedar-hollow";
const THREE = ["robot_kits_parts", "classroom_supplies", "books"];
const breadthAnswer = (categories: string[]) => { const answer = goodAnswer(); answer.allowedCategories.value = categories; answer.breadth = categories.length; return answer; };
const priorities = () => ctx.db.select().from(s.solverPriorityVersions).where(eq(s.solverPriorityVersions.organizationId, ORG)).orderBy(asc(s.solverPriorityVersions.version));
// The pay order the existing v1 formula gives for the funds at their current approved versions, read from the rows, never copied from the code under test.
async function formulaCosts() {
  const funds = await ctx.db.select().from(s.funds).where(eq(s.funds.organizationId, ORG));
  const policies = await ctx.db.select().from(s.fundPolicyVersions);
  const costs = priorityCostsFor(funds.map(fund => ({ id: fund.id, fundClass: fund.fundClass, policy: { breadth: policies.find(policy => policy.fundId === fund.id && policy.version === fund.currentPolicyVersion)!.breadth } })));
  return Object.fromEntries([...costs].map(([id, cost]) => [id, cost.toString()]));
}
const decisionRow = async (decisionId: string) => (await ctx.db.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.id, decisionId)))[0]!;
const reservationStatuses = async (decisionId: string) => (await ctx.db.select({ status: s.fundReservations.status }).from(s.fundReservations).where(eq(s.fundReservations.decisionId, decisionId))).map(row => row.status);
const claimStatus = async (claimId: string) => String((await ctx.client.unsafe(`select status from claims where id = '${claimId}' order by version desc limit 1`))[0]!.status);
const liveDecisions = async () => Number((await ctx.client.unsafe("select count(*)::int as n from allocation_decisions where invalidated_at is null and recognized_at is null"))[0]!.n);
const edgesOfDecision = (decisionId: string) => ctx.db.select().from(s.allocationEdges).where(eq(s.allocationEdges.decisionId, decisionId));
// A claim frozen with the first of its two approvals recorded: not fully approved.
async function halfApprovedClaim(vendor = "Early shop") {
  const claim = await receiptClaim(ctx.db, { vendor });
  expect(await approveDecision(ctx.db, claim.decisionId, "tara", claim.hash)).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
  return claim;
}

describe("DR-51 malformed text is refused with a name, from the model and from the approver", () => {
  it("a lone surrogate in the model answer stores a REFUSED row named MALFORMED_TEXT with a clean path, and nothing becomes a draft", async () => {
    const answer = goodAnswer(); answer.summary = "Pays robot kits \ud800";
    const { result, calls } = await draftOf(TARA, answer);
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ status: "DRAFT_REFUSED", reason: "MALFORMED_TEXT", path: "draft.summary" });
    const [row] = await ctx.db.select().from(s.policyDrafts).where(eq(s.policyDrafts.id, (result as { draftId: string }).draftId));
    expect(row).toMatchObject({ outcome: "REFUSED", draft: null, refusalReason: "MALFORMED_TEXT", refusalPath: "draft.summary" });
    expect(await count("policy_drafts", "outcome = 'DRAFTED'")).toBe(0);
  });
  it("a lone surrogate that is a UTF-16 substring of astral pasted text is refused as a clause, and an object key never reaches the stored path", async () => {
    const text = `${AGREEMENT}\nSection 8. Puzzle \u{1F9E9} kits.`;
    const clause = goodAnswer(); clause.clauses.push({ id: "1.9", text: "\ud83e" });
    expect((await draftOf(TARA, clause, { text })).result).toMatchObject({ status: "DRAFT_REFUSED", reason: "MALFORMED_TEXT", path: "draft.clauses.3.text" });
    const key = goodAnswer(); key["bad key \ud800"] = 1;
    // The flat wire (DR-71, DR-72) refuses a key outside the expected set before the validator sees it: a stored SHAPE refusal at "response", so the key never reaches a path.
    const refused = (await draftOf(TARA, key)).result;
    expect(refused).toMatchObject({ status: "DRAFT_REFUSED", reason: "SHAPE", path: "response" });
    expect(await count("policy_drafts", "outcome = 'DRAFTED'")).toBe(0);
    // The validator itself still names a malformed key and keeps the path clean when it is handed one directly.
    const direct = validateDraft(key, GRANT, "MODEL");
    expect(direct).toMatchObject({ ok: false, reason: "MALFORMED_TEXT" });
    expect((direct as { path: string }).path.replace(/[^A-Za-z0-9_.]/g, "_").slice(0, 80)).toMatch(/^[A-Za-z0-9_.]{1,80}$/);
  });
  it("approver text with a lone surrogate is refused as MALFORMED_TEXT before any model request, a claimant still learns only APPROVER_REQUIRED, and blank or NUL text stays INVALID_REQUEST", async () => {
    const stub = stubFor(goodAnswer()); const before = await hashes();
    for (const text of ["\ud800", `${AGREEMENT}\udc00`, "x\ud83e"]) {
      expect(await createDraft(ctx.db, TARA, FUND, text, deps(stub.client)), JSON.stringify(text)).toEqual({ status: "REFUSED", reason: "MALFORMED_TEXT" });
      expect(await createDraft(ctx.db, MARIA, FUND, text, deps(stub.client)), JSON.stringify(text)).toEqual({ status: "REFUSED", reason: "APPROVER_REQUIRED" });
    }
    for (const text of ["", "  ", "nul\u0000"]) expect(await createDraft(ctx.db, TARA, FUND, text, deps(stub.client))).toEqual({ status: "REFUSED", reason: "INVALID_REQUEST" });
    expect(stub.calls).toHaveLength(0); expect(await hashes()).toEqual(before);
    // A whole astral character is well formed and reaches the model.
    expect((await createDraft(ctx.db, TARA, FUND, `${AGREEMENT}\nPuzzle \u{1F9E9} kits.`, deps(stub.client))).status).toBe("DRAFTED"); expect(stub.calls).toHaveLength(1);
  });
});

describe("DR-52 a value its quote does not state is stored as missing, never bound, and a person fills it", () => {
  it("stores the draft incomplete with the path in quoteUnsupported, refuses its approval as INCOMPLETE, and binds only after an edit fills the value", async () => {
    const answer = goodAnswer(); answer.caps.supplies = { ...answer.caps.supplies, value: 50000 };
    const { result } = await draftOf(TARA, answer);
    expect(result).toMatchObject({ status: "DRAFTED", complete: false, missing: ["caps.supplies"], quoteUnsupported: ["caps.supplies"] });
    const id = (result as { draftId: string }).draftId;
    const read = await readDraft(ctx.db, TARA, id);
    expect(read.status === "OK" && read.view.analysis).toMatchObject({ complete: false, quoteUnsupported: ["caps.supplies"] });
    expect(read.status === "OK" && read.view.draft!.caps.supplies).toEqual({ status: "UNSURE", value: null, clauseId: null, quote: null });
    expect(await approveDraft(ctx.db, TARA, id)).toEqual({ status: "REFUSED", reason: "INCOMPLETE", missing: ["caps.supplies"] });
    expect(await count("policy_draft_events")).toBe(0);
    // An edit that touches another field keeps the downgrade on record. An edit that fills the value clears it and the draft binds.
    const other = await editDraft(ctx.db, TARA, id, { summary: "Pays robot kits and classroom supplies only." });
    expect(other).toMatchObject({ status: "EDITED", complete: false, quoteUnsupported: ["caps.supplies"] });
    const filled = await editDraft(ctx.db, BEN, id, { caps: { supplies: 30000 } });
    expect(filled).toMatchObject({ status: "EDITED", complete: true, missing: [], quoteUnsupported: [] });
    expect((await bindDraft((filled as { draftId: string }).draftId)).two).toMatchObject({ status: "BOUND", policyVersion: 2 });
    expect((await ctx.db.select().from(s.fundBudgetLines).where(and(eq(s.fundBudgetLines.fundId, FUND), eq(s.fundBudgetLines.policyVersion, 2))))[0]).toMatchObject({ capCents: 30000n });
  });
  it("a downgraded threshold binds as the carried previous value, and a supported one binds as drafted", async () => {
    const answer = answerWithThresholds(); answer.thresholds.claimLimitCents = { ...answer.thresholds.claimLimitCents, value: 130000 };
    const { result } = await draftOf(TARA, answer);
    expect(result).toMatchObject({ status: "DRAFTED", complete: true, quoteUnsupported: ["thresholds.claimLimitCents"] });
    expect((await bindDraft((result as { draftId: string }).draftId)).two).toMatchObject({ status: "BOUND" });
    expect((await ctx.db.select().from(s.fundCheckSettings).where(eq(s.fundCheckSettings.fundId, FUND)))).toHaveLength(1);
    const supported = await draftId(TARA, answerWithThresholds());
    expect((await bindDraft(supported)).two).toMatchObject({ status: "BOUND", policyVersion: 3 });
    expect((await ctx.db.select().from(s.fundCheckSettings).where(and(eq(s.fundCheckSettings.fundId, FUND), eq(s.fundCheckSettings.version, 2))))[0]).toMatchObject({ claimLimitCents: 120000n });
  });
});

describe("DR-53 a bind that changes a restricted fund's breadth re-applies the pay order in the same step", () => {
  it("adding a category writes priority N+1 signed by the binding approver with the formula costs, and BOUND reports it", async () => {
    expect((await priorities()).map(row => row.version)).toEqual([1]);
    expect((await priorities())[0]!.costsPerCent).toEqual({ fund_a: "2000", fund_b: "1001", fund_g: "1000000" });
    const id = await draftId(TARA, breadthAnswer(THREE));
    const { two } = await bindDraft(id, TARA, BEN);
    expect(two).toEqual({ status: "BOUND", approvals: 2, policyVersion: 2, priorityVersion: 2, invalidatedDecisions: 0 });
    const rows = await priorities();
    expect(rows.map(row => row.version)).toEqual([1, 2]);
    expect(rows[1]).toMatchObject({ organizationId: ORG, approvedBy: "ben", costsPerCent: await formulaCosts() });
    expect(rows[1]!.costsPerCent).toEqual({ fund_a: "3000", fund_b: "1001", fund_g: "1000000" });
    expect(rows[0]).toMatchObject({ version: 1, costsPerCent: { fund_a: "2000", fund_b: "1001", fund_g: "1000000" } });
    expect((await ctx.db.select().from(s.fundPolicyVersions).where(and(eq(s.fundPolicyVersions.fundId, FUND), eq(s.fundPolicyVersions.version, 2))))[0]).toMatchObject({ approvedBy: "ben", breadth: 3 });
    expect(await count("policy_draft_events", `draft_id = '${id}' and kind = 'BOUND'`)).toBe(1);
  });
  it("removing a category does the same, and the priority row is signed by whoever binds, not by the drafter", async () => {
    const id = await draftId(TARA, breadthAnswer(["robot_kits_parts"]));
    const { two } = await bindDraft(id, BEN, TARA);
    expect(two).toEqual({ status: "BOUND", approvals: 2, policyVersion: 2, priorityVersion: 2, invalidatedDecisions: 0 });
    const rows = await priorities();
    expect(rows[1]).toMatchObject({ version: 2, approvedBy: "tara", costsPerCent: await formulaCosts() });
    expect(rows[1]!.costsPerCent).toEqual({ fund_a: "1000", fund_b: "1001", fund_g: "1000000" });
  });
  it("two breadth changes in a row write versions 2 and 3, each matching the formula at that moment", async () => {
    await bindDraft(await draftId(TARA, breadthAnswer(THREE)));
    const second = await draftId(BEN, breadthAnswer(["robot_kits_parts"]));
    expect((await bindDraft(second, BEN, TARA)).two).toEqual({ status: "BOUND", approvals: 2, policyVersion: 3, priorityVersion: 3, invalidatedDecisions: 0 });
    const rows = await priorities();
    expect(rows.map(row => row.version)).toEqual([1, 2, 3]);
    expect(rows[2]).toMatchObject({ approvedBy: "tara", costsPerCent: await formulaCosts() });
  });
});

describe("DR-54 frozen decisions that are not fully approved go back to draft, decided and recognized ones stay", () => {
  it("a decision with one approval is invalidated by the bind: claim DRAFT, reservations RELEASED, and its next approval is refused", async () => {
    const early = await halfApprovedClaim();
    expect(await liveDecisions()).toBe(1);
    expect((await reservationStatuses(early.decisionId)).length).toBeGreaterThan(0);
    const { two } = await bindDraft(await draftId(TARA, breadthAnswer(THREE)));
    expect(two).toEqual({ status: "BOUND", approvals: 2, policyVersion: 2, priorityVersion: 2, invalidatedDecisions: 1 });
    expect((await decisionRow(early.decisionId)).invalidatedAt).not.toBeNull();
    expect(await claimStatus(early.id)).toBe("DRAFT");
    for (const status of await reservationStatuses(early.decisionId)) expect(status).toBe("RELEASED");
    expect(await liveDecisions()).toBe(0);
    // The existing ledger refuses an approval of an invalidated decision with a thrown error, not an INVALIDATED result. That is unchanged by this fix.
    await expect(approveDecision(ctx.db, early.decisionId, "ben", early.hash)).rejects.toThrow("Decision is invalidated");
  });
  it("the invalidated claim is decided again under policy N+1 and priority N+1 and needs both approvals again", async () => {
    const early = await halfApprovedClaim();
    await bindDraft(await draftId(TARA, breadthAnswer(THREE)));
    const again = await freezeDecision(ctx.db, early.id, "maria");
    expect(again.status).toBe("AWAITING_APPROVAL"); if (again.status !== "AWAITING_APPROVAL") return;
    expect(again.decisionId).not.toBe(early.decisionId); expect(again.decisionHash).not.toBe(early.hash);
    const edges = await edgesOfDecision(again.decisionId);
    for (const edge of edges) expect(edge.solverPriorityVersion).toBe(2);
    const fundA = edges.filter(edge => edge.fundId === FUND);
    expect(fundA.length).toBeGreaterThan(0); for (const edge of fundA) expect(edge.policyVersion).toBe(2);
    // The first approval was on the old decision hash and does not count.
    expect(await approveDecision(ctx.db, again.decisionId, "tara", again.decisionHash)).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    expect(await approveDecision(ctx.db, again.decisionId, "ben", again.decisionHash)).toMatchObject({ status: "APPROVED", approvalCount: 2 });
  });
  it("a bind that keeps the breadth leaves the pay order, so a half approved decision returns INVALIDATED at its next approval and is re-decided under N+1", async () => {
    const early = await halfApprovedClaim();
    expect((await bindDraft(await draftId(TARA))).two).toEqual({ status: "BOUND", approvals: 2, policyVersion: 2, priorityVersion: null, invalidatedDecisions: 0 });
    expect((await decisionRow(early.decisionId)).invalidatedAt).toBeNull();
    expect(await approveDecision(ctx.db, early.decisionId, "ben", early.hash)).toMatchObject({ status: "INVALIDATED", approvalCount: 0 });
    expect(await claimStatus(early.id)).toBe("DRAFT");
    for (const status of await reservationStatuses(early.decisionId)) expect(status).toBe("RELEASED");
    const again = await freezeDecision(ctx.db, early.id, "maria");
    expect(again.status).toBe("AWAITING_APPROVAL"); if (again.status !== "AWAITING_APPROVAL") return;
    const edges = await edgesOfDecision(again.decisionId);
    for (const edge of edges) expect(edge.solverPriorityVersion).toBe(1);
    const fundA = edges.filter(edge => edge.fundId === FUND);
    expect(fundA.length).toBeGreaterThan(0); for (const edge of fundA) expect(edge.policyVersion).toBe(2);
  });
  it("a fully approved, recognized decision is untouched: still APPROVED at policy N and priority N, reservations consumed, no financial row changed", async () => {
    const done = await receiptClaim(ctx.db, { vendor: "Done shop" });
    expect(await approveDecision(ctx.db, done.decisionId, "tara", done.hash)).toMatchObject({ status: "AWAITING_APPROVAL" });
    expect(await approveDecision(ctx.db, done.decisionId, "ben", done.hash)).toMatchObject({ status: "APPROVED", approvalCount: 2 });
    const edgesBefore = await edgesOfDecision(done.decisionId); const financial = await financialHash(ctx.client);
    const { two } = await bindDraft(await draftId(TARA, breadthAnswer(THREE)));
    expect(two).toEqual({ status: "BOUND", approvals: 2, policyVersion: 2, priorityVersion: 2, invalidatedDecisions: 0 });
    expect(await financialHash(ctx.client)).toBe(financial);
    const row = await decisionRow(done.decisionId);
    expect(row.recognizedAt).not.toBeNull(); expect(row.invalidatedAt).toBeNull();
    expect(await claimStatus(done.id)).toBe("APPROVED");
    expect(await edgesOfDecision(done.decisionId)).toEqual(edgesBefore);
    for (const edge of edgesBefore) { expect(edge.solverPriorityVersion).toBe(1); expect(edge.policyVersion).toBe(1); }
    for (const status of await reservationStatuses(done.decisionId)) expect(status).toBe("CONSUMED");
  });
  it("a recognized decision and a half approved one together: only the half approved one is invalidated and counted", async () => {
    const done = await receiptClaim(ctx.db, { vendor: "Done shop" });
    await approveDecision(ctx.db, done.decisionId, "tara", done.hash); await approveDecision(ctx.db, done.decisionId, "ben", done.hash);
    const early = await halfApprovedClaim("Early shop");
    const { two } = await bindDraft(await draftId(TARA, breadthAnswer(THREE)));
    expect(two).toMatchObject({ priorityVersion: 2, invalidatedDecisions: 1 });
    expect((await decisionRow(done.decisionId)).invalidatedAt).toBeNull(); expect(await claimStatus(done.id)).toBe("APPROVED");
    expect((await decisionRow(early.decisionId)).invalidatedAt).not.toBeNull(); expect(await claimStatus(early.id)).toBe("DRAFT");
  });
});

describe("DR-55 a receipt prepared after a breadth changing bind allocates", () => {
  it("freezes under policy N+1 and priority N+1 with no stored-costs error, where it would be refused without the recompute", async () => {
    await bindDraft(await draftId(TARA, breadthAnswer(THREE)));
    const late = await receiptClaim(ctx.db, { vendor: "Late shop" });
    const edges = await edgesOfDecision(late.decisionId);
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) expect(edge.solverPriorityVersion).toBe(2);
    const fundA = edges.filter(edge => edge.fundId === FUND);
    expect(fundA.length).toBeGreaterThan(0); for (const edge of fundA) expect(edge.policyVersion).toBe(2);
    expect(await approveDecision(ctx.db, late.decisionId, "tara", late.hash)).toMatchObject({ status: "AWAITING_APPROVAL" });
    expect(await approveDecision(ctx.db, late.decisionId, "ben", late.hash)).toMatchObject({ status: "APPROVED" });
  });
  it("still allocates after the breadth shrinks and grows again, and after a bind that keeps the breadth", async () => {
    await bindDraft(await draftId(TARA, breadthAnswer(["robot_kits_parts"])));
    expect((await receiptClaim(ctx.db, { vendor: "One shop" })).decisionId).toEqual(expect.any(String));
    await bindDraft(await draftId(BEN, breadthAnswer(THREE)), BEN, TARA);
    expect((await receiptClaim(ctx.db, { vendor: "Three shop" })).decisionId).toEqual(expect.any(String));
    await bindDraft(await draftId(TARA, breadthAnswer(["robot_kits_parts", "classroom_supplies", "hygiene_health_supplies"])));
    expect((await receiptClaim(ctx.db, { vendor: "Same breadth shop" })).decisionId).toEqual(expect.any(String));
    expect((await priorities()).map(row => row.version)).toEqual([1, 2, 3]);
  });
});

describe("DR-56 a bind that keeps the breadth writes no priority version", () => {
  it("leaves the solver priority table byte-identical for the default draft, a category swap and an edit of a cap", async () => {
    const solver = await tableHash(ctx.client, "solver_priority_versions");
    expect((await bindDraft(await draftId(TARA))).two).toMatchObject({ status: "BOUND", priorityVersion: null, invalidatedDecisions: 0 });
    const swap = breadthAnswer(["robot_kits_parts", "books"]);
    expect((await bindDraft(await draftId(BEN, swap), BEN, TARA)).two).toMatchObject({ status: "BOUND", policyVersion: 3, priorityVersion: null, invalidatedDecisions: 0 });
    const parent = await draftId(TARA);
    const child = ((await editDraft(ctx.db, BEN, parent, { caps: { supplies: 25000 } })) as { draftId: string }).draftId;
    expect((await bindDraft(child)).two).toMatchObject({ status: "BOUND", policyVersion: 4, priorityVersion: null });
    expect(await tableHash(ctx.client, "solver_priority_versions")).toEqual(solver);
    expect((await priorities()).map(row => row.version)).toEqual([1]);
  });
  it("does not invalidate a half approved decision by itself", async () => {
    const early = await halfApprovedClaim();
    const { two } = await bindDraft(await draftId(TARA));
    expect(two).toMatchObject({ priorityVersion: null, invalidatedDecisions: 0 });
    expect(await claimStatus(early.id)).toBe("AWAITING_APPROVAL");
    for (const status of await reservationStatuses(early.decisionId)) expect(status).toBe("ACTIVE");
  });
});

describe("DR-57 a failure after the priority write leaves no priority row, policy row, event or invalidation", () => {
  const forceFailure = async (table: string, when = "true") => {
    await ctx.client.unsafe(`create function zz_force_failure() returns trigger language plpgsql as $$ begin raise exception 'forced failure for the test' using errcode = 'P0001'; end; $$`);
    await ctx.client.unsafe(`create trigger zz_force_failure before insert on ${table} for each row when (${when}) execute function zz_force_failure()`);
  };
  const clearFailure = async (table: string) => { await ctx.client.unsafe(`drop trigger zz_force_failure on ${table}`); await ctx.client.unsafe("drop function zz_force_failure()"); };
  it("rolls everything back when the BOUND event, written after the priority revision, fails, then binds cleanly on retry", async () => {
    const early = await halfApprovedClaim();
    const id = await draftId(TARA, breadthAnswer(THREE)); await approveDraft(ctx.db, TARA, id);
    const baseline = { watched: await hashes(), solver: await tableHash(ctx.client, "solver_priority_versions"), financial: await financialHash(ctx.client) };
    await forceFailure("policy_draft_events", "new.kind = 'BOUND'");
    await expect(approveDraft(ctx.db, BEN, id)).rejects.toThrow();
    expect(await hashes()).toEqual(baseline.watched);
    expect(await tableHash(ctx.client, "solver_priority_versions")).toEqual(baseline.solver);
    expect(await financialHash(ctx.client)).toBe(baseline.financial);
    expect((await priorities()).map(row => row.version)).toEqual([1]);
    expect(await currentVersion()).toBe(1); expect(await count("fund_policy_versions", `fund_id = '${FUND}' and version = 2`)).toBe(0);
    expect(await count("policy_draft_events", `draft_id = '${id}'`)).toBe(1);
    expect((await decisionRow(early.decisionId)).invalidatedAt).toBeNull(); expect(await claimStatus(early.id)).toBe("AWAITING_APPROVAL");
    for (const status of await reservationStatuses(early.decisionId)) expect(status).toBe("ACTIVE");
    await clearFailure("policy_draft_events");
    expect(await approveDraft(ctx.db, BEN, id)).toEqual({ status: "BOUND", approvals: 2, policyVersion: 2, priorityVersion: 2, invalidatedDecisions: 1 });
    expect((await priorities()).map(row => row.version)).toEqual([1, 2]);
  });
  it("rolls everything back when the priority insert itself fails, then binds cleanly on retry", async () => {
    const id = await draftId(TARA, breadthAnswer(THREE)); await approveDraft(ctx.db, TARA, id);
    const baseline = { watched: await hashes(), solver: await tableHash(ctx.client, "solver_priority_versions") };
    await forceFailure("solver_priority_versions");
    await expect(approveDraft(ctx.db, BEN, id)).rejects.toThrow();
    expect(await hashes()).toEqual(baseline.watched); expect(await tableHash(ctx.client, "solver_priority_versions")).toEqual(baseline.solver);
    await clearFailure("solver_priority_versions");
    expect(await approveDraft(ctx.db, BEN, id)).toMatchObject({ status: "BOUND", priorityVersion: 2 });
  });
});

describe("DR-58 approve and withdraw take the organization lock and wait for it, a claimant does not", () => {
  // Holds the ledger's organization advisory lock from a separate connection, as a freeze, approval or payout in progress would.
  async function holdOrganizationLock() {
    let release!: () => void; let acquired!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const held = new Promise<void>(resolve => { acquired = resolve; });
    const finished = ctx.client.begin(async tx => { await tx`select pg_advisory_xact_lock(hashtext(${ORG})::bigint)`; acquired(); await gate; });
    await held;
    return async () => { release(); await finished; };
  }
  const settledWithin = (work: Promise<unknown>, ms: number) => Promise.race([work.then(() => true, () => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), ms))]);
  it("an approval and a withdrawal wait while another transaction holds the lock, finish after it is released, and a claimant is refused at once", async () => {
    const a = await draftId(TARA), b = await draftId(BEN, otherAnswer());
    const release = await holdOrganizationLock();
    const approving = approveDraft(ctx.db, TARA, a); const withdrawing = withdrawDraft(ctx.db, BEN, b);
    const claimant = approveDraft(ctx.db, MARIA, a);
    expect(await settledWithin(claimant, 3_000)).toBe(true);
    expect(await claimant).toMatchObject({ status: "REFUSED", reason: "APPROVER_REQUIRED" });
    expect(await settledWithin(approving, 800)).toBe(false); expect(await settledWithin(withdrawing, 800)).toBe(false);
    expect(await count("policy_draft_events")).toBe(0);
    await release();
    expect(await approving).toEqual({ status: "APPROVED", approvals: 1 }); expect(await withdrawing).toEqual({ status: "WITHDRAWN" });
    expect(await count("policy_draft_events", "kind = 'APPROVED'")).toBe(1); expect(await count("policy_draft_events", "kind = 'WITHDRAWN'")).toBe(1);
  });
  it("a refusal that waited for the lock gives the same answer when it runs, and writes nothing", async () => {
    const id = await draftId(TARA); await approveDraft(ctx.db, TARA, id);
    const baseline = await hashes();
    const release = await holdOrganizationLock();
    const again = approveDraft(ctx.db, TARA, id); const unknown = withdrawDraft(ctx.db, BEN, "00000000-0000-4000-8000-000000000000");
    expect(await settledWithin(again, 600)).toBe(false);
    await release();
    expect(await again).toEqual({ status: "REFUSED", reason: "SAME_APPROVER" }); expect(await unknown).toEqual({ status: "REFUSED", reason: "NOT_FOUND" });
    expect(await hashes()).toEqual(baseline);
  });
  it("two approvals queued behind the lock run one after the other: one first approval, then one binding, exactly once", async () => {
    const id = await draftId(TARA);
    const release = await holdOrganizationLock();
    const racers = [approveDraft(ctx.db, TARA, id), approveDraft(ctx.db, BEN, id)];
    await settledWithin(Promise.all(racers), 500);
    await release();
    const results = await Promise.all(racers);
    expect(results.map(result => result.status).sort()).toEqual(["APPROVED", "BOUND"]);
    expect(await count("policy_draft_events", "kind = 'BOUND'")).toBe(1); expect(await currentVersion()).toBe(2);
  });
});

describe("DR-59 the early warning says before the second approval whether a bind would change the pay order", () => {
  const analysisOf = async (id: string) => { const read = await readDraft(ctx.db, TARA, id); return read.status === "OK" ? read.view : null; };
  it("is true for a draft that changes the breadth, false for one that keeps it, and null when the categories are not settled", async () => {
    const grow = await draftId(TARA, breadthAnswer(THREE)); const keep = await draftId(BEN, goodAnswer());
    const open = goodAnswer(); open.allowedCategories = unsureList(); open.breadth = 0;
    const unsettled = await draftId(TARA, open);
    expect((await analysisOf(grow))!.analysis).toMatchObject({ changesPayOrder: true });
    expect((await analysisOf(keep))!.analysis).toMatchObject({ changesPayOrder: false });
    expect((await analysisOf(unsettled))!.analysis).toMatchObject({ changesPayOrder: null });
    // The warning never blocks an approval.
    expect(await approveDraft(ctx.db, TARA, grow)).toEqual({ status: "APPROVED", approvals: 1 });
    expect((await analysisOf(grow))!.analysis).toMatchObject({ changesPayOrder: true });
  });
  it("is null once the draft is bound, stale, withdrawn or refused, and for a draft that cannot be compared", async () => {
    const grow = await draftId(TARA, breadthAnswer(THREE)); const stale = await draftId(BEN, goodAnswer()); const withdrawn = await draftId(BEN, otherAnswer());
    await withdrawDraft(ctx.db, TARA, withdrawn);
    await bindDraft(grow);
    expect((await analysisOf(grow))).toMatchObject({ state: "BOUND", analysis: { changesPayOrder: null } });
    expect((await analysisOf(stale))).toMatchObject({ state: "STALE", analysis: { changesPayOrder: null } });
    expect((await analysisOf(withdrawn))).toMatchObject({ state: "WITHDRAWN", analysis: { changesPayOrder: null } });
    const refusedAnswer = goodAnswer(); refusedAnswer.breadth = 9;
    const refused = (await draftOf(TARA, refusedAnswer)).result as { draftId: string };
    expect((await analysisOf(refused.draftId))).toMatchObject({ state: "REFUSED", analysis: null });
  });
  it("is false for the same breadth even when other funds exist, and reads without writing any row", async () => {
    const id = await draftId(TARA, breadthAnswer(THREE));
    const before = { watched: await hashes(), solver: await tableHash(ctx.client, "solver_priority_versions"), financial: await financialHash(ctx.client) };
    await analysisOf(id); await analysisOf(id);
    expect(await hashes()).toEqual(before.watched); expect(await tableHash(ctx.client, "solver_priority_versions")).toEqual(before.solver); expect(await financialHash(ctx.client)).toBe(before.financial);
  });
});

describe("DR-60 the draft module still reaches no money, claim approval, payout or PayPal path through the new ledger edge", () => {
  it("binds through the ledger revision without writing a journal entry, a debit, a credit, a disbursement or an approval of a claim", async () => {
    const early = await halfApprovedClaim();
    const tables = ["journal_entries", "journal_postings", "fund_debits", "fund_credits", "disbursements", "disbursement_attempts", "approvals", "claim_lines", "allocation_edges"];
    const before = await Promise.all(tables.map(table => tableHash(ctx.client, table)));
    expect((await bindDraft(await draftId(TARA, breadthAnswer(THREE)))).two).toMatchObject({ priorityVersion: 2, invalidatedDecisions: 1 });
    expect(await Promise.all(tables.map(table => tableHash(ctx.client, table)))).toEqual(before);
    expect((await decisionRow(early.decisionId)).invalidatedAt).not.toBeNull();
  });
});

// IAC-440 Package A second evaluation blocker (DR-76): the model answers in the flat wire shape, and a flat answer whose
// key set is not exactly the expected one is stored as a refusal with the existing SHAPE code. Real Postgres, stubbed model.
describe("DR-76 a flat answer with a missing or extra key is stored as a SHAPE refusal, and a whole one still becomes a draft", () => {
  const textOf = (answer: unknown) => ({ content: [{ type: "text", text: JSON.stringify(answer) }] });
  it("stores a REFUSED row with SHAPE and the path response for a missing key, an extra key and the old nested shape, and never a draft", async () => {
    const flat = flatAnswer(goodAnswer()) as Record<string, unknown>;
    const missing = { ...flat }; delete missing.caps_supplies_quote;
    const extra = { ...flat, caps_supplies_note: "x" };
    for (const [name, wire] of [["missing", missing], ["extra", extra], ["nested", goodAnswer()]] as const) {
      const { result, calls } = await draftOf(TARA, goodAnswer(), { response: textOf(wire) });
      expect(calls, name).toHaveLength(1);
      expect(result, name).toMatchObject({ status: "DRAFT_REFUSED", reason: "SHAPE", path: "response" });
    }
    expect(await count("policy_drafts", "outcome = 'REFUSED' and refusal_reason = 'SHAPE'")).toBe(3);
    expect(await count("policy_drafts", "outcome = 'DRAFTED'")).toBe(0);
  });
  it("a whole flat answer is stored as a draft whose nested document is the one the validator read", async () => {
    const { result } = await draftOf();
    expect(result).toMatchObject({ status: "DRAFTED", complete: true });
    const [row] = await ctx.db.select().from(s.policyDrafts).where(eq(s.policyDrafts.id, (result as { draftId: string }).draftId));
    expect(row!.draft).toMatchObject({ programs: { status: "DRAFTED", value: ["robotics"] }, caps: { supplies: { status: "DRAFTED", value: 30000 }, other: { status: "UNSURE", value: null } } });
    expect(JSON.stringify(row!.draft)).not.toContain("programs_status");
  });
});
