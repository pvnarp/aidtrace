import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq } from "drizzle-orm";
import { connectDatabase } from "../src/server/db";
import { seedFixture, type SeedConfig } from "../db/fixture";
import * as s from "../db/schema";

// IAC-382: new databases get the Lanternfield labels; a database seeded with the old labels keeps them and is never rewritten.
const config: SeedConfig = { passwords: { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") }, payeeEmail: "iac382@example.invalid", payeeAllowlist: ["iac382@example.invalid"] };
const url = new URL(process.env.DATABASE_URL ?? "postgres://aidtrace@db:5432/aidtrace"); url.pathname = "/postgres";
const admin = postgres(url.toString(), { max: 1 });
let connection: ReturnType<typeof connectDatabase>; let name: string;
beforeEach(async () => {
  name = `aidtrace_iac382_labels_${randomBytes(6).toString("hex")}`; await admin`create database ${admin(name)}`;
  const dbUrl = new URL(url); dbUrl.pathname = "/" + name;
  connection = connectDatabase(dbUrl.toString()); await migrate(connection.db, { migrationsFolder: "db/migrations" });
}, 30000);
afterEach(async () => { await connection?.client.end(); if (/^aidtrace_iac382_labels_[a-f0-9]{12}$/.test(name)) await admin`drop database ${admin(name)} with (force)`; });
afterAll(async () => { await admin.end(); });

const oldFundBSummary = "Robotics science kits only, October through December 2026; supplies cap $200.";
// Rewrites one label to its pre-IAC-382 value, as an existing database would hold it.
const oldLabel: Record<string, () => Promise<unknown>> = {
  organization: () => connection.db.update(s.organizations).set({ name: "Cedar Hollow Youth Robotics" }),
  "fund name": () => connection.db.update(s.funds).set({ name: "STEM B" }).where(eq(s.funds.id, "fund_b")),
  "claim line description": () => connection.db.update(s.claimLines).set({ description: "Science kits" }).where(and(eq(s.claimLines.claimId, "C-104"), eq(s.claimLines.id, "L1"))),
  "policy summary": async () => {
    // Policy versions are immutable by trigger. A throwaway database stands in for one that was seeded earlier.
    await connection.client`alter table fund_policy_versions disable trigger fund_policy_immutable`;
    await connection.db.update(s.fundPolicyVersions).set({ summary: oldFundBSummary }).where(eq(s.fundPolicyVersions.fundId, "fund_b"));
    await connection.client`alter table fund_policy_versions enable trigger fund_policy_immutable`;
  },
};

it("IAC-382: a fresh database stores the new labels, then the second seed is UNCHANGED", async () => {
  expect(await seedFixture(connection.db, config)).toBe("CREATED");
  expect(await seedFixture(connection.db, config)).toBe("UNCHANGED");
  const [organization] = await connection.db.select().from(s.organizations);
  expect(organization).toMatchObject({ id: "cedar-hollow", name: "Lanternfield Community Alliance" });
  const funds = await connection.db.select().from(s.funds).orderBy(s.funds.id);
  expect(funds.map(fund => [fund.id, fund.name])).toEqual([["fund_a", "Ashmere County Afterschool STEM Subgrant"], ["fund_b", "Tallow Creek Robot Kit Initiative"], ["fund_g", "General Operating"]]);
  const policies = await connection.db.select().from(s.fundPolicyVersions).orderBy(s.fundPolicyVersions.fundId);
  expect(policies.find(row => row.fundId === "fund_a")!.summary).toBe("Eastside Robotics Club share: robot kits, parts and notebooks, September 2026 through June 2027; supplies cap $300.");
  expect(policies.find(row => row.fundId === "fund_b")!.summary).toBe("Eastside Robotics Club share: robot kits and parts only, October through December 2026; supplies cap $200.");
  const lines = await connection.db.select().from(s.claimLines).orderBy(s.claimLines.id);
  expect(lines.map(line => [line.id, line.description, line.category, line.budgetLine, line.amountCents.toString()])).toEqual([
    ["L1", "Robot kit and parts", "robot_kits_parts", "supplies", "28000"], ["L2", "Engineering notebooks", "classroom_supplies", "supplies", "15000"], ["L3", "Team meals", "participant_meals", "other", "7000"]]);
});
it.each(Object.keys(oldLabel))("IAC-382: an existing database holding the old %s refuses the new seed and is left as it was", async label => {
  await seedFixture(connection.db, config);
  await oldLabel[label]!();
  const before = JSON.stringify([await connection.db.select().from(s.organizations), await connection.db.select().from(s.funds), await connection.db.select().from(s.fundPolicyVersions), await connection.db.select().from(s.claimLines)], (_k, v) => typeof v === "bigint" ? v.toString() : v);
  await expect(seedFixture(connection.db, config)).rejects.toThrow("Existing fixture differs");
  const after = JSON.stringify([await connection.db.select().from(s.organizations), await connection.db.select().from(s.funds), await connection.db.select().from(s.fundPolicyVersions), await connection.db.select().from(s.claimLines)], (_k, v) => typeof v === "bigint" ? v.toString() : v);
  expect(after).toBe(before);
});

// CAT-13 (IAC-382 step 7.2): the category ids and the prohibited list are part of the fixture comparison, so a database seeded with the
// old ids refuses the new seed instead of being rewritten (fresh databases only).
const oldCategories: Record<string, () => Promise<unknown>> = {
  "claim line categories": async () => {
    await connection.db.update(s.claimLines).set({ category: "science_kits" }).where(and(eq(s.claimLines.claimId, "C-104"), eq(s.claimLines.id, "L1")));
    await connection.db.update(s.claimLines).set({ category: "notebooks" }).where(and(eq(s.claimLines.claimId, "C-104"), eq(s.claimLines.id, "L2")));
    await connection.db.update(s.claimLines).set({ category: "hospitality", budgetLine: "hospitality" }).where(and(eq(s.claimLines.claimId, "C-104"), eq(s.claimLines.id, "L3")));
  },
  "prohibited list": () => connection.db.update(s.organizations).set({ prohibitedCategories: ["alcohol"] }),
  "allowed categories": async () => {
    await connection.client`alter table fund_policy_versions disable trigger fund_policy_immutable`;
    await connection.db.update(s.fundPolicyVersions).set({ allowedCategories: ["science_kits", "notebooks"] }).where(eq(s.fundPolicyVersions.fundId, "fund_a"));
    await connection.client`alter table fund_policy_versions enable trigger fund_policy_immutable`;
  },
};
it.each(Object.keys(oldCategories))("CAT-13: an existing database holding the old %s refuses the new seed and is left as it was", async label => {
  await seedFixture(connection.db, config);
  const [org] = await connection.db.select().from(s.organizations); expect(org!.prohibitedCategories).toEqual(["alcohol", "gift_cards"]);
  await oldCategories[label]!();
  const snapshot = async () => JSON.stringify([await connection.db.select().from(s.organizations), await connection.db.select().from(s.fundPolicyVersions), await connection.db.select().from(s.claimLines)], (_k, v) => typeof v === "bigint" ? v.toString() : v);
  const before = await snapshot();
  await expect(seedFixture(connection.db, config)).rejects.toThrow("Existing fixture differs");
  expect(await snapshot()).toBe(before);
});
