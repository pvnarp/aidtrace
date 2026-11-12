import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";
import * as s from "../db/schema";
import type { FundMode } from "../db/schema";
import { createPayPalAdapter, type PayoutTransport, type PersistedPayout } from "../src/paypal/adapter";
import { approveDecision, freezeDecision } from "../src/ledger/service";
import { refreshClaimPayout, sendClaimPayout } from "../src/ledger/payout";
import { reconcile } from "../src/ledger/reconcile";
import { captureDonationOrder, createDonationOrder } from "../src/donation/orders";
import { loadGiftPage } from "../src/donation/trail";
import { readModelChecks } from "../src/policy/model-read";
import { runPolicySweep } from "../src/fund-modes/policy-sweep";
import { WORKSHOP_EXAMPLE } from "../src/app/receipts/examples";
import { RECEIPT_PAYEE, createPolicyDatabase, receiptClaim, type PolicyDatabase, type ReceiptLineSpec } from "./support/policy-db";
import { ALL_ASSISTED, ALL_AUTOPILOT, SWEEP_ENV, allOk, setModes, stub } from "./support/fund-modes";
import { makeDonationStub } from "./support/donation-provider";
import { approveDraft, createDraft } from "../src/rules-draft/drafts";
import { stubClient } from "./support/claude-stub";
import { RULE_ENV, drafted, draftMessage, unsure } from "./support/rules-draft";
import { THRESHOLD_KEYS } from "../src/rules-draft/draft-validate";

// IAC-405, GA-01 onward: the November 4 dry run found that the USD 42.00 claim after the USD 500.00 demo claim is
// funded wholly by General, and that Autopilot holds it by design (NOTHING_CHECKED). The only in-app source of new restricted cash is a designated donor gift, so these tests prove the
// whole chain on real Postgres: a gift to fund_a funds the USD 42.00 claim, the sweep recognizes it with all eight guardrails true and sends it with no approval row. Every provider is a
// stub (the PayPal payout transport, the donation order payments and the Claude client). Nothing here reaches a network or a key. Each test builds its own database.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
let ctx: PolicyDatabase;
const open: PolicyDatabase[] = [];
beforeEach(async () => { ctx = await createPolicyDatabase("aidtrace_ga", { payeeEmail: RECEIPT_PAYEE }); open.push(ctx); }, 120_000);
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); while (open.length) await open.pop()!.close(); }, 120_000);

const ORG = "cedar-hollow";
const AUTO_ENV = { ...SWEEP_ENV, FUND_AUTOPILOT_ENABLED: "true" };
const flags = () => { vi.stubEnv("FUND_MODES_ENABLED", "true"); vi.stubEnv("FUND_AUTOPILOT_ENABLED", "true"); };

// A stub payout transport. validatePayout is the real adapter check (allowlist and ceiling), so the automated send meets the same guard as a human send. A settled item reports
// the stored send back to the settlement read, as the other payout tests do. A fee of 0.25 is charged to General on a settled item.
function provider(tag = "GA") {
  let sent: PersistedPayout | undefined; let serial = 0;
  const validatePayout = createPayPalAdapter({ baseUrl: "https://api-m.sandbox.paypal.com", clientId: "synthetic", clientSecret: "synthetic", payeeAllowlist: [RECEIPT_PAYEE], maxDemoPayoutCents: 50_000n }, vi.fn()).validatePayout;
  return { validatePayout: vi.fn(validatePayout), balance: vi.fn<PayoutTransport["balance"]>(async () => ({ readable: false })),
    send: vi.fn<PayoutTransport["send"]>(async payout => { sent = payout; serial++; return { httpStatus: 201, batchId: `BATCH_${tag}_${serial}`, batchStatus: "PENDING" }; }),
    batch: vi.fn<PayoutTransport["batch"]>(async () => ({ httpStatus: 200, batchId: `BATCH_${tag}_${serial}`, senderBatchId: sent?.senderBatchId, batchStatus: "SUCCESS", itemIds: [`ITEM_${tag}_${serial}`] })),
    item: vi.fn<PayoutTransport["item"]>(async () => ({ httpStatus: 200, itemId: `ITEM_${tag}_${serial}`, batchId: `BATCH_${tag}_${serial}`, senderBatchId: sent?.senderBatchId, senderItemId: sent?.senderItemId, payeeEmail: sent?.payeeEmail, amountCents: sent?.amountCents,
      itemStatus: "SUCCESS", feeCents: 25n, processedOn: "2026-10-22" })) } satisfies PayoutTransport;
}
type Provider = ReturnType<typeof provider>;

