import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import * as s from "../db/schema";
import { postJournal } from "../src/ledger/journal";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { reconcile } from "../src/ledger/reconcile";
import { approveDecision, freezeDecision, recognizeDecision, rejectClaim, serializable } from "../src/ledger/service";
import { loadClaimView } from "../src/server/claim-view";

const databaseName = `aidtrace_iac135_test_${randomBytes(6).toString("hex")}`;
const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://aidtrace@db:5432/aidtrace");
adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 });
const testUrl = new URL(adminUrl); testUrl.pathname = `/${databaseName}`;
const { db, client } = connectDatabase(testUrl.toString());
let created = false;
let decisionId: string; let decisionHash: string;
const counts = async () => ({ entries: (await db.select().from(s.journalEntries)).length, postings: (await db.select().from(s.journalPostings)).length, debits: (await db.select().from(s.fundDebits)).length });
const mustFreeze = async (id = "C-104") => {
  const result = await freezeDecision(db, id, "maria");
  if (result.status !== "AWAITING_APPROVAL") throw new Error("Expected funded frozen decision");
  return result;
};
async function extraClaim(id: string, amount = 100n) {
  const [claim] = await db.select().from(s.claims).where(eq(s.claims.id, "C-104"));
  await db.insert(s.claims).values({ ...claim!, id, status: "DRAFT" });
  await db.insert(s.claimLines).values({ claimId: id, claimVersion: 1, id: "extra-line", description: "Test only", category: "participant_meals", budgetLine: "other", amountCents: amount });
}
beforeAll(async () => {
  await admin`create database ${admin(databaseName)}`; created = true;
  await migrate(db, { migrationsFolder: "db/migrations" });
  await migrate(db, { migrationsFolder: "db/migrations" });
  await seedFixture(db, { passwords: { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") }, payeeEmail: "ledger-test@example.invalid", payeeAllowlist: ["ledger-test@example.invalid"] });
}, 30_000);
afterAll(async () => {
  await client.end();
  if (created) await admin`drop database ${admin(databaseName)}`;
  await admin.end();
});

describe("IAC-135 real PostgreSQL ledger and approval boundaries", () => {
  it("retries a real serialization conflict without losing either committed update", async () => {
    await db.execute(sql`create table retry_probe (id integer primary key, value integer not null)`);
    await db.execute(sql`insert into retry_probe values (1, 0)`);
    let arrivals = 0; let attempts = 0; let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const increment = () => serializable(db, async tx => {
      attempts++;
      const rows = await tx.execute(sql`select value from retry_probe where id=1`);
      if (arrivals < 2) { arrivals++; if (arrivals === 2) release(); await barrier; }
      await tx.execute(sql`update retry_probe set value=${Number(rows[0]!.value) + 1} where id=1`);
    });
    await Promise.all([increment(), increment()]);
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect((await db.execute(sql`select value from retry_probe where id=1`))[0]!.value).toBe(2);
    let rejectedAttempts = 0;
    await expect(serializable(db, async tx => {
      rejectedAttempts++;
      await tx.execute(sql`do $$ begin raise exception 'forced test conflict' using errcode = '40001'; end $$`);
    })).rejects.toThrow();
    expect(rejectedAttempts).toBe(4);
    await db.execute(sql`drop table retry_probe`);
  });
  it("rejects empty and unbalanced entries at transaction commit", async () => {
    await expect(db.transaction(async tx => {
      await tx.insert(s.journalEntries).values({ sourceType: "claim_recognition", sourceId: "empty-test", purpose: "recognition", effectiveOn: "2026-10-14" });
    })).rejects.toThrow();
    await expect(db.transaction(async tx => {
      const [entry] = await tx.insert(s.journalEntries).values({ sourceType: "claim_recognition", sourceId: "unbalanced-test", purpose: "recognition", effectiveOn: "2026-10-14" }).returning();
      await tx.insert(s.journalPostings).values([{ entryId: entry!.id, accountCode: "1010", debitCents: 100n, creditCents: 0n }, { entryId: entry!.id, accountCode: "3200", debitCents: 0n, creditCents: 99n }]);
      // Both INSERTs succeed. The deferred balance check rejects the COMMIT.
    })).rejects.toThrow();
    expect(await counts()).toEqual({ entries: 0, postings: 0, debits: 0 });
  });
  it("posts the exact opening once and rejects a changed replay", async () => {
    const first = await db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
    expect(await db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"))).toBe(first);
    const rows = await db.select().from(s.journalPostings).where(eq(s.journalPostings.entryId, first));
    expect(rows.map(row => [row.accountCode, row.subKey, row.debitCents, row.creditCents])).toEqual([["1010", null, 150000n, 0n], ["3100", "fund_a", 0n, 30000n], ["3100", "fund_b", 0n, 20000n], ["3200", null, 0n, 100000n]]);
    const [entry] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.id, first));
    expect(entry!.effectiveOn).toBe("2026-10-14"); expect(entry!.recordedAt).toBeInstanceOf(Date);
    await expect(db.transaction(tx => postJournal(tx, { sourceType: entry!.sourceType, sourceId: entry!.sourceId, purpose: entry!.purpose, effectiveOn: entry!.effectiveOn, postings: [{ accountCode: "1010", debitCents: 1n, creditCents: 0n }, { accountCode: "3200", debitCents: 0n, creditCents: 1n }] }))).rejects.toThrow("replay differs");
    expect((await db.transaction(tx => reconcile(tx, "cedar-hollow"))).matches).toBe(true);
  });
  it("prevents mutation, deletion, truncation and later append to committed journals", async () => {
    const [entry] = await db.select().from(s.journalEntries);
    await expect(db.update(s.journalEntries).set({ purpose: "changed" })).rejects.toThrow();
    await expect(db.delete(s.journalPostings)).rejects.toThrow();
    await expect(db.insert(s.journalPostings).values({ entryId: entry!.id, accountCode: "1010", debitCents: 1n, creditCents: 0n })).rejects.toThrow();
    await expect(db.execute(sql`truncate journal_entries cascade`)).rejects.toThrow();
    expect(await counts()).toEqual({ entries: 1, postings: 4, debits: 0 });
  });
  it("freezes the exact decision and reserves A 23000, B 20000 and General 7000", async () => {
    await expect(freezeDecision(db, "C-104", "tara")).rejects.toThrow("claimant");
    const frozen = await mustFreeze(); decisionId = frozen.decisionId; decisionHash = frozen.decisionHash;
    expect(decisionHash).toMatch(/^[a-f0-9]{64}$/);
    const rows = await db.select().from(s.fundReservations).orderBy(s.fundReservations.fundId);
    expect(rows.map(row => [row.fundId, row.amountCents, row.status])).toEqual([["fund_a", 23000n, "ACTIVE"], ["fund_b", 20000n, "ACTIVE"], ["fund_g", 7000n, "ACTIVE"]]);
    const report = await db.transaction(tx => reconcile(tx, "cedar-hollow"));
    expect(report.fundBalances.find(row => row.fundId === "fund_b")!.availableCents).toBe(0n);
    expect((await mustFreeze()).decisionId).toBe(decisionId);
    expect((await db.select().from(s.fundReservations)).length).toBe(3);
    const level = await serializable(db, async tx => tx.execute(sql`show transaction_isolation`));
    expect(level[0]?.transaction_isolation).toBe("serializable");
  });
  it("APP-01: rejects claimant, missing actor, wrong hash and repeated approver", async () => {
    await expect(approveDecision(db, decisionId, "maria", decisionHash)).rejects.toThrow("Independent");
    await expect(approveDecision(db, decisionId, "missing", decisionHash)).rejects.toThrow("Authenticated");
    await expect(approveDecision(db, decisionId, "tara", "0".repeat(64))).rejects.toThrow("hash");
    expect((await approveDecision(db, decisionId, "tara", decisionHash)).status).toBe("AWAITING_APPROVAL");
    await expect(approveDecision(db, decisionId, "tara", decisionHash)).rejects.toThrow("twice");
    expect((await recognizeDecision(db, decisionId, "ben")).status).toBe("AWAITING_APPROVAL");
    expect(await counts()).toEqual({ entries: 1, postings: 4, debits: 0 });
  });
  it("LED-01: second independent approval atomically recognizes using its own reservations", async () => {
    expect((await approveDecision(db, decisionId, "ben", decisionHash)).status).toBe("APPROVED");
    expect((await db.select().from(s.fundReservations)).every(row => row.status === "CONSUMED")).toBe(true);
    const entries = await db.select().from(s.journalEntries); const postings = await db.select().from(s.journalPostings);
    const exact = (purpose: string) => postings.filter(row => row.entryId === entries.find(entry => entry.purpose === purpose)!.id).map(row => [row.accountCode, row.subKey, row.debitCents, row.creditCents]);
    expect(exact("recognition")).toEqual([["5100", "L1", 28000n, 0n], ["5100", "L2", 15000n, 0n], ["5200", "L3", 7000n, 0n], ["2010", "maria", 0n, 50000n]]);
    expect(exact("restriction_release")).toEqual([["3100", "fund_b", 20000n, 0n], ["3100", "fund_a", 23000n, 0n], ["3200", null, 0n, 43000n]]);
    for (const entry of entries) expect(postings.filter(row => row.entryId === entry.id).reduce((sum, row) => sum + row.debitCents - row.creditCents, 0n)).toBe(0n);
    const debits = await db.select().from(s.fundDebits).orderBy(s.fundDebits.fundId);
    expect(debits.map(row => [row.fundId, row.budgetLine, row.amountCents])).toEqual([["fund_a", "supplies", 23000n], ["fund_b", "supplies", 20000n], ["fund_g", "other", 7000n]]);
    const report = await db.transaction(tx => reconcile(tx, "cedar-hollow"));
    expect(report.openPayableCents).toBe(50000n); expect(report.matches).toBe(true);
    expect((await db.select().from(s.claims))[0]!.status).toBe("APPROVED");
    expect((await db.select().from(s.allocationDecisions))[0]!.recognizedAt).toBeInstanceOf(Date);
  });
  it("replays recognition without another journal or debit and preserves approvals", async () => {
    const before = await counts();
    expect((await recognizeDecision(db, decisionId, "ben")).status).toBe("APPROVED");
    expect(await counts()).toEqual(before);
    await expect(db.delete(s.approvals)).rejects.toThrow();
    await expect(db.update(s.approvals).set({ approvedAt: new Date() })).rejects.toThrow();
    expect((await db.select().from(s.approvals)).length).toBe(2);
    await expect(rejectClaim(db, "C-104", "tara", "Test rejection")).rejects.toThrow("Recognized");
  });
  it("locks recognized claim, line, decision and edge terms at the database boundary", async () => {
    await expect(db.update(s.claims).set({ payeeEmail: "changed@example.invalid" }).where(eq(s.claims.id, "C-104"))).rejects.toThrow();
    await expect(db.update(s.claims).set({ id: "moved" }).where(eq(s.claims.id, "C-104"))).rejects.toThrow();
    await expect(db.update(s.claimLines).set({ description: "changed" })).rejects.toThrow();
    await expect(db.update(s.allocationDecisions).set({ payload: {} })).rejects.toThrow();
    await expect(db.delete(s.allocationEdges)).rejects.toThrow();
    await extraClaim("move-target");
    await expect(db.update(s.claimLines).set({ claimId: "move-target" }).where(eq(s.claimLines.claimId, "C-104"))).rejects.toThrow();
    const [claim] = await db.select().from(s.claims).where(eq(s.claims.id, "C-104"));
    await expect(db.insert(s.claims).values({ ...claim!, version: 2, status: "DRAFT" })).rejects.toThrow();
  });
  it("LED-04: simulated settlement clears payable and ties restricted 7000 and General 93000", async () => {
    await db.transaction(tx => postJournal(tx, { sourceType: "paypal_payout_item", sourceId: "synthetic-settlement-only", purpose: "settlement", effectiveOn: "2026-10-14", postings: [{ accountCode: "2010", subKey: "maria", debitCents: 50000n, creditCents: 0n }, { accountCode: "1010", debitCents: 0n, creditCents: 50000n }] }));
    const report = await db.transaction(tx => reconcile(tx, "cedar-hollow"));
    expect(report).toMatchObject({ matches: true, restrictedCents: 7000n, restrictedGlCents: 7000n, generalCents: 93000n, generalGlCents: 93000n, openPayableCents: 0n, bookCashCents: 100000n, fixtureCashCents: 150000n, providerActivityCashDeltaCents: -50000n });
  });
  it("invalidates changed payee terms, releases reservations and retains prior approval evidence", async () => {
    await extraClaim("changed-payee");
    const frozen = await mustFreeze("changed-payee");
    await approveDecision(db, frozen.decisionId, "tara", frozen.decisionHash);
    const before = await counts();
    await db.update(s.claims).set({ payeeEmail: "new-recipient@example.invalid" }).where(eq(s.claims.id, "changed-payee"));
    expect((await approveDecision(db, frozen.decisionId, "ben", frozen.decisionHash)).status).toBe("INVALIDATED");
    expect((await db.select().from(s.fundReservations).where(eq(s.fundReservations.decisionId, frozen.decisionId))).every(row => row.status === "RELEASED")).toBe(true);
    expect((await db.select().from(s.approvals).where(eq(s.approvals.decisionHash, frozen.decisionHash))).length).toBe(1);
    expect(await counts()).toEqual(before);
  });
  it("releases stale reservations even when changed terms are infeasible", async () => {
    await extraClaim("infeasible-edit"); const frozen = await mustFreeze("infeasible-edit");
    await db.update(s.claimLines).set({ amountCents: 1000000n }).where(eq(s.claimLines.claimId, "infeasible-edit"));
    expect((await freezeDecision(db, "infeasible-edit", "maria")).status).toBe("INFEASIBLE");
    expect((await db.select().from(s.fundReservations).where(eq(s.fundReservations.decisionId, frozen.decisionId)))[0]!.status).toBe("RELEASED");
    expect((await db.select().from(s.claims).where(eq(s.claims.id, "infeasible-edit")))[0]!.status).toBe("DRAFT");
  });
  // FRZ-01 (IAC-415 PR 4). Read-only evidence for the claimant's "Receipt or fund policy changed? Re-check the frozen terms"
  // copy on an awaiting claim: unchanged terms keep the decision and approvals, changed terms funded again replace both, changed terms not funded return
  // the claim to draft (the test above). It asserts current freezeDecision behavior and changes none.
  it("FRZ-01: re-freezing an awaiting claim keeps the decision and approvals when nothing changed and replaces them when the terms changed", async () => {
    await extraClaim("refreeze"); const first = await mustFreeze("refreeze");
    await approveDecision(db, first.decisionId, "tara", first.decisionHash);
    const reservationsOf = async (id: string) => db.select().from(s.fundReservations).where(eq(s.fundReservations.decisionId, id));
    const statusOf = async () => (await db.select().from(s.claims).where(eq(s.claims.id, "refreeze")))[0]!.status;
    const before = await counts();
    // Unchanged terms: the same decision, hash and reservations, and the earlier approval still shows on the claim.
    const again = await mustFreeze("refreeze");
    expect(again.decisionId).toBe(first.decisionId); expect(again.decisionHash).toBe(first.decisionHash);
    expect((await reservationsOf(first.decisionId)).length).toBeGreaterThan(0); expect((await reservationsOf(first.decisionId)).every(row => row.status === "ACTIVE")).toBe(true);
    expect((await loadClaimView(db, "refreeze", "maria")).approvals.map(row => row.approverId)).toEqual(["tara"]);
    expect(await statusOf()).toBe("AWAITING_APPROVAL");
    // Changed terms that funds still cover: the old decision and its reservations are released and new terms are frozen with no approvals on them.
    await db.update(s.claimLines).set({ amountCents: 250n }).where(eq(s.claimLines.claimId, "refreeze"));
    const next = await mustFreeze("refreeze");
    expect(next.decisionId).not.toBe(first.decisionId); expect(next.decisionHash).not.toBe(first.decisionHash);
    expect((await db.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.id, first.decisionId)))[0]!.invalidatedAt).not.toBeNull();
    expect((await reservationsOf(first.decisionId)).every(row => row.status === "RELEASED")).toBe(true);
    expect((await reservationsOf(next.decisionId)).length).toBeGreaterThan(0); expect((await reservationsOf(next.decisionId)).every(row => row.status === "ACTIVE")).toBe(true);
    const view = await loadClaimView(db, "refreeze", "maria");
    expect(view.decision!.id).toBe(next.decisionId); expect(view.approvals).toHaveLength(0);
    // The earlier approval stays as evidence bound to the old hash, and it does not count for the new one.
    expect((await db.select().from(s.approvals).where(eq(s.approvals.decisionHash, first.decisionHash))).length).toBe(1);
    expect((await db.select().from(s.approvals).where(eq(s.approvals.decisionHash, next.decisionHash))).length).toBe(0);
    expect(await statusOf()).toBe("AWAITING_APPROVAL");
    expect(await counts()).toEqual(before);
  });
  it("rejects a draft obligation and releases its reservation without journal postings", async () => {
    await extraClaim("rejected-claim"); const frozen = await mustFreeze("rejected-claim"); const before = await counts();
    await expect(rejectClaim(db, "rejected-claim", "maria", "Test rejection")).rejects.toThrow("Independent");
    await expect(rejectClaim(db, "rejected-claim", "tara", " ")).rejects.toThrow("reason");
    expect((await rejectClaim(db, "rejected-claim", "tara", "This test does not meet the claim requirements")).status).toBe("REJECTED");
    expect((await db.select().from(s.claimRejections).where(eq(s.claimRejections.claimId, "rejected-claim")))[0]!.reason).toBe("This test does not meet the claim requirements");
    expect((await db.select().from(s.fundReservations).where(eq(s.fundReservations.decisionId, frozen.decisionId)))[0]!.status).toBe("RELEASED");
    await expect(approveDecision(db, frozen.decisionId, "ben", frozen.decisionHash)).rejects.toThrow("invalidated");
    expect(await counts()).toEqual(before);
  });
  it("invalidates approvals when the current approved policy version changes", async () => {
    await extraClaim("policy-change"); const frozen = await mustFreeze("policy-change");
    await approveDecision(db, frozen.decisionId, "tara", frozen.decisionHash);
    const [policy] = await db.select().from(s.fundPolicyVersions).where(and(eq(s.fundPolicyVersions.fundId, "fund_g"), eq(s.fundPolicyVersions.version, 1)));
    await db.insert(s.fundPolicyVersions).values({ ...policy!, version: 2 });
    await db.update(s.funds).set({ currentPolicyVersion: 2 }).where(eq(s.funds.id, "fund_g"));
    expect((await approveDecision(db, frozen.decisionId, "ben", frozen.decisionHash)).status).toBe("INVALIDATED");
    await expect(db.update(s.fundPolicyVersions).set({ summary: "changed" })).rejects.toThrow();
  });
});
