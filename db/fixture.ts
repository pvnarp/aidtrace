import { compare, hash } from "bcryptjs";
import { and, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../src/server/db";
import * as s from "./schema";

export interface SeedConfig { passwords: Record<"maria" | "tara" | "ben", string>; payeeEmail: string; payeeAllowlist: string[]; }
export function readSeedConfig(env: Readonly<Record<string, string | undefined>>): SeedConfig {
  const passwords = {} as SeedConfig["passwords"];
  for (const name of ["maria", "tara", "ben"] as const) {
    const value = env[`SEED_PASSWORD_${name.toUpperCase()}`];
    if (!value || value.length < 12 || Buffer.byteLength(value, "utf8") > 72) throw new Error(`SEED_PASSWORD_${name.toUpperCase()} must be 12+ characters and at most 72 UTF-8 bytes`);
    passwords[name] = value;
  }
  if (new Set(Object.values(passwords)).size !== 3) throw new Error("Seed users need distinct passwords");
  const payeeEmail = env.PAYPAL_SANDBOX_PAYEE_EMAIL?.trim();
  const payeeAllowlist = (env.PAYEE_ALLOWLIST ?? "").split(",").map(v => v.trim()).filter(Boolean);
  if (!payeeEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payeeEmail)) throw new Error("Set PAYPAL_SANDBOX_PAYEE_EMAIL before seeding");
  if (!payeeAllowlist.includes(payeeEmail)) throw new Error("Sandbox payee must appear in PAYEE_ALLOWLIST");
  return { passwords, payeeEmail, payeeAllowlist };
}

const organization = { id: "cedar-hollow", name: "Lanternfield Community Alliance", prohibitedCategories: ["alcohol", "gift_cards"], isFixture: true, openingSourceType: "fixture_opening_balance" as const };
const fundRows = [
  { id: "fund_a", organizationId: organization.id, name: "Ashmere County Afterschool STEM Subgrant", fundClass: "RESTRICTED" as const, currentPolicyVersion: 1, isFixture: true },
  { id: "fund_b", organizationId: organization.id, name: "Tallow Creek Robot Kit Initiative", fundClass: "RESTRICTED" as const, currentPolicyVersion: 1, isFixture: true },
  { id: "fund_g", organizationId: organization.id, name: "General Operating", fundClass: "UNRESTRICTED" as const, currentPolicyVersion: 1, isFixture: true },
];
const policies = [
  { fundId: "fund_a", version: 1, approvedBy: "tara", programs: ["robotics"], allowedCategories: ["robot_kits_parts", "classroom_supplies"], periodStart: "2026-09-01", periodEnd: "2027-06-30", breadth: 2, summary: "Eastside Robotics Club share: robot kits, parts and notebooks, September 2026 through June 2027; supplies cap $300." },
  { fundId: "fund_b", version: 1, approvedBy: "tara", programs: ["robotics"], allowedCategories: ["robot_kits_parts"], periodStart: "2026-10-01", periodEnd: "2026-12-31", breadth: 1, summary: "Eastside Robotics Club share: robot kits and parts only, October through December 2026; supplies cap $200." },
  { fundId: "fund_g", version: 1, approvedBy: "tara", programs: null, allowedCategories: null, periodStart: null, periodEnd: null, breadth: null, summary: "Any program and category except the organization prohibited list; no period or budget cap." },
];
const budgetRows = [
  { fundId: "fund_a", policyVersion: 1, budgetLine: "supplies", capCents: 30000n },
  { fundId: "fund_b", policyVersion: 1, budgetLine: "supplies", capCents: 20000n },
];
// IAC-405 step 1 (docs/plans/POLICY_CHECK_SCOPE.md section 3): version 1 check thresholds for the fixture funds, written on a fresh database only.
// An existing database is not asserted against these rows and gets no additive seed (docs/ASSUMPTIONS.md).
const checkSettings = ["fund_a", "fund_b", "fund_g"].map(fundId => ({ fundId, version: 1, approvedBy: "tara", suppliesLimitCents: 25000n, equipmentLimitCents: 50000n, claimLimitCents: 100000n, staleReceiptDays: 60, duplicateWindowDays: 90, splitWindowDays: 3 }));
// IAC-405 step 1 piece G and N1 (docs/plans/POLICY_CHECK_SCOPE.md sections 2.2 and 3.3; docs/ASSUMPTIONS.md section 60): the clause text the model
// reads, at the fixture policy version 1, written on a fresh database only and only when migration 0017 has created the table. The wording was
// finalized by the orchestrator under the owner's October 31 delegation (docs/decisions.md decision 12) and is seeded word for word. fund_g
// (General Operating) has no clauses on purpose: the model check skips it. An existing database gets no additive seed, as with the check settings.
const clauseTexts: Record<string, readonly string[]> = {
  fund_a: [
    "Funds may be used only for direct costs of the Eastside Robotics Club afterschool program: robot kits, robot parts and electronic components, and classroom supplies such as engineering notebooks.",
    "Every cost must be reasonable and necessary for the program and must benefit participating students rather than the organization generally.",
    "Food, meals, travel, entertainment and staff pay are not allowable under this subgrant.",
    "Gift cards, gift certificates and any other cash equivalent are not allowable under any circumstances, including as prizes or incentives.",
    "Alcoholic beverages are not allowable under any circumstances.",
    "Items for personal use, and costs that benefit an individual rather than the program, are not allowable.",
    "Costs of the organization's other programs are not allowable, even where the item could also be used by the robotics club.",
  ],
  fund_b: [
    "Funds may be used only for robot kits and robot parts for the Eastside Robotics Club, including motors, sensors, controllers, structural pieces and batteries for the robots.",
    "Classroom supplies, notebooks, tools, furniture and general electronics that are not robot parts are not allowable under this initiative.",
    "Food, meals, travel, entertainment and staff pay are not allowable.",
    "Gift cards, gift certificates, other cash equivalents and alcoholic beverages are not allowable under any circumstances.",
    "Costs of the organization's other programs are not allowable.",
  ],
};
const clauseNumber: Record<string, number> = { fund_a: 1, fund_b: 2 };
export const fixtureClauses = Object.entries(clauseTexts).flatMap(([fundId, texts]) => texts.map((text, index) => ({ fundId, policyVersion: 1, clauseId: `${clauseNumber[fundId]}.${index + 1}`, text })));
const priority = { organizationId: organization.id, version: 1, approvedBy: "tara", costsPerCent: { fund_a: "2000", fund_b: "1001", fund_g: "1000000" } };
const lines = [
  { claimId: "C-104", claimVersion: 1, id: "L1", description: "Robot kit and parts", category: "robot_kits_parts", budgetLine: "supplies", amountCents: 28000n },
  { claimId: "C-104", claimVersion: 1, id: "L2", description: "Engineering notebooks", category: "classroom_supplies", budgetLine: "supplies", amountCents: 15000n },
  { claimId: "C-104", claimVersion: 1, id: "L3", description: "Team meals", category: "participant_meals", budgetLine: "other", amountCents: 7000n },
];
const openings = [
  { fundId: "fund_a", amountCents: 30000n }, { fundId: "fund_b", amountCents: 20000n }, { fundId: "fund_g", amountCents: 100000n },
].map(row => ({ ...row, sourceType: "fixture_opening_balance" as const, sourceId: "cedar-opening-v1", effectiveOn: "2026-10-14", isOpening: true }));