const fundsNow = async () => Object.fromEntries((await ctx.db.transaction(tx => reconcile(tx, ORG))).fundBalances.map(row => [row.fundId, row.availableCents]));
const claimRow = async (id: string) => (await ctx.db.select().from(s.claims).where(eq(s.claims.id, id)).orderBy(desc(s.claims.version)))[0]!;
const automated = (hash: string) => ctx.db.select().from(s.automatedDecisions).where(eq(s.automatedDecisions.decisionHash, hash));
const kinds = async (hash: string) => (await automated(hash)).map(row => row.kind).sort();
const approvalsOf = (hash: string) => ctx.db.select().from(s.approvals).where(eq(s.approvals.decisionHash, hash));
const edgesOf = (hash: string) => ctx.client`select e.fund_id, e.line_id, e.amount_cents::text as cents from allocation_edges e join allocation_decisions d on d.id = e.decision_id where d.decision_hash = ${hash} order by e.line_id, e.fund_id`;

// The USD 500.00 workshop receipt of the demo, entered by Maria exactly as the new-receipt form fills it, confirmed, frozen, approved by two distinct approvers, sent through the stub payout
// provider and settled. Its three lines exhaust the restricted cash. The sandwiches line is a meal, which the rules hold for a person, and a person approves it here.
const WORKSHOP_CATEGORIES = ["robot_kits_parts", "classroom_supplies", "participant_meals"];
// Clauses 1.1 to 1.5 of the demo grant, word for word as scripts/support/demo-grant.ts has them (the PDF text). They are inlined because the judge export omits scripts/, so this file must not import it.
const GRANT_TEXT = [
  "1.1 The subgrant pays direct costs of the Eastside Robotics Club afterschool program.",
  "1.2 It may pay for robot kits, robot parts, classroom supplies and participant meals.",
  "1.3 The subgrant period begins on 2026-09-01 and ends on 2027-06-30.",
  "1.4 Spending on supplies may not exceed $500.00 in total over the subgrant period.",
  "1.5 Meals and snacks eaten by participants may not exceed $100.00 in total.",
].join("\n");


