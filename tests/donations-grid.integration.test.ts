import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase, type AppDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import * as s from "../db/schema";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { refreshClaimPayout, sendClaimPayout } from "../src/ledger/payout";
import { DONATIONS_ROW_CAP, DonationsAccessError, loadDonationsGrid } from "../src/donation/donations-grid";
import { createPayPalAdapter, type PayoutTransport, type PersistedPayout } from "../src/paypal/adapter";
import { pause, recognizeClaim, recordGift } from "./support/attribution-db";
import { financialHash, tableHash } from "./support/policy-db";

// IAC-413 PR B (test GT-28 and the row states behind GT-31). Real Postgres, stubbed provider
// observations and a stubbed payout transport, no network. Each test gets its own database. Gifts are created inside each test.
const ORG = "cedar-hollow"; const PAYEE = "donations-grid-test@personal.example.com"; const BATCH = "BATCH_GRID_1";
const BIG = 9007199254740993n; // 2^53 + 1: the first integer a JavaScript number cannot hold
interface Fixture { db: AppDatabase; client: ReturnType<typeof connectDatabase>["client"]; close: () => Promise<void> }
const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://aidtrace@db:5432/aidtrace"); adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 });
const open: Fixture[] = [];
vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });
beforeAll(() => { process.env.APP_ORIGIN = "http://127.0.0.1:3100"; });
afterAll(async () => { for (const fixture of open) await fixture.close().catch(() => undefined); await admin.end(); });

async function fresh(): Promise<Fixture> {
  const name = `aidtrace_donationsgrid_${randomBytes(6).toString("hex")}`;
  if (!/^aidtrace_[a-z0-9_]+_[a-f0-9]{12}$/.test(name)) throw new Error("Unexpected test database name");
  const url = new URL(adminUrl); url.pathname = `/${name}`;
  await admin`create database ${admin(name)}`;
  const { db, client } = connectDatabase(url.toString());
  await migrate(db, { migrationsFolder: "db/migrations" });
  const password = () => randomBytes(18).toString("hex");
  await seedFixture(db, { passwords: { maria: password(), tara: password(), ben: password() }, payeeEmail: PAYEE, payeeAllowlist: [PAYEE] });
  await db.transaction(tx => ensureFixtureOpening(tx, ORG));
  const fixture: Fixture = { db, client, close: async () => { await client.end(); await admin`drop database ${admin(name)} with (force)`; } };
  open.push(fixture); return fixture;
}
// A gift recorded before recognition, then the USD 500 claim recognized by both approvers, so the gift is applied by GIFT_ATTRIBUTION_V1.
async function giftedClaim(db: AppDatabase, fundId: string, cents: bigint) {
  const captureId = await recordGift(db, fundId, cents); await pause(25);
  const { frozen } = await recognizeClaim(db, "C-104");
  return { captureId, hash: frozen.decisionHash };
}
function transport(mode: "SUCCESS" | "SEND_FAILS" = "SUCCESS") {
  let sent: PersistedPayout | undefined;
  const validatePayout = createPayPalAdapter({ baseUrl: "https://api-m.sandbox.paypal.com", clientId: "synthetic", clientSecret: "synthetic", payeeAllowlist: [PAYEE], maxDemoPayoutCents: 50000n }, vi.fn()).validatePayout;
  return { validatePayout: vi.fn(validatePayout), balance: vi.fn<PayoutTransport["balance"]>().mockResolvedValue({ readable: false }),
    send: vi.fn<PayoutTransport["send"]>(async payout => { if (mode === "SEND_FAILS") throw new Error("synthetic network timeout"); sent = payout; return { httpStatus: 201, batchId: BATCH, batchStatus: "PENDING" }; }),
    batch: vi.fn<PayoutTransport["batch"]>(async () => ({ httpStatus: 200, batchId: BATCH, senderBatchId: sent?.senderBatchId, batchStatus: "SUCCESS", itemIds: ["ITEM_GRID_1"] })),
    item: vi.fn<PayoutTransport["item"]>(async () => ({ httpStatus: 200, itemId: "ITEM_GRID_1", batchId: BATCH, senderBatchId: sent?.senderBatchId, senderItemId: sent?.senderItemId, payeeEmail: sent?.payeeEmail, amountCents: sent?.amountCents,
      itemStatus: "SUCCESS", feeCents: 25n, processedOn: "2026-10-22" })) } satisfies PayoutTransport;
}
// A donor name goes onto a CREATED order row first, then the provider order id is attached, as e2e/gift.spec.ts seeds it. The table's own
// check allows 1 to 40 characters with no leading or trailing space, so a control character is the one stray character a name can end with.
async function nameDonor(fixture: Fixture, captureId: string, displayName: string) {
  const [receipt] = await fixture.db.select({ orderId: s.donationReceipts.orderId, fundId: s.donationReceipts.fundId, cents: s.donationReceipts.grossCents }).from(s.donationReceipts).where(eq(s.donationReceipts.captureId, captureId));
  const createRequestId = randomUUID();
  await fixture.db.insert(s.donationOrders).values({ fundId: receipt!.fundId, expectedAmountCents: receipt!.cents!, createRequestId, captureRequestId: randomUUID(), displayName });
  await fixture.client`update donation_orders set order_id = ${receipt!.orderId} where create_request_id = ${createRequestId}`;
}
const json = (value: unknown) => JSON.stringify(value);

