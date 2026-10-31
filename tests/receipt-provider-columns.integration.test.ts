import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, afterEach, afterAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import * as s from "../db/schema";
import { RETIRED_MODEL_REVISION, RETIRED_MODEL_SHA256 } from "./support/claude-stub";
import { createReceiptDraft, readReceiptView, suggestReceipt, suggestionHash } from "../src/receipt/service";
import type { DraftInput } from "../src/receipt/terms";
import { createClaudeReceiptCategorizer, type ClaudeMessagesClient } from "../src/ai/claude-receipt";
import { readReceiptAudit } from "../src/ai/audit";

// PRV-03 to PRV-10: IAC-392 provider and model columns (docs/plans/PROVIDER_COLUMNS.md) in isolated databases.
// Stubbed categorizers only. No test calls Anthropic, the local model server or PayPal.
const adminUrl = new URL(process.env.DATABASE_URL!); adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 });
let connection: ReturnType<typeof connectDatabase>; let name: string; const folders: string[] = [];
const input: DraftInput = { vendor: "Fictional shop", program: "robotics", incurredOn: "2026-10-14", source: "Science experiment kit", total: "3.00", lines: [{ description: "Science experiment kit", amount: "3.00" }] };
const payee = "provider-columns-test@personal.example.com";
const KEY = "sk-ant-api03-FAKE-TEST-KEY-NOT-REAL-0000";
const passwords = () => ({ maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") });
async function database() {
  name = `aidtrace_iac392_test_${randomBytes(6).toString("hex")}`;
  await admin`create database ${admin(name)}`;
  const url = new URL(adminUrl); url.pathname = `/${name}`; connection = connectDatabase(url.toString());
}
// A migrations folder holding only the migrations up to and including idx 10 (0010_donation-hardening), so a database
// can be built in the state every deployed database holds before IAC-392, then taken through 0011 with the real migrator.
function folderThrough0010() {
  const dir = mkdtempSync(join(tmpdir(), "aidtrace-iac392-")); folders.push(dir); mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(readFileSync("db/migrations/meta/_journal.json", "utf8")) as { entries: { idx: number; tag: string }[] };
  const entries = journal.entries.filter(entry => entry.idx <= 10);
  expect(entries.at(-1)!.tag).toBe("0010_donation-hardening");
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) copyFileSync(join("db/migrations", `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  return dir;
}
afterEach(async () => {
  vi.unstubAllGlobals(); vi.restoreAllMocks(); await connection?.client.end();
  if (/^aidtrace_iac392_test_[a-f0-9]{12}$/.test(name)) await admin`drop database ${admin(name)} with (force)`;
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 30000);
afterAll(async () => { await admin.end(); });

const draft = () => createReceiptDraft(connection.db, "maria", input, payee);
const view = (id: string) => readReceiptView(connection.db, id, "maria");
const suggest = async (id: string, categorize: Parameters<typeof suggestReceipt>[5]) => { const v = await view(id); return suggestReceipt(connection.db, id, "maria", v.review.id, v.review.draftHash, categorize, suggestionHash(v.suggestion)); };
const proposalText = JSON.stringify({ proposals: [{ lineId: "L1", category: "robot_kits_parts", quote: "Science experiment kit" }] });
const claudeCategorizer = (model: "claude-haiku-5-5" | "claude-sonnet-5-5") => {
  const response = { id: "msg_stub", type: "message", role: "assistant", model, stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text: proposalText }], usage: { input_tokens: 812, output_tokens: 57 } } as unknown as Anthropic.Message;
  return createClaudeReceiptCategorizer({ env: { ANTHROPIC_API_KEY: KEY, AIDTRACE_CLAUDE_MODEL: model }, client: { messages: { create: vi.fn(async () => response) } } as unknown as ClaudeMessagesClient });
};

// Fixed values shared with CAI-32 so the legacy suggestion hash is the same pinned literal.
const LEGACY_ID = "11111111-1111-4111-8111-111111111111";
const LEGACY_HASH = "b5e66c776415473de43347fcd9e04d447d36fbab15a0eae588c8b3e9d748944d";
const proposals = [{ lineId: "L1", category: "science_kits", quote: "Science experiment kit", start: 0, end: 22 }];
const localAudit = { sourceSha256: "a".repeat(64), requestSha256: "b".repeat(64), responseSha256: "c".repeat(64), modelSha256: RETIRED_MODEL_SHA256, modelRevision: RETIRED_MODEL_REVISION, promptVersion: "receipt-category-v1" };
const claudeAudit = (model = "claude-haiku-5-5") => ({ provider: "claude", model, responseModel: model, effort: "low", promptVersion: "receipt-category-claude-v1", schemaVersion: "receipt-proposals-v1",
  sourceSha256: "a".repeat(64), requestSha256: "b".repeat(64), responseSha256: "c".repeat(64), latencyMs: 1200, inputTokens: 812, outputTokens: 57 });
const errorChain = (error: unknown) => { const chain: { message?: string; constraint?: string }[] = []; let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) { chain.push({ message: "message" in current ? String(current.message) : undefined, constraint: "constraint_name" in current ? String(current.constraint_name) : undefined }); current = "cause" in current ? current.cause : undefined; }
  return chain; };
const failure = async (operation: PromiseLike<unknown>) => { const error = await Promise.resolve(operation).then(() => undefined, caught => caught); expect(error, "the statement was accepted").toBeDefined(); return errorChain(error); };

describe("provider and model columns", () => {
  beforeEach(async () => {
    await database(); await migrate(connection.db, { migrationsFolder: "db/migrations" });
    await seedFixture(connection.db, { passwords: passwords(), payeeEmail: payee, payeeAllowlist: [payee] });
    process.env.APP_ORIGIN = "http://127.0.0.1:3100";
  }, 30000);

  it("PRV-03 a local result can no longer be written: the retired shape is refused, and a row an older database holds still reads back as local", async () => {
    const id = await draft();
    const retired = async () => ({ proposals: [{ lineId: "L1", category: "robot_kits_parts", quote: "Science experiment kit", start: 0, end: 22 }],
      audit: { ...localAudit, promptVersion: "receipt-category-v2", latencyMs: 1 } });
    expect(await suggest(id, retired as never)).toBe(false);
    expect((await view(id)).suggestion).toMatchObject({ status: "FAILED", errorCode: "VALIDATION", provider: null, model: null, audit: null });
    // Inserted directly, as an older database holds it. The check constraint still accepts it, so history stays readable.
    const other = await draft(); const v = await view(other);
    await connection.db.insert(s.receiptSuggestions).values({ id: LEGACY_ID, reviewId: v.review.id, attempt: 1, status: "READY", proposals, audit: localAudit, provider: "local", model: RETIRED_MODEL_REVISION });
    const row = (await view(other)).suggestion!;
    expect(row).toMatchObject({ status: "READY", provider: "local", model: RETIRED_MODEL_REVISION });
    expect(row.model).toMatch(/^[a-f0-9]{40}$/); expect(row.audit).not.toHaveProperty("provider");
    expect(row.model).toBe(row.audit!.modelRevision);
    expect(readReceiptAudit(row)).toMatchObject({ provider: "local", modelRevision: RETIRED_MODEL_REVISION });
  });
  it("PRV-04 a stubbed Claude result stores provider claude and the audit's model, for both allowed models", async () => {
    for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5"] as const) {
      const id = await draft(); expect(await suggest(id, claudeCategorizer(model))).toBe(true);
      const row = (await view(id)).suggestion!;
      expect(row).toMatchObject({ status: "READY", provider: "claude", model, audit: { provider: "claude", model } });
      expect(readReceiptAudit(row)).toMatchObject({ provider: "claude", model });
    }
  });

  it("PRV-05 a FAILED completion stores no provider and no model, whether the categorizer threw or its audit was refused", async () => {
    const thrown = await draft(); expect(await suggest(thrown, async () => { throw new Error("stubbed outage"); })).toBe(false);
    expect((await view(thrown)).suggestion).toMatchObject({ status: "FAILED", errorCode: "UNAVAILABLE", provider: null, model: null, audit: null });
    const refusedAudit = await draft(); const result = await claudeCategorizer("claude-haiku-5-5")({ source: input.source, lines: [{ id: "L1", description: "Science experiment kit" }] });
    expect(await suggest(refusedAudit, async () => ({ proposals: result.proposals, audit: { ...result.audit, model: "claude-opus-5-5" } as unknown as typeof result.audit }))).toBe(false);
    expect((await view(refusedAudit)).suggestion).toMatchObject({ status: "FAILED", errorCode: "VALIDATION", provider: null, model: null, audit: null });
    // A RUNNING row also carries none.
    const running = await draft(); const v = await view(running);
    await connection.db.insert(s.receiptSuggestions).values({ reviewId: v.review.id, attempt: 1, status: "RUNNING" });
    expect((await view(running)).suggestion).toMatchObject({ status: "RUNNING", provider: null, model: null });
  });

  it("PRV-06 the check refuses every row whose provider and model do not agree with its status and audit, and accepts the two valid shapes", async () => {
    const id = await draft(); const reviewId = (await view(id)).review.id; let attempt = 0;
    const insert = (values: Record<string, unknown>) => connection.db.insert(s.receiptSuggestions).values({ reviewId, attempt: ++attempt, ...values } as never);
    const good = { status: "READY", proposals };
    // Positive controls first, so every refusal below is attributable to its own change.
    await insert({ ...good, audit: localAudit, provider: "local", model: RETIRED_MODEL_REVISION });
    await insert({ ...good, audit: claudeAudit("claude-haiku-5-5"), provider: "claude", model: "claude-haiku-5-5" });
    await insert({ ...good, audit: claudeAudit("claude-sonnet-5-5"), provider: "claude", model: "claude-sonnet-5-5" });
    const upper = RETIRED_MODEL_REVISION.toUpperCase(); const other = "f".repeat(40);
    const { modelRevision: _removed, ...noRevision } = localAudit;
    const cases: Record<string, Record<string, unknown>> = {
      "READY with a null provider": { ...good, audit: localAudit, provider: null, model: null },
      "READY with a null provider and a model": { ...good, audit: localAudit, provider: null, model: RETIRED_MODEL_REVISION },
      "READY claude audit with null provider": { ...good, audit: claudeAudit(), provider: null, model: null },
      "RUNNING with a provider": { status: "RUNNING", provider: "local", model: RETIRED_MODEL_REVISION },
      "FAILED with a provider": { status: "FAILED", errorCode: "UNAVAILABLE", provider: "claude", model: "claude-haiku-5-5" },
      "FAILED with a model only": { status: "FAILED", errorCode: "UNAVAILABLE", provider: null, model: "claude-haiku-5-5" },
      "provider without a model (local)": { ...good, audit: localAudit, provider: "local", model: null },
      "provider without a model (claude)": { ...good, audit: claudeAudit(), provider: "claude", model: null },
      "local audit carrying a provider key": { ...good, audit: { ...localAudit, provider: "local" }, provider: "local", model: RETIRED_MODEL_REVISION },
      "local model that is not 40 hex": { ...good, audit: { ...localAudit, modelRevision: "r" }, provider: "local", model: "r" },
      "local model in upper-case hex": { ...good, audit: { ...localAudit, modelRevision: upper }, provider: "local", model: upper },
      "local model 39 characters": { ...good, audit: { ...localAudit, modelRevision: other.slice(1) }, provider: "local", model: other.slice(1) },
      "local model different from audit.modelRevision": { ...good, audit: localAudit, provider: "local", model: other },
      "local audit with no modelRevision": { ...good, audit: noRevision, provider: "local", model: other },
      "local provider on a claude audit": { ...good, audit: claudeAudit(), provider: "local", model: RETIRED_MODEL_REVISION },
      "claude model outside the two names": { ...good, audit: claudeAudit("claude-opus-5-5"), provider: "claude", model: "claude-opus-5-5" },
      "claude model different from audit.model": { ...good, audit: claudeAudit("claude-sonnet-5-5"), provider: "claude", model: "claude-haiku-5-5" },
      "claude provider on a local audit": { ...good, audit: localAudit, provider: "claude", model: "claude-haiku-5-5" },
      "claude audit tagged for another provider": { ...good, audit: { ...claudeAudit(), provider: "other" }, provider: "claude", model: "claude-haiku-5-5" },
      "unknown provider": { ...good, audit: claudeAudit(), provider: "openai", model: "claude-haiku-5-5" },
      "empty provider": { ...good, audit: localAudit, provider: "", model: RETIRED_MODEL_REVISION },
    };
    for (const [label, values] of Object.entries(cases)) {
      const chain = await failure(insert(values));
      expect(chain.some(link => link.constraint === "receipt_suggestion_provider"), `${label}: ${JSON.stringify(chain)}`).toBe(true);
    }
    expect(await connection.db.select().from(s.receiptSuggestions)).toHaveLength(3);
  });

  it("PRV-07 after completion neither provider nor model can be updated, and the row cannot be deleted", async () => {
    const id = await draft(); expect(await suggest(id, claudeCategorizer("claude-haiku-5-5"))).toBe(true);
    const failed = await draft(); expect(await suggest(failed, async () => { throw new Error("stubbed outage"); })).toBe(false);
    const rows = await connection.db.select().from(s.receiptSuggestions); expect(rows).toHaveLength(2);
    for (const row of rows) {
      const updates = [{ provider: "claude" as const }, { model: "claude-haiku-5-5" }, { provider: "claude" as const, model: "claude-haiku-5-5" }, { provider: row.provider, model: row.model }, { provider: null, model: null }];
      for (const set of updates) {
        const chain = await failure(connection.db.update(s.receiptSuggestions).set(set).where(sql`${s.receiptSuggestions.id} = ${row.id}`));
        expect(chain.some(link => link.message?.includes("Only completion of an existing receipt suggestion is permitted")), JSON.stringify(chain)).toBe(true);
      }
      const gone = await failure(connection.db.delete(s.receiptSuggestions).where(sql`${s.receiptSuggestions.id} = ${row.id}`));
      expect(gone.some(link => link.message?.includes("Receipt suggestion history is immutable"))).toBe(true);
    }
    expect(await connection.db.select().from(s.receiptSuggestions)).toEqual(rows);
  });

  it("PRV-08 the suggestion hash digests no column: the pinned legacy hash holds for a row that carries provider and model", async () => {
    const id = await draft(); const v = await view(id);
    await connection.db.insert(s.receiptSuggestions).values({ id: LEGACY_ID, reviewId: v.review.id, attempt: 1, status: "READY", proposals, audit: localAudit, provider: "local", model: RETIRED_MODEL_REVISION });
    const row = (await view(id)).suggestion!;
    expect(row).toMatchObject({ provider: "local", model: RETIRED_MODEL_REVISION });
    expect(suggestionHash(row)).toBe(LEGACY_HASH);
    expect(suggestionHash({ ...row, provider: "claude", model: "claude-haiku-5-5" })).toBe(LEGACY_HASH);
  });
});

describe("migration 0011 backfill", () => {
  const draftNow = async () => createReceiptDraft(connection.db, "maria", input, payee);
  const reviewOf = async (id: string) => { const [row] = await connection.client`select id from receipt_reviews where claim_id = ${id}`; return row!.id as string; };
  // Raw SQL only while the database is at 0010: the application schema already names the new columns.
  const insertRaw = (reviewId: string, attempt: number, status: string, fields: { id?: string; proposals?: unknown; audit?: unknown; errorCode?: string }) =>
    connection.client`insert into receipt_suggestions (id, review_id, attempt, status, proposals, audit, error_code)
      values (${fields.id ?? randomUUID()}, ${reviewId}, ${attempt}, ${status}, ${fields.proposals === undefined ? null : JSON.stringify(fields.proposals)}::text::jsonb, ${fields.audit === undefined ? null : JSON.stringify(fields.audit)}::text::jsonb, ${fields.errorCode ?? null})`;
  const columnNames = async () => (await connection.client`select column_name from information_schema.columns where table_name = 'receipt_suggestions' and column_name in ('provider','model')`).map(row => row.column_name as string);
  const triggerState = async () => (await connection.client`select tgenabled from pg_trigger where tgname = 'receipt_suggestion_transition'`)[0]!.tgenabled as string;
  const stored = async () => connection.client`select id, status, proposals, audit, audit::text as audit_text from receipt_suggestions order by id`;

  it("PRV-09 applying 0011 to a database at 0010 backfills READY rows from their audits, leaves FAILED and RUNNING null, and changes no hash or audit byte", async () => {
    await database(); await migrate(connection.db, { migrationsFolder: folderThrough0010() });
    expect(await columnNames()).toEqual([]);
    await seedFixture(connection.db, { passwords: passwords(), payeeEmail: payee, payeeAllowlist: [payee] });
    const [localClaim, claudeClaim, sonnetClaim, failedClaim, runningClaim] = [await draftNow(), await draftNow(), await draftNow(), await draftNow(), await draftNow()];
    const ids = { local: LEGACY_ID, claude: "22222222-2222-4222-8222-222222222222", sonnet: "33333333-3333-4333-8333-333333333333", failed: "44444444-4444-4444-8444-444444444444", running: "55555555-5555-4555-8555-555555555555" };
    await insertRaw(await reviewOf(localClaim), 1, "READY", { id: ids.local, proposals, audit: localAudit });
    await insertRaw(await reviewOf(claudeClaim), 1, "READY", { id: ids.claude, proposals, audit: claudeAudit("claude-haiku-5-5") });
    await insertRaw(await reviewOf(sonnetClaim), 1, "READY", { id: ids.sonnet, proposals, audit: claudeAudit("claude-sonnet-5-5") });
    await insertRaw(await reviewOf(failedClaim), 1, "FAILED", { id: ids.failed, errorCode: "UNAVAILABLE" });
    await insertRaw(await reviewOf(runningClaim), 1, "RUNNING", { id: ids.running });
    const before = await stored(); expect(before).toHaveLength(5);
    const hashes = (rows: typeof before) => Object.fromEntries(rows.map(row => [row.id, suggestionHash({ id: row.id, status: row.status, proposals: row.proposals, audit: row.audit } as never)]));
    expect(hashes(before)[ids.local]).toBe(LEGACY_HASH);

    await migrate(connection.db, { migrationsFolder: "db/migrations" });

    expect(await columnNames()).toEqual(expect.arrayContaining(["provider", "model"]));
    const after = await connection.client`select id, status, provider, model, audit::text as audit_text from receipt_suggestions order by id`;
    const byId = Object.fromEntries(after.map(row => [row.id, row]));
    expect(byId[ids.local]).toMatchObject({ status: "READY", provider: "local", model: RETIRED_MODEL_REVISION });
    expect(byId[ids.claude]).toMatchObject({ status: "READY", provider: "claude", model: "claude-haiku-5-5" });
    expect(byId[ids.sonnet]).toMatchObject({ status: "READY", provider: "claude", model: "claude-sonnet-5-5" });
    expect(byId[ids.failed]).toMatchObject({ status: "FAILED", provider: null, model: null });
    expect(byId[ids.running]).toMatchObject({ status: "RUNNING", provider: null, model: null });
    // The audit bytes, the proposals and the suggestion hashes are exactly what they were before.
    expect(after.map(row => row.audit_text)).toEqual(before.map(row => row.audit_text));
    expect(hashes(await stored())).toEqual(hashes(before));
    // Through the application read path: the legacy row still has the pinned hash and reads back as local.
    const legacy = (await view(localClaim)).suggestion!; expect(suggestionHash(legacy)).toBe(LEGACY_HASH); expect(readReceiptAudit(legacy)).toMatchObject({ provider: "local", modelRevision: RETIRED_MODEL_REVISION });
    expect(readReceiptAudit((await view(claudeClaim)).suggestion!)).toMatchObject({ provider: "claude", model: "claude-haiku-5-5" });
    // The trigger is enabled again and still freezes completed rows; the check is in force.
    expect(await triggerState()).toBe("O");
    const chain = await failure(connection.db.update(s.receiptSuggestions).set({ provider: "claude" }).where(sql`${s.receiptSuggestions.id} = ${ids.local}`));
    expect(chain.some(link => link.message?.includes("Only completion of an existing receipt suggestion is permitted"))).toBe(true);
    const refused = await failure(connection.db.insert(s.receiptSuggestions).values({ reviewId: await reviewOf(localClaim), attempt: 2, status: "READY", proposals, audit: localAudit, provider: null, model: null }));
    expect(refused.some(link => link.constraint === "receipt_suggestion_provider")).toBe(true);
  }, 60000);

  it("PRV-10 a READY row whose audit matches neither provider fails the migration closed: nothing is applied and the trigger stays enabled", async () => {
    await database(); await migrate(connection.db, { migrationsFolder: folderThrough0010() });
    await seedFixture(connection.db, { passwords: passwords(), payeeEmail: payee, payeeAllowlist: [payee] });
    await insertRaw(await reviewOf(await draftNow()), 1, "READY", { proposals, audit: { provider: "other", model: "x" } });
    const before = await stored();
    await expect(migrate(connection.db, { migrationsFolder: "db/migrations" })).rejects.toThrow();
    expect(await columnNames()).toEqual([]);
    expect(await triggerState()).toBe("O");
    expect((await stored()).map(row => row.audit_text)).toEqual(before.map(row => row.audit_text));
  }, 60000);

});

