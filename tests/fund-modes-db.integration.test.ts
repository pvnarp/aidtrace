import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as s from "../db/schema";
import type { FundMode } from "../db/schema";
import { approveDecision, freezeDecision, recognizeDecision } from "../src/ledger/service";
import { reconcile } from "../src/ledger/reconcile";
import { runModelCheck } from "../src/policy/model-run";
import { runPolicyChecks } from "../src/policy/service";
import { noHoldsFor, type HoldReason } from "../src/fund-modes/no-holds";
import { approveFundMode, proposeFundMode, readFundMode } from "../src/fund-modes/change";
import { handleFundMode } from "../src/server/fund-mode-actions";
import { FINANCIAL_TABLES, STANDARD_RECEIPT_LINES, createPolicyDatabase, financialHash, receiptClaim, tableHash, type PolicyDatabase, type ReceiptLineSpec } from "./support/policy-db";
import { AI_ENV, ALL_ASSISTED, ALL_AUTOPILOT, FLAG_ON, HAIKU, SONNET, allOk, conflictAll, dbError, isAshmere, notJson, otherOrganization, setMode, setModes, stub, unsureAll, type Handler } from "./support/fund-modes";

// IAC-405 step 2 PR F (docs/plans/FUND_MODES_SCOPE.md sections 2 and 3, docs/ASSUMPTIONS.md section 76), FM-01 to FM-12 and FM-21 to FM-24 on real Postgres in the isolated check
// project. Mode-aware freeze and recognition, the two-step mode change, the database guards, the append-only refusals and migration 0019 on retained data. The sweep is FM-13 to
// FM-20 (tests/fund-modes-sweep.integration.test.ts) and the static boundaries are FM-25 (tests/fund-modes-static.test.ts). Every model call goes to a stub this file defines.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: PolicyDatabase;
const open: PolicyDatabase[] = []; const folders: string[] = [];
beforeEach(async () => { ctx = await createPolicyDatabase("aidtrace_fm"); open.push(ctx); }, 60_000);
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); while (open.length) await open.pop()!.close(); for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); }, 60_000);

// The flag is read from the process environment by the production path (freeze, approve, recognize), so a test sets it the way an operator would.
const flag = (on: boolean) => vi.stubEnv("FUND_MODES_ENABLED", on ? "true" : "false");
type Claim = { id: string; hash: string; decisionId: string };
const checks = async (hash: string, handler: Handler = allOk) => {
  const rules = await runPolicyChecks(ctx.db, hash, { id: "tara" }); expect(rules.status).toBe("RAN");
  const { client, seen } = stub(handler);
  const model = await runModelCheck(ctx.db, hash, { id: "tara" }, { env: AI_ENV, client }); expect(model.status).toBe("RAN");
  return seen;
};
const noHolds = (hash: string) => ctx.db.transaction(tx => noHoldsFor(tx, hash));
const approve = (claim: Claim, actor: string) => approveDecision(ctx.db, claim.decisionId, actor, claim.hash);
const approvalsOf = (hash: string) => ctx.db.select().from(s.approvals).where(eq(s.approvals.decisionHash, hash));
const automatedOf = (hash: string) => ctx.db.select().from(s.automatedDecisions).where(eq(s.automatedDecisions.decisionHash, hash));
const modeRow = async (hash: string) => (await ctx.db.select().from(s.decisionModes).where(eq(s.decisionModes.decisionHash, hash)))[0];
const claimStatus = async (id: string) => (await ctx.db.select().from(s.claims).where(eq(s.claims.id, id)))[0]!.status;
const journalCount = async () => (await ctx.client`select count(*)::int as n from journal_entries`)[0]!.n as number;
// Two lines with no meal or travel category. Rules P4 raises a HOLD flag for every meal or travel line, so a claim that has to come out with no holds must avoid them. With the fixture
// allocation L1 pays from fund_b and L2 from fund_a, and the General fund pays nothing (FM-02 asserts the versions that froze, which proves the paying funds).
const CLEAN_LINES = STANDARD_RECEIPT_LINES.slice(0, 2);
const clean = (spec: { vendor?: string; source?: string; lines?: ReceiptLineSpec[] } = {}) => receiptClaim(ctx.db, { lines: CLEAN_LINES, ...spec });
const GIFT_CARD_SOURCE = `${CLEAN_LINES.map(line => line.description).join("\n")}\nRaffle prize: gift card`;
// A conflict or an unreadable answer from the Ashmere fund (fund_a) only, so the other fund is unaffected.
const onlyAshmere = (bad: Handler): Handler => (call, input, nth) => isAshmere(input) ? bad(call, input, nth) : allOk(call, input, nth);