describe("GT-28 the loader runs in a read-only transaction", () => {
  type Tx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];
  // users has no immutability trigger, so only the read-only setting can be the reason for a refusal. The write runs in a savepoint so the
  // surrounding transaction still commits.
  const probe = (tx: Tx) => tx.transaction(async inner => { await inner.execute(sql`update users set display_name = display_name`); })
    .then(() => "allowed", (error: Error) => `${error.message} ${(error.cause as Error | undefined)?.message ?? ""}`);
  it("refuses a write made through the very handle the loader used, and allows the same write in an ordinary transaction", async () => {
    const { db } = await fresh(); await recordGift(db, "fund_b", 1000n);
    let outcome = "not probed";
    const probing = new Proxy(db, { get(target, property) {
      if (property === "transaction") return (callback: (tx: Tx) => Promise<unknown>, config?: unknown) => (target.transaction as (cb: unknown, cfg?: unknown) => Promise<unknown>)(async (tx: Tx) => { const result = await callback(tx); outcome = await probe(tx); return result; }, config);
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    } }) as AppDatabase;
    const view = await loadDonationsGrid(probing, "tara");
    expect(view.total).toBe(1);
    expect(outcome).toMatch(/read-only transaction/);
    expect(await db.transaction(tx => probe(tx))).toBe("allowed");
  });
  it("changes no financial row, no donation order and no gift link, and runs without the gift link table", async () => {
    const fixture = await fresh(); const { db, client } = fixture;
    const { captureId } = await giftedClaim(db, "fund_b", 2500n); await nameDonor(fixture, captureId, "Ada Lovelace");
    const before = { financial: await financialHash(client), orders: await tableHash(client, "donation_orders"), links: await tableHash(client, "gift_links"), users: await tableHash(client, "users"), windows: await tableHash(client, "login_windows") };
    await loadDonationsGrid(db, "tara"); await loadDonationsGrid(db, "ben"); await loadDonationsGrid(db, "tara");
    expect({ financial: await financialHash(client), orders: await tableHash(client, "donation_orders"), links: await tableHash(client, "gift_links"), users: await tableHash(client, "users"), windows: await tableHash(client, "login_windows") }).toEqual(before);
    // A throwaway database: with the link table out of the way, any read of it would fail. The loader never reads it.
    await client`alter table gift_links rename to gift_links_hidden_for_test`;
    expect((await loadDonationsGrid(db, "tara")).total).toBe(1);
  });
});

