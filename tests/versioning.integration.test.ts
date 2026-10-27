import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import * as s from "../db/schema";
import { advanceSolverPriority, approveDecision, freezeDecision, recognizeDecision } from "../src/ledger/service";
import { loadClaimView } from "../src/server/claim-view";

const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://aidtrace@db:5432/aidtrace");
adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 });
let databaseName: string;
let connection: ReturnType<typeof connectDatabase>;
let created = false;
beforeEach(async () => {
  databaseName = `aidtrace_iac138_test_${randomBytes(6).toString("hex")}`;
  await admin`create database ${admin(databaseName)}`; created = true;
  const url = new URL(adminUrl); url.pathname = `/${databaseName}`;
  connection = connectDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: "db/migrations" });
  await seedFixture(connection.db, { passwords: { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") }, payeeEmail: "version-test@example.invalid", payeeAllowlist: ["version-test@example.invalid"] });
}, 30_000);
afterEach(async () => {
  if (connection) await connection.client.end();
  if (created) { await admin`drop database ${admin(databaseName)}`; created = false; }
}, 30_000);
afterAll(async () => { await admin.end(); });

async function frozen(id = "C-104") {
  const result = await freezeDecision(connection.db, id, "maria");
  if (result.status !== "AWAITING_APPROVAL") throw new Error("Expected funded decision");
  return result;
}
async function assertReleased(id: string, hash: string) {
  const { db } = connection;
  const [old] = await db.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.id, id));
  expect(old!.invalidatedAt).toBeInstanceOf(Date); expect(old!.recognizedAt).toBeNull();
  const holds = await db.select().from(s.fundReservations).where(eq(s.fundReservations.decisionId, id));
  expect(holds.length).toBeGreaterThan(0); expect(holds.every(row => row.status === "RELEASED")).toBe(true);
  expect((await db.select().from(s.approvals).where(eq(s.approvals.decisionHash, hash))).map(row => row.approverId)).toEqual(["tara"]);
  expect((await db.select().from(s.journalEntries)).every(row => row.sourceType === "fixture_opening_balance")).toBe(true);
}

