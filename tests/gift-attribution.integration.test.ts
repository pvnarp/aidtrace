import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import * as s from "../db/schema";
import { readGiftAttribution } from "../src/donation/attribution-reader";
import { recordDesignatedDonation } from "../src/ledger/donation";
import { approveDecision, freezeDecision, rejectClaim } from "../src/ledger/service";
import type { DonationObservation, DonationReader } from "../src/paypal/adapter";
import { createTestDatabase, extraClaim, pause, recognizeClaim, recordGift, type TestDatabase } from "./support/attribution-db";

// DON-05 integration (IAC-379 step 2). Real Postgres, stubbed
// provider observation, no network. One database, tests run in order and share its state.
let t: TestDatabase; let db: TestDatabase["db"];
beforeAll(async () => { t = await createTestDatabase("aidtrace_iac379a_attr"); db = t.db; }, 60_000);
afterAll(async () => { if (t) await t.close(); });

const ORG = "cedar-hollow";
const robotKit = (amountCents: bigint) => [{ id: "L1", category: "robot_kits_parts", budgetLine: "supplies", amountCents }];
const tables = { journal_entries: s.journalEntries, journal_postings: s.journalPostings, fund_credits: s.fundCredits, fund_debits: s.fundDebits, allocation_decisions: s.allocationDecisions,
  allocation_edges: s.allocationEdges, fund_reservations: s.fundReservations, reservation_budget_lines: s.reservationBudgetLines, approvals: s.approvals,
  donation_receipts: s.donationReceipts, claims: s.claims, claim_lines: s.claimLines, claim_rejections: s.claimRejections, disbursements: s.disbursements, fund_budget_lines: s.fundBudgetLines };
async function rowCounts() { const result: Record<string, number> = {}; for (const [name, table] of Object.entries(tables)) result[name] = (await db.select().from(table)).length; return result; }
let g1: string; let g2: string; let g3: string; let pending: string;

it("records COMPLETED gifts only: a PENDING capture is never a gift, and nothing is applied before any recognition", async () => {
  g1 = await recordGift(db, "fund_b", 2500n, 120n);
  pending = await recordGift(db, "fund_b", 900n, 0n, "PENDING");
  expect((await db.select().from(s.donationReceipts).where(eq(s.donationReceipts.captureId, pending)))[0]!.status).toBe("PENDING");
  const result = await readGiftAttribution(db, ORG);
  expect(result).toEqual({ policy: "GIFT_ATTRIBUTION_V1", applications: [], unspent: [{ captureId: g1, fundId: "fund_b", remainingCents: 2500n }] });
});

it("a rejected claim attributes nothing", async () => {
  await extraClaim(db, "rejected-attr", robotKit(3000n));
  const frozen = await freezeDecision(db, "rejected-attr", "maria");
  if (frozen.status !== "AWAITING_APPROVAL") throw new Error("Expected a funded decision");
  expect(frozen.edges.some(edge => edge.fundId === "fund_b")).toBe(true);
  await rejectClaim(db, "rejected-attr", "tara", "Attribution test rejection");
  expect((await db.select().from(s.claimRejections).where(eq(s.claimRejections.claimId, "rejected-attr"))).length).toBe(1);
  expect((await db.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.id, frozen.decisionId)))[0]!.invalidatedAt).toBeInstanceOf(Date);
  expect((await readGiftAttribution(db, ORG)).applications).toEqual([]);
});

it("an invalidated, never recognized decision attributes nothing", async () => {
  await extraClaim(db, "invalidated-attr", robotKit(3000n));
  const frozen = await freezeDecision(db, "invalidated-attr", "maria");
  if (frozen.status !== "AWAITING_APPROVAL") throw new Error("Expected a funded decision");
  await approveDecision(db, frozen.decisionId, "tara", frozen.decisionHash);
  await db.update(s.claims).set({ payeeEmail: "changed-attribution@example.invalid" }).where(eq(s.claims.id, "invalidated-attr"));
  expect((await approveDecision(db, frozen.decisionId, "ben", frozen.decisionHash)).status).toBe("INVALIDATED");
  const [decision] = await db.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.id, frozen.decisionId));
  expect(decision!.invalidatedAt).toBeInstanceOf(Date); expect(decision!.recognizedAt).toBeNull();
  expect((await readGiftAttribution(db, ORG)).applications).toEqual([]);
});

