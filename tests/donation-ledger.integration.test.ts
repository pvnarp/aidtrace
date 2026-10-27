import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import * as s from "../db/schema";
import { recordDesignatedDonation } from "../src/ledger/donation";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { reconcile } from "../src/ledger/reconcile";
import type { DonationObservation, DonationReader } from "../src/paypal/adapter";
const name = `aidtrace_iac140_test_${randomBytes(6).toString("hex")}`;
const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://aidtrace@db:5432/aidtrace"); adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 }); const url = new URL(adminUrl); url.pathname = `/${name}`;
const { db, client } = connectDatabase(url.toString()); let created = false; let sequence = 0;
beforeAll(async () => {
  await admin`create database ${admin(name)}`; created = true; await migrate(db, { migrationsFolder: "db/migrations" });
  await seedFixture(db, { passwords: { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") }, payeeEmail: "donation-test@example.invalid", payeeAllowlist: ["donation-test@example.invalid"] });
  await db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
}, 30_000);
afterAll(async () => { await client.end(); if (created) await admin`drop database ${admin(name)}`; await admin.end(); });
function observation() {
  const serial = ++sequence;
  const data: DonationObservation = { httpStatus: 200, orderId: `ORDER_${serial}`, intent: "CAPTURE", status: "COMPLETED", units: [{ fundId: "fund_b", amountCents: 100n }], captures: [{ captureId: `CAPTURE_${serial}`, status: "COMPLETED", amountCents: 100n, grossCents: 100n, feeCents: 52n, netCents: 48n, effectiveOn: "2026-10-22" }] };
  const provider = { donationOrder: vi.fn<DonationReader["donationOrder"]>(async () => data) };
  const expected = { orderId: data.orderId!, captureId: data.captures[0]!.captureId!, fundId: "fund_b", amountCents: 100n };
  return { data, provider, expected };
}
const count = async () => (await db.select().from(s.journalEntries)).length;
it("posts exact gross to restricted, exact fee to General and preserves fixture openings", async () => {
  const c = observation();
  const result = await recordDesignatedDonation(db, "tara", c.expected, c.provider);
  expect(result).toMatchObject({ status: "COMPLETED", grossCents: 100n, feeCents: 52n, netCents: 48n, posted: true });
  const credits = await db.select().from(s.fundCredits); expect(credits.filter(row => row.isOpening)).toHaveLength(3);
  expect(credits.filter(row => !row.isOpening)).toMatchObject([{ fundId: "fund_b", amountCents: 100n, sourceType: "paypal_capture", sourceId: c.expected.captureId }]);
  const report = await db.transaction(tx => reconcile(tx, "cedar-hollow"));
  expect(report).toMatchObject({ matches: true, restrictedCents: 50100n, generalCents: 99948n, bookCashCents: 150048n, fixtureCashCents: 150000n, providerActivityCashDeltaCents: 48n });
  const entries = await db.select().from(s.journalEntries).where(eq(s.journalEntries.sourceId, c.expected.captureId));
  const postingPairs = [];
  for (const entry of entries) postingPairs.push([entry.purpose, (await db.select().from(s.journalPostings).where(eq(s.journalPostings.entryId, entry.id))).map(row => [row.accountCode, row.debitCents, row.creditCents])]);
  expect(postingPairs).toEqual([["donation", [["1010", 100n, 0n], ["4100", 0n, 100n]]], ["donation_fee", [["5900", 52n, 0n], ["1010", 0n, 52n]]]]);
  const before = await count(); expect((await recordDesignatedDonation(db, "ben", c.expected, c.provider)).posted).toBe(false); expect(await count()).toBe(before);
  await expect(db.update(s.donationReceipts).set({ feeCents: 1n }).where(eq(s.donationReceipts.orderId, c.expected.orderId))).rejects.toThrow();
  await expect(db.delete(s.donationReceipts).where(eq(s.donationReceipts.orderId, c.expected.orderId))).rejects.toThrow();
});
it("records pending capture then posts once on independent completion", async () => {
  const c = observation(); c.data.captures[0]!.status = "PENDING";
  const before = await count(); expect((await recordDesignatedDonation(db, "tara", c.expected, c.provider)).status).toBe("PENDING"); expect(await count()).toBe(before);
  c.data.captures[0]!.status = "COMPLETED";
  expect((await recordDesignatedDonation(db, "tara", c.expected, c.provider)).posted).toBe(true); expect(await count()).toBe(before + 2);
});
it("concurrent independent observations post one donation and fee pair", async () => {
  const c = observation(); const before = await count();
  const results = await Promise.all([recordDesignatedDonation(db, "tara", c.expected, c.provider), recordDesignatedDonation(db, "ben", c.expected, c.provider)]);
  expect(results.filter(row => row.posted)).toHaveLength(1); expect(await count()).toBe(before + 2);
});
it("zero fee posts no fee entry and retains the first completion date", async () => {
  const c = observation(); c.data.captures[0]!.feeCents = 0n; c.data.captures[0]!.netCents = 100n; c.data.captures[0]!.effectiveOn = undefined;
  const before = await count(); await recordDesignatedDonation(db, "tara", c.expected, c.provider); expect(await count()).toBe(before + 1);
  c.data.captures[0]!.effectiveOn = "2026-10-20"; await recordDesignatedDonation(db, "tara", c.expected, c.provider);
  const [receipt] = await db.select().from(s.donationReceipts).where(eq(s.donationReceipts.orderId, c.expected.orderId));
  expect(receipt!.effectiveOn).toBe(new Date().toISOString().slice(0, 10));
});
it.each(["wrong-order", "wrong-fund", "wrong-gross", "wrong-net", "missing-fee", "wrong-capture", "extra-unit", "extra-capture"])("refuses %s without posting or inserting a receipt", async kind => {
  const c = observation();
  if (kind === "wrong-order") c.data.orderId = "OTHER";
  if (kind === "wrong-fund") c.data.units[0]!.fundId = "fund_a";
  if (kind === "wrong-gross") c.data.captures[0]!.grossCents = 99n;
  if (kind === "wrong-net") c.data.captures[0]!.netCents = 49n;
  if (kind === "missing-fee") c.data.captures[0]!.feeCents = undefined;
  if (kind === "wrong-capture") c.data.captures[0]!.captureId = "OTHER";
  if (kind === "extra-unit") c.data.units.push(c.data.units[0]!);
  if (kind === "extra-capture") c.data.captures.push(c.data.captures[0]!);
  const before = await count(); await expect(recordDesignatedDonation(db, "tara", c.expected, c.provider)).rejects.toThrow();
  expect(await count()).toBe(before); expect(await db.select().from(s.donationReceipts).where(eq(s.donationReceipts.orderId, c.expected.orderId))).toHaveLength(0);
});
it("refuses claimant access before provider requests and rejects changed completed amounts", async () => {
  const c = observation(); await expect(recordDesignatedDonation(db, "maria", c.expected, c.provider)).rejects.toThrow("approver"); expect(c.provider.donationOrder).not.toHaveBeenCalled();
  await recordDesignatedDonation(db, "tara", c.expected, c.provider); const before = await count();
  c.data.captures[0]!.feeCents = 51n; c.data.captures[0]!.netCents = 49n;
  await expect(recordDesignatedDonation(db, "tara", c.expected, c.provider)).rejects.toThrow("manual review"); expect(await count()).toBe(before);
});
