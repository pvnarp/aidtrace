import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";
import * as s from "../db/schema";
import type { FundMode } from "../db/schema";
import { createPayPalAdapter, type PayoutTransport } from "../src/paypal/adapter";
import { approveAutoRecognized, approveDecision, recognizeAutonomously } from "../src/ledger/service";
import { handleClaimAction } from "../src/server/claim-actions";
import { loadClaimView } from "../src/server/claim-view";
import { railLines } from "../src/app/shell-copy";
import * as reviewCopy from "../src/fund-modes/review-copy";
import { noHoldsFor } from "../src/fund-modes/no-holds";
import { paymentLine } from "../src/app/claims/[claimId]/payment-line";
import { sendAutomatedPayout, sendClaimPayout } from "../src/ledger/payout";
import { effectiveOf } from "../src/fund-modes/modes";
import { fundAutopilotEnabled } from "../src/fund-modes/flag";
import { proposeFundMode } from "../src/fund-modes/change";
import { g2Lines, g3FundDay, g4ClaimantWeek, g5PriorHumanClaim, g6EmailUnchanged } from "../src/fund-modes/guardrails";
import { readAutomationSwitch } from "../src/fund-modes/automation-read";
import { automationAllowed, automationState } from "../src/fund-modes/automation-state";
import { resolveHistoricalReview } from "../src/ledger/historical-review";
import { confirmAutomationOn, proposeAutomationOn, recordDisagreement, turnAutomationOff } from "../src/fund-modes/switch";
import { runPolicySweep } from "../src/fund-modes/policy-sweep";
import { ORIGIN, RECEIPT_PAYEE, createPolicyDatabase, insertClaim, receiptClaim, sessionFor, type PolicyDatabase, type ReceiptLineSpec } from "./support/policy-db";
import { ALL_AUTOPILOT, SWEEP_ENV, HAIKU, allOk, conflictAll, dbError, notJson, otherOrganization, setMode, setModes, stub, unsureAll, type Handler } from "./support/fund-modes";

// IAC-405 step 3 PR P (docs/plans/FUND_MODES_SCOPE.md section 5, docs/ASSUMPTIONS.md section 78), AU-01 onward: the Autopilot guardrails G1 to G9, the automated send, the kill switch and the
// database guards, on real Postgres in the isolated check project. The PayPal provider is a stub in every test, and every model call goes to a stub. Nothing here reaches a network or a key.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
let ctx: PolicyDatabase;
const open: PolicyDatabase[] = [];
beforeEach(async () => { ctx = await createPolicyDatabase("aidtrace_au", { payeeEmail: RECEIPT_PAYEE }); open.push(ctx); }, 90_000);
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); while (open.length) await open.pop()!.close(); }, 90_000);

const ORG = "cedar-hollow";
const DAY = 86_400_000;
const AUTO_ENV = { ...SWEEP_ENV, FUND_AUTOPILOT_ENABLED: "true" };
// The production paths (freeze, recognition) read the flags from the process environment.
const flags = (modes: boolean, autopilot: boolean) => { vi.stubEnv("FUND_MODES_ENABLED", modes ? "true" : "false"); vi.stubEnv("FUND_AUTOPILOT_ENABLED", autopilot ? "true" : "false"); };

// A stub provider. validatePayout is the real adapter check (allowlist and ceiling) so the automated send meets the same guard as a human send.
function provider(behaviour: "OK" | "UNKNOWN" | "NO_BALANCE" = "OK", ceiling = 50_000n) {
  const validatePayout = createPayPalAdapter({ baseUrl: "https://api-m.sandbox.paypal.com", clientId: "synthetic", clientSecret: "synthetic", payeeAllowlist: [RECEIPT_PAYEE], maxDemoPayoutCents: ceiling }, vi.fn()).validatePayout;
  return { validatePayout: vi.fn(validatePayout), balance: vi.fn<PayoutTransport["balance"]>(async () => { if (behaviour === "NO_BALANCE") throw new Error("the balance is not readable"); return { readable: false }; }),
    send: vi.fn<PayoutTransport["send"]>(async () => { if (behaviour === "UNKNOWN") throw new Error("the connection dropped"); return { httpStatus: 201, batchId: "BATCH_AU", batchStatus: "PENDING" }; }),
    batch: vi.fn<PayoutTransport["batch"]>(async () => { throw new Error("not used"); }), item: vi.fn<PayoutTransport["item"]>(async () => { throw new Error("not used"); }) } satisfies PayoutTransport;
}
type Provider = ReturnType<typeof provider>;

const lines = (n: number): ReceiptLineSpec[] => [{ description: "Robot servo kit", amount: `${40 + n}.00`, category: "robot_kits_parts" }, { description: "Classroom markers", amount: `${25 + n}.00`, category: "classroom_supplies" }];
const claimN = (n: number, spec: { lines?: ReceiptLineSpec[] } = {}) => receiptClaim(ctx.db, { vendor: `Shop number ${n}`, lines: spec.lines ?? lines(n) });
type Claim = Awaited<ReturnType<typeof claimN>>;
const claimRow = async (id: string) => (await ctx.db.select().from(s.claims).where(eq(s.claims.id, id)).orderBy(desc(s.claims.version)))[0]!;
const statusOf = async (id: string) => (await claimRow(id)).status;
const automated = (hash: string) => ctx.db.select().from(s.automatedDecisions).where(eq(s.automatedDecisions.decisionHash, hash));
const kinds = async (hash: string) => (await automated(hash)).map(row => row.kind).sort();
const approvalsOf = (hash: string) => ctx.db.select().from(s.approvals).where(eq(s.approvals.decisionHash, hash));
const disbursementsOf = (claimId: string) => ctx.db.select().from(s.disbursements).where(eq(s.disbursements.claimId, claimId));
const switchEvents = () => ctx.db.select().from(s.automationSwitchEvents).orderBy(s.automationSwitchEvents.seq);
const approve = (claim: Claim, actor: string) => approveDecision(ctx.db, claim.decisionId, actor, claim.hash);
// A pass has a provider unless the test says it is keyless (provider: null): with none the sweep recognizes nothing for Autopilot (review item 2).
const sweep = async (options: { provider?: Provider | null; audit?: () => number; env?: Record<string, string | undefined>; now?: Date; handler?: Handler } = {}) => {
  const { client } = stub(options.handler ?? allOk);
  const entries: Record<string, string | number | null>[] = [];
  const report = await runPolicySweep(ctx.db, { env: options.env ?? AUTO_ENV, model: { client }, log: entry => entries.push(entry), provider: options.provider === null ? undefined : (options.provider ?? provider()), audit: options.audit ?? (() => 50), now: options.now });
  return { report, entries };
};

// The switch is turned ON the way production does it: a proposal by one approver and the next event by a different approver.
async function switchOn(proposer = "tara", confirmer = "ben") {
  const [proposal] = await ctx.db.insert(s.automationSwitchEvents).values({ organizationId: ORG, event: "PROPOSE_ON", actorId: proposer }).returning({ seq: s.automationSwitchEvents.seq });
  await ctx.db.insert(s.automationSwitchEvents).values({ organizationId: ORG, event: "ON", actorId: confirmer, proposalSeq: proposal!.seq });
}
const plantHistory = (daysAgo: number, email = RECEIPT_PAYEE, userId = "maria") => ctx.db.insert(s.payeeEmailHistory).values({ userId, email, source: "CLAIM", seenAt: new Date(Date.now() - daysAgo * DAY) });
// An earlier claim of Maria's, recognized by two human approvals and then PAID (guardrail G5). The status is set directly: no payout is run for it.
async function priorPaidClaim() {
  flags(true, true);
  const prior = await receiptClaim(ctx.db, { vendor: "Earlier shop", lines: [{ description: "Earlier markers", amount: "30.00", category: "classroom_supplies" }] });
  expect(await approve(prior, "tara")).toMatchObject({ approvalCount: 1 });
  expect(await approve(prior, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 2 });
  await ctx.client`update claims set status = 'PAID' where id = ${prior.id}`;
  return prior;
}
// Everything an automated recognition needs, then the claim under test (frozen after the earlier claim was recognized).
async function ready(options: { changedEmail?: number; prior?: boolean; on?: boolean; modes?: Record<string, FundMode>; lines?: ReceiptLineSpec[] } = {}) {
  if (options.prior !== false) await priorPaidClaim();
  flags(true, true);
  if (options.changedEmail !== undefined) await plantHistory(options.changedEmail, "changed-address@example.invalid");
  await setModes(ctx.db, options.modes ?? ALL_AUTOPILOT);
  if (options.on !== false) await switchOn();
  return claimN(1, { lines: options.lines });
}
// Plants a sent automated payment the way the send would have left it, with the triggers off for this one transaction, so a cap test does not need a cap sized claim.
async function plantAutoSend(claim: { id: string; hash: string }, amountCents: bigint, recordedAt: Date, confirmed = true) {
  await ctx.client.begin(async q => {
    await q`set local session_replication_role = replica`;
    const [auto] = await q`insert into automated_decisions (decision_hash, kind, inputs) values (${claim.hash}, 'AUTO_SENT', '{}'::jsonb) returning id`;
    const [row] = await q`insert into disbursements (claim_id, claim_version, decision_hash, payee_email, amount_cents, recorded_at) values (${claim.id}, 1, ${claim.hash}, ${RECEIPT_PAYEE}, ${amountCents.toString()}::bigint, ${recordedAt.toISOString()}::timestamptz) returning id`;
    await q`insert into disbursement_origins (disbursement_id, automated_decision_id) values (${row!.id}, ${auto!.id})`;
    if (confirmed) await q`insert into automated_decisions (decision_hash, kind, inputs) values (${claim.hash}, 'AUTO_SEND_CONFIRMED', '{}'::jsonb)`;
  });
}
const refused = async (promise: PromiseLike<unknown>, message: RegExp) => { const error = await dbError(promise); expect(error.code, error.message).toBe("23514"); expect(error.message).toMatch(message); };

describe("AU-01 G2 line caps are inclusive on integer cents", () => {
  it("AU-01: supplies at 250.00 and equipment at 500.00 pass, one cent more goes to people, and every other budget line goes to people", async () => {
    const check = async (id: string, budgetLine: string, amountCents: bigint) => {
      await insertClaim(ctx.db, { id, lines: [{ id: "L1", category: "classroom_supplies", budgetLine, amountCents }] });
      return ctx.db.transaction(async tx => (await g2Lines(tx, await claimRow(id))).pass);
    };
    expect(await check("G2-S1", "supplies", 25_000n)).toBe(true);
    expect(await check("G2-S2", "supplies", 25_001n)).toBe(false);
    expect(await check("G2-E1", "equipment", 50_000n)).toBe(true);
    expect(await check("G2-E2", "equipment", 50_001n)).toBe(false);
    expect(await check("G2-E3", "supplies", 50_000n)).toBe(false);
    for (const line of ["other", "travel", "contractual", "personnel"]) expect(await check(`G2-X-${line}`, line, 100n), line).toBe(false);
    // One line over the cap fails the whole claim, however small the others are.
    await insertClaim(ctx.db, { id: "G2-MIX", lines: [{ id: "L1", category: "classroom_supplies", budgetLine: "supplies", amountCents: 100n }, { id: "L2", category: "classroom_supplies", budgetLine: "supplies", amountCents: 25_001n }] });
    expect(await ctx.db.transaction(async tx => g2Lines(tx, await claimRow("G2-MIX")))).toMatchObject({ pass: false, refusedLines: ["L2"] });
  });
});

