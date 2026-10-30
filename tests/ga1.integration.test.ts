import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { compare } from "bcryptjs";
import { connectDatabase, closeDatabase } from "../src/server/db";
import { correctUnallocatedFixturePayee, readSeedConfig, seedFixture } from "../db/fixture";
import * as schema from "../db/schema";
import { authenticate, findSession, revokeSession } from "../src/server/auth";

const databaseName = `aidtrace_iac133_test_${randomBytes(6).toString("hex")}`;
const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://aidtrace@db:5432/aidtrace");
adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 });
const testUrl = new URL(adminUrl); testUrl.pathname = `/${databaseName}`;
const { db, client } = connectDatabase(testUrl.toString());
const passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
const config = { passwords, payeeEmail: "test-recipient@example.invalid", payeeAllowlist: ["test-recipient@example.invalid"] };
let created = false;

beforeAll(async () => {
  // A uniquely named database created by this test is the only database cleaned up below.
  await admin`create database ${admin(databaseName)}`; created = true;
  await migrate(db, { migrationsFolder: "db/migrations" });
  await migrate(db, { migrationsFolder: "db/migrations" });
  process.env.DATABASE_URL = testUrl.toString();
  process.env.APP_ORIGIN = "http://127.0.0.1:3100";
}, 30_000);
afterAll(async () => {
  await closeDatabase(); await client.end();
  if (created) await admin`drop database ${admin(databaseName)}`;
  await admin.end();
});

