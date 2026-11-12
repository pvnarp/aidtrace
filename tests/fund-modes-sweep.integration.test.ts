import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../db/schema";
import { approveDecision } from "../src/ledger/service";
import { sweepModelCheck, sweepRulesCheck } from "../src/policy/sweep";
import { runPolicySweep } from "../src/fund-modes/policy-sweep";
import { handlePolicyChecks } from "../src/server/policy-actions";
import { ORIGIN, createPolicyDatabase, postRequest, receiptClaim, sessionFor, type PolicyDatabase, type ReceiptLineSpec } from "./support/policy-db";
import { AI_ENV, ALL_ASSISTED, ALL_AUTOPILOT, FLAG_ON, SWEEP_ENV, allOk, dbError, otherOrganization, setMode, setModes, stub, type Handler } from "./support/fund-modes";

// IAC-405 step 2 PR F, FM-13 to FM-20: the SWEEP run trigger, the web route, the flag, keyless
// behavior, recognition by the sweep, Manual decisions left alone, no network and liveness. Real Postgres in the isolated check project. Every model call goes to a stub.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: PolicyDatabase;
const open: PolicyDatabase[] = [];
beforeEach(async () => { ctx = await createPolicyDatabase("aidtrace_fs"); open.push(ctx); }, 60_000);
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); while (open.length) await open.pop()!.close(); }, 60_000);

const flag = (on: boolean) => vi.stubEnv("FUND_MODES_ENABLED", on ? "true" : "false");
// Meal-free lines (rules P4 holds every meal), varied per claim so the duplicate rule P1 stays quiet. L1 pays from fund_b and L2 from fund_a.
const lines = (n: number): ReceiptLineSpec[] => [
  { description: "Robot servo kit", amount: `${40 + n}.00`, category: "robot_kits_parts" }, { description: "Classroom markers", amount: `${25 + n}.00`, category: "classroom_supplies" },
];
const claimN = (n: number, spec: { source?: string; lines?: ReceiptLineSpec[] } = {}) => receiptClaim(ctx.db, { vendor: `Shop number ${n}`, lines: lines(n), ...spec });
type Claim = Awaited<ReturnType<typeof claimN>>;
const approve = (claim: Claim, actor: string) => approveDecision(ctx.db, claim.decisionId, actor, claim.hash);
const automatedOf = (hash: string) => ctx.db.select().from(s.automatedDecisions).where(eq(s.automatedDecisions.decisionHash, hash));
const runsOf = (hash: string) => ctx.db.select().from(s.policyCheckRuns).where(eq(s.policyCheckRuns.decisionHash, hash));
const approvalsOf = (hash: string) => ctx.db.select().from(s.approvals).where(eq(s.approvals.decisionHash, hash));
const statusOf = async (id: string) => (await ctx.db.select().from(s.claims).where(eq(s.claims.id, id)))[0]!.status;
const sweep = async (options: { env?: Record<string, string | undefined>; handler?: Handler; batch?: number } = {}) => {
  const { client, seen } = stub(options.handler ?? allOk);
  const entries: Record<string, string | number | null>[] = [];
  const report = await runPolicySweep(ctx.db, { env: options.env ?? SWEEP_ENV, batch: options.batch, model: { client }, log: entry => entries.push(entry) });
  return { report, seen, entries };
};

