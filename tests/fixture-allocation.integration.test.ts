import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { freezeDecision } from "../src/ledger/service";
import * as s from "../db/schema";

// IAC-382 guard: relabeling the fixture must not move any money. Assertions use ids and cents only, never the decision hash.
const databaseName = `aidtrace_iac382_alloc_${randomBytes(6).toString("hex")}`;
const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://aidtrace@db:5432/aidtrace"); adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 });
const testUrl = new URL(adminUrl); testUrl.pathname = `/${databaseName}`;
const { db, client } = connectDatabase(testUrl.toString());
let created = false;
beforeAll(async () => {
  await admin`create database ${admin(databaseName)}`; created = true;
  await migrate(db, { migrationsFolder: "db/migrations" });
  await seedFixture(db, { passwords: { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") }, payeeEmail: "iac382@example.invalid", payeeAllowlist: ["iac382@example.invalid"] });
}, 30_000);
afterAll(async () => {
  await client.end();
  if (created && /^aidtrace_iac382_alloc_[a-f0-9]{12}$/.test(databaseName)) await admin`drop database ${admin(databaseName)} with (force)`;
  await admin.end();
});

it("IAC-382: the USD 500 claim C-104 allocates 200 / 230 / 70 by fund and line in a freshly seeded database", async () => {
  const frozen = await freezeDecision(db, "C-104", "maria");
  expect(frozen.status).toBe("AWAITING_APPROVAL");
  if (frozen.status !== "AWAITING_APPROVAL") return;
  const stored = await db.select().from(s.allocationEdges).where(eq(s.allocationEdges.decisionId, frozen.decisionId));
  const edges = stored.map(edge => [edge.fundId, edge.lineId, edge.amountCents.toString()]).sort((a, b) => a.join().localeCompare(b.join()));
  expect(edges).toEqual([["fund_a", "L1", "8000"], ["fund_a", "L2", "15000"], ["fund_b", "L1", "20000"], ["fund_g", "L3", "7000"]]);
  const totals = new Map<string, bigint>();
  for (const edge of stored) totals.set(edge.fundId, (totals.get(edge.fundId) ?? 0n) + edge.amountCents);
  expect([...totals].sort(([a], [b]) => a.localeCompare(b)).map(([fundId, cents]) => [fundId, cents.toString()])).toEqual([["fund_a", "23000"], ["fund_b", "20000"], ["fund_g", "7000"]]);
  expect([...totals.values()].reduce((sum, cents) => sum + cents, 0n)).toBe(50000n);
  const reservations = await db.select().from(s.fundReservations).where(eq(s.fundReservations.decisionId, frozen.decisionId));
  expect(reservations.map(row => [row.fundId, row.amountCents.toString()]).sort((a, b) => a.join().localeCompare(b.join()))).toEqual([["fund_a", "23000"], ["fund_b", "20000"], ["fund_g", "7000"]]);
});
