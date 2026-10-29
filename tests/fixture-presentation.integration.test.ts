import { randomBytes } from "node:crypto";
import { beforeEach, afterEach, afterAll, expect, it } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { loadClaimView } from "../src/server/claim-view";
import { fixtureNotStarted } from "../src/server/fixture-state";
import { loadAnalyticsSnapshot } from "../src/analytics/snapshot";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { rejectClaim } from "../src/ledger/service";
import { recordDesignatedDonation } from "../src/ledger/donation";
import * as s from "../db/schema";

const url = new URL(process.env.DATABASE_URL!); url.pathname = "/postgres";
const admin = postgres(url.toString(), { max: 1 });
let connection: ReturnType<typeof connectDatabase>; let name: string;
beforeEach(async () => {
  name = `aidtrace_ui348_${randomBytes(6).toString("hex")}`; await admin`create database ${admin(name)}`;
  const dbUrl = new URL(url); dbUrl.pathname = "/" + name;
  connection = connectDatabase(dbUrl.toString()); await migrate(connection.db, { migrationsFolder: "db/migrations" });
  await seedFixture(connection.db, { passwords: { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") }, payeeEmail: "ui348@example.invalid", payeeAllowlist: ["ui348@example.invalid"] });
}, 30000);
afterEach(async () => { await connection?.client.end(); if (/^aidtrace_ui348_[a-f0-9]{12}$/.test(name)) await admin`drop database ${admin(name)} with (force)`; });
afterAll(async () => { await admin.end(); });
const untouched = () => connection.db.transaction(tx => fixtureNotStarted(tx, "cedar-hollow"));

it("UI-348: fresh display is explicit without turning a mismatch into a match or writing journals", async () => {
  const view = await loadClaimView(connection.db, "C-104", "maria");
  expect(view.fixtureNotStarted).toBe(true); expect(view.report.matches).toBe(false);
  expect(view.report.bookCashCents).toBe(0n); expect(view.report.restrictedCents).toBe(50000n);
  const snapshot = await loadAnalyticsSnapshot(connection.db, "tara");
  expect(snapshot.fixtureNotStarted).toBe(true); expect(snapshot.matches).toBe(false);
  expect(snapshot.facts.find(fact => fact.id === "tie-out")?.text).toContain("No ledger tie-out is claimed");
  expect(await connection.db.select().from(s.journalEntries)).toHaveLength(0);
  expect(await connection.db.select().from(s.fundReservations)).toHaveLength(0);
});
it("UI-348: opening entries enable normal reconciliation, and a later discrepancy remains visible", async () => {
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  const first = await loadAnalyticsSnapshot(connection.db, "tara");
  expect(first.fixtureNotStarted).toBe(false); expect(first.matches).toBe(true);
  await connection.db.update(s.fundCredits).set({ amountCents: 29999n }).where(eq(s.fundCredits.fundId, "fund_a"));
  const changed = await loadAnalyticsSnapshot(connection.db, "tara");
  expect(changed.fixtureNotStarted).toBe(false); expect(changed.matches).toBe(false);
  expect(changed.facts.find(fact => fact.id === "tie-out")?.text).toContain("Review is required");
  expect(changed.digest).not.toBe(first.digest);
});
it("UI-348: missing, non-opening or inconsistent credits never receive the untouched-fixture label", async () => {
  await expect(connection.db.update(s.fundCredits).set({ isOpening: false }).where(eq(s.fundCredits.fundId, "fund_a"))).rejects.toThrow();
  expect(await untouched()).toBe(true); // The database refused the inconsistent write.
  await connection.db.update(s.fundCredits).set({ isOpening: true, sourceId: "different-source" }).where(eq(s.fundCredits.fundId, "fund_a")); expect(await untouched()).toBe(false);
  await connection.db.delete(s.fundCredits).where(eq(s.fundCredits.fundId, "fund_a")); expect(await untouched()).toBe(false);
});
it("UI-348: a nonfixture or foreign actor cannot acquire fixture-only reassurance", async () => {
  await expect(loadClaimView(connection.db, "C-104", "missing-actor")).rejects.toThrow();
  await expect(loadAnalyticsSnapshot(connection.db, "maria")).rejects.toMatchObject({ status: 403 });
  await connection.db.update(s.organizations).set({ isFixture: false }); expect(await untouched()).toBe(false);
});
it("UI-348: a rejected draft cannot be described as an untouched fixture", async () => {
  await rejectClaim(connection.db, "C-104", "tara", "Synthetic pre-freeze rejection");
  expect(await untouched()).toBe(false);
  expect(await connection.db.select().from(s.journalEntries)).toHaveLength(0);
});
it("UI-348: an observed pending donation is activity even without opening journals", async () => {
  await recordDesignatedDonation(connection.db, "tara", { orderId: "SYNTHETIC_PENDING_DONATION", fundId: "fund_b", amountCents: 100n }, {
    async donationOrder() { return { httpStatus: 200, orderId: "SYNTHETIC_PENDING_DONATION", intent: "CAPTURE", status: "APPROVED", units: [{ fundId: "fund_b", amountCents: 100n }], captures: [] }; },
  });
  expect(await untouched()).toBe(false);
  expect(await connection.db.select().from(s.journalEntries)).toHaveLength(0);
});