describe("FM-13 the SWEEP trigger is a database rule", () => {
  it("FM-13: a sweep run carries no user, needs a non-Manual recorded decision of its own organization, and an approver run needs a real approver", async () => {
    await otherOrganization(ctx.db);
    flag(false); const none = await claimN(1); // no decision_modes row
    flag(true); const manual = await claimN(2); // recorded Manual
    await setModes(ctx.db, ALL_ASSISTED);
    const assisted = await claimN(3); // recorded Assisted
    const insert = (claim: Claim, patch: { trigger?: string; startedBy?: string | null; organizationId?: string; claimId?: string } = {}) => ctx.client`
      insert into policy_check_runs (decision_hash, claim_id, claim_version, organization_id, kind, trigger, started_by, settings_versions, rule_set_version, facts_digest)
      values (${claim.hash}, ${patch.claimId ?? claim.id}, 1, ${patch.organizationId ?? "cedar-hollow"}, 'RULES', ${patch.trigger ?? "SWEEP"}, ${patch.startedBy === undefined ? null : patch.startedBy}, '{}'::jsonb, 'policy-rules-v1', ${"a".repeat(64)})`;
    const refused = async (promise: PromiseLike<unknown>, message: RegExp) => { const error = await dbError(promise); expect(error.code, error.message).toBe("23514"); expect(error.message).toMatch(message); };
    await refused(insert(assisted, { startedBy: "tara" }), /carries no user/);
    await refused(insert(assisted, { trigger: "APPROVER", startedBy: null }), /started by an approver of the claim organization/);
    await refused(insert(assisted, { trigger: "APPROVER", startedBy: "maria" }), /started by an approver of the claim organization/);
    await refused(insert(assisted, { trigger: "APPROVER", startedBy: "zed" }), /started by an approver of the claim organization/);
    await refused(insert(assisted, { trigger: "BAD", startedBy: null }), /from an approver or from the sweep/);
    await refused(insert(assisted, { organizationId: "other-org" }), /belongs to a claim of its organization/);
    await refused(insert(manual), /recorded mode is not Manual/);
    await refused(insert(none), /recorded mode is not Manual/);
    expect(await ctx.client`select count(*)::int as n from policy_check_runs`).toMatchObject([{ n: 0 }]);
    await insert(assisted);
    await insert(manual, { trigger: "APPROVER", startedBy: "tara" });
    expect(await ctx.client`select trigger, started_by from policy_check_runs where decision_hash = ${assisted.hash}`).toMatchObject([{ trigger: "SWEEP", started_by: null }]);
    expect(await ctx.client`select trigger, started_by from policy_check_runs where decision_hash = ${manual.hash}`).toMatchObject([{ trigger: "APPROVER", started_by: "tara" }]);
  });
});

describe("FM-14 the web route cannot start a sweep run", () => {
  it("FM-14: a press creates approver runs only, and a trigger or action naming the sweep is refused with no run", async () => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await claimN(1); const other = await claimN(2);
    vi.stubEnv("APP_ORIGIN", ORIGIN);
    const token = await sessionFor(ctx.db, "tara");
    const model = { env: AI_ENV, client: stub(allOk).client };
    const call = (id: string, fields: Record<string, string>) => handlePolicyChecks(postRequest(id, token, fields), id, { db: ctx.db, model });
    expect((await call(other.id, { action: "run", decisionHash: other.hash, trigger: "SWEEP" })).status).toBe(400);
    expect((await call(other.id, { action: "sweep", decisionHash: other.hash })).status).toBe(400);
    expect(await runsOf(other.hash)).toEqual([]);
    expect((await call(claim.id, { action: "run", decisionHash: claim.hash })).status).toBe(303);
    const runs = await runsOf(claim.hash);
    expect(runs.map(run => run.kind).sort()).toEqual(["MODEL", "RULES"]);
    for (const run of runs) expect(run).toMatchObject({ trigger: "APPROVER", startedBy: "tara" });
  });
});

