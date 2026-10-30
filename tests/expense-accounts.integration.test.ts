import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import * as s from "../db/schema";
import { postJournal } from "../src/ledger/journal";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { reconcile } from "../src/ledger/reconcile";
import { approveDecision, freezeDecision } from "../src/ledger/service";

// IAC-382 step 7.2: the SF-424A budget lines map to expense accounts 5100 to 5500.
const databaseName = `aidtrace_iac382_accounts_${randomBytes(6).toString("hex")}`;
const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://aidtrace@db:5432/aidtrace");
adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 });
const testUrl = new URL(adminUrl); testUrl.pathname = `/${databaseName}`;
const { db, client } = connectDatabase(testUrl.toString());
let created = false;

async function claimWith(id: string, category: string, budgetLine: string, amount = 100n) {
  const [claim] = await db.select().from(s.claims).where(eq(s.claims.id, "C-104"));
  await db.insert(s.claims).values({ ...claim!, id, status: "DRAFT" });
  await db.insert(s.claimLines).values({ claimId: id, claimVersion: 1, id: "only-line", description: "Test only", category, budgetLine, amountCents: amount });
}
// Freeze, take both independent approvals and return the recognition postings.
async function recognize(id: string) {
  const frozen = await freezeDecision(db, id, "maria");
  if (frozen.status !== "AWAITING_APPROVAL") throw new Error(`Expected a funded frozen decision, got ${frozen.status}`);
  await approveDecision(db, frozen.decisionId, "tara", frozen.decisionHash);
  const result = await approveDecision(db, frozen.decisionId, "ben", frozen.decisionHash);
  const entries = await db.select().from(s.journalEntries).where(eq(s.journalEntries.sourceId, frozen.decisionId));
  const recognition = entries.find(entry => entry.purpose === "recognition");
  const postings = recognition ? await db.select().from(s.journalPostings).where(eq(s.journalPostings.entryId, recognition.id)) : [];
  return { status: result.status, postings: postings.map(row => [row.accountCode, row.subKey, row.debitCents, row.creditCents]) };
}

beforeAll(async () => {
  await admin`create database ${admin(databaseName)}`; created = true;
  await migrate(db, { migrationsFolder: "db/migrations" });
  await seedFixture(db, { passwords: { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") }, payeeEmail: "accounts-test@example.invalid", payeeAllowlist: ["accounts-test@example.invalid"] });
  await db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
}, 30_000);
afterAll(async () => {
  await client.end();
  if (created) await admin`drop database ${admin(databaseName)}`;
  await admin.end();
});

describe("IAC-382 expense accounts for the twenty-category budget lines", () => {
  it("CAT-08: travel, equipment and contractual lines recognize to 5300, 5400 and 5500 and the books still reconcile", async () => {
    const cases: [string, string, string, string][] = [
      ["acct-travel", "mileage", "travel", "5300"],
      ["acct-equipment", "refrigeration_equipment", "equipment", "5400"],
      ["acct-contractual", "background_checks", "contractual", "5500"],
    ];
    for (const [id, category, budgetLine, account] of cases) {
      await claimWith(id, category, budgetLine);
      const result = await recognize(id);
      expect(result.status).toBe("APPROVED");
      expect(result.postings).toEqual([[account, "only-line", 100n, 0n], ["2010", "maria", 0n, 100n]]);
      expect((await db.transaction(tx => reconcile(tx, "cedar-hollow"))).matches).toBe(true);
    }
    const report = await db.transaction(tx => reconcile(tx, "cedar-hollow"));
    expect(report).toMatchObject({ matches: true, openPayableCents: 300n });
  });
  it("CAT-09: supplies and other lines recognize to 5100 and 5200 unchanged", async () => {
    await claimWith("acct-supplies", "classroom_supplies", "supplies");
    expect((await recognize("acct-supplies")).postings).toEqual([["5100", "only-line", 100n, 0n], ["2010", "maria", 0n, 100n]]);
    await claimWith("acct-other", "participant_meals", "other");
    expect((await recognize("acct-other")).postings).toEqual([["5200", "only-line", 100n, 0n], ["2010", "maria", 0n, 100n]]);
    expect((await db.transaction(tx => reconcile(tx, "cedar-hollow"))).matches).toBe(true);
  });
  it("CAT-10: a preserved legacy hospitality line still posts to 5200", async () => {
    await claimWith("acct-legacy", "participant_meals", "hospitality");
    expect((await recognize("acct-legacy")).postings).toEqual([["5200", "only-line", 100n, 0n], ["2010", "maria", 0n, 100n]]);
    expect((await db.transaction(tx => reconcile(tx, "cedar-hollow"))).matches).toBe(true);
  });
  it("CAT-11: a line on the prohibited sentinel has no expense account and recognition refuses it", async () => {
    await claimWith("acct-prohibited", "participant_meals", "prohibited");
    const frozen = await freezeDecision(db, "acct-prohibited", "maria");
    if (frozen.status !== "AWAITING_APPROVAL") throw new Error(`Expected a funded frozen decision, got ${frozen.status}`);
    await approveDecision(db, frozen.decisionId, "tara", frozen.decisionHash);
    await expect(approveDecision(db, frozen.decisionId, "ben", frozen.decisionHash)).rejects.toThrow("No approved expense account");
    const entries = await db.select().from(s.journalEntries).where(eq(s.journalEntries.sourceId, frozen.decisionId));
    expect(entries).toEqual([]);
  });
  it("CAT-12: the database accepts the new account codes and still refuses an unknown one", async () => {
    for (const [index, accountCode] of (["5300", "5400", "5500"] as const).entries()) {
      await db.transaction(tx => postJournal(tx, { sourceType: "claim_recognition", sourceId: `direct-${index}`, purpose: "recognition", effectiveOn: "2026-10-14", postings: [{ accountCode, debitCents: 1n, creditCents: 0n }, { accountCode: "2010", subKey: "maria", debitCents: 0n, creditCents: 1n }] }));
    }
    await expect(db.transaction(tx => postJournal(tx, { sourceType: "claim_recognition", sourceId: "direct-unknown", purpose: "recognition", effectiveOn: "2026-10-14", postings: [{ accountCode: "5600" as never, debitCents: 1n, creditCents: 0n }, { accountCode: "2010", subKey: "maria", debitCents: 0n, creditCents: 1n }] }))).rejects.toThrow();
    expect((await db.select().from(s.journalEntries).where(eq(s.journalEntries.sourceId, "direct-unknown"))).length).toBe(0);
  });
});
