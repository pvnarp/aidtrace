import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { approveDecision, freezeDecision } from "../src/ledger/service";
import { findGiftLinkCapture, issueGiftLink } from "../src/donation/gift-link";
import { recordGift } from "./support/attribution-db";
import { createPolicyDatabase, financialHash, tableHash, type PolicyDatabase } from "./support/policy-db";

// IAC-413 PR A, GT-33 (added at the merge to close a known gap): migration 0016 on a
// database that already holds a frozen claim, an approval and two gifts. Same method as PC-24 for 0015. Real Postgres, no network.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const open: PolicyDatabase[] = []; const folders: string[] = [];
afterEach(async () => { while (open.length) await open.pop()!.close(); for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// A migrations folder holding only the migrations up to and including idx `last`, so later migrations cannot change the result.
function folderThrough(last: number, tag: string) {
  const dir = mkdtempSync(join(tmpdir(), "aidtrace-iac413-")); folders.push(dir); mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(readFileSync("db/migrations/meta/_journal.json", "utf8")) as { entries: { idx: number; tag: string }[] };
  const entries = journal.entries.filter(entry => entry.idx <= last);
  expect(entries.at(-1)!.tag).toBe(tag);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) copyFileSync(join("db/migrations", `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  return dir;
}

describe("GT-33 migration 0016 on a database with retained data", () => {
  it("applied by the real migrator to a database at 0015 with a frozen claim, one approval and two gifts, it changes no existing row and only adds gift_links", async () => {
    const old = await createPolicyDatabase("aidtrace_giftmig", { migrationsFolder: folderThrough(15, "0015_policy-checks") }); open.push(old);
    const tables = async () => (await old.client`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`).map(row => String(row.table_name));
    expect(await tables()).not.toContain("gift_links");
    const frozen = await freezeDecision(old.db, "C-104", "maria"); if (frozen.status !== "AWAITING_APPROVAL") throw new Error("Expected funded");
    expect((await approveDecision(old.db, frozen.decisionId, "tara", frozen.decisionHash)).status).toBe("AWAITING_APPROVAL");
    const completed = await recordGift(old.db, "fund_a", 2500n);
    const pending = await recordGift(old.db, "fund_b", 900n, 0n, "PENDING");
    const existing = (await tables()).filter(name => name !== "__drizzle_migrations");
    const hashes = async () => Object.fromEntries(await Promise.all(existing.map(async name => [name, await tableHash(old.client, name)] as const)));
    const retained = await hashes();
    expect(retained["approvals"]!.count).toBe(1); expect(retained["donation_receipts"]!.count).toBe(2); expect(retained["journal_entries"]!.count).toBeGreaterThan(0);
    const financialBefore = await financialHash(old.client);

    await migrate(old.db, { migrationsFolder: folderThrough(16, "0016_gift-links") });
    expect(await hashes()).toEqual(retained);
    expect((await tables()).filter(name => !existing.includes(name) && name !== "__drizzle_migrations")).toEqual(["gift_links"]);
    expect((await old.client`select count(*)::int as n from gift_links`)[0]!.n).toBe(0);

    // A gift recorded before the migration can get a link afterwards; a pending one cannot. Neither changes a financial table.
    const issued = await issueGiftLink(old.db, completed);
    expect(issued?.state).toBe("ISSUED");
    if (issued?.state === "ISSUED") expect(await findGiftLinkCapture(old.db, issued.token)).toBe(completed);
    expect(await issueGiftLink(old.db, pending)).toBeNull();
    expect((await old.client`select count(*)::int as n from gift_links`)[0]!.n).toBe(1);
    expect(await financialHash(old.client)).toBe(financialBefore);
  });
  it("0016 only creates gift_links, its guard function and its triggers", () => {
    const sqlText = readFileSync("db/migrations/0016_gift-links.sql", "utf8");
    const statements = sqlText.split("--> statement-breakpoint").map(part => part.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
    for (const statement of statements) {
      expect(statement, statement.slice(0, 60)).toMatch(/^(CREATE TABLE|ALTER TABLE|CREATE FUNCTION|CREATE TRIGGER)\b/);
      if (/^(CREATE TABLE|ALTER TABLE)/.test(statement)) expect(statement, statement.slice(0, 80)).toMatch(/^(CREATE|ALTER) TABLE "gift_links"[ \n(]/);
      if (/^CREATE TRIGGER/.test(statement)) expect(statement, statement.slice(0, 80)).toMatch(/ ON gift_links /);
    }
    expect(statements.some(statement => /^(INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b/.test(statement))).toBe(false);
  });
});