describe("FM-15 and FM-16 the flag and the keyless pass", () => {
  it.each([undefined, "", "false", "TRUE", "1", "yes", " true"])("FM-15: with the flag %j the sweep does nothing and the sweep entry points refuse", async value => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await claimN(1);
    const env = { ...AI_ENV, FUND_MODES_ENABLED: value };
    const { report, seen } = await sweep({ env });
    expect(report).toEqual({ status: "OFF" });
    expect(seen).toHaveLength(0);
    expect(await runsOf(claim.hash)).toEqual([]);
    expect(await sweepRulesCheck(ctx.db, claim.hash, env)).toEqual({ status: "REFUSED", reason: "NOT_SWEEPABLE" });
    expect(await sweepModelCheck(ctx.db, claim.hash, { env, client: stub(allOk).client })).toEqual({ status: "REFUSED", reason: "NOT_SWEEPABLE" });
    expect(await runsOf(claim.hash)).toEqual([]);
  });

  it("FM-15: a Manual decision is NOT_SWEEPABLE even with the flag on", async () => {
    flag(true);
    const claim = await claimN(1);
    expect(await sweepRulesCheck(ctx.db, claim.hash, SWEEP_ENV)).toEqual({ status: "REFUSED", reason: "NOT_SWEEPABLE" });
    expect(await sweepModelCheck(ctx.db, claim.hash, { env: SWEEP_ENV, client: stub(allOk).client })).toEqual({ status: "REFUSED", reason: "NOT_SWEEPABLE" });
  });

  it("FM-16: a keyless pass stores the rules run, records one HELD for NO_MODEL_RUN, repeats without a second row and never recognizes", async () => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await claimN(1);
    const first = await sweep({ env: FLAG_ON });
    expect(first.report).toEqual({ status: "DONE", considered: 1, rulesRuns: 1, modelRuns: 0, held: 1, recognized: 0, failed: 0 });
    expect(first.seen).toHaveLength(0);
    const runs = await runsOf(claim.hash);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: "RULES", trigger: "SWEEP", startedBy: null });
    const held = await automatedOf(claim.hash);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ kind: "HELD", inputs: { reason: "NO_MODEL_RUN", rulesTrigger: "SWEEP" } });
    expect((await sweep({ env: FLAG_ON })).report).toMatchObject({ considered: 1, rulesRuns: 0, held: 0, recognized: 0 });
    expect(await automatedOf(claim.hash)).toHaveLength(1);
    // One human approval still does not recognize: with no model run there is never "no holds".
    expect(await approve(claim, "tara")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    expect((await sweep({ env: FLAG_ON })).report).toMatchObject({ recognized: 0 });
    expect(await statusOf(claim.id)).toBe("AWAITING_APPROVAL");
    expect(await approve(claim, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 2 });
  });
});

describe("FM-17 the sweep checks and recognizes only what already holds one human approval", () => {
  it("FM-17: clean checks and one existing approval are recognized by the sweep with a NO_HOLDS record whose runs are SWEEP runs", async () => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await claimN(1);
    expect(await approve(claim, "tara")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    const { report, seen, entries } = await sweep();
    expect(report).toEqual({ status: "DONE", considered: 1, rulesRuns: 1, modelRuns: 1, held: 0, recognized: 1, failed: 0 });
    expect(seen).toHaveLength(2);
    expect(await statusOf(claim.id)).toBe("APPROVED");
    expect(await approvalsOf(claim.hash)).toHaveLength(1);
    const automated = await automatedOf(claim.hash);
    expect(automated).toHaveLength(1);
    expect(automated[0]).toMatchObject({ kind: "NO_HOLDS", inputs: { approvals: 1, rulesTrigger: "SWEEP", modelTrigger: "SWEEP" } });
    // Logs carry counts and eight-character hashes only.
    const text = JSON.stringify(entries);
    expect(text).not.toContain(claim.hash); expect(text).not.toContain("test-key-not-real");
    expect(entries.filter(entry => entry.decision !== undefined).every(entry => String(entry.decision).length === 8)).toBe(true);
  });

  it("FM-17: clean checks with no approval are stored and nothing is recognized; the first human approval then recognizes", async () => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await claimN(1);
    const { report } = await sweep();
    expect(report).toMatchObject({ rulesRuns: 1, modelRuns: 1, held: 0, recognized: 0 });
    expect(await statusOf(claim.id)).toBe("AWAITING_APPROVAL");
    expect(await approvalsOf(claim.hash)).toEqual([]);
    expect(await automatedOf(claim.hash)).toEqual([]);
    expect(await approve(claim, "tara")).toMatchObject({ status: "APPROVED", approvalCount: 1 });
    expect((await automatedOf(claim.hash))[0]).toMatchObject({ kind: "NO_HOLDS", inputs: { rulesTrigger: "SWEEP", modelTrigger: "SWEEP" } });
  });

  it("FM-17: a hold is recorded once and the claim waits for its second human approval", async () => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await claimN(1, { source: `${lines(1).map(line => line.description).join("\n")}\nRaffle prize: gift card` });
    expect(await approve(claim, "tara")).toMatchObject({ approvalCount: 1 });
    const first = await sweep();
    expect(first.report).toMatchObject({ rulesRuns: 1, modelRuns: 0, held: 1, recognized: 0 }); // A rules hold spends no model call.
    expect(first.seen).toHaveLength(0);
    expect((await runsOf(claim.hash)).map(run => run.kind)).toEqual(["RULES"]);
    expect((await sweep()).report).toMatchObject({ rulesRuns: 0, modelRuns: 0, held: 0, recognized: 0 });
    const held = await automatedOf(claim.hash);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ kind: "HELD", inputs: { reason: "RULES_HOLD" } });
    expect(await statusOf(claim.id)).toBe("AWAITING_APPROVAL");
    expect(await approve(claim, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 2 });
    expect((await automatedOf(claim.hash)).map(row => row.kind)).toEqual(["HELD"]);
  });
});