// fund_a rules version 2, drafted from the demo grant (the PDF text of scripts/support/demo-grant.ts) the way the demo does it: a stub model answers with the November 2 rehearsal values
// (the same ones tests/demo-grant.test.ts validates), and two distinct approvers bind it through approveDraft. The seeded version 1 has no meals category, so without version 2 the
// sandwiches line would be paid by General and fund_a would keep USD 70.00 (observed in the first run of this file).
const rehearsalAnswer = (): Record<string, unknown> => {
  const lines = GRANT_TEXT.split("\n");
  const clause = (id: string) => ({ id, text: lines.find(line => line.startsWith(`${id} `))! });
  return {
    clauses: ["1.1", "1.2", "1.3", "1.4", "1.5"].map(clause),
    programs: drafted(["robotics"], "1.1", "Eastside Robotics Club afterschool program"),
    allowedCategories: drafted(WORKSHOP_CATEGORIES, "1.2", "robot kits, robot parts, classroom supplies and participant meals"),
    periodStart: drafted("2026-09-01", "1.3", "begins on 2026-09-01"),
    periodEnd: drafted("2027-06-30", "1.3", "ends on 2027-06-30"),
    breadth: 3,
    caps: { supplies: drafted(50000, "1.4", "may not exceed $500.00 in total"), other: drafted(10000, "1.5", "may not exceed $100.00 in total"), travel: unsure(), equipment: unsure(), contractual: unsure() },
    thresholds: Object.fromEntries(THRESHOLD_KEYS.map(key => [key, unsure()])),
    summary: "Pays direct costs of the Eastside Robotics Club afterschool program: robot kits and parts, classroom supplies and participant meals.",
  };
};
async function bindDemoRules() {
  const model = stubClient(() => draftMessage(rehearsalAnswer()));
  const created = await createDraft(ctx.db, { id: "tara" }, "fund_a", GRANT_TEXT, { env: RULE_ENV, client: model.client });
  if (created.status !== "DRAFTED") throw new Error(`Expected a drafted rule set, got ${JSON.stringify(created)}`);
  expect(await approveDraft(ctx.db, { id: "tara" }, created.draftId)).toMatchObject({ status: "APPROVED", approvals: 1 });
  expect(await approveDraft(ctx.db, { id: "ben" }, created.draftId)).toMatchObject({ status: "BOUND", approvals: 2, policyVersion: 2 });
  expect(model.calls).toHaveLength(1);
  const [fund] = await ctx.db.select().from(s.funds).where(eq(s.funds.id, "fund_a"));
  expect(fund!.currentPolicyVersion).toBe(2);
}
async function exhaustRestrictedCash() {
  flags();
  expect(await fundsNow()).toMatchObject({ fund_a: 30_000n, fund_b: 20_000n, fund_g: 100_000n });
  await bindDemoRules();
  const lines: ReceiptLineSpec[] = WORKSHOP_EXAMPLE.lines.map((line, index) => ({ description: line.description, amount: line.amount, category: WORKSHOP_CATEGORIES[index]! }));
  const claim = await receiptClaim(ctx.db, { vendor: WORKSHOP_EXAMPLE.vendor, lines });
  // The split the dry run saw: fund_b 200.00 of the kit line, fund_a the other 80.00, the notebooks 150.00 and the sandwiches 70.00.
  expect(await edgesOf(claim.hash)).toMatchObject([{ line_id: "L1", fund_id: "fund_a", cents: "8000" }, { line_id: "L1", fund_id: "fund_b", cents: "20000" }, { line_id: "L2", fund_id: "fund_a", cents: "15000" }, { line_id: "L3", fund_id: "fund_a", cents: "7000" }]);
  expect(await approveDecision(ctx.db, claim.decisionId, "tara", claim.hash)).toMatchObject({ approvalCount: 1 });
  expect(await approveDecision(ctx.db, claim.decisionId, "ben", claim.hash)).toMatchObject({ status: "APPROVED", approvalCount: 2 });
  const stubbed = provider();
  await sendClaimPayout(ctx.db, claim.id, "tara", claim.hash, stubbed);
  await refreshClaimPayout(ctx.db, claim.id, "tara", stubbed);
  expect((await claimRow(claim.id)).status).toBe("PAID");
  expect(stubbed.send).toHaveBeenCalledTimes(1);
  return claim;
}
// The kill switch is turned ON the way production does it: a proposal by one approver and the next event by a different approver. The fund modes are written through the two-person rows.
async function autopilotOn(modes: Record<string, FundMode> = ALL_AUTOPILOT) {
  await setModes(ctx.db, modes);
  const [proposal] = await ctx.db.insert(s.automationSwitchEvents).values({ organizationId: ORG, event: "PROPOSE_ON", actorId: "tara" }).returning({ seq: s.automationSwitchEvents.seq });
  await ctx.db.insert(s.automationSwitchEvents).values({ organizationId: ORG, event: "ON", actorId: "ben", proposalSeq: proposal!.seq });
}
const CLASSROOM: ReceiptLineSpec[] = [{ description: "Classroom supplies", amount: "42.00", category: "classroom_supplies" }];
const classroomClaim = () => receiptClaim(ctx.db, { vendor: "Maple Street Stationers", lines: CLASSROOM });
const sweep = async (stubbed: Provider) => {
  const { client, seen } = stub(allOk);
  const report = await runPolicySweep(ctx.db, { env: AUTO_ENV, model: { client }, log: () => undefined, provider: stubbed, audit: () => 50 });
  return { report, seen };
};
// A designated gift to a restricted fund through the real order and capture services with the stubbed donation payments: create, approve at the provider, capture (which records and
// reconciles the gift in the ledger). Returns the capture id.
async function gift(fundId: string, amountCents: bigint) {
  const payments = makeDonationStub();
  const created = await createDonationOrder(ctx.db, payments.payments, { fundId, amountCents });
  payments.approve();
  const captured = await captureDonationOrder(ctx.db, payments.payments, created.orderId);
  expect(captured).toMatchObject({ status: "COMPLETED" });
  return { captureId: payments.captureId, payments };
}

