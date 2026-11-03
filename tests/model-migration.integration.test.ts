import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as s from "../db/schema";
import { fixtureClauses } from "../db/fixture";
import { approveDecision } from "../src/ledger/service";
import type { ClaudeMessagesClient } from "../src/ai/claude-client";
import { runModelCheck } from "../src/policy/model-run";
import { readModelChecks } from "../src/policy/model-read";
import { runPolicyChecks } from "../src/policy/service";
import { COMPLIANCE_ARM, sha256 } from "../src/policy/compliance";
import { addLegacyPhotoColumn, createPolicyDatabase, financialHash, receiptClaim, tableHash, type PolicyDatabase } from "./support/policy-db";

// IAC-405 step 1 piece G and N1, migration 0017 (docs/ASSUMPTIONS.md section 60): the same method as PC-24 for 0015 and GT-33 for 0016. Real Postgres in the
// isolated check project. No network, no key. Every model call here is a stub that throws if it is ever reached.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const open: PolicyDatabase[] = []; const folders: string[] = [];
afterEach(async () => { while (open.length) await open.pop()!.close(); for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// A migrations folder holding only the migrations up to and including idx `last`, so later migrations cannot change the result.
function folderThrough(last: number, tag: string) {
  const dir = mkdtempSync(join(tmpdir(), "aidtrace-iac405g-")); folders.push(dir); mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(readFileSync("db/migrations/meta/_journal.json", "utf8")) as { entries: { idx: number; tag: string }[] };
  const entries = journal.entries.filter(entry => entry.idx <= last);
  expect(entries.at(-1)!.tag).toBe(tag);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) copyFileSync(join("db/migrations", `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  return dir;
}
const dbError = async (promise: PromiseLike<unknown>) => promise.then(() => ({ code: "", message: "no error" }), (error: unknown) => {
  let current: unknown = error; let code = ""; const messages: string[] = [];
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    if ("code" in current && typeof current.code === "string" && !code) code = current.code;
    if ("message" in current && typeof current.message === "string") messages.push(current.message);
    current = "cause" in current ? current.cause : undefined;
  }
  return { code, message: messages.join(" | ") };
});
const hashOfFile = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const ENV = { AI_COMPLIANCE_ENABLED: "true", ANTHROPIC_API_KEY: "test-key-not-real" };
const unreachable = () => { const calls: unknown[] = []; return { calls, client: { messages: { async create(request: unknown) { calls.push(request); throw new Error("a model call was not expected"); } } } as unknown as ClaudeMessagesClient }; };

describe("migration 0017 on a database that already holds retained data", () => {
  it("applied by the real migrator to a database at 0016 with a frozen receipt claim, one approval and a rules run, it changes no existing row and only adds the two model tables", async () => {
    const old = await createPolicyDatabase("aidtrace_modelmig", { migrationsFolder: folderThrough(16, "0016_gift-links") }); open.push(old);
    const tables = async () => (await old.client`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`).map(row => String(row.table_name));
    expect(await tables()).not.toContain("fund_policy_clauses");
    expect(await tables()).not.toContain("policy_model_results");
    await addLegacyPhotoColumn(old.client); const claim = await receiptClaim(old.db);
    expect((await approveDecision(old.db, claim.decisionId, "tara", claim.hash)).status).toBe("AWAITING_APPROVAL");
    // The service now writes the migration 0019 trigger column, which a database at 0016 lacks, so the retained rules run is inserted in its 0016 shape.
    const [rulesRun] = await old.client`insert into policy_check_runs (decision_hash, claim_id, claim_version, organization_id, kind, started_by, settings_versions, rule_set_version, facts_digest)
      values (${claim.hash}, ${claim.id}, 1, 'cedar-hollow', 'RULES', 'tara', '{}'::jsonb, 'policy-rules-v1', ${sha256("facts")}) returning id`;
    await old.client`insert into policy_check_results (run_id, sequence, entry, inputs) values (${rulesRun!.id}, 1, 'RUN_END', '{}'::jsonb)`;
    const existing = (await tables()).filter(name => name !== "__drizzle_migrations");
    const hashes = async () => Object.fromEntries(await Promise.all(existing.map(async name => [name, await tableHash(old.client, name)] as const)));
    const retained = await hashes();
    expect(retained["approvals"]!.count).toBe(1); expect(retained["policy_check_runs"]!.count).toBe(1); expect(retained["journal_entries"]!.count).toBeGreaterThan(0);
    const financialBefore = await financialHash(old.client);

    await migrate(old.db, { migrationsFolder: folderThrough(17, "0017_model-check") });
    expect(await hashes()).toEqual(retained);
    expect((await tables()).filter(name => !existing.includes(name) && name !== "__drizzle_migrations")).toEqual(["fund_policy_clauses", "policy_model_results"]);
    expect(await financialHash(old.client)).toBe(financialBefore);
    // The seed writes clauses on a fresh database only. An existing database has none until a person records them (ASSUMPTIONS section 60).
    expect((await old.client`select count(*)::int as n from fund_policy_clauses`)[0]!.n).toBe(0);
    expect((await old.client`select count(*)::int as n from policy_model_results`)[0]!.n).toBe(0);

    // The current model check writes the migration 0019 trigger column, so it runs once the rest of the chain is applied (tests/fund-modes-db.integration.test.ts).
    await migrate(old.db, { migrationsFolder: "db/migrations" });
    // The migrated database runs the model check without clauses: the restricted funds are NOT_CHECKED with NO_CLAUSES and no model named, and no request is sent.
    const { client, calls } = unreachable();
    const result = await runModelCheck(old.db, claim.hash, { id: "tara" }, { env: ENV, client });
    expect(result).toMatchObject({ status: "RAN", requests: 0, checked: 0, notChecked: 2, skipped: 1 });
    expect(calls).toHaveLength(0);
    const rows = await old.db.select().from(s.policyModelResults).orderBy(s.policyModelResults.sequence);
    expect(rows.map(row => [row.entry, row.fundId, row.reasonCode, row.model])).toEqual([["NOT_CHECKED", "fund_a", "NO_CLAUSES", null], ["NOT_CHECKED", "fund_b", "NO_CLAUSES", null], ["SKIPPED", "fund_g", "GENERAL_FUND", null], ["RUN_END", null, null, null]]);
    const view = await old.db.transaction(tx => readModelChecks(tx, claim.hash));
    expect([view!.status, view!.state]).toEqual(["HOLD", "DONE"]);
    expect(view!.pairs.map(pair => [pair.fundId, pair.state, pair.reasonCode])).toEqual([["fund_a", "NOT_CHECKED", "NO_CLAUSES"], ["fund_b", "NOT_CHECKED", "NO_CLAUSES"], ["fund_g", "SKIPPED", "GENERAL_FUND"]]);
    expect(await financialHash(old.client)).toBe(financialBefore);
  });

  it("migrations 0015 and 0016 are byte-for-byte unchanged by this package", () => {
    // Pinned from the committed files at the start of piece G (openssl dgst -sha256 on the host). A change to either file changes the hash.
    expect(hashOfFile("db/migrations/0015_policy-checks.sql")).toBe("9867826ded09f3113d7381eb1ff0f1b476d22c7dd1223df32dd1b83375a05b91");
    expect(hashOfFile("db/migrations/0016_gift-links.sql")).toBe("6f6422c112c5859bd07b8ce8c883ec4ebad7a2d04c6652ac893d105e2e179fed");
  });

  it("0017 only creates the two tables, their constraints, their guards and triggers, and replaces the run guard; it touches no other table", () => {
    const sqlText = readFileSync("db/migrations/0017_model-check.sql", "utf8");
    const statements = sqlText.split("--> statement-breakpoint").map(part => part.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
    expect(statements.length).toBeGreaterThan(10);
    for (const statement of statements) expect(statement, statement.slice(0, 60)).toMatch(/^(CREATE TABLE|ALTER TABLE|CREATE FUNCTION|CREATE OR REPLACE FUNCTION|CREATE TRIGGER)\b/);
    expect(statements.some(statement => /^(INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b/.test(statement))).toBe(false);
    for (const statement of statements.filter(item => item.startsWith("CREATE TABLE"))) expect(statement).toMatch(/^CREATE TABLE "(fund_policy_clauses|policy_model_results)"/);
    for (const statement of statements.filter(item => item.startsWith("ALTER TABLE"))) expect(statement).toMatch(/^ALTER TABLE "(fund_policy_clauses|policy_model_results)" ADD CONSTRAINT/);
    for (const statement of statements.filter(item => item.startsWith("CREATE TRIGGER"))) expect(statement).toMatch(/ ON (fund_policy_clauses|policy_model_results) /);
    expect(statements.filter(item => item.startsWith("CREATE OR REPLACE FUNCTION")).map(item => item.match(/FUNCTION (\w+)/)![1])).toEqual(["aidtrace_policy_run_insert_guard"]);
    // No guard reads or writes an approval, a reservation, a journal entry or a payout.
    expect(statements.join("\n")).not.toMatch(/\b(approvals|fund_reservations|journal_entries|journal_postings|disbursements|disbursement_attempts|retry_authorizations|provider_events)\b/);
  });
});

describe("the new tables and the replaced run guard", () => {
  it("the seed writes 7 clauses for fund_a and 5 for fund_b at policy version 1, none for the General fund, and the stored text is the fixture text", async () => {
    const fresh = await createPolicyDatabase("aidtrace_modelmig"); open.push(fresh);
    const rows = await fresh.client`select fund_id, policy_version, clause_id, text from fund_policy_clauses order by fund_id, policy_version, clause_id`;
    const counts = Object.fromEntries(["fund_a", "fund_b", "fund_g"].map(fundId => [fundId, rows.filter(row => row.fund_id === fundId).length]));
    expect(counts).toEqual({ fund_a: 7, fund_b: 5, fund_g: 0 });
    expect(rows.every(row => row.policy_version === 1)).toBe(true);
    expect(rows.map(row => [row.fund_id, row.clause_id, row.text])).toEqual(fixtureClauses.map(clause => [clause.fundId, clause.clauseId, clause.text]).sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : (a[1]! as string).localeCompare(b[1]! as string, "en", { numeric: true })));
    expect(fixtureClauses.every(clause => clause.text === clause.text.trim() && clause.text.length <= 600)).toBe(true);
  });

  it("both tables are append-only: update, delete and truncate are refused, and the refusal leaves every row in place", async () => {
    const fresh = await createPolicyDatabase("aidtrace_modelmig"); open.push(fresh);
    const claim = await receiptClaim(fresh.db);
    await runPolicyChecks(fresh.db, claim.hash, { id: "tara" });
    const answer = { messages: { async create(request: { model: string; messages: { content: string }[] }) {
      const input = JSON.parse(request.messages[0]!.content) as { receipt: { lines: { id: string }[] } };
      return { id: "m", type: "message", role: "assistant", model: request.model, content: [{ type: "text", text: JSON.stringify({ lines: input.receipt.lines.map(line => ({ lineId: line.id, verdict: "OK", clauseId: null })) }) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    } } } as unknown as ClaudeMessagesClient;
    expect((await runModelCheck(fresh.db, claim.hash, { id: "tara" }, { env: ENV, client: answer })).status).toBe("RAN");
    const before = { clauses: await tableHash(fresh.client, "fund_policy_clauses"), results: await tableHash(fresh.client, "policy_model_results") };
    expect(before.results.count).toBeGreaterThan(0);
    for (const statement of ["update fund_policy_clauses set text = 'x'", "delete from fund_policy_clauses", "update policy_model_results set verdict = 'CONFLICT'", "delete from policy_model_results", "truncate policy_model_results"]) {
      expect((await dbError(fresh.client.unsafe(statement))).code, statement).toBe("23514");
    }
    // Postgres refuses to truncate a table that a foreign key references (0A000) before any trigger runs. Either refusal leaves the rows in place.
    expect(["0A000", "23514"]).toContain((await dbError(fresh.client.unsafe("truncate fund_policy_clauses"))).code);
    expect({ clauses: await tableHash(fresh.client, "fund_policy_clauses"), results: await tableHash(fresh.client, "policy_model_results") }).toEqual(before);
  });

  it("the result guard needs a model run, numbers rows in order and accepts nothing after the run end; the shape checks refuse every impossible row", async () => {
    const fresh = await createPolicyDatabase("aidtrace_modelmig"); open.push(fresh);
    const claim = await receiptClaim(fresh.db);
    const rules = await runPolicyChecks(fresh.db, claim.hash, { id: "tara" });
    if (rules.status !== "RAN") throw new Error("Expected RAN");
    const [decision] = await fresh.db.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.decisionHash, claim.hash));
    const insertResult = (runId: string, sequence: number, values: Partial<typeof s.policyModelResults.$inferInsert>) =>
      fresh.db.insert(s.policyModelResults).values({ runId, sequence, entry: "SKIPPED", fundId: "fund_g", policyVersion: 1, reasonCode: "GENERAL_FUND", ...values } as typeof s.policyModelResults.$inferInsert);
    // A rules run holds no model rows.
    expect((await dbError(insertResult(rules.runId, 1, {}))).message).toContain("belong to a model run");
    const [run] = await fresh.db.insert(s.policyCheckRuns).values({
      decisionHash: claim.hash, claimId: claim.id, claimVersion: decision!.claimVersion, organizationId: decision!.organizationId, kind: "MODEL", startedBy: "tara", settingsVersions: {}, ruleSetVersion: COMPLIANCE_ARM,
      factsDigest: sha256("facts"), model: "claude-haiku-5-5>claude-sonnet-5-5", effort: "low", promptVersion: "compliance-v1", schemaVersion: "compliance-lines-v1", clauseSetHash: sha256("clauses"), requestDigest: sha256("plan"),
    }).returning({ id: s.policyCheckRuns.id });
    const id = run!.id;
    expect((await dbError(insertResult(id, 2, {}))).message).toContain("numbered in order");
    const impossible: [string, Partial<typeof s.policyModelResults.$inferInsert>, string[]][] = [
      ["an unknown entry", { entry: "FOO" as never }, ["23514"]],
      ["OK carrying a clause", { entry: "LINE", fundId: "fund_a", lineId: "L2", verdict: "OK", clauseId: "1.1", model: "claude-haiku-5-5", effort: "low", reasonCode: null }, ["23514"]],
      ["CONFLICT without a clause", { entry: "LINE", fundId: "fund_a", lineId: "L2", verdict: "CONFLICT", clauseId: null, model: "claude-haiku-5-5", effort: "low", reasonCode: null }, ["23514"]],
      ["a line naming a clause that does not exist for the fund", { entry: "LINE", fundId: "fund_a", lineId: "L2", verdict: "CONFLICT", clauseId: "9.9", model: "claude-haiku-5-5", effort: "low", reasonCode: null }, ["23503"]],
      ["a line with no model", { entry: "LINE", fundId: "fund_a", lineId: "L2", verdict: "OK", clauseId: null, model: null, effort: null, reasonCode: null }, ["23514"]],
      ["NOT_CHECKED NO_CLAUSES naming a model", { entry: "NOT_CHECKED", fundId: "fund_a", reasonCode: "NO_CLAUSES", model: "claude-haiku-5-5", effort: "low" }, ["23514"]],
      ["NOT_CHECKED INVALID naming no model", { entry: "NOT_CHECKED", fundId: "fund_a", reasonCode: "INVALID", model: null, effort: null }, ["23514"]],
      ["NOT_CHECKED GENERAL_FUND", { entry: "NOT_CHECKED", fundId: "fund_g", reasonCode: "GENERAL_FUND", model: null, effort: null }, ["23514"]],
      ["SKIPPED for a reason other than the General fund", { entry: "SKIPPED", reasonCode: "INVALID" }, ["23514"]],
      ["a run end that names a fund", { entry: "RUN_END", fundId: "fund_a", reasonCode: null }, ["23514"]],
      ["a fund version that does not exist", { entry: "SKIPPED", fundId: "fund_g", policyVersion: 9 }, ["23503"]],
      ["a fund without a version", { entry: "SKIPPED", fundId: "fund_g", policyVersion: null }, ["23514"]],
      ["a request digest that is not a SHA-256", { entry: "CALL", fundId: "fund_a", model: "claude-haiku-5-5", effort: "low", requestDigest: "abc", reasonCode: null }, ["23514"]],
      ["a model without an effort", { entry: "CALL", fundId: "fund_a", model: "claude-haiku-5-5", effort: null, requestDigest: sha256("x"), reasonCode: null }, ["23514"]],
      ["a negative token count", { entry: "CALL", fundId: "fund_a", model: "claude-haiku-5-5", effort: "low", requestDigest: sha256("x"), reasonCode: null, inputTokens: -1 }, ["23514"]],
      ["a reason code outside the list", { entry: "NOT_CHECKED", fundId: "fund_a", reasonCode: "REFUSED" as never, model: "claude-haiku-5-5", effort: "low" }, ["23514"]],
    ];
    for (const [name, values, codes] of impossible) {
      const refused = await dbError(insertResult(id, 1, values));
      expect(codes, `${name}: ${JSON.stringify(refused)}`).toContain(refused.code);
    }
    // None of those rows was stored, so the next row is still number 1. A valid run is accepted, and nothing follows its end.
    expect((await fresh.client`select count(*)::int as n from policy_model_results where run_id = ${id}`)[0]!.n).toBe(0);
    await insertResult(id, 1, {});
    await insertResult(id, 2, { entry: "RUN_END", fundId: null, policyVersion: null, reasonCode: null });
    expect((await dbError(insertResult(id, 3, {}))).message).toContain("finished model check run accepts no more rows");
    expect((await fresh.client`select count(*)::int as n from policy_model_results where run_id = ${id}`)[0]!.n).toBe(2);
  });

  it("the replaced run guard accepts a MODEL run only after the rule run of the same decision, still refuses a claimant, and still refuses any other kind", async () => {
    const fresh = await createPolicyDatabase("aidtrace_modelmig"); open.push(fresh);
    const claim = await receiptClaim(fresh.db);
    const [decision] = await fresh.db.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.decisionHash, claim.hash));
    const values = (kind: string, startedBy: string) => ({
      decisionHash: claim.hash, claimId: claim.id, claimVersion: decision!.claimVersion, organizationId: decision!.organizationId, kind: kind as "MODEL", startedBy, settingsVersions: {}, ruleSetVersion: COMPLIANCE_ARM,
      factsDigest: sha256("facts"), model: "claude-haiku-5-5>claude-sonnet-5-5", effort: "low", promptVersion: "compliance-v1", schemaVersion: "compliance-lines-v1", clauseSetHash: sha256("clauses"), requestDigest: sha256("plan"),
    });
    expect((await dbError(fresh.db.insert(s.policyCheckRuns).values(values("MODEL", "tara")))).message).toContain("follows the rule checks");
    expect((await dbError(fresh.db.insert(s.policyCheckRuns).values(values("FOO", "tara")))).code).not.toBe("");
    await runPolicyChecks(fresh.db, claim.hash, { id: "tara" });
    expect((await dbError(fresh.db.insert(s.policyCheckRuns).values(values("MODEL", "maria")))).message).toContain("started by an approver");
    await fresh.db.insert(s.policyCheckRuns).values(values("MODEL", "tara"));
    expect((await dbError(fresh.db.insert(s.policyCheckRuns).values(values("MODEL", "ben")))).code).toBe("23505");
    const kinds = await fresh.db.select({ kind: s.policyCheckRuns.kind }).from(s.policyCheckRuns).where(and(eq(s.policyCheckRuns.decisionHash, claim.hash)));
    expect(kinds.map(row => row.kind).sort()).toEqual(["MODEL", "RULES"]);
  });

  it("a clause is bounded and belongs to an existing policy version of its fund", async () => {
    const fresh = await createPolicyDatabase("aidtrace_modelmig"); open.push(fresh);
    const insert = (values: Partial<typeof s.fundPolicyClauses.$inferInsert>) => fresh.db.insert(s.fundPolicyClauses).values({ fundId: "fund_g", policyVersion: 1, clauseId: "3.1", text: "A clause.", ...values });
    expect((await dbError(insert({ clauseId: "3.100" }))).code).toBe("23514");
    expect((await dbError(insert({ clauseId: "x" }))).code).toBe("23514");
    expect((await dbError(insert({ text: "x".repeat(601) }))).code).toBe("23514");
    expect((await dbError(insert({ text: " padded" }))).code).toBe("23514");
    expect((await dbError(insert({ text: "" }))).code).toBe("23514");
    expect(["23503", "23514"]).toContain((await dbError(insert({ policyVersion: 9 }))).code);
    expect((await dbError(insert({ fundId: "fund_a", policyVersion: 1, clauseId: "1.1" }))).code).toBe("23505");
    expect((await fresh.client`select count(*)::int as n from fund_policy_clauses where fund_id = 'fund_g'`)[0]!.n).toBe(0);
  });
});