function comparable(value: unknown) {
  return JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v);
}
function assertRows(actual: Record<string, unknown>[], expected: Record<string, unknown>[], orderBy: string[]) {
  const project = (rows: Record<string, unknown>[]) => rows.map(row => Object.fromEntries(Object.keys(expected[0] ?? {}).map(key => [key, row[key]])))
    .sort((a, b) => comparable(orderBy.map(k => a[k])).localeCompare(comparable(orderBy.map(k => b[k]))));
  if (comparable(project(actual)) !== comparable(project(expected))) throw new Error("Existing fixture differs; seed refuses to overwrite data. Use a separate workspace or reviewed migration.");
}

// IAC-405 step 3 PR P (docs/ASSUMPTIONS.md section 78). Pavan's decision 5, November 2: "Seed it, marked as demo (Recommended)". The seed alone writes one payee_email_history row of source FIXTURE for Maria's
// payout email, first seen 45 days before the seed runs, so guardrail G6 can pass for her in a fresh database. No claim-creation write can produce that source: the claims trigger of migration 0020
// writes CLAIM only. The claim page shows a FIXTURE row as demo history. A database taken only through migration 0019 or earlier has no such table, so it is skipped there. Written once.
const DEMO_HISTORY_DAYS = 45;
async function ensureDemoEmailHistory(tx: Pick<AppDatabase, "select" | "insert" | "execute">, payeeEmail: string) {
  const [table] = await tx.execute<{ present: boolean }>(sql`select to_regclass('public.payee_email_history') is not null as present`);
  if (!table?.present) return;
  const existing = await tx.select({ id: s.payeeEmailHistory.id }).from(s.payeeEmailHistory).where(and(eq(s.payeeEmailHistory.userId, "maria"), eq(s.payeeEmailHistory.source, "FIXTURE")));
  if (existing.length) return;
  await tx.insert(s.payeeEmailHistory).values({ userId: "maria", email: payeeEmail, source: "FIXTURE", seenAt: new Date(Date.now() - DEMO_HISTORY_DAYS * 86_400_000) });
}