describe("GA-01 the defect: a claim funded wholly by General is held by Autopilot", () => {
  it("GA-01: after the USD 500.00 claim exhausts restricted cash, the USD 42.00 claim is paid by fund_g alone, its model status is NOTHING_CHECKED and one sweep holds it", async () => {
    await exhaustRestrictedCash();
    const balances = await fundsNow();
    expect(balances.fund_a).toBe(0n); expect(balances.fund_b).toBe(0n);
    await autopilotOn();
    const claim = await classroomClaim();
    expect(await edgesOf(claim.hash)).toMatchObject([{ fund_id: "fund_g", cents: "4200" }]);
    const stubbed = provider();
    const { report } = await sweep(stubbed);
    expect(report).toMatchObject({ status: "DONE", considered: 1, held: 1, recognized: 0, autopilot: { recognized: 0, routedToPeople: 0, sent: 0, sendBlocked: 0 } });
    const model = await readModelChecks(ctx.db, claim.hash);
    expect(model?.status).toBe("NOTHING_CHECKED");
    expect(model?.pairs.map(pair => [pair.fundId, pair.state, pair.reasonCode])).toEqual([["fund_g", "SKIPPED", "GENERAL_FUND"]]);
    // The sweep records one HELD row naming NOTHING_CHECKED, and no AUTO_RECOGNIZED, AUTO_SENT or approval row.
    expect(await kinds(claim.hash)).toEqual(["HELD"]);
    expect((await automated(claim.hash))[0]!.inputs).toMatchObject({ reason: "NOTHING_CHECKED" });
    expect(await approvalsOf(claim.hash)).toEqual([]);
    expect(stubbed.send).not.toHaveBeenCalled();
    expect((await claimRow(claim.id)).status).toBe("AWAITING_APPROVAL");
    expect(await ctx.db.select().from(s.disbursements).where(eq(s.disbursements.claimId, claim.id))).toEqual([]);
  });
});

describe("GA-02 the fix: a designated gift is new restricted cash", () => {
  it("GA-02: a USD 50.00 gift to fund_a is created, captured and reconciled through the stub: the fund credit, the journal entry, and a balanced ledger", async () => {
    await exhaustRestrictedCash();
    const before = await ctx.db.transaction(tx => reconcile(tx, ORG));
    expect(before.matches).toBe(true);
    const { captureId, payments } = await gift("fund_a", 5000n);
    expect(payments.calls).toEqual(expect.arrayContaining(["create", "capture"]));
    const credits = await ctx.db.select().from(s.fundCredits).where(eq(s.fundCredits.sourceId, captureId));
    expect(credits).toMatchObject([{ fundId: "fund_a", amountCents: 5000n, sourceType: "paypal_capture", isOpening: false }]);
    const entries = await ctx.db.select().from(s.journalEntries).where(eq(s.journalEntries.sourceId, captureId));
    expect(entries.map(entry => entry.purpose).sort()).toEqual(["donation", "donation_fee"]);
    const donation = entries.find(entry => entry.purpose === "donation")!;
    expect((await ctx.db.select().from(s.journalPostings).where(eq(s.journalPostings.entryId, donation.id))).map(row => [row.accountCode, row.debitCents, row.creditCents]).sort())
      .toEqual([["1010", 5000n, 0n], ["4100", 0n, 5000n]]);
    const after = await ctx.db.transaction(tx => reconcile(tx, ORG));
    expect(after.matches).toBe(true);
    const balances = Object.fromEntries(after.fundBalances.map(row => [row.fundId, row.availableCents]));
    expect(balances.fund_a).toBe(5000n); expect(balances.fund_b).toBe(0n);
    expect(after.restrictedCents - before.restrictedCents).toBe(5000n);
    const receipts = await ctx.db.select().from(s.donationReceipts).where(eq(s.donationReceipts.captureId, captureId));
    expect(receipts).toMatchObject([{ status: "COMPLETED", fundId: "fund_a", grossCents: 5000n }]);
  });
});