describe("IAC-138 isolated PostgreSQL acceptance", () => {
  it("SOL-04: overlapping claim freezes retry or fail cleanly without over-reserving fund_b", async () => {
    const { db, client } = connection;
    const [template] = await db.select().from(s.claims);
    for (const id of ["race-a", "race-b"]) {
      await db.insert(s.claims).values({ ...template!, id, status: "DRAFT" });
      await db.insert(s.claimLines).values({ claimId: id, claimVersion: 1, id: "kits", description: "Race fixture", category: "science_kits", budgetLine: "supplies", amountCents: 100000n });
    }
    let attempts!: Promise<PromiseSettledResult<Awaited<ReturnType<typeof freezeDecision>>>[]>;
    // Hold the actual application lock until both transactions have reached it. Their
    // pre-lock reads acquire snapshots before either competing freeze can commit.
    await client.begin(async gate => {
      await gate`select pg_advisory_xact_lock(hashtext('cedar-hollow')::bigint)`;
      attempts = Promise.allSettled([freezeDecision(db, "race-a", "maria"), freezeDecision(db, "race-b", "maria")]);
      let waiting = 0;
      for (let poll = 0; poll < 200; poll++) {
        const rows = await gate`select count(*)::int as n from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())`;
        waiting = Number(rows[0]!.n); if (waiting === 2) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(2);
    });
    const results = await attempts;
    expect(results.every(result => result.status === "fulfilled")).toBe(true);
    expect(results.map(result => result.status === "fulfilled" ? result.value.status : "ERROR").sort()).toEqual(["AWAITING_APPROVAL", "INFEASIBLE"]);
    const active = await db.select().from(s.fundReservations).where(eq(s.fundReservations.status, "ACTIVE"));
    expect(active.filter(row => row.fundId === "fund_b").reduce((sum, row) => sum + row.amountCents, 0n)).toBe(20000n);
    const capacities = { fund_a: 30000n, fund_b: 20000n, fund_g: 100000n };
    for (const [fund, capacity] of Object.entries(capacities)) expect(active.filter(row => row.fundId === fund).reduce((sum, row) => sum + row.amountCents, 0n)).toBeLessThanOrEqual(capacity);
    const losing = results.findIndex(result => result.status === "fulfilled" && result.value.status === "INFEASIBLE");
    expect((await db.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.claimId, ["race-a", "race-b"][losing]!))).length).toBe(0);
  }, 15_000);

  it("SOL-05: advancing priority atomically invalidates pending approvals and holds, then recomputes deterministically", async () => {
    const { db } = connection; const old = await frozen();
    await approveDecision(db, old.decisionId, "tara", old.decisionHash);
    const [template] = await db.select().from(s.claims);
    await db.insert(s.claims).values({ ...template!, id: "another-pending", status: "DRAFT" });
    await db.insert(s.claimLines).values({ claimId: "another-pending", claimVersion: 1, id: "snack", description: "Second pending claim", category: "hospitality", budgetLine: "hospitality", amountCents: 100n });
    const another = await frozen("another-pending"); await approveDecision(db, another.decisionId, "tara", another.decisionHash);
    await expect(advanceSolverPriority(db, "cedar-hollow", "maria", 1)).rejects.toThrow("approver");
    await expect(advanceSolverPriority(db, "other-org", "tara", 1)).rejects.toThrow("approver");
    expect(await advanceSolverPriority(db, "cedar-hollow", "tara", 1)).toEqual({ version: 2, invalidatedDecisions: 2 });
    await assertReleased(old.decisionId, old.decisionHash);
    await assertReleased(another.decisionId, another.decisionHash);
    await expect(approveDecision(db, old.decisionId, "ben", old.decisionHash)).rejects.toThrow("invalidated");
    await expect(advanceSolverPriority(db, "cedar-hollow", "tara", 1)).rejects.toThrow("version changed");
    const next = await frozen(); expect(next.decisionHash).not.toBe(old.decisionHash);
    expect(next.edges.map(edge => edge.solverPriorityVersion)).toEqual([2, 2, 2, 2]);
    expect(next.edges.map(({ solverPriorityVersion: _version, ...edge }) => edge)).toEqual(old.edges.map(({ solverPriorityVersion: _version, ...edge }) => edge));
    expect(await frozen()).toEqual(next);
    expect((await approveDecision(db, next.decisionId, "ben", next.decisionHash))).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    expect((await approveDecision(db, next.decisionId, "tara", next.decisionHash)).status).toBe("APPROVED");
  });

  it("preserves recognized v1 decisions and journal rows across a later priority revision", async () => {
    const { db } = connection; const old = await frozen();
    await approveDecision(db, old.decisionId, "tara", old.decisionHash); await approveDecision(db, old.decisionId, "ben", old.decisionHash);
    const decisions = await db.select().from(s.allocationDecisions); const postings = await db.select().from(s.journalPostings);
    expect(await advanceSolverPriority(db, "cedar-hollow", "tara", 1)).toEqual({ version: 2, invalidatedDecisions: 0 });
    expect(await db.select().from(s.allocationDecisions)).toEqual(decisions); expect(await db.select().from(s.journalPostings)).toEqual(postings);
    expect((await recognizeDecision(db, old.decisionId, "ben")).status).toBe("APPROVED");
    const view = await loadClaimView(db, "C-104", "ben");
    expect(view.decision!.solverPriorityVersion).toBe(1); expect(view.edges).toHaveLength(4); expect(view.report.openPayableCents).toBe(50000n);
  });

  it.each(["line", "payee", "policy", "edge"])("APP-02: changed %s creates a new hash with no carried approval", async kind => {
    const { db } = connection; const old = await frozen(); await approveDecision(db, old.decisionId, "tara", old.decisionHash);
    if (kind === "line" || kind === "payee") {
      // A trusted test edit creates a new claim version, preserving original terms.
      const [claim] = await db.select().from(s.claims);
      await db.insert(s.claims).values({ ...claim!, version: 2, status: "DRAFT", ...(kind === "payee" ? { payeeEmail: "changed@example.invalid" } : {}) });
      const lines = await db.select().from(s.claimLines);
      await db.insert(s.claimLines).values(lines.map(line => ({ ...line, claimVersion: 2, ...(kind === "line" && line.id === "L1" ? { amountCents: line.amountCents + 100n } : {}) })));
    } else if (kind === "policy") {
      const [policy] = await db.select().from(s.fundPolicyVersions).where(eq(s.fundPolicyVersions.fundId, "fund_a"));
      await db.insert(s.fundPolicyVersions).values({ ...policy!, version: 2 });
      await db.insert(s.fundBudgetLines).values({ fundId: "fund_a", policyVersion: 2, budgetLine: "supplies", capCents: 30000n });
      await db.update(s.funds).set({ currentPolicyVersion: 2 }).where(eq(s.funds.id, "fund_a"));
    } else {
      // Frozen edges cannot be edited. A changed capacity snapshot causes a valid
      // replacement allocation instead, with the same claim and policy version IDs.
      await expect(db.update(s.allocationEdges).set({ amountCents: 1n }).where(eq(s.allocationEdges.decisionId, old.decisionId))).rejects.toThrow();
      await db.update(s.fundBudgetLines).set({ capCents: 10000n }).where(and(eq(s.fundBudgetLines.fundId, "fund_a"), eq(s.fundBudgetLines.policyVersion, 1)));
    }
    const next = await frozen(); expect(next.decisionHash).not.toBe(old.decisionHash);
    if (kind === "edge") expect(next.edges).not.toEqual(old.edges);
    await assertReleased(old.decisionId, old.decisionHash);
    await expect(approveDecision(db, next.decisionId, "ben", old.decisionHash)).rejects.toThrow("hash");
    expect((await approveDecision(db, next.decisionId, "ben", next.decisionHash))).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    const [current] = await db.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.id, next.decisionId));
    expect(current!.recognizedAt).toBeNull();
  });

  it("SOL-07: persisted shared supplies cap binds across both categories", async () => {
    const { db } = connection;
    await db.update(s.fundBudgetLines).set({ capCents: 10000n }).where(eq(s.fundBudgetLines.fundId, "fund_a"));
    const result = await frozen();
    for (const [fund, amount] of [["fund_a", 10000n], ["fund_b", 20000n], ["fund_g", 20000n]] as const) {
      expect(result.edges.filter(edge => edge.fundId === fund).reduce((sum, edge) => sum + edge.amountCents, 0n)).toBe(amount);
      const [hold] = await db.select().from(s.fundReservations).where(and(eq(s.fundReservations.decisionId, result.decisionId), eq(s.fundReservations.fundId, fund)));
      expect(hold!.amountCents).toBe(amount);
    }
    expect(await frozen()).toEqual(result);
  });
});