describe("AU-02 and AU-03 the fund day cap and the claimant week cap", () => {
  it("AU-02: the fund total for the UTC day, with this claim's share, may reach 1,000.00 and not one cent more; yesterday does not count", async () => {
    flags(true, true);
    const planted = await claimN(1);
    const [edge] = await ctx.client`select e.fund_id, e.amount_cents::text as cents from allocation_edges e join allocation_decisions d on d.id = e.decision_id where d.decision_hash = ${planted.hash} order by e.fund_id limit 1`;
    const used = BigInt(edge!.cents as string); const fundId = edge!.fund_id as string;
    const now = new Date("2026-10-20T15:00:00Z");
    await plantAutoSend(planted, 1_000n, new Date("2026-10-20T00:00:00Z"));
    const g3 = (share: bigint, at = now) => ctx.db.transaction(tx => g3FundDay(tx, [{ fundId, lineId: "L1", amountCents: share }], at));
    expect((await g3(100_000n - used)).pass).toBe(true);
    expect((await g3(100_000n - used + 1n)).pass).toBe(false);
    expect(await g3(100_000n - used + 1n)).toMatchObject({ overFunds: [fundId], capCents: "100000" });
    // The planted send was recorded at the first instant of the UTC day, so it counts at 23:59:59 and not on the next day.
    expect((await g3(100_000n - used + 1n, new Date("2026-10-20T23:59:59Z"))).pass).toBe(false);
    expect((await g3(100_000n, new Date("2026-10-21T00:00:00Z"))).pass).toBe(true);
    expect((await g3(100_001n, new Date("2026-10-21T00:00:00Z"))).pass).toBe(false);
  });

  it("AU-03: the claimant's automated sends over 7 days plus this claim may reach 500.00; a human-approved payout and a send older than 7 days do not count", async () => {
    flags(true, true);
    const planted = await claimN(1);
    const claim = await claimRow(planted.id);
    const now = new Date("2026-10-20T12:00:00Z");
    await plantAutoSend(planted, 30_000n, new Date(now.getTime() - 3 * DAY));
    const g4 = (total: bigint, at = now) => ctx.db.transaction(tx => g4ClaimantWeek(tx, claim, total, at));
    expect((await g4(20_000n)).pass).toBe(true);
    expect((await g4(20_001n)).pass).toBe(false);
    expect(await g4(20_000n)).toMatchObject({ usedCents: "30000", capCents: "50000" });
    // 7 days and one second after the send, it no longer counts.
    expect((await g4(50_000n, new Date(now.getTime() + 4 * DAY + 1_000))).pass).toBe(true);
    expect((await g4(50_001n, new Date(now.getTime() + 4 * DAY + 1_000))).pass).toBe(false);
    // A human-approved payout signed by an approver is not an automated send.
    const human = await claimN(2);
    await ctx.client.begin(async q => {
      await q`set local session_replication_role = replica`;
      const [row] = await q`insert into disbursements (claim_id, claim_version, decision_hash, payee_email, amount_cents, recorded_at) values (${human.id}, 1, ${human.hash}, ${RECEIPT_PAYEE}, 40000, ${now.toISOString()}::timestamptz) returning id`;
      await q`insert into disbursement_origins (disbursement_id, signed_by) values (${row!.id}, 'tara')`;
    });
    expect(await g4(20_000n)).toMatchObject({ usedCents: "30000", pass: true });
  });
});

describe("AU-04 G5 an earlier claim paid after two human approvals", () => {
  it("AU-04: no earlier claim, an earlier claim not yet paid and an earlier claim with one approval fail; a paid claim with two human approvals passes", async () => {
    flags(true, true);
    const oneApproval = await receiptClaim(ctx.db, { vendor: "Shop A", lines: [{ description: "Earlier markers", amount: "30.00", category: "classroom_supplies" }] });
    const twoApprovals = await receiptClaim(ctx.db, { vendor: "Shop B", lines: [{ description: "Other markers", amount: "31.00", category: "classroom_supplies" }] });
    const later = await claimN(1);
    const g5 = async (at: Date) => ctx.db.transaction(async tx => g5PriorHumanClaim(tx, await claimRow(later.id), at));
    const after = () => new Date(Date.now() + 1_000);
    expect((await g5(after())).pass).toBe(false);
    await approve(oneApproval, "tara");
    await ctx.client`update claims set status = 'PAID' where id = ${oneApproval.id}`; // marked PAID with one approval and never recognized
    expect((await g5(after())).pass).toBe(false);
    await approve(twoApprovals, "tara"); expect(await approve(twoApprovals, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 2 });
    expect((await g5(after())).pass).toBe(false); // recognized by two approvals but not PAID yet
    await ctx.client`update claims set status = 'PAID' where id = ${twoApprovals.id}`;
    expect(await g5(after())).toMatchObject({ pass: true, priorClaim: twoApprovals.id });
    // The earlier claim must have been recognized before this decision was frozen.
    expect((await g5(new Date(Date.now() - 3_600_000))).pass).toBe(false);
  });
});

describe("AU-05 G6 the payout email unchanged for 30 days", () => {
  // Tara stands in for a claimant with no seeded history: her claim creation row is new, so only the planted rows count.
  const taraClaim = async (id: string) => { await insertClaim(ctx.db, { id, claimantId: "tara", lines: [{ id: "L1", category: "classroom_supplies", budgetLine: "supplies", amountCents: 100n }] }); return id; };
  const g6 = (id: string) => ctx.db.transaction(async tx => g6EmailUnchanged(tx, await claimRow(id), new Date()));

  it("AU-05: no history and 29 days fail, 30 days passes, a later change fails", async () => {
    const id = await taraClaim("G6-A");
    expect((await g6(id)).pass).toBe(false);
    await plantHistory(29, RECEIPT_PAYEE, "tara"); expect((await g6(id)).pass).toBe(false);
    await plantHistory(30, RECEIPT_PAYEE, "tara"); expect(await g6(id)).toMatchObject({ pass: true, demoHistory: false, changedSince: 0 });
    await plantHistory(10, "someone-else@example.invalid", "tara"); expect(await g6(id)).toMatchObject({ pass: false, changedSince: 1 });
  });

  it("AU-05: an address that was different 40 days ago and has been the current one for 35 days passes", async () => {
    const id = await taraClaim("G6-B");
    await plantHistory(40, "old-address@example.invalid", "tara"); await plantHistory(35, RECEIPT_PAYEE, "tara");
    expect(await g6(id)).toMatchObject({ pass: true });
  });

  it("AU-05: a claim written for an address that differs from the latest anchor fails", async () => {
    const id = await taraClaim("G6-C");
    await plantHistory(45, "old-address@example.invalid", "tara");
    expect(await g6(id)).toMatchObject({ pass: false, anchorMatches: false });
  });
});

describe("AU-06 decision 5: the demo history row", () => {
  it("AU-06: after seeding, G6 passes for Maria's seeded claim from a FIXTURE row read as demo history, and fails for a claimant with no history", async () => {
    const seeded = await ctx.db.select().from(s.payeeEmailHistory).where(eq(s.payeeEmailHistory.source, "FIXTURE"));
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({ userId: "maria", email: RECEIPT_PAYEE, source: "FIXTURE" });
    const ageDays = (Date.now() - seeded[0]!.seenAt.getTime()) / DAY;
    expect(ageDays).toBeGreaterThan(44.9); expect(ageDays).toBeLessThan(45.1);
    const c104 = await claimRow("C-104");
    expect(c104.payeeEmail).toBe(RECEIPT_PAYEE);
    expect(await ctx.db.transaction(tx => g6EmailUnchanged(tx, c104, new Date()))).toMatchObject({ pass: true, demoHistory: true, anchorSource: "FIXTURE" });
    // Any other claimant has no history: the claim creation row is new, so G6 fails.
    await insertClaim(ctx.db, { id: "NO-HISTORY", claimantId: "tara", lines: [{ id: "L1", category: "classroom_supplies", budgetLine: "supplies", amountCents: 100n }] });
    expect(await ctx.db.transaction(async tx => g6EmailUnchanged(tx, await claimRow("NO-HISTORY"), new Date()))).toMatchObject({ pass: false, anchorSource: null, demoHistory: false });
  });

  it("AU-06: creating a claim writes the CLAIM source only, and the seed ran once", async () => {
    await insertClaim(ctx.db, { id: "NEW-ONE", claimantId: "maria", lines: [{ id: "L1", category: "classroom_supplies", budgetLine: "supplies", amountCents: 100n }] });
    const rows = await ctx.db.select().from(s.payeeEmailHistory).orderBy(s.payeeEmailHistory.seenAt);
    expect(rows.filter(row => row.source === "FIXTURE")).toHaveLength(1);
    const claimRows = rows.filter(row => row.source === "CLAIM");
    expect(claimRows.length).toBeGreaterThan(0);
    expect(claimRows.every(row => row.source === "CLAIM")).toBe(true);
    // The history is append-only.
    await refused(ctx.client`update payee_email_history set email = 'x@example.invalid'`, /Immutable/);
  });
});

describe("AU-07 an Autopilot claim is recognized and sent with no human approval", () => {
  it("AU-07: one sweep recognizes it, sends once as AT-<disbursement>-1, records the guardrail inputs and shows no approval", async () => {
    const claim = await ready();
    const stubbed = provider();
    const { report } = await sweep({ provider: stubbed });
    expect(report).toMatchObject({ status: "DONE", considered: 1, recognized: 1, autopilot: { recognized: 1, routedToPeople: 0, sent: 1, sendBlocked: 0, unknownSends: 0 } });
    expect(await approvalsOf(claim.hash)).toEqual([]);
    expect(await kinds(claim.hash)).toEqual(["AUTO_RECOGNIZED", "AUTO_SEND_CONFIRMED", "AUTO_SENT"]);
    const recognized = (await automated(claim.hash)).find(row => row.kind === "AUTO_RECOGNIZED")!;
    const inputs = recognized.inputs as { guardrails: Record<string, { pass: boolean; draw?: number }>; claimCents: string };
    expect(Object.keys(inputs.guardrails).sort()).toEqual(["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"]);
    for (const result of Object.values(inputs.guardrails)) expect(result.pass).toBe(true);
    expect(inputs.guardrails.G7!.draw).toBe(50);
    expect(inputs.claimCents).toBe("6700");
    expect(stubbed.send).toHaveBeenCalledTimes(1);
    const [disbursement] = await disbursementsOf(claim.id);
    const [attempt] = await ctx.db.select().from(s.disbursementAttempts).where(eq(s.disbursementAttempts.disbursementId, disbursement!.id));
    expect(attempt!.senderBatchId).toBe(`AT-${disbursement!.id}-1`);
    const [origin] = await ctx.db.select().from(s.disbursementOrigins).where(eq(s.disbursementOrigins.disbursementId, disbursement!.id));
    expect(origin).toMatchObject({ signedBy: null });
    expect(origin!.automatedDecisionId).toBe((await automated(claim.hash)).find(row => row.kind === "AUTO_SENT")!.id);
    expect(await statusOf(claim.id)).toBe("PAYOUT_PROCESSING");
    const [entries] = await ctx.client`select count(*)::int as n from journal_entries where source_type = 'claim_recognition' and source_id = ${(await ctx.db.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.decisionHash, claim.hash)))[0]!.id}`;
    expect(entries!.n).toBe(2);
  });

  it("AU-07: a human send still writes a signed_by origin row, and a second pass sends nothing again", async () => {
    flags(true, false);
    const claim = await claimN(1);
    await approve(claim, "tara"); await approve(claim, "ben");
    const { sendClaimPayout } = await import("../src/ledger/payout");
    await sendClaimPayout(ctx.db, claim.id, "tara", claim.hash, provider());
    const [disbursement] = await disbursementsOf(claim.id);
    const [origin] = await ctx.db.select().from(s.disbursementOrigins).where(eq(s.disbursementOrigins.disbursementId, disbursement!.id));
    expect(origin).toMatchObject({ signedBy: "tara", automatedDecisionId: null });
  });
});