describe("GA-03 to GA-05 the gift funds an Autopilot claim", () => {
  async function giftedFlow(giftCents: bigint, modes: Record<string, FundMode> = ALL_AUTOPILOT) {
    await exhaustRestrictedCash();
    const donation = await gift("fund_a", giftCents);
    await autopilotOn(modes);
    const claim = await classroomClaim();
    return { ...donation, claim };
  }

  it("GA-03: the USD 42.00 claim is funded by fund_a, the stub model check is OK, the sweep records AUTO_RECOGNIZED with G1 to G8 true and then AUTO_SENT, with no approval row", async () => {
    const { claim } = await giftedFlow(5000n);
    expect(await edgesOf(claim.hash)).toMatchObject([{ fund_id: "fund_a", cents: "4200" }]);
    const stubbed = provider();
    const { report, seen } = await sweep(stubbed);
    expect(report).toMatchObject({ status: "DONE", considered: 1, recognized: 1, autopilot: { recognized: 1, routedToPeople: 0, sent: 1, sendBlocked: 0, unknownSends: 0 } });
    expect(seen.length).toBeGreaterThan(0);
    const model = await readModelChecks(ctx.db, claim.hash);
    expect(model?.status).toBe("NO_CONFLICT_FOUND");
    expect(model?.pairs.map(pair => [pair.fundId, pair.state, pair.lines.map(line => line.verdict)])).toEqual([["fund_a", "CHECKED", ["OK"]]]);
    expect(await kinds(claim.hash)).toEqual(["AUTO_RECOGNIZED", "AUTO_SEND_CONFIRMED", "AUTO_SENT"]);
    const recognized = (await automated(claim.hash)).find(row => row.kind === "AUTO_RECOGNIZED")!;
    const inputs = recognized.inputs as { guardrails: Record<string, { pass: boolean }>; claimCents: string };
    expect(Object.keys(inputs.guardrails).sort()).toEqual(["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"]);
    for (const [name, result] of Object.entries(inputs.guardrails)) expect(result.pass, name).toBe(true);
    expect(inputs.claimCents).toBe("4200");
    expect(await approvalsOf(claim.hash)).toEqual([]);
    expect(stubbed.send).toHaveBeenCalledTimes(1);
    expect(stubbed.send).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 4200n, payeeEmail: RECEIPT_PAYEE }));
    expect((await claimRow(claim.id)).status).toBe("PAYOUT_PROCESSING");
    const [disbursement] = await ctx.db.select().from(s.disbursements).where(eq(s.disbursements.claimId, claim.id));
    const [origin] = await ctx.db.select().from(s.disbursementOrigins).where(eq(s.disbursementOrigins.disbursementId, disbursement!.id));
    expect(origin).toMatchObject({ signedBy: null });
    expect(origin!.automatedDecisionId).toBe((await automated(claim.hash)).find(row => row.kind === "AUTO_SENT")!.id);
  });

  it("GA-04: the donor trail reads the gift as applied to the USD 42.00 claim line, paying under Autopilot guardrails, with the unspent USD 8.00 shown", async () => {
    const { captureId, claim } = await giftedFlow(5000n);
    await sweep(provider());
    const page = (await loadGiftPage(ctx.db, captureId))!;
    expect(page.trail.grossCents).toBe(5000n); expect(page.trail.matchedCents).toBe(4200n); expect(page.trail.unspentCents).toBe(800n);
    expect(page.trail.lines).toHaveLength(1);
    expect(page.trail.lines[0]).toMatchObject({ description: "Classroom supplies", vendor: "Maple Street Stationers", appliedCents: 4200n, lineCents: 4200n });
    expect(page.trail.gift.fundName).toMatch(/^Ashmere/);
    // The claim has no approval row and the payout has been sent but not settled. IAC-405 PR GT: the Autopilot record is the approval, so the trail reads PAYING under Autopilot
    // guardrails (this line first asserted MATCHED, the defect GTA-09 describes).
    expect(await approvalsOf(claim.hash)).toEqual([]);
    expect(page.trail.state).toBe("PAYING");
    expect(page.trail.approval).toBe("AUTOPILOT");
    expect(page.trail.payout.status).not.toBe("PAID");
  });

  it("GA-05: a gift of USD 30.00 leaves USD 12.00 of the USD 42.00 claim on fund_g, and the sweep still recognizes and sends it", async () => {
    const { claim } = await giftedFlow(3000n);
    expect(await edgesOf(claim.hash)).toMatchObject([{ fund_id: "fund_a", cents: "3000" }, { fund_id: "fund_g", cents: "1200" }]);
    const stubbed = provider();
    const { report } = await sweep(stubbed);
    // Observed in the first run, then pinned: a claim split between a restricted fund and General is NOT held. Only a claim paid wholly by General has the model status NOTHING_CHECKED.
    // Here the fund_a pair is CHECKED and OK, and the strict reading of "no holds" accepts the General pair as SKIPPED with the reason GENERAL_FUND. So the sweep recognizes the whole
    // USD 42.00 claim, with the General share included, and sends all of it. This is how src/fund-modes/no-holds.ts is written (strict option), not a finding about money movement beyond it.
    expect(report).toMatchObject({ status: "DONE", considered: 1, held: 0, recognized: 1, autopilot: { recognized: 1, routedToPeople: 0, sent: 1, sendBlocked: 0, unknownSends: 0 } });
    const model = await readModelChecks(ctx.db, claim.hash);
    expect(model?.status).toBe("NO_CONFLICT_FOUND");
    expect(model?.pairs.map(pair => [pair.fundId, pair.state, pair.reasonCode])).toEqual([["fund_a", "CHECKED", null], ["fund_g", "SKIPPED", "GENERAL_FUND"]]);
    expect(await kinds(claim.hash)).toEqual(["AUTO_RECOGNIZED", "AUTO_SEND_CONFIRMED", "AUTO_SENT"]);
    expect(await approvalsOf(claim.hash)).toEqual([]);
    expect(stubbed.send).toHaveBeenCalledTimes(1);
    expect(stubbed.send).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 4200n }));
  });
});