it("the USD 500 claim recognized after a USD 25 gift applies USD 25.00 of the fund_b share to L1", async () => {
  await pause(25);
  const { second } = await recognizeClaim(db, "C-104");
  expect(second.status).toBe("APPROVED");
  const result = await readGiftAttribution(db, ORG);
  expect(result.applications).toEqual([{ captureId: g1, claimId: "C-104", claimVersion: 1, lineId: "L1", fundId: "fund_b", appliedCents: 2500n }]);
  expect(result.unspent).toEqual([]);
  const [line] = await db.select().from(s.claimLines).where(eq(s.claimLines.claimId, "C-104"));
  expect(result.applications.every(row => row.appliedCents > 0n)).toBe(true); expect(line).toBeDefined();
  expect(result.applications.some(row => row.captureId === pending)).toBe(false);
});

it("a gift recorded after recognition does not attach to that claim", async () => {
  await pause(25);
  g2 = await recordGift(db, "fund_b", 700n, 30n);
  const result = await readGiftAttribution(db, ORG);
  expect(result.applications.map(row => row.captureId)).toEqual([g1]);
  expect(result.unspent).toEqual([{ captureId: g2, fundId: "fund_b", remainingCents: 700n }]);
});

it("an unrecognized claim (one approval only) attributes nothing", async () => {
  g3 = await recordGift(db, "fund_a", 5000n);
  await extraClaim(db, "pending-attr", robotKit(100n));
  const frozen = await freezeDecision(db, "pending-attr", "maria");
  if (frozen.status !== "AWAITING_APPROVAL") throw new Error("Expected a funded decision");
  expect(frozen.edges.some(edge => edge.fundId === "fund_a")).toBe(true);
  expect((await approveDecision(db, frozen.decisionId, "tara", frozen.decisionHash)).status).toBe("AWAITING_APPROVAL");
  const result = await readGiftAttribution(db, ORG);
  expect(result.applications.map(row => row.captureId)).toEqual([g1]);
  expect(result.unspent).toEqual([{ captureId: g3, fundId: "fund_a", remainingCents: 5000n }, { captureId: g2, fundId: "fund_b", remainingCents: 700n }]);
});

it("the loader issues no writes: row counts are identical, a read-only transaction succeeds and a repeat gives the same answer", async () => {
  const before = await rowCounts();
  const first = await readGiftAttribution(db, ORG);
  const insideReadOnly = await db.transaction(tx => readGiftAttribution(tx, ORG), { accessMode: "read only", isolationLevel: "serializable" });
  const second = await readGiftAttribution(db, ORG);
  expect(insideReadOnly).toEqual(first); expect(second).toEqual(first);
  expect(await rowCounts()).toEqual(before);
  expect(before.donation_receipts).toBe(4); expect(before.fund_budget_lines).toBe(2);
});

it("is scoped to the organization", async () => {
  expect(await readGiftAttribution(db, "another-organization")).toEqual({ policy: "GIFT_ATTRIBUTION_V1", applications: [], unspent: [] });
});