describe("AU-08 a claim that misses a guardrail goes to people", () => {
  const stays = async (claim: Claim, stubbed: Provider) => {
    expect(stubbed.send).not.toHaveBeenCalled();
    expect(await statusOf(claim.id)).toBe("AWAITING_APPROVAL");
    expect(await disbursementsOf(claim.id)).toEqual([]);
    expect(await kinds(claim.hash)).not.toContain("AUTO_RECOGNIZED");
    // The people path is untouched: two approvals still recognize it.
    await approve(claim, "tara");
    expect(await approve(claim, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 2 });
  };

  it("AU-08: no earlier human-approved paid claim (G5) records GUARDRAIL_REFUSED naming G5", async () => {
    const claim = await ready({ prior: false });
    const stubbed = provider();
    const { report } = await sweep({ provider: stubbed });
    expect(report).toMatchObject({ recognized: 0, autopilot: { recognized: 0, routedToPeople: 1, sent: 0 } });
    const [row] = await automated(claim.hash);
    expect(row).toMatchObject({ kind: "GUARDRAIL_REFUSED" });
    expect((row!.inputs as { guardrails: Record<string, { pass: boolean }> }).guardrails.G5!.pass).toBe(false);
    await stays(claim, stubbed);
  });

  it("AU-08: an email that changed 10 days ago (G6) goes to people", async () => {
    const claim = await ready({ changedEmail: 10 });
    const stubbed = provider();
    const { report } = await sweep({ provider: stubbed });
    expect(report).toMatchObject({ autopilot: { recognized: 0, routedToPeople: 1 } });
    expect(await kinds(claim.hash)).toEqual(["GUARDRAIL_REFUSED"]);
    const [row] = await automated(claim.hash);
    expect((row!.inputs as { guardrails: Record<string, { pass: boolean; changedSince: number }> }).guardrails.G6).toMatchObject({ pass: false, changedSince: 1 });
    await stays(claim, stubbed);
  });
  it("AU-08: a claim drawn for the 5 percent audit (G7) goes to two approvers, and a draw of 5 does not", async () => {
    const sampled = await ready();
    const stubbed = provider();
    const { report } = await sweep({ provider: stubbed, audit: () => 4 });
    expect(report).toMatchObject({ autopilot: { recognized: 0, routedToPeople: 1, sent: 0 } });
    const [row] = await automated(sampled.hash);
    expect(row).toMatchObject({ kind: "AUDIT_SAMPLED" });
    expect((row!.inputs as { guardrails: Record<string, { draw: number; sampled: boolean }> }).guardrails.G7).toMatchObject({ draw: 4, sampled: true });
    // The routing is final: another pass with a passing draw does not recognize it.
    await sweep({ provider: stubbed, audit: () => 99 });
    expect(await kinds(sampled.hash)).toEqual(["AUDIT_SAMPLED"]);
    await stays(sampled, stubbed);
  });

  it("AU-08: a draw of 5 is not sampled", async () => {
    const claim = await ready();
    const stubbed = provider();
    const { report } = await sweep({ provider: stubbed, audit: () => 5 });
    expect(report).toMatchObject({ autopilot: { recognized: 1, sent: 1 } });
    expect(stubbed.send).toHaveBeenCalledTimes(1);
    expect(await kinds(claim.hash)).toEqual(["AUTO_RECOGNIZED", "AUTO_SEND_CONFIRMED", "AUTO_SENT"]);
  });

  it("AU-08: the draw comes from the injected source, which must return a whole number from 0 to 99, and is made only when every other guardrail holds", async () => {
    const claim = await ready({ prior: false });
    const never = vi.fn(() => 1);
    await sweep({ provider: provider(), audit: never });
    expect(never).not.toHaveBeenCalled();
    expect(await kinds(claim.hash)).toEqual(["GUARDRAIL_REFUSED"]);
    expect(readFileSync("src/fund-modes/guardrails.ts", "utf8")).toMatch(/randomInt\(0, 100\)/);
  });

  it("AU-08: a line over the cap (250.01 of supplies) or a meal category never reaches an automatic payment", async () => {
    const over = await ready({ lines: [{ description: "Large classroom order", amount: "250.01", category: "classroom_supplies" }] });
    const stubbed = provider();
    await sweep({ provider: stubbed });
    expect(await kinds(over.hash)).not.toContain("AUTO_RECOGNIZED");
    expect(stubbed.send).not.toHaveBeenCalled();
    expect(await statusOf(over.id)).toBe("AWAITING_APPROVAL");
    const meal = await claimN(2, { lines: [{ description: "Pizza party", amount: "20.00", category: "participant_meals" }] });
    await sweep({ provider: stubbed });
    expect(await kinds(meal.hash)).not.toContain("AUTO_RECOGNIZED");
    expect(stubbed.send).not.toHaveBeenCalled();
  });
});

describe("AU-09 two sweeps at once send once", () => {
  it("AU-09: concurrent passes recognize once and the stub provider is called once", async () => {
    const claim = await ready();
    const stubbed = provider();
    const [one, two] = await Promise.all([sweep({ provider: stubbed }), sweep({ provider: stubbed })]);
    expect(stubbed.send).toHaveBeenCalledTimes(1);
    expect(await disbursementsOf(claim.id)).toHaveLength(1);
    expect(await kinds(claim.hash)).toEqual(["AUTO_RECOGNIZED", "AUTO_SEND_CONFIRMED", "AUTO_SENT"]);
    expect([one.report, two.report].every(report => report.status === "DONE")).toBe(true);
    const direct = await sendAutomatedPayout(ctx.db, claim.id, claim.hash, stubbed, { env: AUTO_ENV });
    expect(direct).toEqual({ status: "BLOCKED", reason: "NOT_APPROVED" });
    expect(stubbed.send).toHaveBeenCalledTimes(1);
  });
});

describe("AU-10 and AU-11 the send re-checks the switch and the mode", () => {
  it("AU-10: the switch turned off before the next pass stops the send, and a pass with it on again sends", async () => {
    const claim = await ready();
    const first = await sweep({ provider: provider("NO_BALANCE") });
    expect(first.report).toMatchObject({ autopilot: { recognized: 1, sent: 0 } });
    expect(await statusOf(claim.id)).toBe("APPROVED");
    expect(await disbursementsOf(claim.id)).toEqual([]);
    expect(await turnAutomationOff(ctx.db, { id: "ben" }, { env: AUTO_ENV })).toEqual({ status: "OFF" });
    const stubbed = provider();
    const stopped = await sweep({ provider: stubbed });
    expect(stopped.report).toMatchObject({ autopilot: { sent: 0, sendBlocked: 1 } });
    expect(stopped.entries.find(entry => entry.event === "send-blocked")).toMatchObject({ reason: "SWITCH_OFF" });
    expect(stubbed.send).not.toHaveBeenCalled();
    expect(await sendAutomatedPayout(ctx.db, claim.id, claim.hash, stubbed, { env: AUTO_ENV })).toEqual({ status: "BLOCKED", reason: "SWITCH_OFF" });
    expect(await disbursementsOf(claim.id)).toEqual([]);
    expect(await statusOf(claim.id)).toBe("APPROVED");
    // Two approvers turn it on again: the same claim goes out on the next pass.
    const proposal = await proposeAutomationOn(ctx.db, { id: "tara" }, { env: AUTO_ENV });
    if (proposal.status !== "PROPOSED") throw new Error("expected a proposal");
    expect(await confirmAutomationOn(ctx.db, { id: "ben" }, proposal.seq, { env: AUTO_ENV })).toEqual({ status: "ON" });
    await sweep({ provider: stubbed });
    expect(stubbed.send).toHaveBeenCalledTimes(1);
  });

  it("AU-11: a fund moved to Manual between recognition and send blocks the automated send, and one to Assisted does too; the claim stays APPROVED and unsent until people take over (AU-49)", async () => {
    const claim = await ready();
    await sweep({ provider: provider("NO_BALANCE") });
    expect(await statusOf(claim.id)).toBe("APPROVED");
    await setMode(ctx.db, "fund_a", "MANUAL");
    const stubbed = provider();
    const first = await sweep({ provider: stubbed });
    expect(first.entries.find(entry => entry.event === "send-blocked")).toMatchObject({ reason: "MODE_CHANGED" });
    expect(stubbed.send).not.toHaveBeenCalled();
    await setMode(ctx.db, "fund_a", "ASSISTED");
    expect(await sendAutomatedPayout(ctx.db, claim.id, claim.hash, stubbed, { env: AUTO_ENV })).toEqual({ status: "BLOCKED", reason: "MODE_CHANGED" });
    expect(await approvalsOf(claim.hash)).toEqual([]); // nobody has taken it over, so nothing moves it
    expect(await disbursementsOf(claim.id)).toEqual([]);
    expect(await statusOf(claim.id)).toBe("APPROVED");
  });

  it("AU-11: with the second flag off the automated send refuses even a recognized claim", async () => {
    const claim = await ready();
    await sweep({ provider: provider("NO_BALANCE") });
    const stubbed = provider();
    expect(await sendAutomatedPayout(ctx.db, claim.id, claim.hash, stubbed, { env: { ...AUTO_ENV, FUND_AUTOPILOT_ENABLED: "false" } })).toEqual({ status: "BLOCKED", reason: "FLAG_OFF" });
    expect(stubbed.send).not.toHaveBeenCalled();
  });

  it("AU-11: the day cap and the week cap are checked again at the send", async () => {
    const claim = await ready();
    await sweep({ provider: provider("NO_BALANCE") }); // recognized, not sent
    const planted = await claimN(2);
    await plantAutoSend(planted, 50_000n - 6_700n + 1n, new Date());
    const stubbed = provider();
    expect(await sendAutomatedPayout(ctx.db, claim.id, claim.hash, stubbed, { env: AUTO_ENV })).toEqual({ status: "BLOCKED", reason: "G4_CLAIMANT_WEEK_CAP" });
    expect(stubbed.send).not.toHaveBeenCalled();
    expect(await disbursementsOf(claim.id)).toEqual([]);
  });
});

describe("AU-12 Disagree trips the switch", () => {
  it("AU-12: an approver who is not the claimant turns automation off with reason DISAGREE; the claimant, a non-automated claim, another organization and a missing flag are refused", async () => {
    const claim = await ready();
    await sweep({ provider: provider() });
    await otherOrganization(ctx.db);
    expect(await recordDisagreement(ctx.db, { id: "maria" }, claim.id, { env: AUTO_ENV })).toEqual({ status: "REFUSED", reason: "APPROVER_REQUIRED" });
    expect(await recordDisagreement(ctx.db, { id: "zed" }, claim.id, { env: AUTO_ENV })).toEqual({ status: "REFUSED", reason: "NOT_FOUND" });
    expect(await recordDisagreement(ctx.db, { id: "tara" }, claim.id, { env: { ...AUTO_ENV, FUND_AUTOPILOT_ENABLED: undefined } })).toEqual({ status: "REFUSED", reason: "FLAG_OFF" });
    expect(await recordDisagreement(ctx.db, { id: "tara" }, "C-104", { env: AUTO_ENV })).toEqual({ status: "REFUSED", reason: "NOT_AUTOMATED" });
    expect((await switchEvents()).filter(event => event.event === "OFF")).toEqual([]);
    expect(await recordDisagreement(ctx.db, { id: "tara" }, claim.id, { env: AUTO_ENV })).toEqual({ status: "OFF" });
    const off = (await switchEvents()).filter(event => event.event === "OFF");
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({ reason: "DISAGREE", actorId: "tara", decisionHash: claim.hash });
    const view = await readAutomationSwitch(ctx.db, { id: "ben" }, { env: AUTO_ENV });
    expect(view).toMatchObject({ status: "OK", view: { on: false, lastOff: { reason: "DISAGREE" } } });
    // The next claim is not recognized while the switch is off.
    const next = await claimN(2);
    const { report } = await sweep({ provider: provider() });
    expect(report).toMatchObject({ autopilot: { recognized: 0, switchOff: 1 } });
    expect(await kinds(next.hash)).toEqual([]);
  });
});