describe("GT-28 rows: one per completed gift, newest first, with the donor joined by order id", () => {
  it("lists only COMPLETED gifts newest first, strips control characters from donor names and defaults a missing name to A donor", async () => {
    const fixture = await fresh(); const { db } = fixture;
    const first = await recordGift(db, "fund_b", 1000n); await pause(25);
    const second = await recordGift(db, "fund_b", 1500n); await pause(25);
    const third = await recordGift(db, "fund_b", 2000n); await pause(25);
    await recordGift(db, "fund_b", 700n, 0n, "PENDING");
    await nameDonor(fixture, first, "Ada\u0007\u200eLovelace"); await nameDonor(fixture, third, "Grace Hopper\u0007");
    const view = await loadDonationsGrid(db, "tara");
    expect(view.organization).toBe("Lanternfield Community Alliance");
    expect(view.total).toBe(3); expect(view.capped).toBe(false);
    expect(view.rows.map(row => row.amountCents)).toEqual(["2000", "1500", "1000"]);
    expect(view.rows.map(row => row.donor)).toEqual(["Grace Hopper", "A donor", "Ada Lovelace"]);
    expect(view.rows.map(row => row.capture)).toEqual([third, second, first].map(id => id.slice(-6)));
    for (const row of view.rows) {
      expect(row).toMatchObject({ received: "2026-10-22", fund: "Tallow Creek Robot Kit Initiative", state: "Waiting for a receipt", lines: "0 lines", vendor: "None yet", payoutStatus: "No payment", payoutDot: "gx-dot-idle", paypalReference: "None yet", verify: false });
      expect(row.waitingCents).toBe(row.amountCents); expect(row.matchedCents).toBe("0");
      expect(row.id).toMatch(/^gift-[0-9a-f]{16}$/);
    }
    expect(new Set(view.rows.map(row => row.id)).size).toBe(3);
    // The full capture ID and the order ID never leave the loader.
    for (const id of [first, second, third]) expect(json(view)).not.toContain(id);
    expect(json(view)).not.toMatch(/ORDER_/);
    expect(view.totals).toEqual({ amountCents: "4500", matchedCents: "0", waitingCents: "4500" });
  });
  it("shows an approved, unpaid gift as Approved with its line, vendor and payout 'No payment'", async () => {
    const { db } = await fresh(); const { captureId } = await giftedClaim(db, "fund_b", 2500n);
    const [claim] = await db.select({ vendor: s.claims.vendor }).from(s.claims).where(eq(s.claims.id, "C-104"));
    const view = await loadDonationsGrid(db, "tara"); const row = view.rows[0]!;
    expect(view.rows).toHaveLength(1); expect(row.capture).toBe(captureId.slice(-6));
    expect(row).toMatchObject({ state: "Approved", matchedCents: "2500", waitingCents: "0", payoutStatus: "No payment", paypalReference: "None yet", verify: false });
    expect(row.lines).toMatch(/^[0-9]+ lines?$/); expect(row.linesTip).toMatch(/: \$[0-9,.]+ of the \$[0-9,.]+ line/);
    expect(row.vendor).toBe(claim!.vendor.trim()); expect(row.vendorTip).toBe(claim!.vendor.trim());
    expect(view.totals).toEqual({ amountCents: "2500", matchedCents: "2500", waitingCents: "0" });
  });
  it("marks a payout whose send outcome is unknown as Being verified with the verify flag, never as paid or failed", async () => {
    const { db } = await fresh(); const { hash } = await giftedClaim(db, "fund_b", 2500n);
    await sendClaimPayout(db, "C-104", "tara", hash, transport("SEND_FAILS"));
    const row = (await loadDonationsGrid(db, "tara")).rows[0]!;
    expect(row).toMatchObject({ state: "Payout in progress", payoutStatus: "Being verified", payoutDot: "gx-dot-hold", paypalReference: "None yet", verify: true });
    expect(row.payoutTip).toContain("not paid"); expect(row.payoutTip).toContain("not failed");
    expect(json(row)).not.toMatch(/declined|error/i);
    expect(row.payoutStatus).not.toMatch(/paid|failed/i);
  });
  it("shows a settled payout as Paid with only the last 6 characters of the batch id", async () => {
    const { db } = await fresh(); const { hash } = await giftedClaim(db, "fund_b", 2500n);
    const provider = transport();
    await sendClaimPayout(db, "C-104", "tara", hash, provider);
    expect((await loadDonationsGrid(db, "tara")).rows[0]).toMatchObject({ state: "Payout in progress", payoutStatus: "Processing", paypalReference: "None yet", verify: false });
    await refreshClaimPayout(db, "C-104", "tara", provider);
    const view = await loadDonationsGrid(db, "tara"); const row = view.rows[0]!;
    expect(row).toMatchObject({ state: "Paid", payoutStatus: "Paid", payoutDot: "gx-dot-ok", paypalReference: BATCH.slice(-6), verify: false });
    expect(json(view)).not.toContain(BATCH);
  });
});

