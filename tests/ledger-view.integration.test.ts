import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import * as s from "../db/schema";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { approveDecision, freezeDecision } from "../src/ledger/service";
import { refreshClaimPayout, sendClaimPayout } from "../src/ledger/payout";
import { recordDesignatedDonation } from "../src/ledger/donation";
import { postJournal } from "../src/ledger/journal";
import { reconcile } from "../src/ledger/reconcile";
import { createPayPalAdapter, type DonationObservation, type DonationReader, type PayoutItemResult, type PayoutTransport, type PersistedPayout } from "../src/paypal/adapter";
import { LEDGER_ROW_CAP, LedgerAccessError, loadLedgerView, type LedgerRow } from "../src/ledger/view";

// IAC-380 step 2, the read-only /ledger view against a real isolated PostgreSQL (LG-01, LG-02, LG-08 and the access cases).
// Every provider here is a scripted stand-in written in this file. No PayPal request is made and no result below is a provider result.
const PAYEE = "ledger-view-test@personal.example.com";
const BIG = 9007199254740993n;
const databaseName = `aidtrace_ledgerview_${randomBytes(6).toString("hex")}`;
const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://aidtrace@db:5432/aidtrace"); adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 }); const testUrl = new URL(adminUrl); testUrl.pathname = `/${databaseName}`;
const { db, client } = connectDatabase(testUrl.toString());
let created = false; let serial = 0;