describe("AU-13 an UNKNOWN automated send trips the switch and is never retried", () => {
  it("AU-13: the attempt stays UNKNOWN, automation turns off, a later pass sends nothing, and it stays paused after the switch is turned on until the outcome is resolved", async () => {
    const claim = await ready();
    const unknown = provider("UNKNOWN");
    const { report } = await sweep({ provider: unknown });
    expect(report).toMatchObject({ autopilot: { sent: 1, unknownSends: 1 } });
    const [disbursement] = await disbursementsOf(claim.id);
    const [attempt] = await ctx.db.select().from(s.disbursementAttempts).where(eq(s.disbursementAttempts.disbursementId, disbursement!.id));
    expect(attempt).toMatchObject({ state: "UNKNOWN", lastErrorCode: "SEND_OUTCOME_UNKNOWN" });
    expect(await statusOf(claim.id)).toBe("PAYOUT_PROCESSING");
    const off = (await switchEvents()).filter(event => event.event === "OFF");
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({ reason: "UNKNOWN_SEND", actorId: null, decisionHash: claim.hash });
    // Never retried: more passes and a direct call send nothing new.
    await sweep({ provider: unknown }); await sweep({ provider: unknown });
    expect(await sendAutomatedPayout(ctx.db, claim.id, claim.hash, unknown, { env: AUTO_ENV })).toMatchObject({ status: "BLOCKED" });
    expect(unknown.send).toHaveBeenCalledTimes(1);
    expect(await disbursementsOf(claim.id)).toHaveLength(1);
    const attempts = await ctx.db.select().from(s.disbursementAttempts).where(eq(s.disbursementAttempts.disbursementId, disbursement!.id));
    expect(attempts).toHaveLength(1);
    // Two approvers turn the switch on again. The unresolved attempt still pauses automation for the next claim.
    const proposal = await proposeAutomationOn(ctx.db, { id: "tara" }, { env: AUTO_ENV });
    if (proposal.status !== "PROPOSED") throw new Error("expected a proposal");
    await confirmAutomationOn(ctx.db, { id: "ben" }, proposal.seq, { env: AUTO_ENV });
    const view = await readAutomationSwitch(ctx.db, { id: "ben" }, { env: AUTO_ENV });
    expect(view).toMatchObject({ view: { on: true, unknownOutstanding: true } });
    const next = await claimN(2);
    const second = await sweep({ provider: unknown });
    expect(second.report).toMatchObject({ autopilot: { recognized: 0, switchOff: 1 } });
    expect(await kinds(next.hash)).toEqual([]);
    expect(unknown.send).toHaveBeenCalledTimes(1);
  });
});

describe("AU-14 to AU-16 the flags and the effective mode", () => {
  it("AU-14: the second flag is on only for exactly true and only with the first; with it off an Autopilot row is Manual everywhere", async () => {
    for (const value of [undefined, "", "false", "TRUE", "True", "1", "yes", " true", "true ", "on"]) expect(fundAutopilotEnabled({ FUND_MODES_ENABLED: "true", FUND_AUTOPILOT_ENABLED: value }), JSON.stringify(value)).toBe(false);
    expect(fundAutopilotEnabled({ FUND_AUTOPILOT_ENABLED: "true" })).toBe(false);
    expect(fundAutopilotEnabled({ FUND_MODES_ENABLED: "false", FUND_AUTOPILOT_ENABLED: "true" })).toBe(false);
    expect(fundAutopilotEnabled({ FUND_MODES_ENABLED: "true", FUND_AUTOPILOT_ENABLED: "true" })).toBe(true);
    expect(effectiveOf("AUTOPILOT", { FUND_MODES_ENABLED: "true" })).toBe("MANUAL");
    expect(effectiveOf("AUTOPILOT", { FUND_MODES_ENABLED: "true", FUND_AUTOPILOT_ENABLED: "true" })).toBe("AUTOPILOT");
    expect(effectiveOf("ASSISTED", { FUND_MODES_ENABLED: "true" })).toBe("ASSISTED");
    await setModes(ctx.db, ALL_AUTOPILOT);
    flags(true, false);
    const claim = await claimN(1);
    expect((await ctx.db.select().from(s.decisionModes).where(eq(s.decisionModes.decisionHash, claim.hash)))[0]).toMatchObject({ effectiveMode: "MANUAL" });
    const stubbed = provider();
    const { report } = await sweep({ provider: stubbed, env: { ...SWEEP_ENV } });
    expect(report).toEqual({ status: "DONE", considered: 0, rulesRuns: 0, modelRuns: 0, held: 0, recognized: 0, failed: 0 });
    expect(stubbed.send).not.toHaveBeenCalled();
    // Even a decision recorded as Autopilot while the flag was on is left to people when the flag is turned off.
    flags(true, true);
    const recorded = await claimN(2);
    expect((await ctx.db.select().from(s.decisionModes).where(eq(s.decisionModes.decisionHash, recorded.hash)))[0]).toMatchObject({ effectiveMode: "AUTOPILOT" });
    flags(true, false);
    const off = await sweep({ provider: stubbed, env: { ...SWEEP_ENV } });
    expect(off.report).toMatchObject({ considered: 0 });
    expect(await kinds(recorded.hash)).toEqual([]);
  });

  it("AU-14: a proposal of Autopilot is refused with the second flag off and made with it on", async () => {
    const off = await proposeFundMode(ctx.db, { id: "tara" }, "fund_a", "AUTOPILOT", { env: { FUND_MODES_ENABLED: "true" } });
    expect(off).toMatchObject({ status: "REFUSED" });
    expect(await ctx.db.select().from(s.fundModeProposals)).toEqual([]);
    const on = await proposeFundMode(ctx.db, { id: "tara" }, "fund_a", "AUTOPILOT", { env: AUTO_ENV });
    expect(on).toMatchObject({ status: "PROPOSED" });
  });

  it("AU-15: a Manual fund is untouched with both flags on: two approvals, no automated record, no send", async () => {
    flags(true, true);
    await setModes(ctx.db, { fund_a: "MANUAL", fund_b: "MANUAL", fund_g: "MANUAL" });
    await switchOn(); await plantHistory(40);
    const claim = await claimN(1);
    const stubbed = provider();
    const { report } = await sweep({ provider: stubbed });
    expect(report).toMatchObject({ considered: 0, recognized: 0 });
    expect(await automated(claim.hash)).toEqual([]);
    expect(await approve(claim, "tara")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    expect(await approve(claim, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 2 });
    expect(stubbed.send).not.toHaveBeenCalled();
  });

  it("AU-16: a claim split across an Autopilot fund and an Assisted fund is Assisted: no automatic recognition, one approval with clean checks", async () => {
    const claim = await ready({ modes: { fund_a: "AUTOPILOT", fund_b: "ASSISTED", fund_g: "AUTOPILOT" } });
    expect((await ctx.db.select().from(s.decisionModes).where(eq(s.decisionModes.decisionHash, claim.hash)))[0]).toMatchObject({ effectiveMode: "ASSISTED" });
    const stubbed = provider();
    const { report } = await sweep({ provider: stubbed });
    expect(report.status === "DONE" && report.autopilot).toMatchObject({ recognized: 0, sent: 0 });
    expect(await kinds(claim.hash)).not.toContain("AUTO_RECOGNIZED");
    expect(stubbed.send).not.toHaveBeenCalled();
    expect(await approve(claim, "tara")).toMatchObject({ status: "APPROVED", approvalCount: 1 });
    expect(await kinds(claim.hash)).toContain("NO_HOLDS");
  });
});

describe("AU-17 the switch-on trigger", () => {
  const insert = (patch: { organizationId?: string; event?: string; actorId?: string | null; proposalSeq?: number | null; reason?: string | null; decisionHash?: string | null }) => ctx.client`
    insert into automation_switch_events (organization_id, event, actor_id, proposal_seq, reason, decision_hash)
    values (${patch.organizationId ?? ORG}, ${patch.event ?? "PROPOSE_ON"}, ${patch.actorId === undefined ? "tara" : patch.actorId}, ${patch.proposalSeq ?? null}, ${patch.reason ?? null}, ${patch.decisionHash ?? null}) returning seq`;

  it("AU-17: one approver cannot propose and confirm, the claimant cannot propose, another organization cannot confirm, and an ON with no proposal is refused", async () => {
    await otherOrganization(ctx.db);
    await refused(insert({ actorId: "maria" }), /by an approver of its organization/);
    await refused(insert({ event: "ON" }), /Turning automation on confirms a proposal|check/);
    const [proposal] = await insert({ actorId: "tara" });
    await refused(insert({ event: "ON", actorId: "tara", proposalSeq: proposal!.seq as number }), /two distinct approvers/);
    await refused(insert({ event: "ON", actorId: "zed", proposalSeq: proposal!.seq as number }), /by an approver of its organization|same organization/);
    await refused(insert({ organizationId: "other-org", event: "ON", actorId: "zed", proposalSeq: proposal!.seq as number }), /same organization/);
    await refused(insert({ organizationId: "other-org", event: "PROPOSE_ON", actorId: "tara" }), /by an approver of its organization/);
    expect((await ctx.client`select count(*)::int as n from automation_switch_events`)[0]).toMatchObject({ n: 1 });
    await insert({ event: "ON", actorId: "ben", proposalSeq: proposal!.seq as number });
    // A used proposal cannot be confirmed twice, and a proposal made before a later change is stale.
    await refused(insert({ event: "ON", actorId: "ben", proposalSeq: proposal!.seq as number }), /./);
  });

  it("AU-17: the service refuses one approver, the claimant and a missing flag with closed codes, and a stale proposal after an off", async () => {
    expect(await proposeAutomationOn(ctx.db, { id: "tara" }, { env: { FUND_MODES_ENABLED: "true" } })).toEqual({ status: "REFUSED", reason: "FLAG_OFF" });
    expect(await proposeAutomationOn(ctx.db, { id: "maria" }, { env: AUTO_ENV })).toEqual({ status: "REFUSED", reason: "APPROVER_REQUIRED" });
    const proposal = await proposeAutomationOn(ctx.db, { id: "tara" }, { env: AUTO_ENV });
    if (proposal.status !== "PROPOSED") throw new Error("expected a proposal");
    expect(await confirmAutomationOn(ctx.db, { id: "tara" }, proposal.seq, { env: AUTO_ENV })).toEqual({ status: "REFUSED", reason: "SAME_APPROVER" });
    expect(await confirmAutomationOn(ctx.db, { id: "maria" }, proposal.seq, { env: AUTO_ENV })).toEqual({ status: "REFUSED", reason: "APPROVER_REQUIRED" });
    expect(await confirmAutomationOn(ctx.db, { id: "ben" }, 0, { env: AUTO_ENV })).toEqual({ status: "REFUSED", reason: "INVALID_REQUEST" });
    expect(await confirmAutomationOn(ctx.db, { id: "ben" }, 9_999, { env: AUTO_ENV })).toEqual({ status: "REFUSED", reason: "NOT_FOUND" });
    expect(await turnAutomationOff(ctx.db, { id: "tara" }, { env: AUTO_ENV })).toEqual({ status: "REFUSED", reason: "ALREADY_OFF" });
    expect(await confirmAutomationOn(ctx.db, { id: "ben" }, proposal.seq, { env: AUTO_ENV })).toEqual({ status: "ON" });
    expect(await proposeAutomationOn(ctx.db, { id: "tara" }, { env: AUTO_ENV })).toEqual({ status: "REFUSED", reason: "ALREADY_ON" });
    expect(await turnAutomationOff(ctx.db, { id: "tara" }, { env: AUTO_ENV })).toEqual({ status: "OFF" });
    expect(await confirmAutomationOn(ctx.db, { id: "ben" }, proposal.seq, { env: AUTO_ENV })).toEqual({ status: "REFUSED", reason: "STALE_PROPOSAL" });
  });

  it("AU-17: a Disagree or an UNKNOWN trip must name an automated payment of its own organization", async () => {
    await refused(insert({ event: "OFF", actorId: "tara", reason: "DISAGREE", decisionHash: null }), /./);
    await refused(insert({ event: "OFF", actorId: "tara", reason: "DISAGREE", decisionHash: "0".repeat(64) }), /./);
  });
});

describe("AU-18 every new table refuses update, delete and truncate", () => {
  it("AU-18: payee_email_history, automation_switch_events and disbursement_origins are append-only", async () => {
    await switchOn();
    const claim = await ready({ on: false });
    await plantAutoSend(claim, 100n, new Date());
    const cases: [string, string, string][] = [
      ["payee_email_history", "update payee_email_history set email = 'x@example.invalid'", "delete from payee_email_history"],
      ["automation_switch_events", "update automation_switch_events set actor_id = 'tara'", "delete from automation_switch_events"],
      ["disbursement_origins", "update disbursement_origins set recorded_at = now()", "delete from disbursement_origins"],
    ];
    for (const [table, update, remove] of cases) {
      expect((await ctx.client.unsafe(`select count(*)::int as n from ${table}`))[0]!.n as number, table).toBeGreaterThan(0);
      await refused(ctx.client.unsafe(update), /Immutable/);
      await refused(ctx.client.unsafe(remove), /Immutable/);
      await refused(ctx.client.unsafe(`truncate ${table} cascade`), /Immutable/);
    }
  });

  it("AU-18: a disbursement origin names exactly one of a signer and an automated decision", async () => {
    const claim = await claimN(1);
    await ctx.client.begin(async q => {
      await q`set local session_replication_role = replica`;
      await q`insert into disbursements (id, claim_id, claim_version, decision_hash, payee_email, amount_cents) values ('00000000-0000-4000-8000-000000000001', ${claim.id}, 1, ${claim.hash}, ${RECEIPT_PAYEE}, 100)`;
    });
    const origin = (signed: string | null, auto: string | null) => ctx.client`insert into disbursement_origins (disbursement_id, signed_by, automated_decision_id) values ('00000000-0000-4000-8000-000000000001', ${signed}, ${auto})`;
    expect((await dbError(origin(null, null))).code).toBe("23514");
    expect((await dbError(origin("tara", "00000000-0000-4000-8000-0000000000aa"))).code).not.toBe("");
    await refused(origin("maria", null), /signed by an approver of the claim organization who is not the claimant/);
    await origin("tara", null);
    expect((await dbError(origin("ben", null))).code).toBe("23505"); // one origin per disbursement
  });
});

describe("AU-19 the recognized_at guard", () => {
  const recognize = (hash: string) => ctx.client`update allocation_decisions set recognized_at = now() where decision_hash = ${hash}`;

  it("AU-19: no approval, one approval of a Manual decision and the claimant's own approval row cannot set recognized_at", async () => {
    flags(false, false);
    const claim = await claimN(1);
    await refused(recognize(claim.hash), /two approvals, one approval and a no-holds record, or a passing automated record/);
    await approve(claim, "tara");
    await refused(recognize(claim.hash), /two approvals/);
    expect((await ctx.db.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.decisionHash, claim.hash)))[0]!.recognizedAt).toBeNull();
  });

  it("AU-19: a decision with a NO_HOLDS record but no approval, and a HELD record, cannot be recognized by a direct update", async () => {
    flags(true, true);
    await setModes(ctx.db, { fund_a: "ASSISTED", fund_b: "ASSISTED", fund_g: "ASSISTED" });
    const claim = await claimN(1);
    await ctx.client`insert into automated_decisions (decision_hash, kind, inputs) values (${claim.hash}, 'HELD', '{}'::jsonb)`;
    await refused(recognize(claim.hash), /two approvals/);
  });

  it("AU-19: a hand-written AUTO_RECOGNIZED row is refused unless it carries every guardrail as passing and the runs of a decision recorded as Autopilot", async () => {
    const claim = await ready({ on: false });
    const insert = (inputs: object) => ctx.client`insert into automated_decisions (decision_hash, kind, inputs) values (${claim.hash}, 'AUTO_RECOGNIZED', ${JSON.stringify(inputs)}::jsonb)`;
    await refused(insert({}), /./);
    await refused(insert({ guardrails: { G1: { pass: true } } }), /./);
    await refused(ctx.client`insert into automated_decisions (decision_hash, kind, inputs) values (${claim.hash}, 'AUTO_SENT', '{}'::jsonb)`, /needs a recognized decision with an automated recognition record/);
    expect(await recognize(claim.hash).then(() => "ok", () => "refused")).toBe("refused");
  });

  it("AU-19: two approvals and one approval with a NO_HOLDS record still recognize through the service", async () => {
    flags(false, false);
    const manual = await claimN(1);
    await approve(manual, "tara");
    expect(await approve(manual, "ben")).toMatchObject({ status: "APPROVED" });
    flags(true, true);
    await setModes(ctx.db, { fund_a: "ASSISTED", fund_b: "ASSISTED", fund_g: "ASSISTED" });
    const assisted = await claimN(2);
    await sweep({ provider: provider() });
    expect(await approve(assisted, "tara")).toMatchObject({ status: "APPROVED", approvalCount: 1 });
  });
});