describe("GT-28 the cap and the totals past it", () => {
  it("returns the newest 2000 gifts newest first, sets capped, and totals every gift in bigint", async () => {
    const { db, client } = await fresh();
    // Direct rows in a throwaway database: 2003 completed gifts of g cents recorded g seconds after a fixed time, so the newest is the largest.
    await client`insert into donation_receipts (order_id, organization_id, fund_id, expected_amount_cents, capture_id, status, provider_status, gross_cents, fee_cents, net_cents, effective_on, recorded_by, recorded_at)
      select 'BULK_ORDER_' || g, ${ORG}, 'fund_b', g, 'BULK_CAPTURE_' || g, 'COMPLETED', 'COMPLETED', g, 0, g, date '2026-10-22', 'tara', timestamptz '2026-10-30 00:00:00+00' + g * interval '1 second'
      from generate_series(1, ${DONATIONS_ROW_CAP + 3}) g`;
    const view = await loadDonationsGrid(db, "tara");
    const everything = BigInt((DONATIONS_ROW_CAP + 3) * (DONATIONS_ROW_CAP + 4) / 2);
    expect(DONATIONS_ROW_CAP).toBe(2000);
    expect(view.total).toBe(DONATIONS_ROW_CAP + 3); expect(view.capped).toBe(true); expect(view.rows).toHaveLength(DONATIONS_ROW_CAP);
    expect(view.rows[0]!.amountCents).toBe("2003"); expect(view.rows[DONATIONS_ROW_CAP - 1]!.amountCents).toBe("4");
    expect(new Set(view.rows.map(row => row.id)).size).toBe(DONATIONS_ROW_CAP);
    const [stored] = await client`select count(*)::text as n, sum(gross_cents)::text as gross from donation_receipts where status = 'COMPLETED'`;
    expect(BigInt(stored!.gross as string)).toBe(everything); expect(Number(stored!.n)).toBe(DONATIONS_ROW_CAP + 3);
    expect(view.totals).toEqual({ amountCents: everything.toString(), matchedCents: "0", waitingCents: everything.toString() });
    // The rows alone do not reach the server total: the three oldest gifts (1, 2 and 3 cents) are past the cap.
    const visible = view.rows.reduce((total, row) => total + BigInt(row.amountCents), 0n);
    expect(visible).toBe(everything - 6n);
  });
  it("carries an amount a JavaScript number cannot hold exactly, in the row and in the totals", async () => {
    const { db, client } = await fresh();
    await recordGift(db, "fund_b", 1000n); await pause(25);
    await client`insert into donation_receipts (order_id, organization_id, fund_id, expected_amount_cents, capture_id, status, provider_status, gross_cents, fee_cents, net_cents, effective_on, recorded_by)
      values ('BIG_ORDER', ${ORG}, 'fund_b', ${BIG.toString()}, 'BIG_CAPTURE_1', 'COMPLETED', 'COMPLETED', ${BIG.toString()}, 0, ${BIG.toString()}, date '2026-10-22', 'tara')`;
    const view = await loadDonationsGrid(db, "tara");
    expect(view.rows[0]!.amountCents).toBe("9007199254740993"); expect(view.rows[0]!.waitingCents).toBe("9007199254740993");
    expect(view.totals.amountCents).toBe((BIG + 1000n).toString()); expect(view.totals.waitingCents).toBe((BIG + 1000n).toString());
    // The failure this guards against: the same value through a JavaScript number loses its last cent.
    expect(BigInt(Number(BIG))).not.toBe(BIG);
  });
});