const TABLES = ["claims", "claim_lines", "allocation_decisions", "allocation_edges", "approvals", "fund_reservations", "reservation_budget_lines", "fund_credits", "fund_debits", "journal_entries", "journal_postings", "disbursements", "disbursement_attempts", "donation_receipts", "retry_authorizations", "provider_events"];
async function financialHash() {
  const rows = [];
  for (const table of TABLES) rows.push(await client`select to_jsonb(r)::text as v from ${client(table)} r order by (to_jsonb(r)::text) collate "C"`);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
const sums = async () => { const [row] = await client`select count(*)::text as n, coalesce(sum(debit_cents),0)::text as debit, coalesce(sum(credit_cents),0)::text as credit from journal_postings`; return { n: Number(row!.n), debit: BigInt(row!.debit), credit: BigInt(row!.credit) }; };

function donation() {
  const n = ++serial;
  const data: DonationObservation = { httpStatus: 200, orderId: `LVORDER_${n}`, intent: "CAPTURE", status: "COMPLETED", units: [{ fundId: "fund_b", amountCents: 100n }], captures: [{ captureId: `LVCAPTURE_${n}`, status: "COMPLETED", amountCents: 100n, grossCents: 100n, feeCents: 52n, netCents: 48n, effectiveOn: "2026-10-30" }] };
  const provider = { donationOrder: vi.fn<DonationReader["donationOrder"]>(async () => data) };
  return { provider, expected: { orderId: data.orderId!, captureId: data.captures[0]!.captureId!, fundId: "fund_b", amountCents: 100n } };
}
function transport() {
  const n = ++serial; let sent: PersistedPayout | undefined;
  const validatePayout = createPayPalAdapter({ baseUrl: "https://api-m.sandbox.paypal.com", clientId: "synthetic", clientSecret: "synthetic", payeeAllowlist: [PAYEE], maxDemoPayoutCents: 50000n }, vi.fn()).validatePayout;
  const provider = {
    validatePayout: vi.fn(validatePayout),
    balance: vi.fn<PayoutTransport["balance"]>().mockResolvedValue({ readable: false }),
    send: vi.fn<PayoutTransport["send"]>(async payout => { sent = payout; return { httpStatus: 201, batchId: `LVBATCH_${n}`, batchStatus: "PENDING" }; }),
    batch: vi.fn<PayoutTransport["batch"]>(async () => ({ httpStatus: 200, batchId: `LVBATCH_${n}`, senderBatchId: sent?.senderBatchId, batchStatus: "SUCCESS", itemIds: [`LVITEM_${n}`] })),
    item: vi.fn<PayoutTransport["item"]>(async () => ({ httpStatus: 200, itemId: `LVITEM_${n}`, batchId: `LVBATCH_${n}`, senderBatchId: sent?.senderBatchId, senderItemId: sent?.senderItemId, payeeEmail: sent?.payeeEmail, amountCents: sent?.amountCents, itemStatus: "SUCCESS", feeCents: 25n, processedOn: "2026-10-22" } satisfies PayoutItemResult)),
  } satisfies PayoutTransport;
  return { provider, itemId: `LVITEM_${n}` };
}

const facts: { captureId: string; claimId: string; itemId: string } = { captureId: "", claimId: "", itemId: "" };

beforeAll(async () => {
  await admin`create database ${admin(databaseName)}`; created = true;
  await migrate(db, { migrationsFolder: "db/migrations" });
  await seedFixture(db, { passwords: { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") }, payeeEmail: PAYEE, payeeAllowlist: [PAYEE] });
  await db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  // A stubbed donation capture, then one claim carried through two approvals, a stubbed payout and a stubbed settlement.
  const gift = donation(); await recordDesignatedDonation(db, "tara", gift.expected, gift.provider); facts.captureId = gift.expected.captureId;
  const [original] = await db.select().from(s.claims).where(eq(s.claims.id, "C-104"));
  facts.claimId = "LV-CLAIM-1"; await db.insert(s.claims).values({ ...original!, id: facts.claimId, status: "DRAFT" });
  await db.insert(s.claimLines).values({ claimId: facts.claimId, claimVersion: 1, id: "lv-line", description: "Ledger view test only", category: "participant_meals", budgetLine: "other", amountCents: 100n });
  const frozen = await freezeDecision(db, facts.claimId, "maria"); if (frozen.status !== "AWAITING_APPROVAL") throw new Error("Test claim must be funded");
  await approveDecision(db, frozen.decisionId, "tara", frozen.decisionHash); await approveDecision(db, frozen.decisionId, "ben", frozen.decisionHash);
  const payout = transport(); facts.itemId = payout.itemId;
  await sendClaimPayout(db, facts.claimId, "ben", frozen.decisionHash, payout.provider);
  await refreshClaimPayout(db, facts.claimId, "ben", payout.provider);
}, 60_000);
afterAll(async () => { await client.end(); if (created) await admin`drop database ${admin(databaseName)} with (force)`; await admin.end(); });

const find = (rows: LedgerRow[], type: string, account?: string) => rows.filter(row => row.entryType === type && (account === undefined || row.accountCode === account));

describe("LG-01 the loader returns exact string cents and resolves joins from real postings", () => {
  it("returns the organization, every posting and string money", async () => {
    const view = await loadLedgerView(db, "tara"); const sum = await sums();
    expect(view).toMatchObject({ organization: "Lanternfield Community Alliance", fixture: true, events: [] });
    expect(view.total).toBe(sum.n); expect(view.rows).toHaveLength(sum.n);
    expect(Number.isNaN(Date.parse(view.observedAt))).toBe(false);
    for (const row of view.rows) {
      expect(typeof row.debitCents).toBe("string"); expect(typeof row.creditCents).toBe("string");
      expect((row.debitCents === "") !== (row.creditCents === ""), `${row.id} needs exactly one side`).toBe(true);
      expect(row.debitCents || row.creditCents).toMatch(/^[1-9][0-9]*$/);
    }
    expect(() => JSON.stringify(view)).not.toThrow();
  });
  it("orders newest first by recorded time", async () => {
    const view = await loadLedgerView(db, "ben");
    const times = view.rows.map(row => row.recordedAt);
    expect([...times].sort().reverse()).toEqual(times);
  });
  it("shows opening balances with no claim and no PayPal reference", async () => {
    const view = await loadLedgerView(db, "tara"); const openings = find(view.rows, "Opening balance");
    expect(openings.length).toBeGreaterThan(0);
    for (const row of openings) expect(row).toMatchObject({ claim: "No claim", approvals: "Not applicable", paypalReference: "No PayPal reference", verify: false });
    expect(openings.find(row => row.accountCode === "1010")).toMatchObject({ account: "1010 Cash", debitCents: "150000", creditCents: "" });
    expect(find(view.rows, "Opening balance", "3200")[0]).toMatchObject({ fund: "General" });
    expect(find(view.rows, "Opening balance", "3100").map(row => row.fund).sort()).toEqual(["Ashmere County Afterschool STEM Subgrant", "Tallow Creek Robot Kit Initiative"]);
  });
  it("resolves the stubbed donation to its capture id and fund name", async () => {
    const view = await loadLedgerView(db, "tara");
    const gift = find(view.rows, "Donation");
    expect(gift).toHaveLength(2);
    for (const row of gift) expect(row.paypalReference).toBe(facts.captureId);
    expect(gift.find(row => row.accountCode === "4100")).toMatchObject({ creditCents: "100", fund: "Tallow Creek Robot Kit Initiative" });
    expect(find(view.rows, "Donation fee").map(row => [row.accountCode, row.debitCents || row.creditCents])).toEqual(expect.arrayContaining([["5900", "52"], ["1010", "52"]]));
  });
  it("resolves recognition entries to the claim and two approvals, and the settlement to the payout item id", async () => {
    const view = await loadLedgerView(db, "tara");
    const recognition = view.rows.filter(row => row.entryType === "Claim recognition" || row.entryType === "Restriction release");
    expect(recognition.length).toBeGreaterThan(0);
    for (const row of recognition) expect(row).toMatchObject({ claim: facts.claimId, approvals: "2 of 2", paypalReference: "No PayPal reference" });
    const settlement = find(view.rows, "Payout settlement");
    expect(settlement.length).toBe(2);
    for (const row of settlement) expect(row).toMatchObject({ claim: facts.claimId, approvals: "2 of 2", paypalReference: facts.itemId, verify: false });
    for (const row of find(view.rows, "Payout fee")) expect(row).toMatchObject({ paypalReference: facts.itemId });
  });
  it("resolves every join in a real flow: no row shows an unresolved source", async () => {
    const view = await loadLedgerView(db, "tara");
    for (const row of view.rows) for (const text of [row.claim, row.approvals, row.paypalReference]) expect(text, row.id).not.toMatch(/^Unresolved/);
    expect(view.rows.some(row => row.verify)).toBe(false);
  });
});

describe("LG-02 totals tie out, and the view leaves the ledger as it found it", () => {
  it("returns debit and credit totals that are equal in bigint and equal to the stored sums", async () => {
    const view = await loadLedgerView(db, "tara"); const sum = await sums();
    expect(BigInt(view.totals.debitCents)).toBe(BigInt(view.totals.creditCents));
    expect(BigInt(view.totals.debitCents)).toBe(sum.debit);
    expect(BigInt(view.totals.creditCents)).toBe(sum.credit);
    // An uncapped view: the rows themselves add up to the same totals.
    const debitRows = view.rows.reduce((total, row) => total + (row.debitCents ? BigInt(row.debitCents) : 0n), 0n);
    expect(debitRows).toBe(sum.debit);
  });
  it("leaves the reconcile report unchanged", async () => {
    const before = await db.transaction(tx => reconcile(tx, "cedar-hollow"));
    await loadLedgerView(db, "tara");
    const after = await db.transaction(tx => reconcile(tx, "cedar-hollow"));
    expect(after).toEqual(before);
    expect(after.matches).toBe(true);
  });
});

describe("LG-08 the loader changes no financial row", () => {
  it("keeps the 16-table financial hash identical across repeated loads by both approvers", async () => {
    const before = await financialHash();
    await loadLedgerView(db, "tara"); await loadLedgerView(db, "ben"); await loadLedgerView(db, "tara");
    expect(await financialHash()).toBe(before);
  });
  it("relies on a real PostgreSQL rule: a write inside a read-only transaction like the loader's is refused", async () => {
    // users has no immutability trigger, so only the read-only setting can be the reason for the refusal.
    const attempt = (readOnly: boolean) => db.transaction(async tx => { if (readOnly) await tx.execute(sql`set transaction read only`); await tx.execute(sql`update users set display_name = display_name`); })
      .then(() => "allowed", (error: Error) => `${error.message} ${(error.cause as Error | undefined)?.message ?? ""}`);
    expect(await attempt(true)).toMatch(/read-only transaction/);
    expect(await attempt(false)).toBe("allowed");
  });
});

describe("access: only an approver in the single organization reads the view", () => {
  it("refuses an unknown or anonymous actor id with 403", async () => {
    for (const actor of ["nobody", "", "anonymous"]) await expect(loadLedgerView(db, actor)).rejects.toMatchObject({ status: 403 });
    await expect(loadLedgerView(db, "nobody")).rejects.toBeInstanceOf(LedgerAccessError);
  });
  it("refuses the claimant with 403", async () => {
    await expect(loadLedgerView(db, "maria")).rejects.toMatchObject({ status: 403 });
  });
});

describe("LG-04 and GS-13 boundary: the cap, the totals past the cap and an amount a JavaScript number cannot hold", () => {
  it("returns the newest 2000 rows, counts every posting and totals every posting", async () => {
    const before = await sums();
    const postings: { accountCode: "1010" | "4100"; subKey?: string; debitCents: bigint; creditCents: bigint }[] = [];
    for (let i = 1; i <= 1001; i++) { postings.push({ accountCode: "1010", debitCents: BigInt(i), creditCents: 0n }); postings.push({ accountCode: "4100", subKey: "fund_b", debitCents: 0n, creditCents: BigInt(i) }); }
    await db.transaction(tx => postJournal(tx, { sourceType: "paypal_capture", sourceId: "LV_BULK_CAPTURE", purpose: "donation", effectiveOn: "2026-10-30", postings }));
    const view = await loadLedgerView(db, "tara"); const after = await sums();
    expect(LEDGER_ROW_CAP).toBe(2000);
    expect(after.n).toBe(before.n + 2002);
    expect(view.total).toBe(after.n); expect(view.rows).toHaveLength(2000);
    expect(BigInt(view.totals.debitCents)).toBe(after.debit); expect(BigInt(view.totals.creditCents)).toBe(after.credit);
    expect(BigInt(view.totals.debitCents)).toBe(before.debit + 501501n);
    // Every visible row is from the newest entry, largest debit first, and the rows alone do not reach the server total.
    for (const row of view.rows) expect(row.paypalReference).toBe("Unresolved: paypal_capture LV_BULK_CAPTURE (no donation receipt matches this capture id)");
    expect(view.rows[0]!.debitCents).toBe("1001"); expect(view.rows[1000]!.debitCents).toBe("1");
    expect(view.rows.slice(1001).every(row => row.debitCents === "" && row.creditCents !== "")).toBe(true);
    const visibleCredit = view.rows.reduce((total, row) => total + (row.creditCents ? BigInt(row.creditCents) : 0n), 0n);
    expect(visibleCredit < after.credit).toBe(true);
  });
  it("shows a raw source for an entry whose id matches no claim, no receipt and no attempt", async () => {
    const orphan = "99999999-9999-4999-8999-999999999999";
    await db.transaction(async tx => {
      await postJournal(tx, { sourceType: "claim_recognition", sourceId: orphan, purpose: "recognition", effectiveOn: "2026-10-30", postings: [{ accountCode: "5100", debitCents: 7n, creditCents: 0n }, { accountCode: "2010", debitCents: 0n, creditCents: 7n }] });
      await postJournal(tx, { sourceType: "paypal_payout_item", sourceId: "LV_ORPHAN_ITEM", purpose: "settlement", effectiveOn: "2026-10-30", postings: [{ accountCode: "2010", debitCents: 7n, creditCents: 0n }, { accountCode: "1010", debitCents: 0n, creditCents: 7n }] });
    });
    const view = await loadLedgerView(db, "ben");
    const recognition = view.rows.filter(row => row.claim.includes(orphan));
    expect(recognition).toHaveLength(2);
    expect(recognition[0]!.claim).toBe(`Unresolved: claim_recognition ${orphan} (no allocation decision matches this source id)`);
    const item = view.rows.filter(row => row.paypalReference.includes("LV_ORPHAN_ITEM"));
    expect(item).toHaveLength(2);
    expect(item[0]!.paypalReference).toBe("Unresolved: paypal_payout_item LV_ORPHAN_ITEM (no disbursement attempt matches this payout item id)");
    expect(item.every(row => !row.verify)).toBe(true);
  });
  it("posts a balanced 9007199254740993-cent entry through postJournal and returns it exactly", async () => {
    const before = await sums();
    await db.transaction(tx => postJournal(tx, { sourceType: "paypal_capture", sourceId: "LV_BIG_CAPTURE", purpose: "donation", effectiveOn: "2026-10-30", postings: [{ accountCode: "1010", debitCents: BIG, creditCents: 0n }, { accountCode: "4100", subKey: "fund_b", debitCents: 0n, creditCents: BIG }] }));
    const view = await loadLedgerView(db, "tara"); const after = await sums();
    const big = view.rows.filter(row => row.paypalReference.includes("LV_BIG_CAPTURE"));
    expect(big.map(row => row.debitCents || row.creditCents)).toEqual(["9007199254740993", "9007199254740993"]);
    expect(view.totals.debitCents).toBe((before.debit + BIG).toString());
    expect(view.totals.creditCents).toBe((before.credit + BIG).toString());
    expect(BigInt(view.totals.debitCents)).toBe(after.debit);
    // The failure this guards against: the same value through a JavaScript number loses its last cent.
    expect(BigInt(Number(BIG))).not.toBe(BIG);
  });
});

describe("access after the data changes", () => {
  it("refuses an approver whose role changed to claimant, with 403", async () => {
    await expect(loadLedgerView(db, "ben")).resolves.toBeTruthy();
    await db.update(s.users).set({ role: "CLAIMANT" }).where(eq(s.users.id, "ben"));
    await expect(loadLedgerView(db, "ben")).rejects.toMatchObject({ status: 403 });
  });
  it("refuses all consolidated journal data with 503 once a second organization exists", async () => {
    await expect(loadLedgerView(db, "tara")).resolves.toBeTruthy();
    await db.insert(s.organizations).values({ id: "lv-other", name: "Private other organization", prohibitedCategories: [], openingSourceType: "fixture_opening_balance" });
    await expect(loadLedgerView(db, "tara")).rejects.toMatchObject({ status: 503 });
  });
});