// The recording setup (beat 7): only Ashmere (fund_a) is on Autopilot, fund_b and fund_g stay Manual. The strictest mode of the paying funds decides (src/fund-modes/modes.ts).
const RECORDING_MODES: Record<string, FundMode> = { fund_a: "AUTOPILOT", fund_b: "MANUAL", fund_g: "MANUAL" };
const modeOf = async (hash: string) => (await ctx.db.select().from(s.decisionModes).where(eq(s.decisionModes.decisionHash, hash)))[0]?.effectiveMode;
describe("GA-06 and GA-07 the recording setup: fund_a Autopilot, fund_b and fund_g Manual", () => {
  const flow = async (giftCents: bigint) => {
    await exhaustRestrictedCash();
    await gift("fund_a", giftCents);
    await autopilotOn(RECORDING_MODES);
    return classroomClaim();
  };

  it("GA-06: a USD 50.00 gift to fund_a funds the USD 42.00 claim from fund_a alone, its decision mode is AUTOPILOT, and one sweep recognizes and sends it with no approval row", async () => {
    const claim = await flow(5000n);
    expect(await edgesOf(claim.hash)).toMatchObject([{ fund_id: "fund_a", cents: "4200" }]);
    expect(await modeOf(claim.hash)).toBe("AUTOPILOT");
    const stubbed = provider();
    const { report } = await sweep(stubbed);
    expect(report).toMatchObject({ status: "DONE", considered: 1, recognized: 1, autopilot: { recognized: 1, routedToPeople: 0, sent: 1, sendBlocked: 0, unknownSends: 0 } });
    expect(await kinds(claim.hash)).toEqual(["AUTO_RECOGNIZED", "AUTO_SEND_CONFIRMED", "AUTO_SENT"]);
    const recognized = (await automated(claim.hash)).find(row => row.kind === "AUTO_RECOGNIZED")!;
    const guardrails = (recognized.inputs as { guardrails: Record<string, { pass: boolean }> }).guardrails;
    expect(Object.keys(guardrails).sort()).toEqual(["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"]);
    for (const [name, result] of Object.entries(guardrails)) expect(result.pass, name).toBe(true);
    expect(await approvalsOf(claim.hash)).toEqual([]);
    expect(stubbed.send).toHaveBeenCalledTimes(1);
    expect(stubbed.send).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 4200n, payeeEmail: RECEIPT_PAYEE }));
  });

  it("GA-07: a USD 30.00 gift splits the claim fund_a 3000 plus fund_g 1200, its decision mode is MANUAL, and one sweep sends nothing and records no AUTO_RECOGNIZED", async () => {
    const claim = await flow(3000n);
    expect(await edgesOf(claim.hash)).toMatchObject([{ fund_id: "fund_a", cents: "3000" }, { fund_id: "fund_g", cents: "1200" }]);
    expect(await modeOf(claim.hash)).toBe("MANUAL");
    const stubbed = provider();
    await sweep(stubbed);
    expect(await kinds(claim.hash)).not.toContain("AUTO_RECOGNIZED");
    expect(stubbed.send).not.toHaveBeenCalled();
    expect(await approvalsOf(claim.hash)).toEqual([]);
    expect((await claimRow(claim.id)).status).toBe("AWAITING_APPROVAL");
  });
});

