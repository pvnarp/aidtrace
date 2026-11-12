import { expect, it } from "vitest";
import * as s from "../db/schema";
import type { AppDatabase } from "../src/server/db";
import { createTestDatabase, pause, recognizeClaim, recordGift } from "./support/attribution-db";

// DON-06 (IAC-379 step 2): allocation, freeze, confirmation and the
// two approvals are identical with and without gifts. Each run uses a fresh database: seed, optional COMPLETED gifts recorded
// first through recordDesignatedDonation (stubbed observation, no network), then the USD 500 fixture claim C-104.
// Confirmation: C-104 is not an R- receipt claim, so requireReceiptConfirmation returns without a stored confirmation in every
// run, with or without gifts. The receipt confirmation path itself is covered by expense-proposal.integration.test.ts.
type Gifts = readonly (readonly [fundId: string, amountCents: bigint, feeCents: bigint])[];
const sorted = <T>(rows: T[]) => rows.map(row => JSON.stringify(row, (_key, value) => typeof value === "bigint" ? `${value}n` : value)).sort().map(text => JSON.parse(text) as T);
const budgetRows = async (db: AppDatabase) => sorted((await db.select().from(s.fundBudgetLines)).map(row => [row.fundId, row.policyVersion, row.budgetLine, row.capCents.toString()]));

async function run(gifts: Gifts) {
  const t = await createTestDatabase("aidtrace_iac379a_inv");
  try {
    const db = t.db;
    const budgetsBeforeGift = await budgetRows(db);
    const captures: string[] = [];
    for (const [fundId, amountCents, feeCents] of gifts) captures.push(await recordGift(db, fundId, amountCents, feeCents));
    const credits = await db.select().from(s.fundCredits);
    const creditByFund = Object.fromEntries(["fund_a", "fund_b", "fund_g"].map(fund => [fund, credits.filter(row => row.fundId === fund).reduce((sum, row) => sum + row.amountCents, 0n).toString()]));
    const budgetsAfterGift = await budgetRows(db);
    if (gifts.length) await pause(25);
    const { frozen, first, second } = await recognizeClaim(db, "C-104");
    const edges = sorted((await db.select().from(s.allocationEdges)).map(row => [row.fundId, row.lineId, row.amountCents.toString(), row.policyVersion, row.solverPriorityVersion, row.reason]));
    const reservations = await db.select().from(s.fundReservations);
    const splits = await db.select().from(s.reservationBudgetLines);
    const entries = await db.select().from(s.journalEntries); const postings = await db.select().from(s.journalPostings);
    const posted = (purpose: string) => sorted(postings.filter(row => row.entryId === entries.find(entry => entry.purpose === purpose)!.id).map(row => [row.accountCode, row.subKey, row.debitCents.toString(), row.creditCents.toString()]));
    const [claim] = await db.select().from(s.claims);
    return {
      captures, creditByFund, budgetsBeforeGift, budgetsAfterGift, budgetsAfterClaim: await budgetRows(db),
      decisionHash: frozen.decisionHash, frozenEdges: sorted(frozen.edges.map(edge => [edge.fundId, edge.lineId, edge.amountCents.toString()])),
      edges, reservations: sorted(reservations.map(row => [row.fundId, row.amountCents.toString(), row.status])),
      reservationBudgetLines: sorted(splits.map(row => [reservations.find(r => r.id === row.reservationId)!.fundId, row.budgetLine, row.amountCents.toString()])),
      approvals: { afterFirst: first.approvalCount, afterSecond: second.approvalCount, status: second.status, rows: (await db.select().from(s.approvals)).length },
      recognition: posted("recognition"), restrictionRelease: posted("restriction_release"),
      debits: sorted((await db.select().from(s.fundDebits)).filter(row => row.sourceType === "claim_recognition").map(row => [row.fundId, row.budgetLine, row.amountCents.toString(), row.purpose])),
      claimStatus: claim!.status, decisions: (await db.select().from(s.allocationDecisions)).length,
    };
  } finally { await t.close(); }
}
let cached: ReturnType<typeof run> | undefined;
const baseline = () => (cached ??= run([]));

it("baseline with no gifts: edges are fund_a L1 8000 and L2 15000, fund_b L1 20000, General L3 7000, two approvals", async () => {
  const b = await baseline();
  expect(b.edges.map(row => row.slice(0, 3))).toEqual(sorted([["fund_a", "L1", "8000"], ["fund_a", "L2", "15000"], ["fund_b", "L1", "20000"], ["fund_g", "L3", "7000"]]));
  expect(b.reservations).toEqual(sorted([["fund_a", "23000", "CONSUMED"], ["fund_b", "20000", "CONSUMED"], ["fund_g", "7000", "CONSUMED"]]));
  expect(b.approvals).toEqual({ afterFirst: 1, afterSecond: 2, status: "APPROVED", rows: 2 });
  expect(b.decisionHash).toMatch(/^[a-f0-9]{64}$/);
  expect(b.budgetsAfterClaim).toEqual(b.budgetsBeforeGift);
}, 120_000);

it.each<[string, Gifts, Record<string, string>]>([
  ["a USD 25 gift to fund_b with a USD 1.20 fee", [["fund_b", 2500n, 120n]], { fund_a: "30000", fund_b: "22500", fund_g: "100000" }],
  ["USD 1000 gifts to fund_a and fund_b with fees", [["fund_a", 100000n, 250n], ["fund_b", 100000n, 250n]], { fund_a: "130000", fund_b: "120000", fund_g: "100000" }],
])("DON-06: %s leaves edges, reservations, reservation budget lines, decision hash, approvals and fund_budget_lines identical", async (_name, gifts, credits) => {
  const [base, withGift] = [await baseline(), await run(gifts)];
  expect(withGift.captures).toHaveLength(gifts.length);
  // The gift really landed as a fund credit, so any difference below would be the gift's doing.
  expect(withGift.creditByFund).toEqual(credits); expect(base.creditByFund).toEqual({ fund_a: "30000", fund_b: "20000", fund_g: "100000" });
  expect(withGift.edges).toEqual(base.edges);
  expect(withGift.frozenEdges).toEqual(base.frozenEdges);
  expect(withGift.reservations).toEqual(base.reservations);
  expect(withGift.reservationBudgetLines).toEqual(base.reservationBudgetLines);
  expect(withGift.decisionHash).toBe(base.decisionHash);
  expect(withGift.approvals).toEqual(base.approvals);
  expect(withGift.recognition).toEqual(base.recognition); expect(withGift.restrictionRelease).toEqual(base.restrictionRelease);
  expect(withGift.debits).toEqual(base.debits);
  expect(withGift.claimStatus).toBe("APPROVED"); expect(withGift.decisions).toBe(1);
  // fund_budget_lines rows are not touched by a gift, at the gift and after the claim.
  expect(withGift.budgetsAfterGift).toEqual(withGift.budgetsBeforeGift); expect(withGift.budgetsAfterClaim).toEqual(withGift.budgetsBeforeGift);
  expect(withGift.budgetsBeforeGift).toEqual(base.budgetsBeforeGift);
}, 180_000);