describe("FM-18 Manual decisions are never swept", () => {
  it("FM-18: no row, a Manual row, a split and Autopilot decisions get no run and no model call", async () => {
    flag(false); const a = await claimN(1);
    flag(true); const b = await claimN(2);
    await setMode(ctx.db, "fund_a", "ASSISTED"); const c = await claimN(3); // fund_b has no row: a Manual split
    await setMode(ctx.db, "fund_b", "AUTOPILOT"); const d = await claimN(4); // Assisted plus Autopilot
    await setMode(ctx.db, "fund_a", "AUTOPILOT"); const e = await claimN(5); // all Autopilot
    for (const claim of [a, b, c, d, e]) expect(await approve(claim, "tara")).toMatchObject({ status: "AWAITING_APPROVAL" });
    const { report, seen } = await sweep();
    expect(report).toEqual({ status: "DONE", considered: 0, rulesRuns: 0, modelRuns: 0, held: 0, recognized: 0, failed: 0 });
    expect(seen).toHaveLength(0);
    expect(await ctx.client`select count(*)::int as n from policy_check_runs`).toMatchObject([{ n: 0 }]);
    expect(await ctx.client`select count(*)::int as n from automated_decisions`).toMatchObject([{ n: 0 }]);
    for (const claim of [a, b, c, d, e]) expect(await statusOf(claim.id)).toBe("AWAITING_APPROVAL");
  });

  it("FM-18: a fund moved to Manual after the freeze keeps the sweep from recognizing on one approval", async () => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await claimN(1);
    expect(await approve(claim, "tara")).toMatchObject({ approvalCount: 1 });
    await setMode(ctx.db, "fund_b", "MANUAL");
    const { report } = await sweep();
    expect(report).toMatchObject({ considered: 1, rulesRuns: 1, modelRuns: 1, recognized: 0 });
    expect(await statusOf(claim.id)).toBe("AWAITING_APPROVAL");
    expect(await automatedOf(claim.hash)).toEqual([]);
    expect(await approve(claim, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 2 });
  });

  it("FM-18: an all-Autopilot fund set is Manual, so the sweep skips it", async () => {
    flag(true); await setModes(ctx.db, ALL_AUTOPILOT);
    await claimN(1);
    expect((await sweep()).report).toMatchObject({ considered: 0 });
  });
});