describe("FM-01 to FM-04 recognition by mode", () => {
  it("FM-01: with the flag off and Assisted rows stored, a funded claim freezes with no mode row and still needs two approvals even with clean checks", async () => {
    await setModes(ctx.db, ALL_ASSISTED); flag(false);
    const claim = await clean();
    expect(await modeRow(claim.hash)).toBeUndefined();
    await checks(claim.hash);
    expect((await noHolds(claim.hash)).noHolds).toBe(true);
    const before = await journalCount();
    expect(await approve(claim, "tara")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    expect(await claimStatus(claim.id)).toBe("AWAITING_APPROVAL");
    expect(await journalCount()).toBe(before);
    expect(await approve(claim, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 2 });
    expect(await automatedOf(claim.hash)).toEqual([]);
    expect(await approvalsOf(claim.hash)).toHaveLength(2);
  });

  it("FM-02: with the flag on and every paying fund Assisted, clean stored runs and one approval recognize the claim and write one NO_HOLDS record that is not an approval", async () => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await clean();
    expect(await modeRow(claim.hash)).toMatchObject({ effectiveMode: "ASSISTED", fundModeVersions: { fund_a: 1, fund_b: 1 } });
    await checks(claim.hash);
    const outcome = await noHolds(claim.hash);
    expect(outcome).toMatchObject({ noHolds: true, checkedPairs: 2, okLines: 2, rulesTrigger: "APPROVER", modelTrigger: "APPROVER" });
    const before = await journalCount();
    expect(await approve(claim, "tara")).toMatchObject({ status: "APPROVED", approvalCount: 1 });
    expect(await claimStatus(claim.id)).toBe("APPROVED");
    expect(await journalCount()).toBeGreaterThan(before);
    const approvals = await approvalsOf(claim.hash);
    expect(approvals.map(row => row.approverId)).toEqual(["tara"]);
    const automated = await automatedOf(claim.hash);
    expect(automated).toHaveLength(1);
    expect(automated[0]).toMatchObject({ kind: "NO_HOLDS", inputs: { approvals: 1, checkedPairs: 2, okLines: 2, rulesTrigger: "APPROVER", modelTrigger: "APPROVER" } });
    if (!outcome.noHolds) throw new Error("Expected no holds");
    expect(automated[0]).toMatchObject({ rulesRunId: outcome.rulesRunId, modelRunId: outcome.modelRunId, ruleSetVersion: outcome.ruleSetVersion, model: outcome.model, promptVersion: outcome.promptVersion });
    // A replay answers with the approvals the decision actually holds (one), never a fixed two, and writes nothing again.
    const replayBefore = await journalCount();
    expect(await recognizeDecision(ctx.db, claim.decisionId, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 1 });
    expect(await journalCount()).toBe(replayBefore);
    expect(await automatedOf(claim.hash)).toHaveLength(1);
    expect(await approvalsOf(claim.hash)).toHaveLength(1);
  });

  const HOLDS: { name: string; reason: HoldReason; claim?: { source?: string; lines?: ReceiptLineSpec[] }; rules?: boolean; model?: Handler | null }[] = [
    { name: "a rules HOLD flag (a gift card on the receipt)", reason: "RULES_HOLD", claim: { source: GIFT_CARD_SOURCE } },
    { name: "a rules HOLD flag on a meal line (rule P4 holds every participant meal, with every model answer OK)", reason: "RULES_HOLD", claim: { lines: STANDARD_RECEIPT_LINES } },
    { name: "a model CONFLICT line", reason: "MODEL_HOLD", model: onlyAshmere(conflictAll) },
    { name: "a model UNSURE line", reason: "MODEL_HOLD", model: onlyAshmere(unsureAll) },
    { name: "a model NOT_CHECKED line (an unreadable answer from both steps)", reason: "MODEL_HOLD", model: onlyAshmere(notJson) },
    { name: "a rules run and no model run", reason: "NO_MODEL_RUN", model: null },
    { name: "no rules run and no model run", reason: "NO_RULES_RUN", rules: false, model: null },
  ];
  it.each(HOLDS)("FM-03: $name keeps an Assisted claim waiting for its second approval, and the second approval recognizes it", async ({ reason, claim: spec, rules, model }) => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await clean(spec);
    if (rules === false) { /* nothing is run */ }
    else if (model === null) expect((await runPolicyChecks(ctx.db, claim.hash, { id: "tara" })).status).toBe("RAN");
    else await checks(claim.hash, model ?? allOk);
    expect(await noHolds(claim.hash)).toMatchObject({ noHolds: false, reason });
    const before = await journalCount();
    expect(await approve(claim, "tara")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    expect(await claimStatus(claim.id)).toBe("AWAITING_APPROVAL");
    expect(await journalCount()).toBe(before);
    expect(await automatedOf(claim.hash)).toEqual([]);
    expect(await approve(claim, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 2 });
    expect(await claimStatus(claim.id)).toBe("APPROVED");
    // The second approval is a human one: the record of the check outcome is still absent and the two approvals are both stored.
    expect(await automatedOf(claim.hash)).toEqual([]);
    expect((await approvalsOf(claim.hash)).map(row => row.approverId).sort()).toEqual(["ben", "tara"]);
  });

  it("FM-04: a Manual decision whose stored runs would qualify as no holds, with a NO_HOLDS record already stored, still needs two approvals", async () => {
    flag(true); // No fund_modes row exists, so every fund is Manual.
    const claim = await clean();
    expect(await modeRow(claim.hash)).toMatchObject({ effectiveMode: "MANUAL", fundModeVersions: { fund_a: 0, fund_b: 0 } });
    await checks(claim.hash);
    const outcome = await noHolds(claim.hash);
    if (!outcome.noHolds) throw new Error(`Expected the runs to qualify, got ${outcome.reason}`);
    // The record an Assisted recognition would have written. It is audit text: it must not count as the second approval.
    await ctx.db.insert(s.automatedDecisions).values({ decisionHash: claim.hash, kind: "NO_HOLDS", rulesRunId: outcome.rulesRunId, modelRunId: outcome.modelRunId,
      ruleSetVersion: outcome.ruleSetVersion, model: outcome.model, promptVersion: outcome.promptVersion, inputs: { approvals: 1 } });
    const before = await journalCount();
    expect(await approve(claim, "tara")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    expect(await claimStatus(claim.id)).toBe("AWAITING_APPROVAL");
    expect(await journalCount()).toBe(before);
    expect(await approvalsOf(claim.hash)).toHaveLength(1);
    expect(await approve(claim, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 2 });
    expect(await automatedOf(claim.hash)).toHaveLength(1);
  });
});

describe("FM-05 to FM-08 the strictest mode, timing, Autopilot and the coverage of the model run", () => {
  it.each<[string, Record<string, FundMode>, Record<string, number>]>([
    ["a Manual fund row", { fund_a: "ASSISTED", fund_b: "MANUAL", fund_g: "ASSISTED" }, { fund_a: 1, fund_b: 1 }],
    ["a fund with no mode row", { fund_a: "ASSISTED", fund_g: "ASSISTED" }, { fund_a: 1, fund_b: 0 }],
  ])("FM-05: a split across Assisted funds and %s is recorded Manual and needs two approvals", async (_name, modes, versions) => {
    flag(true); await setModes(ctx.db, modes);
    const claim = await clean();
    expect(await modeRow(claim.hash)).toMatchObject({ effectiveMode: "MANUAL", fundModeVersions: versions });
    await checks(claim.hash);
    expect((await noHolds(claim.hash)).noHolds).toBe(true);
    expect(await approve(claim, "tara")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    expect(await automatedOf(claim.hash)).toEqual([]);
    expect(await approve(claim, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 2 });
  });

  it("FM-06: funds moved to Assisted after the claim froze do not loosen it", async () => {
    flag(true);
    const claim = await clean();
    await setModes(ctx.db, ALL_ASSISTED);
    expect(await modeRow(claim.hash)).toMatchObject({ effectiveMode: "MANUAL", fundModeVersions: { fund_a: 0, fund_b: 0 } });
    await checks(claim.hash);
    expect(await approve(claim, "tara")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    expect(await approve(claim, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 2 });
    expect(await automatedOf(claim.hash)).toEqual([]);
  });

  it("FM-06: a fund moved to Manual after the claim froze tightens it at once, and moving it back to Assisted lifts only that", async () => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await clean();
    await checks(claim.hash);
    await setMode(ctx.db, "fund_b", "MANUAL");
    expect(await modeRow(claim.hash)).toMatchObject({ effectiveMode: "ASSISTED" }); // What froze stays on record.
    expect(await approve(claim, "tara")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    expect(await recognizeDecision(ctx.db, claim.decisionId, "ben")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    await setMode(ctx.db, "fund_b", "ASSISTED");
    expect(await recognizeDecision(ctx.db, claim.decisionId, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 1 });
    expect(await automatedOf(claim.hash)).toHaveLength(1);
  });

  it.each<[string, Record<string, FundMode>]>([
    ["every paying fund Autopilot", ALL_AUTOPILOT],
    ["an Assisted fund and an Autopilot fund in one split", { fund_a: "ASSISTED", fund_b: "AUTOPILOT", fund_g: "ASSISTED" }],
  ])("FM-07: %s is recorded Manual and needs two approvals", async (_name, modes) => {
    flag(true); await setModes(ctx.db, modes);
    const claim = await clean();
    expect(await modeRow(claim.hash)).toMatchObject({ effectiveMode: "MANUAL" });
    await checks(claim.hash);
    expect((await noHolds(claim.hash)).noHolds).toBe(true);
    expect(await approve(claim, "tara")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    expect(await automatedOf(claim.hash)).toEqual([]);
    expect(await approve(claim, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 2 });
  });

  it("FM-07: a fund moved to Autopilot after an Assisted freeze counts as Manual, and the service refuses to propose or approve Autopilot", async () => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await clean();
    await checks(claim.hash);
    await setMode(ctx.db, "fund_a", "AUTOPILOT");
    expect(await approve(claim, "tara")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    expect(await automatedOf(claim.hash)).toEqual([]);
    expect(await approve(claim, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 2 });
    // The service: a proposal for Autopilot is refused, and so is the approval of an Autopilot proposal that was inserted behind the service.
    const env = { env: FLAG_ON };
    expect(await proposeFundMode(ctx.db, { id: "tara" }, "fund_g", "AUTOPILOT", env)).toEqual({ status: "REFUSED", reason: "MODE_NOT_OFFERED" });
    const [stored] = await ctx.db.insert(s.fundModeProposals).values({ fundId: "fund_g", mode: "AUTOPILOT", baseVersion: 1, proposedBy: "tara" }).returning({ id: s.fundModeProposals.id });
    expect(await approveFundMode(ctx.db, { id: "ben" }, stored!.id, env)).toEqual({ status: "REFUSED", reason: "MODE_NOT_OFFERED" });
    expect((await ctx.db.select().from(s.fundModes).where(eq(s.fundModes.fundId, "fund_g"))).map(row => [row.version, row.mode])).toEqual([[1, "ASSISTED"]]);
    // A stored Autopilot reads as Manual on the screen.
    expect(await readFundMode(ctx.db, { id: "tara" }, "fund_a", env)).toMatchObject({ status: "OK", view: { mode: "MANUAL", version: 2 } });
  });

  it.each([
    ["Haiku objects (CONFLICT) and Sonnet then answers all OK", conflictAll],
    ["Haiku is UNSURE and Sonnet then answers all OK", unsureAll],
  ])("FM-08: %s on one fund is an escalation hold, so one approval does not recognize", async (_name, first) => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await clean();
    const seen = await checks(claim.hash, (call, input, nth) => isAshmere(input) && call.model === HAIKU ? first(call, input, nth) : allOk(call, input, nth));
    expect(seen.map(call => call.model).sort()).toEqual([HAIKU, HAIKU, SONNET]);
    // The stored lines are Sonnet's, all OK: the run reads as no conflict found, and only the escalation keeps the hold.
    expect(await noHolds(claim.hash)).toMatchObject({ noHolds: false, reason: "MODEL_ESCALATED" });
    expect(await approve(claim, "tara")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    expect(await automatedOf(claim.hash)).toEqual([]);
    expect(await approve(claim, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 2 });
  });
  it("FM-08: escalation is read by position, so stored model names that differ from today's steps still hold", async () => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await clean();
    await checks(claim.hash, (call, input, nth) => isAshmere(input) && call.model === HAIKU ? conflictAll(call, input, nth) : allOk(call, input, nth));
    expect(await noHolds(claim.hash)).toMatchObject({ noHolds: false, reason: "MODEL_ESCALATED" });
    // Rename every stored model to a pair no current step uses. Position, not name, decides.
    await ctx.client`alter table policy_model_results disable trigger user`;
    await ctx.client`update policy_model_results set model = case when sequence = (select min(sequence) from policy_model_results p where p.run_id = policy_model_results.run_id and p.fund_id = policy_model_results.fund_id and p.entry = 'CALL') then 'retired-first-step' else 'retired-second-step' end where entry = 'CALL'`;
    await ctx.client`alter table policy_model_results enable trigger user`;
    expect((await ctx.client`select distinct model from policy_model_results where entry = 'CALL' order by model`).map(row => row.model)).toEqual(["retired-first-step", "retired-second-step"]);
    expect(await noHolds(claim.hash)).toMatchObject({ noHolds: false, reason: "MODEL_ESCALATED" });
    expect(await approve(claim, "tara")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
  });

  it.each<[string, Handler]>([
    ["an unreadable answer", notJson],
    ["a thrown error", () => { throw new Error("service unavailable"); }],
  ])("FM-08: a first step that fails (%s) and a second step that answers all OK is not a hold", async (_name, failure) => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await clean();
    await checks(claim.hash, (call, input, nth) => isAshmere(input) && call.model === HAIKU ? failure(call, input, nth) : allOk(call, input, nth));
    expect(await noHolds(claim.hash)).toMatchObject({ noHolds: true });
    expect(await approve(claim, "tara")).toMatchObject({ status: "APPROVED", approvalCount: 1 });
    expect(await automatedOf(claim.hash)).toHaveLength(1);
  });

  it("FM-08: a stored model run that lacks a paying fund is incomplete, not clean", async () => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await clean();
    await checks(claim.hash);
    expect((await noHolds(claim.hash)).noHolds).toBe(true);
    // The service cannot write a run that skips a funded pair. The database is changed behind it, with its guards switched off for this statement only.
    await ctx.client.unsafe("alter table policy_model_results disable trigger user");
    await ctx.client`delete from policy_model_results where fund_id = 'fund_b'`;
    await ctx.client.unsafe("alter table policy_model_results enable trigger user");
    expect(await noHolds(claim.hash)).toMatchObject({ noHolds: false, reason: "MODEL_INCOMPLETE" });
    expect(await approve(claim, "tara")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    expect(await automatedOf(claim.hash)).toEqual([]);
  });

  it("FM-08: a checked fund with a paid line that has no stored answer is incomplete, not clean", async () => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const lines: ReceiptLineSpec[] = [{ description: "Robot servo kit", amount: "90.00", category: "robot_kits_parts" }, { description: "Robot sensor kit", amount: "60.00", category: "robot_kits_parts" }];
    const claim = await receiptClaim(ctx.db, { lines });
    await checks(claim.hash);
    expect((await noHolds(claim.hash)).noHolds).toBe(true);
    const rows = await ctx.client`select fund_id, line_id from policy_model_results where entry = 'LINE' order by fund_id, line_id`;
    const perFund = new Map<string, string[]>();
    for (const row of rows) perFund.set(String(row.fund_id), [...(perFund.get(String(row.fund_id)) ?? []), String(row.line_id)]);
    const fundWithTwo = [...perFund].find(([, lineIds]) => lineIds.length >= 2);
    expect(fundWithTwo, "this recipe must route two lines to one checked fund").toBeDefined();
    const [fundId, lineIds] = fundWithTwo!;
    await ctx.client.unsafe("alter table policy_model_results disable trigger user");
    await ctx.client`delete from policy_model_results where entry = 'LINE' and fund_id = ${fundId} and line_id = ${lineIds[0]!}`;
    await ctx.client.unsafe("alter table policy_model_results enable trigger user");
    expect(await noHolds(claim.hash)).toMatchObject({ noHolds: false, reason: "MODEL_INCOMPLETE" });
    expect(await approve(claim, "tara")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
  });
});

describe("FM-09 to FM-12 the books, the reasons, the mode change service and the flag at recognition", () => {
  it("FM-09: an Assisted recognition posts exactly what a two-approval recognition posts", async () => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const assisted = await clean();
    await checks(assisted.hash);
    expect(await approve(assisted, "tara")).toMatchObject({ status: "APPROVED" });
    const manual = await createPolicyDatabase("aidtrace_fm"); open.push(manual);
    const second = await receiptClaim(manual.db, { lines: CLEAN_LINES });
    expect(await approveDecision(manual.db, second.decisionId, "tara", second.hash)).toMatchObject({ status: "AWAITING_APPROVAL" });
    expect(await approveDecision(manual.db, second.decisionId, "ben", second.hash)).toMatchObject({ status: "APPROVED", approvalCount: 2 });
    const books = async (database: PolicyDatabase) => ({
      postings: await database.client`select e.purpose, p.account_code, p.sub_key, p.debit_cents::text as debit, p.credit_cents::text as credit from journal_postings p join journal_entries e on e.id = p.entry_id
        order by e.purpose, p.account_code, p.sub_key nulls first, p.debit_cents, p.credit_cents`,
      debits: await database.client`select fund_id, budget_line, amount_cents::text as amount, purpose from fund_debits order by fund_id, budget_line, purpose`,
      reservations: await database.client`select r.fund_id, r.status, r.amount_cents::text as amount from fund_reservations r order by r.fund_id`,
    });
    const left = await books(ctx); const right = await books(manual);
    expect(left.postings.length).toBeGreaterThan(8);
    expect(JSON.parse(JSON.stringify(left))).toEqual(JSON.parse(JSON.stringify(right)));
    expect((await ctx.db.transaction(tx => reconcile(tx, "cedar-hollow"))).matches).toBe(true);
  });

  it("FM-10: no holds is derived from the stored runs of the exact hash and says why it is not", async () => {
    flag(true);
    expect(await noHolds("0".repeat(64))).toMatchObject({ noHolds: false, reason: "NOT_CURRENT" });
    const claim = await clean();
    expect(await noHolds(claim.hash)).toMatchObject({ noHolds: false, reason: "NO_RULES_RUN" });
    expect((await runPolicyChecks(ctx.db, claim.hash, { id: "tara" })).status).toBe("RAN");
    expect(await noHolds(claim.hash)).toMatchObject({ noHolds: false, reason: "NO_MODEL_RUN" });
    // A keyless instance stores no model run at all, so it can never have "no holds".
    const keyless = await runModelCheck(ctx.db, claim.hash, { id: "tara" }, { env: { AI_COMPLIANCE_ENABLED: "true" } });
    expect(keyless.status).toBe("OFF");
    expect(await ctx.client`select count(*)::int as n from policy_check_runs where kind = 'MODEL'`).toMatchObject([{ n: 0 }]);
    expect(await noHolds(claim.hash)).toMatchObject({ noHolds: false, reason: "NO_MODEL_RUN" });
    await runModelCheck(ctx.db, claim.hash, { id: "tara" }, { env: AI_ENV, client: stub(allOk).client });
    // A recognized decision is no longer current.
    await approve(claim, "tara"); await approve(claim, "ben");
    expect(await noHolds(claim.hash)).toMatchObject({ noHolds: false, reason: "NOT_CURRENT" });
  });

  it("FM-11: the mode change takes two distinct approvers of the organization, offers Manual and Assisted only and refuses a stale proposal", async () => {
    await otherOrganization(ctx.db);
    const env = { env: FLAG_ON }; const off = { env: {} };
    const tara = { id: "tara" }, ben = { id: "ben" };
    const missing = "00000000-0000-4000-8000-000000000000";
    // The flag off refuses every function and writes nothing.
    expect(await proposeFundMode(ctx.db, tara, "fund_b", "ASSISTED", off)).toEqual({ status: "REFUSED", reason: "FLAG_OFF" });
    expect(await approveFundMode(ctx.db, ben, missing, off)).toEqual({ status: "REFUSED", reason: "FLAG_OFF" });
    expect(await readFundMode(ctx.db, tara, "fund_b", off)).toEqual({ status: "REFUSED", reason: "FLAG_OFF" });
    expect(await ctx.db.select().from(s.fundModeProposals)).toEqual([]);
    // Closed refusal codes for every bad request.
    const refused = (reason: string) => ({ status: "REFUSED", reason });
    expect(await proposeFundMode(ctx.db, tara, "fund b", "ASSISTED", env)).toEqual(refused("INVALID_REQUEST"));
    expect(await proposeFundMode(ctx.db, tara, "fund_b", "AUTOPILOT", env)).toEqual(refused("MODE_NOT_OFFERED"));
    expect(await proposeFundMode(ctx.db, tara, "fund_b", "ASSISTED; drop table funds", env)).toEqual(refused("MODE_NOT_OFFERED"));
    expect(await proposeFundMode(ctx.db, tara, "fund_b", undefined, env)).toEqual(refused("MODE_NOT_OFFERED"));
    expect(await proposeFundMode(ctx.db, { id: "maria" }, "fund_b", "ASSISTED", env)).toEqual(refused("APPROVER_REQUIRED"));
    expect(await proposeFundMode(ctx.db, { id: "" }, "fund_b", "ASSISTED", env)).toEqual(refused("APPROVER_REQUIRED"));
    expect(await proposeFundMode(ctx.db, { id: "nobody" }, "fund_b", "ASSISTED", env)).toEqual(refused("APPROVER_REQUIRED"));
    expect(await proposeFundMode(ctx.db, { id: "zed" }, "fund_b", "ASSISTED", env)).toEqual(refused("NOT_FOUND")); // Another organization's fund reads as no fund.
    expect(await proposeFundMode(ctx.db, tara, "no_such_fund", "ASSISTED", env)).toEqual(refused("NOT_FOUND"));
    expect(await proposeFundMode(ctx.db, tara, "fund_b", "MANUAL", env)).toEqual(refused("NO_CHANGE")); // No row means Manual already.
    expect(await approveFundMode(ctx.db, ben, "not-a-uuid", env)).toEqual(refused("INVALID_REQUEST"));
    expect(await approveFundMode(ctx.db, ben, missing, env)).toEqual(refused("NOT_FOUND"));
    expect(await ctx.db.select().from(s.fundModeProposals)).toEqual([]);
    // Two proposals made against the same version: the first approval wins, the second is stale.
    const first = await proposeFundMode(ctx.db, tara, "fund_b", "ASSISTED", env);
    const twin = await proposeFundMode(ctx.db, tara, "fund_b", "ASSISTED", env);
    if (first.status !== "PROPOSED" || twin.status !== "PROPOSED") throw new Error("Expected two proposals");
    expect(first.baseVersion).toBe(0);
    expect(await readFundMode(ctx.db, ben, "fund_b", env)).toMatchObject({ status: "OK", view: { mode: "MANUAL", version: 0 } });
    expect((await readFundMode(ctx.db, ben, "fund_b", env) as { view: { pending: unknown[] } }).view.pending).toHaveLength(2);
    expect(await approveFundMode(ctx.db, tara, first.proposalId, env)).toEqual(refused("SAME_APPROVER"));
    expect(await approveFundMode(ctx.db, { id: "maria" }, first.proposalId, env)).toEqual(refused("APPROVER_REQUIRED"));
    expect(await approveFundMode(ctx.db, { id: "zed" }, first.proposalId, env)).toEqual(refused("NOT_FOUND"));
    expect(await ctx.db.select().from(s.fundModes)).toEqual([]);
    expect(await approveFundMode(ctx.db, ben, first.proposalId, env)).toEqual({ status: "APPROVED", fundId: "fund_b", mode: "ASSISTED", version: 1 });
    expect(await approveFundMode(ctx.db, ben, first.proposalId, env)).toEqual(refused("ALREADY_APPROVED"));
    expect(await approveFundMode(ctx.db, ben, twin.proposalId, env)).toEqual(refused("STALE_BASE"));
    expect(await proposeFundMode(ctx.db, ben, "fund_b", "ASSISTED", env)).toEqual(refused("NO_CHANGE"));
    const view = await readFundMode(ctx.db, ben, "fund_b", env);
    expect(view).toMatchObject({ status: "OK", view: { fundId: "fund_b", mode: "ASSISTED", version: 1, pending: [] } }); // The stale twin is not shown as pending.
    expect(await readFundMode(ctx.db, { id: "zed" }, "fund_b", env)).toEqual(refused("NOT_FOUND"));
    // Back to Manual takes the same two steps and the next version.
    const back = await proposeFundMode(ctx.db, ben, "fund_b", "MANUAL", env);
    if (back.status !== "PROPOSED") throw new Error("Expected a proposal");
    expect(back.baseVersion).toBe(1);
    expect(await approveFundMode(ctx.db, tara, back.proposalId, env)).toEqual({ status: "APPROVED", fundId: "fund_b", mode: "MANUAL", version: 2 });
    expect((await ctx.db.select().from(s.fundModes).where(eq(s.fundModes.fundId, "fund_b"))).map(row => [row.version, row.mode, row.approvedBy])).toEqual([[1, "ASSISTED", "ben"], [2, "MANUAL", "tara"]]);
  });

  it("FM-11: approval is bound to the URL fund, and the tightening read leaves every other financial table unchanged", async () => {
    const env = { env: FLAG_ON }; const tara = { id: "tara" }, ben = { id: "ben" };
    const OTHER = FINANCIAL_TABLES.filter(table => table !== "fund_modes" && table !== "fund_mode_proposals");
    expect(FINANCIAL_TABLES).toHaveLength(23);
    const proposed = await proposeFundMode(ctx.db, tara, "fund_b", "ASSISTED", env);
    if (proposed.status !== "PROPOSED") throw new Error("Expected a proposal");
    // A proposal of fund_b approved under fund_a's URL is not found, and nothing is written.
    expect(await approveFundMode(ctx.db, ben, proposed.proposalId, env, "fund_a")).toEqual({ status: "REFUSED", reason: "NOT_FOUND" });
    expect(await ctx.db.select().from(s.fundModes)).toEqual([]);
    const before = await financialHash(ctx.client, OTHER); const allBefore = await financialHash(ctx.client);
    expect(await approveFundMode(ctx.db, ben, proposed.proposalId, env, "fund_b")).toEqual({ status: "APPROVED", fundId: "fund_b", mode: "ASSISTED", version: 1 });
    expect(await financialHash(ctx.client, OTHER)).toBe(before);
    // The twenty-three-table hash does move: the mode change writes the mode tables by design.
    expect(await financialHash(ctx.client)).not.toBe(allBefore);
  });

  it("FM-11: with the flag off the route answers 404 before the method, origin, session and role checks; with it on a wrong method is 405", async () => {
    const url = "http://localhost:3100/api/funds/fund_b/mode";
    const bare = (method: string) => new Request(url, { method, headers: { origin: "http://evil.example" } });
    for (const method of ["GET", "POST", "DELETE"]) expect((await handleFundMode(bare(method), "fund_b", { db: ctx.db, env: {} })).status, method).toBe(404);
    expect((await handleFundMode(bare("GET"), "fund_b", { db: ctx.db, env: FLAG_ON })).status).toBe(405);
  });

  it("FM-12: the flag is read when the claim is recognized: off after an Assisted freeze it is Manual again, and on again it is Assisted", async () => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await clean();
    await checks(claim.hash);
    flag(false);
    expect(await approve(claim, "tara")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    expect(await recognizeDecision(ctx.db, claim.decisionId, "ben")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    expect(await automatedOf(claim.hash)).toEqual([]);
    expect(await modeRow(claim.hash)).toMatchObject({ effectiveMode: "ASSISTED" });
    flag(true);
    expect(await recognizeDecision(ctx.db, claim.decisionId, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 1 });
    expect(await automatedOf(claim.hash)).toHaveLength(1);
  });
});

describe("FM-21 to FM-24 database guards, append-only tables, the freeze-only mode write and migration 0019", () => {
  it("FM-21: fund_modes refuses the proposer approving their own proposal, a claimant, an approver of another organization, a second approval, a mismatch, a skipped version and a stale base", async () => {
    await otherOrganization(ctx.db);
    const proposal = async (patch: Partial<typeof s.fundModeProposals.$inferInsert> = {}) =>
      (await ctx.db.insert(s.fundModeProposals).values({ fundId: "fund_b", mode: "ASSISTED", baseVersion: 0, proposedBy: "tara", ...patch }).returning({ id: s.fundModeProposals.id }))[0]!.id;
    const approval = (proposalId: string, patch: Partial<typeof s.fundModes.$inferInsert> = {}) =>
      ctx.db.insert(s.fundModes).values({ fundId: "fund_b", version: 1, mode: "ASSISTED", proposalId, approvedBy: "ben", ...patch });
    const refused = async (promise: PromiseLike<unknown>, message: RegExp) => { const error = await dbError(promise); expect(error.code, error.message).toBe("23514"); expect(error.message).toMatch(message); };
    const count = async (table: string) => (await ctx.client`select count(*)::int as n from ${ctx.client(table)}`)[0]!.n as number;
    const p = await proposal();
    await refused(approval(p, { approvedBy: "tara" }), /second approver, not the proposer/);
    await refused(approval(p, { approvedBy: "maria" }), /approved by an approver of the fund organization/);
    await refused(approval(p, { approvedBy: "zed" }), /approved by an approver of the fund organization/);
    await refused(approval(p, { mode: "MANUAL" }), /the fund and the mode that were proposed/);
    await refused(approval(p, { fundId: "fund_a" }), /the fund and the mode that were proposed/);
    await refused(approval(p, { version: 2 }), /numbered in order/);
    expect(await count("fund_modes")).toBe(0);
    await approval(p);
    await refused(approval(p, { version: 2 }), /at most once/);
    const stale = await proposal({ mode: "MANUAL", baseVersion: 0 }); // Made against version 0 after version 1 was approved.
    await refused(approval(stale, { version: 2, mode: "MANUAL" }), /before a later mode change/);
    expect(await count("fund_modes")).toBe(1);
    // Proposals: a claimant and an approver of another organization cannot propose, and a negative base version is not a version.
    await refused(ctx.db.insert(s.fundModeProposals).values({ fundId: "fund_b", mode: "ASSISTED", baseVersion: 1, proposedBy: "maria" }), /proposed by an approver of the fund organization/);
    await refused(ctx.db.insert(s.fundModeProposals).values({ fundId: "fund_b", mode: "ASSISTED", baseVersion: 1, proposedBy: "zed" }), /proposed by an approver of the fund organization/);
    await refused(ctx.db.insert(s.fundModeProposals).values({ fundId: "fund_b", mode: "ASSISTED", baseVersion: -1, proposedBy: "tara" }), /fund_mode_proposal_base_version/);
    await refused(ctx.db.insert(s.fundModeProposals).values({ fundId: "fund_b", mode: "SEMI" as FundMode, baseVersion: 1, proposedBy: "tara" }), /fund_mode_proposal_mode/);
    expect(await count("fund_mode_proposals")).toBe(2);
  });

  it("FM-22: every new table refuses update, delete and truncate", async () => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await clean();
    await checks(claim.hash);
    expect(await approve(claim, "tara")).toMatchObject({ status: "APPROVED" });
    const updates: Record<string, string> = {
      fund_mode_proposals: "update fund_mode_proposals set mode = 'MANUAL'", fund_modes: "update fund_modes set mode = 'MANUAL'",
      decision_modes: "update decision_modes set effective_mode = 'MANUAL'", automated_decisions: "update automated_decisions set kind = 'HELD'",
    };
    for (const [table, update] of Object.entries(updates)) {
      const before = await tableHash(ctx.client, table);
      expect(before.count, table).toBeGreaterThan(0);
      for (const statement of [update, `delete from ${table}`, `truncate ${table} cascade`]) {
        const error = await dbError(ctx.client.unsafe(statement));
        expect(error.code, `${statement}: ${error.message}`).toBe("23514");
        expect(error.message).toContain("Immutable");
      }
      expect(await tableHash(ctx.client, table), table).toEqual(before);
    }
  });

  it("FM-23: a decision mode is written only by the transaction that froze the decision", async () => {
    const claim = await clean(); // The flag is off: the decision has no mode row.
    expect(await modeRow(claim.hash)).toBeUndefined();
    const late = await dbError(ctx.db.insert(s.decisionModes).values({ decisionHash: claim.hash, effectiveMode: "ASSISTED", fundModeVersions: { fund_a: 1 } }));
    expect(late.code, late.message).toBe("23514");
    expect(late.message).toContain("recorded only when the decision is frozen");
    const unknown = await dbError(ctx.db.insert(s.decisionModes).values({ decisionHash: "f".repeat(64), effectiveMode: "ASSISTED", fundModeVersions: {} }));
    expect(unknown.code, unknown.message).toBe("23514");
    expect(await ctx.client`select count(*)::int as n from decision_modes`).toMatchObject([{ n: 0 }]);
    // With the flag on, the freeze writes it, and freezing the same terms again or changing a fund mode later never rewrites it.
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const other = await clean({ vendor: "Second shop", lines: [{ description: "Notebooks", amount: "20.00", category: "classroom_supplies" }] });
    const stored = await modeRow(other.hash);
    expect(stored).toMatchObject({ effectiveMode: "ASSISTED" });
    const again = await freezeDecision(ctx.db, other.id, "maria");
    expect(again).toMatchObject({ status: "AWAITING_APPROVAL", decisionHash: other.hash });
    await setMode(ctx.db, "fund_a", "MANUAL");
    expect(await modeRow(other.hash)).toEqual(stored);
    expect(await ctx.client`select count(*)::int as n from decision_modes`).toMatchObject([{ n: 1 }]);
  });

  // A migrations folder holding only the migrations up to and including idx `last`, so the later migration cannot change the starting point.
  function folderThrough(last: number, tag: string) {
    const dir = mkdtempSync(join(tmpdir(), "aidtrace-iac405f-")); folders.push(dir); mkdirSync(join(dir, "meta"));
    const journal = JSON.parse(readFileSync("db/migrations/meta/_journal.json", "utf8")) as { entries: { idx: number; tag: string }[] };
    const entries = journal.entries.filter(entry => entry.idx <= last);
    expect(entries.at(-1)!.tag).toBe(tag);
    writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) copyFileSync(join("db/migrations", `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
    return dir;
  }
  it("FM-24: migration 0019 applied to a database at 0018 with a frozen receipt claim, one approval and a rules run changes no existing row and only adds the four fund mode tables", async () => {
    const old = await createPolicyDatabase("aidtrace_fm", { migrationsFolder: folderThrough(18, "0018_ai-drafted-rules") }); open.push(old);
    const tables = async () => (await old.client`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`).map(row => String(row.table_name));
    expect(await tables()).not.toContain("fund_modes");
    const claim = await receiptClaim(old.db);
    expect((await approveDecision(old.db, claim.decisionId, "tara", claim.hash)).status).toBe("AWAITING_APPROVAL");
    // The retained rules run is inserted in its 0018 shape, which has no trigger column.
    const [rulesRun] = await old.client`insert into policy_check_runs (decision_hash, claim_id, claim_version, organization_id, kind, started_by, settings_versions, rule_set_version, facts_digest)
      values (${claim.hash}, ${claim.id}, 1, 'cedar-hollow', 'RULES', 'tara', '{}'::jsonb, 'policy-rules-v1', ${"a".repeat(64)}) returning id`;
    await old.client`insert into policy_check_results (run_id, sequence, entry, inputs) values (${rulesRun!.id}, 1, 'RUN_END', '{}'::jsonb)`;
    const existing = (await tables()).filter(name => name !== "__drizzle_migrations");
    // policy_check_runs gains a column, so it is compared without that column.
    const hashes = async () => Object.fromEntries(await Promise.all(existing.map(async name => [name, name === "policy_check_runs"
      ? await old.client`select (to_jsonb(r) - 'trigger')::text as v from policy_check_runs r order by (to_jsonb(r) - 'trigger')::text collate "C"`.then(rows => rows.map(row => row.v))
      : await tableHash(old.client, name)] as const)));
    const retained = await hashes();
    expect((retained["approvals"] as { count: number }).count).toBe(1); expect(retained["policy_check_runs"]).toHaveLength(1);
    const financialBefore = await financialHash(old.client);

    await migrate(old.db, { migrationsFolder: "db/migrations" });
    expect(await hashes()).toEqual(retained);
    // The test migrates the whole folder, so the three tables of migration 0020 (IAC-405 PR P) are added beside the four of 0019. Neither migration writes a row.
    expect((await tables()).filter(name => !existing.includes(name) && name !== "__drizzle_migrations")).toEqual(["automated_decisions", "automation_switch_events", "decision_modes", "disbursement_origins", "fund_mode_proposals", "fund_modes", "payee_email_history"]);
    for (const table of ["automated_decisions", "automation_switch_events", "decision_modes", "disbursement_origins", "fund_mode_proposals", "fund_modes", "payee_email_history"]) expect((await old.client`select count(*)::int as n from ${old.client(table)}`)[0]!.n, table).toBe(0);
    expect(await financialHash(old.client)).toBe(financialBefore);
    // The retained run reads as an approver run, the column that took its new default is nullable and a retained claim still takes its second approval as before.
    expect(await old.client`select trigger, started_by from policy_check_runs`).toMatchObject([{ trigger: "APPROVER", started_by: "tara" }]);
    expect(await old.client`select is_nullable from information_schema.columns where table_name = 'policy_check_runs' and column_name = 'started_by'`).toMatchObject([{ is_nullable: "YES" }]);
    expect(await approveDecision(old.db, claim.decisionId, "ben", claim.hash)).toMatchObject({ status: "APPROVED", approvalCount: 2 });
  });

  it("FM-24: migration 0019 only creates the four tables, their guards and their triggers, replaces one run guard and writes no row", () => {
    const sqlText = readFileSync("db/migrations/0019_fund-modes.sql", "utf8");
    const statements = sqlText.split("--> statement-breakpoint").map(part => part.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
    const news = ["automated_decisions", "decision_modes", "fund_mode_proposals", "fund_modes"];
    for (const statement of statements) {
      expect(statement, statement.slice(0, 60)).toMatch(/^(CREATE TABLE|ALTER TABLE|CREATE FUNCTION|CREATE OR REPLACE FUNCTION|CREATE TRIGGER)\b/);
      if (/^CREATE TABLE/.test(statement)) expect(news.some(name => new RegExp(`^CREATE TABLE "${name}" \\(`).test(statement)), statement.slice(0, 80)).toBe(true);
      if (/^ALTER TABLE/.test(statement)) expect([...news, "policy_check_runs"].some(name => new RegExp(`^ALTER TABLE "${name}" `).test(statement)), statement.slice(0, 80)).toBe(true);
      if (/^CREATE TRIGGER/.test(statement)) expect(news.some(name => new RegExp(` ON ${name} `).test(statement)), statement.slice(0, 80)).toBe(true);
      if (/^CREATE OR REPLACE FUNCTION/.test(statement)) expect(statement).toMatch(/^CREATE OR REPLACE FUNCTION aidtrace_policy_run_insert_guard\(\)/);
    }
    expect(statements.some(statement => /^(INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b/.test(statement))).toBe(false);
    expect(statements.filter(statement => /^CREATE TABLE/.test(statement))).toHaveLength(4);
    // Every new table has its immutable and no-truncate triggers.
    for (const name of news) { expect(sqlText).toMatch(new RegExp(`BEFORE UPDATE OR DELETE ON ${name} `)); expect(sqlText).toMatch(new RegExp(`BEFORE TRUNCATE ON ${name} `)); }
  });
});