it("excludes a recognized decision whose claim version also has a rejection row (defensive, rolled back)", async () => {
  const before = await rowCounts();
  const sentinel = new Error("rollback sentinel");
  const inside = await db.transaction(async tx => {
    await tx.insert(s.claimRejections).values({ claimId: "C-104", claimVersion: 1, rejectedBy: "tara", reason: "Defensive loader check, rolled back" });
    const result = await readGiftAttribution(tx, ORG);
    throw Object.assign(sentinel, { result });
  }).catch((error: unknown) => { if (error !== sentinel) throw error; return (error as Error & { result: Awaited<ReturnType<typeof readGiftAttribution>> }).result; });
  expect(inside.applications).toEqual([]);
  expect(inside.unspent.map(row => row.captureId).sort()).toEqual([g1, g2, g3].sort());
  expect(await rowCounts()).toEqual(before);
});

// DON-05b (IAC-379 step 2 follow-up). The gift stored PENDING in the first test completes only now, after
// C-104 was recognized. Its donation_receipts.recorded_at keeps the PENDING insert time, which is before the recognition, so ordering by that
// column alone would apply it to C-104's fund_b line. Its paypal_capture fund credit is recorded now, after the recognition, so it stays unspent.
// Runs last because it completes the shared PENDING gift.
it("DON-05b a gift first stored PENDING and completed after a recognition does not attach to that claim", async () => {
  const [stored] = await db.select().from(s.donationReceipts).where(eq(s.donationReceipts.captureId, pending));
  expect(stored).toMatchObject({ status: "PENDING", fundId: "fund_b", expectedAmountCents: 900n });
  const [recognized] = await db.select().from(s.allocationDecisions)
    .where(and(eq(s.allocationDecisions.claimId, "C-104"), isNotNull(s.allocationDecisions.recognizedAt), isNull(s.allocationDecisions.invalidatedAt)));
  const recognizedAt = recognized!.recognizedAt!;
  expect(stored!.recordedAt.getTime()).toBeLessThan(recognizedAt.getTime());
  // The C-104 fund_b edges have room past the USD 25 gift, so ordering by the PENDING insert time would apply this USD 9 gift to them.
  const fundB = (await db.select().from(s.allocationEdges).where(eq(s.allocationEdges.decisionId, recognized!.id))).filter(edge => edge.fundId === "fund_b");
  expect(fundB.reduce((sum, edge) => sum + edge.amountCents, 0n)).toBeGreaterThan(2500n + 900n);
  await pause(25);
  const orderId = stored!.orderId;
  const data: DonationObservation = { httpStatus: 200, orderId, intent: "CAPTURE", status: "COMPLETED", units: [{ fundId: "fund_b", amountCents: 900n }],
    captures: [{ captureId: pending, status: "COMPLETED", amountCents: 900n, grossCents: 900n, feeCents: 0n, netCents: 900n, effectiveOn: "2026-10-22" }] };
  const provider = { donationOrder: vi.fn<DonationReader["donationOrder"]>(async () => data) };
  expect(await recordDesignatedDonation(db, "tara", { orderId, captureId: pending, fundId: "fund_b", amountCents: 900n }, provider)).toMatchObject({ status: "COMPLETED", posted: true });
  const [after] = await db.select().from(s.donationReceipts).where(eq(s.donationReceipts.captureId, pending));
  expect(after!.status).toBe("COMPLETED"); expect(after!.recordedAt.getTime()).toBe(stored!.recordedAt.getTime());
  const credits = await db.select().from(s.fundCredits).where(and(eq(s.fundCredits.sourceType, "paypal_capture"), eq(s.fundCredits.sourceId, pending)));
  expect(credits).toHaveLength(1); expect(credits[0]!.fundId).toBe("fund_b");
  expect(credits[0]!.recordedAt.getTime()).toBeGreaterThan(recognizedAt.getTime());
  const result = await readGiftAttribution(db, ORG);
  expect(result.applications.some(row => row.captureId === pending)).toBe(false);
  expect(result.applications).toEqual([{ captureId: g1, claimId: "C-104", claimVersion: 1, lineId: "L1", fundId: "fund_b", appliedCents: 2500n }]);
  expect(result.unspent).toContainEqual({ captureId: pending, fundId: "fund_b", remainingCents: 900n });
});