describe("GT-28 access: only an approver reads the grid, and only gifts of the approver's own organization", () => {
  it("refuses an unknown or anonymous actor id and the claimant with 403", async () => {
    const { db } = await fresh(); await recordGift(db, "fund_b", 1000n);
    for (const actor of ["nobody", "", "anonymous", "maria"]) await expect(loadDonationsGrid(db, actor)).rejects.toMatchObject({ status: 403 });
    await expect(loadDonationsGrid(db, "maria")).rejects.toBeInstanceOf(DonationsAccessError);
  });
  it("refuses an approver whose role changed to claimant, with 403", async () => {
    const { db } = await fresh(); await recordGift(db, "fund_b", 1000n);
    await expect(loadDonationsGrid(db, "ben")).resolves.toBeTruthy();
    await db.update(s.users).set({ role: "CLAIMANT" }).where(eq(s.users.id, "ben"));
    await expect(loadDonationsGrid(db, "ben")).rejects.toMatchObject({ status: 403 });
  });
  it("shows an approver of another organization none of this organization's gifts, and this approver none of theirs", async () => {
    const { db, client } = await fresh();
    await recordGift(db, "fund_b", 1000n); await recordGift(db, "fund_b", 1500n);
    await db.insert(s.organizations).values({ id: "dg-other", name: "Private other organization", prohibitedCategories: [], openingSourceType: "fixture_opening_balance" });
    await db.insert(s.users).values({ id: "dg-approver", organizationId: "dg-other", username: "dg-approver", displayName: "Other Approver", role: "APPROVER", passwordHash: "not-a-real-hash" });
    await db.insert(s.funds).values({ id: "dg_fund_x", organizationId: "dg-other", name: "Other organization fund", fundClass: "RESTRICTED", currentPolicyVersion: 1 });
    await client`insert into donation_receipts (order_id, organization_id, fund_id, expected_amount_cents, capture_id, status, provider_status, gross_cents, fee_cents, net_cents, effective_on, recorded_by)
      values ('DG_OTHER_ORDER', 'dg-other', 'dg_fund_x', 4242, 'DG_OTHER_CAPTURE', 'COMPLETED', 'COMPLETED', 4242, 0, 4242, date '2026-10-22', 'dg-approver')`;
    const mine = await loadDonationsGrid(db, "tara"); const theirs = await loadDonationsGrid(db, "dg-approver");
    expect(mine.organization).toBe("Lanternfield Community Alliance"); expect(mine.rows.map(row => row.amountCents).sort()).toEqual(["1000", "1500"]);
    // The other organization's amount is matched as a whole JSON value ("4242" or a bare 4242 number): gift ids derive from random capture ids and may contain 4242 (MEM-52).
    const OTHER_AMOUNT = /"4242"|:4242[,}\]]/;
    expect('{"amountCents":"4242"}').toMatch(OTHER_AMOUNT); expect('{"total":4242}').toMatch(OTHER_AMOUNT); expect('{"id":"gift-a98442423e7a"}').not.toMatch(OTHER_AMOUNT);
    expect(mine.total).toBe(2); expect(mine.totals.amountCents).toBe("2500"); expect(json(mine.rows)).not.toMatch(OTHER_AMOUNT); expect(json(mine.rows)).not.toMatch(/Other organization fund/); expect(json(mine)).not.toContain("Private other organization");
    expect(theirs.organization).toBe("Private other organization"); expect(theirs.rows).toHaveLength(1); expect(theirs.total).toBe(1);
    expect(theirs.rows[0]).toMatchObject({ amountCents: "4242", fund: "Other organization fund", waitingCents: "4242", capture: "APTURE" });
    expect(theirs.totals.amountCents).toBe("4242"); expect(json(theirs.rows)).not.toMatch(/1000|1500|Tallow Creek/);
  });
});