export async function seedFixture(db: AppDatabase, config: SeedConfig) {
  const people = [
    { id: "maria", organizationId: organization.id, username: "maria", displayName: "Maria", role: "CLAIMANT" as const, isFixture: true },
    { id: "tara", organizationId: organization.id, username: "tara", displayName: "Tara", role: "APPROVER" as const, isFixture: true },
    { id: "ben", organizationId: organization.id, username: "ben", displayName: "Ben", role: "APPROVER" as const, isFixture: true },
  ];
  const claim = { id: "C-104", version: 1, organizationId: organization.id, claimantId: "maria", program: "robotics", vendor: "Brightbench Supply Co.", incurredOn: "2026-10-14", payeeEmail: config.payeeEmail, payeeIsPlaceholder: config.payeeEmail.endsWith(".invalid"), status: "DRAFT" as const, isFixture: true };
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(13320261022)`);
    const existing = await tx.select().from(s.organizations);
    if (existing.length) {
      assertRows(existing, [organization], ["id"]);
      const existingPeople = await tx.select().from(s.users);
      assertRows(existingPeople, people, ["id"]);
      for (const person of people) {
        const stored = existingPeople.find(row => row.id === person.id);
        if (!stored || !await compare(config.passwords[person.id as keyof SeedConfig["passwords"]], stored.passwordHash)) throw new Error("Existing credentials differ; seed does not reset passwords");
      }
      assertRows(await tx.select().from(s.funds), fundRows, ["id"]);
      assertRows(await tx.select().from(s.fundPolicyVersions), policies, ["fundId", "version"]);
      assertRows(await tx.select().from(s.fundBudgetLines), budgetRows, ["fundId", "budgetLine"]);
      assertRows(await tx.select().from(s.solverPriorityVersions), [priority], ["version"]);
      assertRows(await tx.select().from(s.claims), [claim], ["id", "version"]);
      assertRows(await tx.select().from(s.claimLines), lines, ["id"]);
      assertRows(await tx.select().from(s.fundCredits).where(eq(s.fundCredits.isOpening, true)), openings, ["fundId"]);
      await ensureDemoEmailHistory(tx, config.payeeEmail);
      return "UNCHANGED" as const;
    }
    await tx.insert(s.organizations).values(organization);
    for (const person of people) await tx.insert(s.users).values({ ...person, passwordHash: await hash(config.passwords[person.id as keyof SeedConfig["passwords"]], 12) });
    await tx.insert(s.funds).values(fundRows);
    await tx.insert(s.fundPolicyVersions).values(policies);
    await tx.insert(s.fundBudgetLines).values(budgetRows);
    // A database taken only through migration 0014 (tests build one to prove migration 0015 on retained data) has no settings table yet. Skip it there, never fail.
    const [settingsTable] = await tx.execute<{ present: boolean }>(sql`select to_regclass('public.fund_check_settings') is not null as present`);
    if (settingsTable?.present) await tx.insert(s.fundCheckSettings).values(checkSettings);
    // Same rule for the clause table of migration 0017: a database taken only through 0016 or earlier has none, so skip it there, never fail.
    const [clauseTable] = await tx.execute<{ present: boolean }>(sql`select to_regclass('public.fund_policy_clauses') is not null as present`);
    if (clauseTable?.present) await tx.insert(s.fundPolicyClauses).values(fixtureClauses);
    await tx.insert(s.solverPriorityVersions).values(priority);
    await tx.insert(s.claims).values(claim);
    await tx.insert(s.claimLines).values(lines);
    await tx.insert(s.fundCredits).values(openings);
    await ensureDemoEmailHistory(tx, config.payeeEmail);
    return "CREATED" as const;
  });
}

export async function correctUnallocatedFixturePayee(db: AppDatabase, payeeEmail: string) {
  if (!/^[^\s@]+@personal\.example\.com$/.test(payeeEmail)) throw new Error("Correction requires the default sandbox Personal account email");
  await db.transaction(async tx => {
    const [claim] = await tx.select().from(s.claims).where(and(eq(s.claims.id, "C-104"), eq(s.claims.version, 1))).for("update");
    if (!claim || !claim.isFixture || claim.status !== "DRAFT") throw new Error("Correction refused: expected untouched DRAFT fixture");
    const activity = await tx.execute(sql`select
      (select count(*) from allocation_decisions) + (select count(*) from approvals) +
      (select count(*) from fund_reservations) + (select count(*) from disbursements) +
      (select count(*) from journal_entries) as count`);
    if (Number(activity[0]?.count) !== 0) throw new Error("Correction refused: financial workflow activity exists");
    await tx.update(s.claims).set({ payeeEmail, payeeIsPlaceholder: false }).where(and(eq(s.claims.id, "C-104"), eq(s.claims.version, 1)));
  }, { isolationLevel: "serializable" });
}