// IAC-405 PR GT ("Gift trail names the approval path"), GTA-09 and GTA-10. GA-04 originally asserted the defect: it read an Autopilot claim with no approval row as
// "MATCHED, waiting for approvals" while the same page said the line was paid. The ids GT-06 to GT-18 belong to tests/gift-trail.test.ts, so these use GTA.
describe("GTA-09 and GTA-10 the donor page names the approval path that paid the claim", () => {
  it("GTA-09: after the Autopilot sweep pays the USD 42.00 claim from the USD 50.00 gift, loadGiftPage gives PAID, step 3 Approved under Autopilot guardrails done, and step 4 done", async () => {
    await exhaustRestrictedCash();
    const { captureId } = await gift("fund_a", 5000n);
    await autopilotOn(RECORDING_MODES);
    const claim = await classroomClaim();
    const stubbed = provider("GT");
    await sweep(stubbed);
    expect(await approvalsOf(claim.hash)).toEqual([]);
    const processing = (await loadGiftPage(ctx.db, captureId))!;
    expect(processing.trail.state).toBe("PAYING");
    expect(processing.trail.steps[2]).toMatchObject({ state: "done", title: "Approved under Autopilot guardrails" });
    await refreshClaimPayout(ctx.db, claim.id, "tara", stubbed);
    expect((await claimRow(claim.id)).status).toBe("PAID");
    const page = (await loadGiftPage(ctx.db, captureId))!;
    expect(page.trail.state).toBe("PAID"); expect(page.trail.approval).toBe("AUTOPILOT");
    expect(page.trail.steps.map(step => step.state)).toEqual(["done", "done", "done", "done"]);
    expect(page.trail.steps[2]).toEqual({ id: 3, state: "done", title: "Approved under Autopilot guardrails", detail: "Every rule passed. No person was needed" });
    expect(page.trail.steps[3]).toMatchObject({ id: 4, state: "done", title: "Paid through PayPal" });
    expect(page.trail.steps[3]!.detail).toMatch(/^Paid, batch ending /);
    expect(page.trail.stateSentence).toBe("Your gift was applied, approved under Autopilot guardrails and paid through PayPal.");
    expect(page.trail.lines[0]!.payoutSentence).toMatch(/^Paid\. PayPal payout batch ending /);
    // The public page shows no person, no approver id and no model text.
    const shown = JSON.stringify(page, (_key, value) => typeof value === "bigint" ? value.toString() : value);
    for (const forbidden of ["tara", "ben", "Tara", "Ben", "Maria", "maria", "NO_CONFLICT", "AUTO_RECOGNIZED"]) expect(shown).not.toContain(forbidden);
  });

  it("GTA-10: an Assisted claim with no holds and one approval reads approved by one person after AI checks", async () => {
    flags();
    await exhaustRestrictedCash();
    const { captureId } = await gift("fund_a", 5000n);
    await setModes(ctx.db, ALL_ASSISTED);
    const claim = await classroomClaim();
    expect(await approveDecision(ctx.db, claim.decisionId, "tara", claim.hash)).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    // Before the sweep the decision is not recognized, so the gift is not yet applied to the claim (gift attribution reads recognized decisions only).
    await sweep(provider());
    expect(await kinds(claim.hash)).toEqual(["NO_HOLDS"]);
    expect(await approvalsOf(claim.hash)).toHaveLength(1);
    const page = (await loadGiftPage(ctx.db, captureId))!;
    expect(page.trail.state).toBe("APPROVED"); expect(page.trail.approval).toBe("ONE_PERSON");
    expect(page.trail.steps[2]).toEqual({ id: 3, state: "done", title: "Approved by one person after AI checks", detail: "One person approved, no holds found" });
    expect(page.trail.stateSentence).toBe("Your gift was applied to a receipt line and approved by one person after AI checks.");
  });
});