describe("IAC-133 real Postgres migration, fixture, and sessions", () => {
  it("creates all nineteen domain entities and supporting auth/budget tables", async () => {
    const rows = await client`select table_name from information_schema.tables where table_schema='public'`;
    const names = rows.map(row => row.table_name);
    for (const name of ["organizations", "users", "funds", "fund_policy_versions", "solver_priority_versions", "claims", "claim_lines", "allocation_decisions", "allocation_edges", "fund_reservations", "approvals", "fund_credits", "fund_debits", "journal_entries", "journal_postings", "disbursements", "disbursement_attempts", "retry_authorizations", "provider_events", "fund_budget_lines", "reservation_budget_lines", "sessions", "login_windows"]) expect(names.includes(name)).toBe(true);
  });
  it("seeds exactly Section 3 and is idempotent without duplicating openings", async () => {
    expect(await seedFixture(db, config)).toBe("CREATED");
    expect(await seedFixture(db, config)).toBe("UNCHANGED");
    const people = await db.select().from(schema.users);
    expect(people.length).toBe(3);
    for (const name of ["maria", "tara", "ben"] as const) {
      const user = people.find(row => row.username === name)!;
      expect(user.role).toBe(name === "maria" ? "CLAIMANT" : "APPROVER");
      expect(user.passwordHash.startsWith("$2b$12$")).toBe(true);
      expect(user.passwordHash === passwords[name]).toBe(false);
      expect(await compare(passwords[name], user.passwordHash)).toBe(true);
    }
    const funds = await db.select().from(schema.funds);
    expect(funds.length).toBe(3);
    const lines = await db.select().from(schema.claimLines).orderBy(schema.claimLines.id);
    expect(lines.map(row => [row.id, row.category, row.amountCents])).toEqual([["L1", "robot_kits_parts", 28000n], ["L2", "classroom_supplies", 15000n], ["L3", "participant_meals", 7000n]]);
    const credits = await db.select().from(schema.fundCredits).orderBy(schema.fundCredits.fundId);
    expect(credits.map(row => [row.fundId, row.amountCents, row.sourceType, row.isOpening])).toEqual([["fund_a", 30000n, "fixture_opening_balance", true], ["fund_b", 20000n, "fixture_opening_balance", true], ["fund_g", 100000n, "fixture_opening_balance", true]]);
    expect(credits.every(row => row.effectiveOn === "2026-10-14" && row.recordedAt instanceof Date)).toBe(true);
    const caps = await db.select().from(schema.fundBudgetLines).orderBy(schema.fundBudgetLines.fundId);
    expect(caps.map(row => [row.fundId, row.budgetLine, row.capCents])).toEqual([["fund_a", "supplies", 30000n], ["fund_b", "supplies", 20000n]]);
    expect((await db.select().from(schema.journalEntries)).length).toBe(0);
  }, 15_000);
  it("refuses changed seed inputs without replacing credentials or data", async () => {
    await expect(seedFixture(db, { ...config, payeeEmail: "changed@example.invalid" })).rejects.toThrow("refuses to overwrite");
    const [claim] = await db.select().from(schema.claims);
    expect(claim.payeeEmail === config.payeeEmail).toBe(true);
  });
  it("rejects negative money at the database boundary", async () => {
    await expect(db.insert(schema.fundCredits).values({ fundId: "fund_a", amountCents: -1n, sourceType: "fixture_opening_balance", sourceId: "negative-test", effectiveOn: "2026-10-14", isOpening: true })).rejects.toMatchObject({ cause: { code: "23514", constraint_name: "credit_amount_positive" } });
  });
  it("rejects mixed opening sources but allows genuinely new donations", async () => {
    await expect(db.insert(schema.fundCredits).values({ fundId: "fund_b", amountCents: 100n, sourceType: "paypal_capture", sourceId: "synthetic-opening-test", effectiveOn: "2026-10-14", isOpening: true })).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(db.update(schema.organizations).set({ openingSourceType: "paypal_capture" }).where(eq(schema.organizations.id, "cedar-hollow"))).rejects.toMatchObject({ cause: { code: "23514" } });
    await db.transaction(async tx => {
      await tx.insert(schema.fundCredits).values({ fundId: "fund_b", amountCents: 100n, sourceType: "paypal_capture", sourceId: "synthetic-new-donation", effectiveOn: "2026-10-14", isOpening: false });
      const rows = await tx.select().from(schema.fundCredits).where(eq(schema.fundCredits.sourceId, "synthetic-new-donation"));
      expect(rows.length).toBe(1);
      await tx.delete(schema.fundCredits).where(eq(schema.fundCredits.sourceId, "synthetic-new-donation"));
    });
  });
  it("authenticates all three users and stores only token hashes", async () => {
    for (const name of ["maria", "tara", "ben"] as const) {
      const result = await authenticate(name, passwords[name], db);
      expect(Boolean(result)).toBe(true);
      const current = await findSession(result!.token, db);
      expect(current?.username).toBe(name);
      const stored = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, name));
      expect(stored.some(row => row.tokenHash === result!.token)).toBe(false);
      await revokeSession(result!.token, db);
      expect(await findSession(result!.token, db)).toBeNull();
    }
    expect(await authenticate("maria", "wrong-password", db)).toBeNull();
    expect(await authenticate("nobody", "wrong-password", db)).toBeNull();
  }, 15_000);
  it("rejects expired and forged sessions", async () => {
    const result = await authenticate("tara", passwords.tara, db);
    await db.update(schema.sessions).set({ createdAt: new Date(Date.now() - 7200000), expiresAt: new Date(Date.now() - 3600000) }).where(eq(schema.sessions.userId, "tara"));
    expect(await findSession(result!.token, db)).toBeNull();
    expect(await findSession("0".repeat(64), db)).toBeNull();
  });
  it("sets httpOnly cookies, requires origin, revokes sessions, and exposes no role toggle", async () => {
    const login = await import("../src/app/api/auth/login/route");
    const session = await import("../src/app/api/auth/session/route");
    const logout = await import("../src/app/api/auth/logout/route");
    const make = (username: string, password: string, origin = "http://127.0.0.1:3100") => new Request("http://127.0.0.1:3100/api/auth/login", { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username, password, role: "APPROVER" }).toString() });
    expect((await login.POST(make("maria", passwords.maria, "https://untrusted.example"))).status).toBe(403);
    for (const name of ["maria", "tara", "ben"] as const) {
      const response = await login.POST(make(name, passwords[name]));
      expect(response.status).toBe(303);
      const cookie = response.headers.get("set-cookie")!;
      expect(cookie.includes("HttpOnly")).toBe(true);
      expect(cookie.includes("SameSite=Strict")).toBe(true);
      const cookieHeader = cookie.split(";")[0];
      const result = await session.GET(new Request("http://127.0.0.1:3100/api/auth/session", { headers: { cookie: cookieHeader } }));
      expect(result.status).toBe(200);
      const body = await result.json();
      expect(body.user.username).toBe(name);
      expect(body.user.role).toBe(name === "maria" ? "CLAIMANT" : "APPROVER");
      expect("passwordHash" in body.user).toBe(false);
      expect((await logout.POST(new Request("http://127.0.0.1:3100/api/auth/logout", { method: "POST", headers: { origin: "http://127.0.0.1:3100", cookie: cookieHeader } }))).status).toBe(303);
      expect((await session.GET(new Request("http://127.0.0.1:3100/api/auth/session", { headers: { cookie: cookieHeader } }))).status).toBe(401);
    }
  }, 15_000);
  it("bounds repeated login attempts using shared database state", async () => {
    await db.delete(schema.loginWindows).where(eq(schema.loginWindows.username, "maria"));
    for (let i = 0; i < 10; i++) await authenticate("maria", "incorrect", db);
    expect(await authenticate("maria", passwords.maria, db)).toBeNull();
    await db.update(schema.loginWindows).set({ resetsAt: new Date(Date.now() - 1) }).where(eq(schema.loginWindows.username, "maria"));
    expect(Boolean(await authenticate("maria", passwords.maria, db))).toBe(true);
  }, 15_000);
  it("rejects missing seed inputs before any writes", () => {
    expect(() => readSeedConfig({})).toThrow("SEED_PASSWORD_MARIA");
  });
  it("corrects only an unallocated DRAFT fixture and refuses changes after a decision exists", async () => {
    await correctUnallocatedFixturePayee(db, "recipient@personal.example.com");
    const [claim] = await db.select().from(schema.claims);
    expect(claim.payeeEmail).toBe("recipient@personal.example.com");
    await db.insert(schema.allocationDecisions).values({ claimId: "C-104", claimVersion: 1, organizationId: "cedar-hollow", solverPriorityVersion: 1, decisionHash: "1".repeat(64), payload: {} });
    await expect(correctUnallocatedFixturePayee(db, "other@personal.example.com")).rejects.toThrow("activity exists");
    expect((await db.select().from(schema.claims))[0]?.payeeEmail).toBe("recipient@personal.example.com");
    // Frozen decisions remain preserved; afterAll removes only this test's own database.
  });
});