describe("AU-20 SEC-01 repeated for the automated path", () => {
  it("AU-20: an automated send meets the adapter guard: a payee off the allowlist, an amount over the ceiling and a placeholder payee send nothing and persist nothing", async () => {
    const claim = await ready();
    await sweep({ provider: provider("NO_BALANCE") }); // recognized, not sent
    // Ceiling below the claim total.
    const low = provider("OK", 6_699n);
    expect(await sendAutomatedPayout(ctx.db, claim.id, claim.hash, low, { env: AUTO_ENV })).toEqual({ status: "BLOCKED", reason: "PAYOUT_REFUSED" });
    expect(low.send).not.toHaveBeenCalled();
    // A provider whose allowlist lacks the payee.
    const stranger = { ...provider(), validatePayout: createPayPalAdapter({ baseUrl: "https://api-m.sandbox.paypal.com", clientId: "synthetic", clientSecret: "synthetic", payeeAllowlist: ["someone-else@example.invalid"], maxDemoPayoutCents: 50_000n }, vi.fn()).validatePayout };
    expect(await sendAutomatedPayout(ctx.db, claim.id, claim.hash, stranger, { env: AUTO_ENV })).toEqual({ status: "BLOCKED", reason: "PAYOUT_REFUSED" });
    expect(stranger.send).not.toHaveBeenCalled();
    expect(await disbursementsOf(claim.id)).toEqual([]);
    expect(await ctx.client`select count(*)::int as n from disbursement_attempts`).toMatchObject([{ n: 0 }]);
    expect(await kinds(claim.hash)).toEqual(["AUTO_RECOGNIZED"]);
    expect(await statusOf(claim.id)).toBe("APPROVED");
    // The balance is read through the stub and a short readable balance blocks too.
    const short = provider(); short.balance.mockResolvedValue({ readable: true, availableCents: 100n });
    expect(await sendAutomatedPayout(ctx.db, claim.id, claim.hash, short, { env: AUTO_ENV })).toEqual({ status: "BLOCKED", reason: "BALANCE_SHORT" });
    expect(short.send).not.toHaveBeenCalled();
    // Everything in order: it sends.
    const fine = provider();
    expect(await sendAutomatedPayout(ctx.db, claim.id, claim.hash, fine, { env: AUTO_ENV })).toMatchObject({ status: "SENT" });
    expect(fine.send).toHaveBeenCalledTimes(1);
    expect(await sendAutomatedPayout(ctx.db, claim.id, claim.hash, fine, { env: AUTO_ENV })).toEqual({ status: "BLOCKED", reason: "NOT_APPROVED" });
    expect(fine.send).toHaveBeenCalledTimes(1);
  });

  it("AU-20: the wrong decision hash and a claim of another claimant's decision are refused", async () => {
    const claim = await ready();
    await sweep({ provider: provider("NO_BALANCE") });
    const stubbed = provider();
    expect(await sendAutomatedPayout(ctx.db, claim.id, "f".repeat(64), stubbed, { env: AUTO_ENV })).toEqual({ status: "BLOCKED", reason: "NO_DECISION" });
    expect(stubbed.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// IAC-405 PR P independent review, items 1 to 8 (docs/ASSUMPTIONS.md section 78). AU-40 onward.
const BIG = [{ description: "Robot servo kit", amount: "200.00", category: "robot_kits_parts" }] satisfies ReceiptLineSpec[];
const NO_SEND = () => provider("NO_BALANCE");
// Holds the organization advisory lock in a separate transaction, runs the caller while it is held, then commits an OFF event before it releases the lock.
async function offWhileWaiting<T>(start: () => Promise<T>): Promise<T> {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let locked!: () => void; const gotLock = new Promise<void>(resolve => { locked = resolve; });
  const holder = ctx.client.begin(async q => {
    await q`select pg_advisory_xact_lock(hashtext(${ORG})::bigint)`; locked(); await gate;
    await q`insert into automation_switch_events (organization_id, event, reason, actor_id) values (${ORG}, 'OFF', 'APPROVER', 'ben')`;
  });
  await gotLock; const pending = start(); await new Promise(resolve => setTimeout(resolve, 800)); release(); await holder;
  return pending;
}

describe("AU-40 G3 and G4 count recognized claims that are not sent yet", () => {
  it("AU-40: three 200.00 claims of one claimant in one pass, only the two that fit the 500.00 week cap are recognized, the third is GUARDRAIL_REFUSED for G4", async () => {
    const first = await ready({ lines: BIG });
    const all: Claim[] = [first, await claimN(2, { lines: BIG }), await claimN(3, { lines: BIG })];
    const { report } = await sweep({ provider: NO_SEND() });
    expect(report).toMatchObject({ autopilot: { recognized: 2, routedToPeople: 1, sent: 0 } });
    for (const claim of all.slice(0, 2)) { expect(await statusOf(claim.id), claim.id).toBe("APPROVED"); expect(await kinds(claim.hash)).toEqual(["AUTO_RECOGNIZED"]); }
    for (const claim of all.slice(2)) {
      expect(await statusOf(claim.id), claim.id).toBe("AWAITING_APPROVAL"); expect(await kinds(claim.hash)).toEqual(["GUARDRAIL_REFUSED"]);
      expect(((await automated(claim.hash))[0]!.inputs as { failed: string[] }).failed).toEqual(["G4"]);
      expect(await approvalsOf(claim.hash)).toEqual([]);
    }
  });

  it("AU-40: G3 and G4 report the recognized-unsent amount, exclude the decision under evaluation, and the cap holds across a recognized claim and a sent one", async () => {
    const first = await ready({ lines: BIG });
    await sweep({ provider: NO_SEND() });
    expect(await statusOf(first.id)).toBe("APPROVED");
    const claim = await claimRow(first.id);
    const edges = await ctx.db.select({ fundId: s.allocationEdges.fundId, lineId: s.allocationEdges.lineId, amountCents: s.allocationEdges.amountCents }).from(s.allocationEdges).where(eq(s.allocationEdges.claimId, first.id));
    const now = new Date();
    const own = await ctx.db.transaction(async tx => ({ g3: await g3FundDay(tx, edges, now, first.hash), g4: await g4ClaimantWeek(tx, claim, 20_000n, now, first.hash) }));
    expect(own.g3).toMatchObject({ pass: true, recognizedUnsentCents: "0" }); expect(own.g4).toMatchObject({ pass: true, usedCents: "0", recognizedUnsentCents: "0" });
    const other = await ctx.db.transaction(async tx => ({ g3: await g3FundDay(tx, edges, now), g4: await g4ClaimantWeek(tx, claim, 20_000n, now) }));
    expect(other.g3).toMatchObject({ recognizedUnsentCents: "20000" }); expect(other.g4).toMatchObject({ pass: true, usedCents: "20000", recognizedUnsentCents: "20000" });
    // A sent 300.00 plus the recognized 200.00 leaves no room for one more cent.
    const planted = await claimN(2); await plantAutoSend(planted, 30_000n, new Date());
    const full = await ctx.db.transaction(async tx => g4ClaimantWeek(tx, claim, 1n, now));
    expect(full).toMatchObject({ pass: false, usedCents: "50000", recognizedUnsentCents: "20000" });
  });

  it("AU-40: the day cap per fund counts recognized claims too: a sent amount near the 1,000.00 cap leaves room for one recognized claim and no second", async () => {
    const first = await ready({ lines: BIG });
    const planted = await claimN(2); await plantAutoSend(planted, 1n, new Date());
    // Another claimant has no week used, so only G3 can stop the second claim of the same fund.
    const edgesOf = async (id: string) => ctx.db.select({ fundId: s.allocationEdges.fundId, lineId: s.allocationEdges.lineId, amountCents: s.allocationEdges.amountCents }).from(s.allocationEdges).where(eq(s.allocationEdges.claimId, id));
    await sweep({ provider: NO_SEND() });
    const edges = await edgesOf(first.id);
    const total = edges.reduce((sum, edge) => sum + edge.amountCents, 0n);
    const result = await ctx.db.transaction(async tx => g3FundDay(tx, edges.map(edge => ({ ...edge, amountCents: 100_000n - total + 1n })), new Date()));
    expect(result.pass).toBe(false);
  });
});

describe("AU-41 a keyless pass recognizes nothing", () => {
  it("AU-41: with no send provider the sweep stores the checks, recognizes no Autopilot claim and leaves it for people, and a later pass with a provider recognizes and sends", async () => {
    const claim = await ready();
    const keyless = await sweep({ provider: null });
    expect(keyless.report).toMatchObject({ autopilot: { recognized: 0, sent: 0 } });
    expect(keyless.entries.some(entry => entry.event === "autopilot-skipped-no-provider")).toBe(true);
    expect(await statusOf(claim.id)).toBe("AWAITING_APPROVAL");
    expect(await kinds(claim.hash)).toEqual([]);
    expect(await disbursementsOf(claim.id)).toEqual([]);
    const stubbed = provider();
    await sweep({ provider: stubbed });
    expect(stubbed.send).toHaveBeenCalledTimes(1);
    expect(await kinds(claim.hash)).toEqual(["AUTO_RECOGNIZED", "AUTO_SEND_CONFIRMED", "AUTO_SENT"]);
  });
});

describe("AU-42 the audit draw is made once", () => {
  it("AU-42: a serializable retry reuses the draw: one call to the draw source, two attempts of the transaction, and the stored draw is the one drawn", async () => {
    const claim = await ready();
    await sweep({ provider: null });
    const audit = vi.fn(() => 37);
    const real = ctx.db.transaction.bind(ctx.db);
    let attempts = 0;
    vi.spyOn(ctx.db, "transaction").mockImplementation(((work: (tx: unknown) => Promise<unknown>, config: unknown) => {
      attempts++;
      if (attempts > 1) return (real as (w: unknown, c: unknown) => Promise<unknown>)(work, config);
      return (real as (w: unknown, c: unknown) => Promise<unknown>)(async (tx: unknown) => { await work(tx); throw Object.assign(new Error("could not serialize access"), { code: "40001" }); }, config);
    }) as never);
    const result = await recognizeAutonomously(ctx.db, claim.hash, { env: AUTO_ENV, audit });
    expect(result).toMatchObject({ status: "RECOGNIZED" });
    expect(attempts).toBe(2);
    expect(audit).toHaveBeenCalledTimes(1);
    const record = (await automated(claim.hash)).find(row => row.kind === "AUTO_RECOGNIZED")!;
    expect((record.inputs as { guardrails: { G7: { draw: number } } }).guardrails.G7.draw).toBe(37);
  });
});

describe("AU-43 the lock comes first and an OFF that committed while waiting stops the work", () => {
  it("AU-43: an OFF committed while the recognition waited for the lock stops it, and writes no record", async () => {
    const claim = await ready();
    await sweep({ provider: null });
    const result = await offWhileWaiting(() => recognizeAutonomously(ctx.db, claim.hash, { env: AUTO_ENV, audit: () => 50 }));
    expect(result).toMatchObject({ status: "SWITCH_OFF", reason: "OFF" });
    expect(await kinds(claim.hash)).toEqual([]);
    expect(await statusOf(claim.id)).toBe("AWAITING_APPROVAL");
  });

  it("AU-43: an OFF committed while the send waited for the lock blocks it, sends nothing and persists nothing", async () => {
    const claim = await ready();
    await sweep({ provider: NO_SEND() });
    const stubbed = provider();
    const result = await offWhileWaiting(() => sendAutomatedPayout(ctx.db, claim.id, claim.hash, stubbed, { env: AUTO_ENV }));
    expect(result).toEqual({ status: "BLOCKED", reason: "SWITCH_OFF" });
    expect(stubbed.send).not.toHaveBeenCalled();
    expect(await disbursementsOf(claim.id)).toEqual([]);
  });
});

describe("AU-44 two approvals for good", () => {
  async function planNoHoldsRow(hash: string) {
    const outcome = await ctx.db.transaction(tx => noHoldsFor(tx, hash));
    if (!outcome.noHolds) throw new Error(`expected no holds, got ${outcome.reason}`);
    await ctx.client`insert into automated_decisions (decision_hash, kind, rules_run_id, model_run_id, rule_set_version, model, prompt_version, inputs)
      values (${hash}, 'NO_HOLDS', ${outcome.rulesRunId}, ${outcome.modelRunId}, ${outcome.ruleSetVersion}, ${outcome.model}, ${outcome.promptVersion}, '{}'::jsonb)`;
  }
  const recognizeDirectly = (hash: string) => ctx.client`update allocation_decisions set recognized_at = now() where decision_hash = ${hash}`;

  it("AU-44: a decision stored as Autopilot with one approval and a NO_HOLDS row is refused by the database, and the claim keeps waiting", async () => {
    const claim = await ready({ prior: false });
    await sweep({ provider: null });
    expect(await approve(claim, "tara")).toMatchObject({ approvalCount: 1 });
    await planNoHoldsRow(claim.hash);
    await refused(recognizeDirectly(claim.hash), /recognized only with two approvals/);
    expect(await statusOf(claim.id)).toBe("AWAITING_APPROVAL");
  });

  it("AU-44: a decision stored as Assisted that an Autopilot record routed to people is refused with one approval and a NO_HOLDS row, in the service and in the database", async () => {
    flags(true, true);
    await setModes(ctx.db, { fund_a: "ASSISTED", fund_b: "ASSISTED", fund_g: "ASSISTED" });
    const claim = await claimN(1);
    await sweep({ provider: null });
    const outcome = await ctx.db.transaction(tx => noHoldsFor(tx, claim.hash));
    if (!outcome.noHolds) throw new Error("expected no holds");
    await ctx.client`insert into automated_decisions (decision_hash, kind, rules_run_id, model_run_id, rule_set_version, model, prompt_version, inputs)
      values (${claim.hash}, 'AUDIT_SAMPLED', ${outcome.rulesRunId}, ${outcome.modelRunId}, ${outcome.ruleSetVersion}, ${outcome.model}, ${outcome.promptVersion}, '{}'::jsonb)`;
    expect(await approve(claim, "tara")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    await planNoHoldsRow(claim.hash);
    await refused(recognizeDirectly(claim.hash), /recognized only with two approvals/);
    expect(await approve(claim, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 2 });
  });

  it("AU-44: a decision refused by a guardrail and then moved to Assisted still needs two human approvals", async () => {
    const claim = await ready({ changedEmail: 10 });
    await sweep({ provider: NO_SEND() });
    expect(await kinds(claim.hash)).toEqual(["GUARDRAIL_REFUSED"]);
    await setModes(ctx.db, { fund_a: "ASSISTED", fund_b: "ASSISTED", fund_g: "ASSISTED" });
    expect(await approve(claim, "tara")).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    expect(await statusOf(claim.id)).toBe("AWAITING_APPROVAL");
    expect(await approve(claim, "ben")).toMatchObject({ status: "APPROVED", approvalCount: 2 });
  });

  it("AU-44: an Assisted decision that nothing routed to people still recognizes with one approval and clean checks", async () => {
    flags(true, true);
    await setModes(ctx.db, { fund_a: "ASSISTED", fund_b: "ASSISTED", fund_g: "ASSISTED" });
    const claim = await claimN(1);
    await sweep({ provider: null });
    expect(await approve(claim, "tara")).toMatchObject({ status: "APPROVED", approvalCount: 1 });
  });
});

describe("AU-45 G1 under Autopilot", () => {
  const holds: [string, Handler][] = [
    ["a model CONFLICT", conflictAll],
    ["a model UNSURE", unsureAll],
    ["a model escalation (Haiku objects, Sonnet then answers all OK)", (call, input, nth) => (call.model === HAIKU ? unsureAll(call, input, nth) : allOk(call, input, nth))],
    ["a pair that was not checked (the model answer was unreadable)", notJson],
  ];
  for (const [label, handler] of holds) {
    it(`AU-45: ${label} stops the automatic recognition: the claim waits for two approvers, with a HELD record and nothing recognized`, async () => {
      const claim = await ready();
      const { report } = await sweep({ provider: provider(), handler });
      expect(report).toMatchObject({ autopilot: { recognized: 0, sent: 0 } });
      expect(await statusOf(claim.id)).toBe("AWAITING_APPROVAL");
      expect(await kinds(claim.hash)).toEqual(["HELD"]);
      expect(await disbursementsOf(claim.id)).toEqual([]);
    });
  }

  it("AU-45: the strict check refuses a paying fund pair that is skipped as General when it is a restricted fund, and the default check is the one Assisted keeps using", async () => {
    const claim = await ready();
    await sweep({ provider: null });
    const before = await ctx.db.transaction(async tx => ({ assisted: await noHoldsFor(tx, claim.hash), strict: await noHoldsFor(tx, claim.hash, new Date(), { strict: true }) }));
    expect(before.assisted.noHolds).toBe(true); expect(before.strict.noHolds).toBe(true);
    // A SKIPPED GENERAL_FUND row for a restricted paying fund (the stored shape allows it), written with the triggers off.
    await ctx.client.begin(async q => {
      await q`set local session_replication_role = replica`;
      await q`insert into policy_model_results (run_id, sequence, entry, fund_id, policy_version, reason_code) select run_id, 9999, 'SKIPPED', fund_id, policy_version, 'GENERAL_FUND' from policy_model_results where entry = 'CALL' limit 1`;
    });
    const strictAfter = await ctx.db.transaction(tx => noHoldsFor(tx, claim.hash, new Date(), { strict: true }));
    expect(strictAfter).toMatchObject({ noHolds: false, reason: "MODEL_INCOMPLETE" });
  });
});

describe("AU-46 honest labels", () => {
  it("AU-46: the claim page says Paid only for a settled payment, and the approvals column says Approved under Autopilot guardrails", () => {
    expect(paymentLine("SETTLED")).toBe("Payment: Paid.");
    for (const state of [null, "UNKNOWN", "UNKNOWN_STATUS", "MANUAL_REVIEW", "SUBMITTED", "PREPARED", "FUNDING_REJECTED", "FAILED"]) expect(paymentLine(state), String(state)).not.toMatch(/\bPaid\b/);
    expect(paymentLine("UNKNOWN")).toMatch(/unknown/);
    expect(readFileSync("src/ledger/view.ts", "utf8")).toContain("AUTOPILOT_PHRASE = 'Approved under Autopilot guardrails'");
    expect(readFileSync("src/ledger/view.ts", "utf8")).not.toMatch(/Paid under/);
  });
});

describe("AU-47 a failed trip fails closed", () => {
  it("AU-47: an automated send that was never confirmed and has no OFF event after it blocks automation, even with the switch ON, until an OFF event and a new two-approver ON", async () => {
    const claim = await ready();
    const planted = await claimN(2);
    await plantAutoSend(planted, 100n, new Date(), false);
    const view = await readAutomationSwitch(ctx.db, { id: "ben" }, { env: AUTO_ENV });
    expect(view).toMatchObject({ view: { on: true, unknownOutstanding: true } });
    const blocked = await sweep({ provider: provider() });
    expect(blocked.report).toMatchObject({ autopilot: { recognized: 0, switchOff: 2 } });
    expect(await kinds(claim.hash)).toEqual([]);
    expect(await turnAutomationOff(ctx.db, { id: "ben" }, { env: AUTO_ENV })).toEqual({ status: "OFF" });
    const proposal = await proposeAutomationOn(ctx.db, { id: "tara" }, { env: AUTO_ENV });
    if (proposal.status !== "PROPOSED") throw new Error("expected a proposal");
    expect(await confirmAutomationOn(ctx.db, { id: "ben" }, proposal.seq, { env: AUTO_ENV })).toEqual({ status: "ON" });
    expect(await readAutomationSwitch(ctx.db, { id: "ben" }, { env: AUTO_ENV })).toMatchObject({ view: { on: true, unknownOutstanding: false } });
    const resumed = await sweep({ provider: provider() });
    expect(resumed.report.status === "DONE" && resumed.report.autopilot!.recognized).toBeGreaterThan(0); expect(await kinds(claim.hash)).toContain("AUTO_RECOGNIZED");
  });

  it("AU-47: a known send result leaves a confirmation in the same transaction, and a send with an UNKNOWN result leaves none", async () => {
    const ok = await ready();
    await sweep({ provider: provider() });
    expect(await kinds(ok.hash)).toEqual(["AUTO_RECOGNIZED", "AUTO_SEND_CONFIRMED", "AUTO_SENT"]);
  });
});

// IAC-405 PR P item 10 (docs/ASSUMPTIONS.md section 78 item 30): two people finish a claim whose automatic payment did not go out.
describe("AU-49 two people finish a claim whose automatic payment was blocked", () => {
  // Recognized under Autopilot, send blocked (the balance is unreadable), then the switch is turned off the way a person would.
  async function stuck() {
    const claim = await ready();
    await sweep({ provider: provider("NO_BALANCE") });
    expect(await kinds(claim.hash)).toEqual(["AUTO_RECOGNIZED"]);
    expect(await statusOf(claim.id)).toBe("APPROVED");
    return claim;
  }
  const post = (claim: Claim, token: string | null, fields: Record<string, string> = { action: "takeover" }, patch: { origin?: string | null; method?: string } = {}) => handleClaimAction(
    new Request(`${ORIGIN}/api/claims/${claim.id}/actions`, { method: patch.method ?? "POST", headers: { ...(patch.origin === null ? {} : { origin: patch.origin ?? ORIGIN }), "content-type": "application/x-www-form-urlencoded", ...(token ? { cookie: `aidtrace_session=${token}` } : {}) }, body: new URLSearchParams(fields).toString() }),
    claim.id, { db: ctx.db, provider: () => provider() });

  it("AU-49: happy path, with the switch turned off after recognition: two approvers take over, the automated send refuses, a person sends", async () => {
    const claim = await stuck();
    expect(await turnAutomationOff(ctx.db, { id: "ben" }, { env: AUTO_ENV })).toEqual({ status: "OFF" });
    expect(await approveAutoRecognized(ctx.db, claim.id, "tara")).toEqual({ status: "APPROVED", decisionHash: claim.hash, approvalCount: 1 });
    // One approval cannot send: the human send refuses before the second approval.
    const stubbed = provider();
    await expect(sendClaimPayout(ctx.db, claim.id, "tara", claim.hash, stubbed)).rejects.toThrow("Two approvers must take over this claim before it is sent");
    expect(stubbed.send).not.toHaveBeenCalled();
    expect(await disbursementsOf(claim.id)).toEqual([]);
    expect(await approveAutoRecognized(ctx.db, claim.id, "ben")).toEqual({ status: "APPROVED", decisionHash: claim.hash, approvalCount: 2 });
    // A person who did not approve cannot send; one who approved can, and the origin names that person.
    await expect(sendClaimPayout(ctx.db, claim.id, "maria", claim.hash, stubbed)).rejects.toThrow("Independent authenticated approver required");
    await sendClaimPayout(ctx.db, claim.id, "tara", claim.hash, stubbed);
    expect(stubbed.send).toHaveBeenCalledTimes(1);
    const [disbursement] = await disbursementsOf(claim.id);
    const [origin] = await ctx.db.select().from(s.disbursementOrigins).where(eq(s.disbursementOrigins.disbursementId, disbursement!.id));
    expect(origin).toMatchObject({ signedBy: "tara", automatedDecisionId: null });
    expect(await kinds(claim.hash)).toEqual(["AUTO_RECOGNIZED"]);
    expect(await statusOf(claim.id)).toBe("PAYOUT_PROCESSING");
  });

  it("AU-49: the claimant, a duplicate approver, a third approval, another organization, a paid claim and a non-automated claim are refused", async () => {
    const claim = await stuck();
    await expect(approveAutoRecognized(ctx.db, claim.id, "maria")).rejects.toThrow("Independent authenticated approver required");
    await approveAutoRecognized(ctx.db, claim.id, "tara");
    await expect(approveAutoRecognized(ctx.db, claim.id, "tara")).rejects.toThrow("The same approver cannot approve twice");
    await approveAutoRecognized(ctx.db, claim.id, "ben");
    expect(await approvalsOf(claim.hash)).toHaveLength(2);
    // approveDecision still refuses a recognized decision.
    await expect(approveDecision(ctx.db, claim.decisionId, "tara", claim.hash)).rejects.toThrow("The same approver cannot approve twice");
    // A claim with a payout takes no further approval.
    await sendClaimPayout(ctx.db, claim.id, "ben", claim.hash, provider());
    await expect(approveAutoRecognized(ctx.db, claim.id, "tara")).rejects.toThrow("A payout already exists for this claim");
    // A claim recognized by two humans is not auto-recognized, so there is nothing to finish.
    flags(true, false);
    const manual = await claimN(2);
    await approve(manual, "tara"); await approve(manual, "ben");
    await expect(approveAutoRecognized(ctx.db, manual.id, "tara")).rejects.toThrow("No automatically recognized decision to finish");
    const waiting = await claimN(3);
    await expect(approveAutoRecognized(ctx.db, waiting.id, "tara")).rejects.toThrow("No automatically recognized decision to finish");
    // Another organization comes last: the ledger model supports one organization at a time (recognition reconciles).
    await otherOrganization(ctx.db);
    await expect(approveAutoRecognized(ctx.db, waiting.id, "zed")).rejects.toThrow("Authenticated organization member required");
  });

  it("AU-49: once a person has begun the takeover the automated send refuses with HUMAN_TAKEOVER, even with the switch back on", async () => {
    const claim = await stuck();
    await approveAutoRecognized(ctx.db, claim.id, "tara");
    const stubbed = provider();
    expect(await sendAutomatedPayout(ctx.db, claim.id, claim.hash, stubbed, { env: AUTO_ENV })).toEqual({ status: "BLOCKED", reason: "HUMAN_TAKEOVER" });
    const pass = await sweep({ provider: stubbed });
    expect(pass.entries.find(entry => entry.event === "send-blocked")).toMatchObject({ reason: "HUMAN_TAKEOVER" });
    expect(stubbed.send).not.toHaveBeenCalled();
    expect(await disbursementsOf(claim.id)).toEqual([]);
  });

  it("AU-49: the count of two is for good even when the fund is Assisted afterwards, and the flags and the switch do not matter", async () => {
    const claim = await stuck();
    await setMode(ctx.db, "fund_a", "ASSISTED"); await setMode(ctx.db, "fund_b", "ASSISTED"); await setMode(ctx.db, "fund_g", "ASSISTED");
    flags(false, false);
    expect(await approveAutoRecognized(ctx.db, claim.id, "tara")).toMatchObject({ approvalCount: 1 });
    await expect(sendClaimPayout(ctx.db, claim.id, "tara", claim.hash, provider())).rejects.toThrow("Two approvers must take over this claim before it is sent");
    expect(await approveAutoRecognized(ctx.db, claim.id, "ben")).toMatchObject({ approvalCount: 2 });
    await sendClaimPayout(ctx.db, claim.id, "ben", claim.hash, provider());
    expect(await disbursementsOf(claim.id)).toHaveLength(1);
  });

  it("AU-49: the database refuses an approval on a recognized Manual decision, a third approval and an approval on a claim with a payout", async () => {
    flags(true, false);
    const manual = await claimN(2);
    await approve(manual, "tara"); await approve(manual, "ben");
    await refused(ctx.client`insert into approvals (decision_hash, approver_id) values (${manual.hash}, 'maria')`, /Autopilot recognized it/);
    await refused(ctx.client`insert into approvals (decision_hash, approver_id) values (${manual.hash}, 'tara')`, /Autopilot recognized it/);
    expect(await approvalsOf(manual.hash)).toHaveLength(2);
    const claim = await stuck();
    await ctx.client`insert into approvals (decision_hash, approver_id) values (${claim.hash}, 'tara')`;
    await ctx.client`insert into approvals (decision_hash, approver_id) values (${claim.hash}, 'ben')`;
    await refused(ctx.client`insert into approvals (decision_hash, approver_id) values (${claim.hash}, 'maria')`, /at most two/);
    expect(await approvalsOf(claim.hash)).toHaveLength(2);
  });

  it("AU-49: the database refuses an approval on an auto-recognized claim that already has a payout", async () => {
    const claim = await ready();
    await sweep({ provider: provider() });
    expect(await disbursementsOf(claim.id)).toHaveLength(1);
    await refused(ctx.client`insert into approvals (decision_hash, approver_id) values (${claim.hash}, 'tara')`, /payout takes no further approval/);
    await expect(approveAutoRecognized(ctx.db, claim.id, "tara")).rejects.toThrow("A payout already exists for this claim");
  });

  it("AU-49: the route takes the takeover from approvers only, by POST from the app origin, with no hash from the client, whatever the flags say", async () => {
    const claim = await stuck();
    flags(false, false); vi.stubEnv("APP_ORIGIN", ORIGIN);
    const maria = await sessionFor(ctx.db, "maria"); const tara = await sessionFor(ctx.db, "tara"); const ben = await sessionFor(ctx.db, "ben");
    expect((await post(claim, null)).status).toBe(401);
    expect((await post(claim, tara, { action: "takeover" }, { origin: "http://evil.example" })).status).toBe(403);
    expect((await post(claim, tara, { action: "takeover" }, { origin: null })).status).toBe(403);
    expect((await post(claim, maria)).status).toBe(403);
    expect(await approvalsOf(claim.hash)).toEqual([]);
    const saved = await post(claim, tara);
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(`/claims/${claim.id}?notice=takeover-saved`);
    const again = await post(claim, tara);
    expect(again.headers.get("location")).toBe(`/claims/${claim.id}?notice=already-approved`);
    const done = await post(claim, ben);
    expect(done.headers.get("location")).toBe(`/claims/${claim.id}?notice=takeover-done`);
    expect(await approvalsOf(claim.hash)).toHaveLength(2);
    const third = await post(claim, tara);
    expect(third.status).toBe(303);
    expect(await approvalsOf(claim.hash)).toHaveLength(2);
    // The send form is the existing one and still demands the confirmation and the current hash.
    expect((await post(claim, tara, { action: "send", decisionHash: claim.hash })).status).toBe(400);
  });

  it("AU-49: the claim page text is fixed, and the source shows the control to approvers only", () => {
    const trail = readFileSync("src/app/claims/[claimId]/automated-trail.tsx", "utf8");
    expect(trail).toContain("Automatic payment did not go out. Two approvers can finish this claim.");
    expect(trail).toContain("People: {takeovers.length} of 2");
    expect(trail).toMatch(/showTakeover = !attempt && isApprover/);
    expect(trail).toMatch(/isApprover = viewer\.role === "APPROVER" && viewer\.id !== row\.claimantId/);
  });
});

// IAC-405 PR P merge fix (PR A's reviewMode returned MANUAL for an auto-recognized claim, so the page said "Two independent approvals" next to the Autopilot trail).
describe("AU-50 the claim page reads one way for each Autopilot state", () => {
  const modeFor = async (claimId: string, viewer: string) => (await loadClaimView(ctx.db, claimId, viewer)).reviewMode;

  it("AU-50: recognized and sent with no person: AUTO_RECOGNIZED_SENT for every viewer, and the fixed lines say none required", async () => {
    const claim = await ready();
    await sweep({ provider: provider() });
    expect(await disbursementsOf(claim.id)).toHaveLength(1);
    for (const viewer of ["tara", "ben", "maria"]) expect(await modeFor(claim.id, viewer), viewer).toBe("AUTO_RECOGNIZED_SENT");
    flags(false, false); // stored records only: the flags do not change the reading
    expect(await modeFor(claim.id, "tara")).toBe("AUTO_RECOGNIZED_SENT");
    expect(reviewCopy.APPROVALS_HEADING_AUTOPILOT).toBe("Autopilot review");
    expect(reviewCopy.REVIEW_COUNT_AUTOPILOT).toBe("Human reviews: none required. Approved under Autopilot guardrails.");
    expect(reviewCopy.REFERENCE_BINDS_AUTOPILOT).toBe("The guardrail record binds this reference.");
    const paypal = { key: "submitted", rail: "x" } as never; const ai = { rail: "y" } as never;
    expect(railLines({ stage: 5, typedReceipt: true, ai, approvals: 0, paypal, required: "auto" })[3]!.state).toBe("Autopilot");
    expect(railLines({ stage: 5, typedReceipt: true, ai, approvals: 0, paypal })[3]!.state).toBe("People: 0 of 2");
  });

  it("AU-50: recognized but not sent (the send was blocked): AUTO_RECOGNIZED_PEOPLE, so the page keeps the two-person words beside the takeover sentence", async () => {
    const claim = await ready();
    await sweep({ provider: provider("NO_BALANCE") });
    expect(await disbursementsOf(claim.id)).toEqual([]);
    expect(await modeFor(claim.id, "tara")).toBe("AUTO_RECOGNIZED_PEOPLE");
    expect(await modeFor(claim.id, "maria")).toBe("AUTO_RECOGNIZED_PEOPLE");
  });

  it("AU-50: takeover state, after one approval and after the person's send: AUTO_RECOGNIZED_PEOPLE, never the none-required lines", async () => {
    const claim = await ready();
    await sweep({ provider: provider("NO_BALANCE") });
    await approveAutoRecognized(ctx.db, claim.id, "tara");
    expect(await modeFor(claim.id, "ben")).toBe("AUTO_RECOGNIZED_PEOPLE");
    await approveAutoRecognized(ctx.db, claim.id, "ben");
    await sendClaimPayout(ctx.db, claim.id, "ben", claim.hash, provider());
    expect(await modeFor(claim.id, "tara")).toBe("AUTO_RECOGNIZED_PEOPLE");
  });

  it("AU-50: a Manual claim and a claim routed to people (audit sampled) never read as Autopilot", async () => {
    flags(true, false);
    const manual = await claimN(2);
    await approve(manual, "tara"); await approve(manual, "ben");
    expect(await modeFor(manual.id, "tara")).toBe("MANUAL");
    const sampled = await ready();
    await sweep({ provider: provider(), audit: () => 0 });
    expect(await kinds(sampled.hash)).toContain("AUDIT_SAMPLED");
    expect(await modeFor(sampled.id, "tara")).toBe("MANUAL");
  });

  it("AU-50: the page source takes the new lines only from the server reading, and every new string is in review-copy", () => {
    const page = readFileSync("src/app/claims/[claimId]/page.tsx", "utf8");
    expect(page.match(/const autoReview = [^;]+;/g)).toEqual(['const autoReview = view.reviewMode === "AUTO_RECOGNIZED_SENT";']);
    expect(page).not.toMatch(/Human reviews: none required|Autopilot review|guardrail record binds/);
    expect(page).toContain("{autoReview ? REVIEW_COUNT_AUTOPILOT : <>Human reviews:");
  });
});

describe("AU-51 the title of a recognized claim that has not gone out", () => {
  it("AU-51: the new title is fixed text from review-copy, used only in the page source for the waiting takeover state, and every other title line is untouched", () => {
    expect(`$67.00 ${reviewCopy.TITLE_AUTO_NOT_SENT}`).toBe("$67.00 approved under Autopilot. Payment did not go out.");
    const page = readFileSync("src/app/claims/[claimId]/page.tsx", "utf8");
    expect(page.match(/const autoWaiting = [^;]+;/g)).toEqual(['const autoWaiting = view.reviewMode === "AUTO_RECOGNIZED_PEOPLE" && claim.status === "APPROVED" && approvals.length < 2;']);
    expect(page).toContain('autoWaiting ? `${usd(total)} ${TITLE_AUTO_NOT_SENT}` : handoffReady ? `${usd(total)} approved. PayPal handoff ready. Unpaid.` : `${usd(total)} approved. Payment is a separate decision.`');
    expect(page).not.toMatch(/Payment did not go out/);
  });
});

describe("HWR-08 an open historical PayPal event review holds Autopilot", () => {
  // Plants a disbursement with two attempts and a review for the first, with the triggers off for this one transaction. origin is an automated decision or a human signer.
  async function plantReview(claim: { id: string; hash: string }, origin: "AUTOMATED" | "HUMAN") {
    return ctx.client.begin(async q => {
      await q`set local session_replication_role = replica`;
      const [row] = await q`insert into disbursements (claim_id, claim_version, decision_hash, payee_email, amount_cents) values (${claim.id}, 1, ${claim.hash}, ${RECEIPT_PAYEE}, 100::bigint) returning id`;
      if (origin === "AUTOMATED") {
        const [auto] = await q`insert into automated_decisions (decision_hash, kind, inputs) values (${claim.hash}, 'AUTO_SENT', '{}'::jsonb) returning id`;
        await q`insert into automated_decisions (decision_hash, kind, inputs) values (${claim.hash}, 'AUTO_SEND_CONFIRMED', '{}'::jsonb)`;
        await q`insert into disbursement_origins (disbursement_id, automated_decision_id) values (${row!.id}, ${auto!.id})`;
      } else await q`insert into disbursement_origins (disbursement_id, signed_by) values (${row!.id}, 'tara')`;
      const [first] = await q`insert into disbursement_attempts (disbursement_id, attempt_number, sender_batch_id, sender_item_id, amount_cents, payee_email, state) values (${row!.id}, 1, ${`AT-${row!.id}-1`}, ${`AT-${row!.id}-1-1`}, 100::bigint, ${RECEIPT_PAYEE}, 'FAILED') returning id`;
      const [latest] = await q`insert into disbursement_attempts (disbursement_id, attempt_number, sender_batch_id, sender_item_id, amount_cents, payee_email, state) values (${row!.id}, 2, ${`AT-${row!.id}-2`}, ${`AT-${row!.id}-2-1`}, 100::bigint, ${RECEIPT_PAYEE}, 'PENDING') returning id`;
      const [event] = await q`insert into provider_events (event_id, event_type, verification_status) values (${`WH-HWR-${claim.id}`}, 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', 'SUCCESS') returning id`;
      const [review] = await q`insert into historical_event_reviews (provider_event_id, claim_id, claim_version, disbursement_id, event_attempt_id, latest_attempt_id, latest_state_at_event) values (${event!.id}, ${claim.id}, 1, ${row!.id}, ${first!.id}, ${latest!.id}, 'PENDING') returning id`;
      return review!.id as string;
    });
  }
  const read = () => readAutomationSwitch(ctx.db, { id: "ben" }, { env: AUTO_ENV });

  it("HWR-08: an open review on an automated disbursement sets unknownOutstanding and blocks automation, and resolving it clears that term", async () => {
    await ready(); const planted = await claimN(2);
    expect(await read()).toMatchObject({ view: { on: true, unknownOutstanding: false } });
    const reviewId = await plantReview(planted, "AUTOMATED");
    expect(await read()).toMatchObject({ view: { on: true, unknownOutstanding: true } });
    const state = await automationState(ctx.db, ORG); expect(state.unknownOutstanding).toBe(true); expect(automationAllowed(state)).toBe(false);
    await resolveHistoricalReview(ctx.db, reviewId, "ben", "Checked both attempts in the PayPal sandbox activity page.");
    const after = await automationState(ctx.db, ORG); expect(after.unknownOutstanding).toBe(false); expect(automationAllowed(after)).toBe(true);
    expect(await read()).toMatchObject({ view: { on: true, unknownOutstanding: false } });
  });

  it("HWR-08: an open review on a human-signed disbursement does not set unknownOutstanding", async () => {
    await ready(); const planted = await claimN(2);
    await plantReview(planted, "HUMAN");
    const state = await automationState(ctx.db, ORG); expect(state.unknownOutstanding).toBe(false); expect(automationAllowed(state)).toBe(true);
  });
});