describe("FM-19 the sweep reaches no network", () => {
  it("FM-19: flag off, keyless and stubbed passes never call fetch", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("network is not allowed in this test"); });
    vi.stubGlobal("fetch", fetchSpy);
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    await claimN(1);
    await sweep({ env: {} });
    await sweep({ env: FLAG_ON });
    await sweep();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("FM-20 liveness", () => {
  it("FM-20: a batch of one model run still gives every candidate its rules run, and the next pass checks and recognizes the one that was waiting", async () => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const older = await claimN(1); const newer = await claimN(2);
    expect(await approve(newer, "tara")).toMatchObject({ approvalCount: 1 });
    const first = await sweep({ batch: 1 });
    expect(first.report).toEqual({ status: "DONE", considered: 2, rulesRuns: 2, modelRuns: 1, held: 0, recognized: 0, failed: 0 });
    expect((await runsOf(older.hash)).map(run => run.kind).sort()).toEqual(["MODEL", "RULES"]);
    expect((await runsOf(newer.hash)).map(run => run.kind)).toEqual(["RULES"]);
    // The batch cap deferred the model run: that is waiting, not a hold, so no HELD row is written for it.
    expect(await automatedOf(newer.hash)).toEqual([]);
    const second = await sweep({ batch: 1 });
    expect(second.report).toMatchObject({ considered: 2, rulesRuns: 0, modelRuns: 1, recognized: 1 });
    expect(await statusOf(newer.id)).toBe("APPROVED");
    expect(await statusOf(older.id)).toBe("AWAITING_APPROVAL");
  });

  it("FM-20: a model run still going is waiting, not held, so a pass that meets it writes no HELD row", async () => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await claimN(1);
    let inner: Awaited<ReturnType<typeof sweep>> | undefined;
    // While the first pass's model call is in flight the model run has no RUN_END: a second pass meets a RUNNING run.
    const outer = await sweep({ handler: async (call, input, nth) => { inner ??= await sweep(); return allOk(call, input, nth); } });
    expect(inner?.report).toMatchObject({ considered: 1, modelRuns: 0, held: 0, recognized: 0 });
    expect(outer.report).toMatchObject({ modelRuns: 1, held: 0 });
    expect(await automatedOf(claim.hash)).toEqual([]);
  });

  it("FM-20: a pass over a decision with no human approval stores its checks and recognizes nothing, and the pre-check runs before the recognition call", async () => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await claimN(1);
    expect((await sweep()).report).toMatchObject({ rulesRuns: 1, modelRuns: 1, held: 0, recognized: 0, failed: 0 });
    expect(await approvalsOf(claim.hash)).toEqual([]);
    expect(await statusOf(claim.id)).toBe("AWAITING_APPROVAL");
    const text = readFileSync("src/fund-modes/policy-sweep.ts", "utf8");
    const loop = text.slice(text.indexOf("for (const { hash } of candidates)"));
    expect(loop.indexOf("hasValidApproval(db, hash)")).toBeGreaterThan(-1);
    expect(loop.indexOf("hasValidApproval(db, hash)")).toBeLessThan(loop.indexOf("recognizeWhenReady(db, hash"));
    expect(loop.indexOf("rulesHold")).toBeLessThan(loop.indexOf("sweepModelCheck"));
  });

  it("FM-20: an approval that committed outside the sweep's own call is recognized by the next pass", async () => {
    flag(true); await setModes(ctx.db, ALL_ASSISTED);
    const claim = await claimN(1);
    expect((await sweep()).report).toMatchObject({ rulesRuns: 1, modelRuns: 1, recognized: 0 });
    // The approval row lands without the ledger recognizing (the state a call that read an older snapshot leaves behind).
    await ctx.db.insert(s.approvals).values({ decisionHash: claim.hash, approverId: "tara" });
    expect(await statusOf(claim.id)).toBe("AWAITING_APPROVAL");
    expect((await sweep()).report).toMatchObject({ considered: 1, recognized: 1 });
    expect(await statusOf(claim.id)).toBe("APPROVED");
    expect((await automatedOf(claim.hash))[0]).toMatchObject({ kind: "NO_HOLDS", inputs: { approvals: 1 } });
  });
});

