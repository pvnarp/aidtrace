import { randomBytes } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, afterEach, afterAll, expect, it, vi } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import * as s from "../db/schema";
import { createReceiptDraft, readReceiptView, suggestReceipt, confirmReceipt, suggestionHash } from "../src/receipt/service";
import { digest, type DraftInput } from "../src/receipt/terms";
import { createReceiptCategorizer, validateProposals, PROMPT_VERSION } from "../src/ai/receipt";
import { createClaudeReceiptCategorizer, CLAUDE_PROMPT_VERSION, CLAUDE_SCHEMA_VERSION, type ClaudeMessagesClient } from "../src/ai/claude-receipt";
import { readReceiptAudit } from "../src/ai/audit";
import { handleReceiptAction } from "../src/server/receipt-actions";
import { handleExpenseProposal } from "../src/server/proposal-actions";
import { readExpenseProposal } from "../src/proposal/service";
import { SESSION_COOKIE } from "../src/server/auth";

// CAI-30 to CAI-34: IAC-383 provider-tagged persistence in an isolated database. Stubbed
// Claude client or stubbed global fetch only. No test calls Anthropic or PayPal.
const adminUrl = new URL(process.env.DATABASE_URL!); adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 });
let connection: ReturnType<typeof connectDatabase>; let name: string;
const input: DraftInput = { vendor: "Fictional shop", program: "robotics", incurredOn: "2026-10-14", source: "Science experiment kit", total: "3.00", lines: [{ description: "Science experiment kit", amount: "3.00" }] };
const payee = "wiring-test@personal.example.com";
const KEY = "sk-ant-api03-FAKE-TEST-KEY-NOT-REAL-0000";
beforeEach(async () => {
  name = `aidtrace_iac383_test_${randomBytes(6).toString("hex")}`;
  await admin`create database ${admin(name)}`;
  const url = new URL(adminUrl); url.pathname = `/${name}`; connection = connectDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: "db/migrations" });
  await seedFixture(connection.db, { passwords: { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") }, payeeEmail: payee, payeeAllowlist: [payee] });
  process.env.APP_ORIGIN = "http://127.0.0.1:3100";
}, 30000);
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await connection?.client.end(); if (/^aidtrace_iac383_test_[a-f0-9]{12}$/.test(name)) await admin`drop database ${admin(name)} with (force)`; }, 30000);
afterAll(async () => { await admin.end(); });
const draft = () => createReceiptDraft(connection.db, "maria", input, payee);
const view = (id: string) => readReceiptView(connection.db, id, "maria");
const message = (model = "claude-haiku-5-5") => ({ id: "msg_stub", type: "message", role: "assistant", model, stop_reason: "end_turn", stop_sequence: null,
  content: [{ type: "text", text: JSON.stringify({ proposals: [{ lineId: "L1", category: "robot_kits_parts", quote: "Science experiment kit" }] }) }], usage: { input_tokens: 812, output_tokens: 57 } }) as unknown as Anthropic.Message;
const claudeClient = (response = message()) => { const create = vi.fn(async () => response); return { create, client: { messages: { create } } as unknown as ClaudeMessagesClient }; };
const suggest = async (id: string, categorize: Parameters<typeof suggestReceipt>[5]) => { const v = await view(id); return suggestReceipt(connection.db, id, "maria", v.review.id, v.review.draftHash, categorize, suggestionHash(v.suggestion)); };
async function request(fields: Record<string, string>, id: string, path = `/api/receipts/${id}`) {
  const token = randomBytes(32).toString("hex");
  await connection.db.insert(s.sessions).values({ tokenHash: digest(token), userId: "maria", expiresAt: new Date(Date.now() + 60000) });
  return new Request(`http://127.0.0.1:3100${path}`, { method: "POST", headers: { origin: "http://127.0.0.1:3100", cookie: `${SESSION_COOKIE}=${token}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
}
const suggestFields = async (id: string) => { const v = await view(id); return { action: "suggest", reviewId: v.review.id, draftHash: v.review.draftHash, suggestionHash: suggestionHash(v.suggestion) }; };

it("CAI-30 a Claude result is stored under Claude provenance with the categorizer's own audit, never under Qwen provenance", async () => {
  const id = await draft(); const { create, client } = claudeClient();
  const categorize = createClaudeReceiptCategorizer({ env: { ANTHROPIC_API_KEY: KEY }, client });
  expect(await suggest(id, categorize)).toBe(true); expect(create).toHaveBeenCalledTimes(1);
  const v = await view(id); const audit = v.suggestion!.audit!;
  expect(v.suggestion!.status).toBe("READY");
  expect(audit).toMatchObject({ provider: "claude", model: "claude-haiku-5-5", responseModel: "claude-haiku-5-5", effort: "low", promptVersion: CLAUDE_PROMPT_VERSION, schemaVersion: CLAUDE_SCHEMA_VERSION, sourceSha256: digest(input.source), inputTokens: 812, outputTokens: 57 });
  expect(audit).not.toHaveProperty("modelSha256"); expect(audit).not.toHaveProperty("modelRevision");
  for (const key of ["requestSha256", "responseSha256"]) expect(audit[key]).toMatch(/^[a-f0-9]{64}$/);
  expect(readReceiptAudit(v.suggestion!)).toMatchObject({ provider: "claude", model: "claude-haiku-5-5" });
  // The stored row hashes stably across reads, and confirmation accepts it like any ready suggestion.
  expect(suggestionHash((await view(id)).suggestion)).toBe(suggestionHash(v.suggestion));
  await confirmReceipt(connection.db, id, "maria", v.review.id, v.review.draftHash, v.suggestion!.id, suggestionHash(v.suggestion), [{ lineId: "L1", category: "robot_kits_parts", reason: "" }]);
  expect((await view(id)).confirmation!.selections[0]!.provenance).toBe("AI_ACCEPTED");
});

it("CAI-31 an invalid Claude audit is refused and stores nothing as READY", async () => {
  const id = await draft();
  const result = await createClaudeReceiptCategorizer({ env: { ANTHROPIC_API_KEY: KEY }, client: claudeClient().client })({ source: input.source, lines: [{ id: "L1", description: "Science experiment kit" }] });
  for (const audit of [{ ...result.audit, sourceSha256: digest("another source") }, { ...result.audit, requestSha256: "not-a-hash" }, { ...result.audit, model: "claude-opus-5-5" }]) {
    const fresh = await draft(); expect(fresh).not.toBe(id);
    expect(await suggest(fresh, async () => ({ proposals: result.proposals, audit: audit as typeof result.audit }))).toBe(false);
    const failed = (await view(fresh)).suggestion!; expect(failed).toMatchObject({ status: "FAILED", errorCode: "VALIDATION", audit: null, proposals: null });
  }
});

it("CAI-32 a legacy local row and a new local row have the same stored shape, and the legacy row reads back as local with an unchanged hash", async () => {
  const id = await draft(); const first = await view(id);
  // A READY row as every database holds it today: six audit fields, no provider key. Inserted
  // directly with fixed values so its hash is pinned (shasum -a 256 over the jsonb read-back text).
  const legacy = { sourceSha256: "a".repeat(64), requestSha256: "b".repeat(64), responseSha256: "c".repeat(64),
    modelSha256: "061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a", modelRevision: "90862c4b9d2787eaed51d12237eafdfe7c5f6077", promptVersion: "receipt-category-v1" };
  await connection.db.insert(s.receiptSuggestions).values({ id: "11111111-1111-4111-8111-111111111111", reviewId: first.review.id, attempt: 1, status: "READY", provider: "local", model: legacy.modelRevision,
    proposals: [{ lineId: "L1", category: "science_kits", quote: "Science experiment kit", start: 0, end: 22 }], audit: legacy });
  const row = (await view(id)).suggestion!;
  expect(suggestionHash(row)).toBe("b5e66c776415473de43347fcd9e04d447d36fbab15a0eae588c8b3e9d748944d");
  expect(readReceiptAudit(row)).toMatchObject({ provider: "local", modelRevision: legacy.modelRevision });
  expect(row.audit).not.toHaveProperty("provider");
  // A new local result is written with exactly the same keys and lock values.
  const other = await draft(); const v = await view(other);
  const body = JSON.stringify({ model: "aidtrace-category-qwen3", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ proposals: [{ lineId: "L1", category: "robot_kits_parts", quote: "Science experiment kit" }] }) } }] });
  const local = createReceiptCategorizer(async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
  expect(await suggestReceipt(connection.db, other, "maria", v.review.id, v.review.draftHash, local, suggestionHash(v.suggestion))).toBe(true);
  const stored = (await view(other)).suggestion!.audit!;
  expect(Object.keys(stored).sort()).toEqual(Object.keys(legacy).sort());
  expect(stored).toMatchObject({ modelSha256: legacy.modelSha256, modelRevision: legacy.modelRevision, promptVersion: PROMPT_VERSION, sourceSha256: digest(input.source) });
  expect(readReceiptAudit((await view(other)).suggestion!)).toMatchObject({ provider: "local" });
});

it("CAI-33 the receipt action selects Claude from the environment, stores the Claude audit, and refuses an invalid selection with no model call", async () => {
  const fetchStub = vi.fn(async () => new Response(JSON.stringify(message()), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchStub);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const id = await draft();
  const bad = { db: connection.db, env: { AI_RECEIPT_ENABLED: "true", AIDTRACE_RECEIPT_AI_PROVIDER: "Claude", ANTHROPIC_API_KEY: KEY, PAYPAL_SANDBOX_PAYEE_EMAIL: payee, PAYEE_ALLOWLIST: payee } };
  const refused = await handleReceiptAction(await request(await suggestFields(id), id), id, bad);
  expect(refused.headers.get("location")).toContain("notice=manual"); expect(fetchStub).not.toHaveBeenCalled();
  expect((await view(id)).suggestion).toMatchObject({ status: "FAILED", errorCode: "UNAVAILABLE", audit: null });
  expect(JSON.stringify(errors.mock.calls)).not.toContain("Claude"); expect(errors.mock.calls).toEqual([["Receipt AI provider configuration refused:", "ReceiptAiConfigError"]]);
  const off = { db: connection.db, env: { ...bad.env, AI_RECEIPT_ENABLED: "false", AIDTRACE_RECEIPT_AI_PROVIDER: "claude" } };
  const second = await draft();
  expect((await handleReceiptAction(await request(await suggestFields(second), second), second, off)).headers.get("location")).toContain("notice=manual");
  expect(fetchStub).not.toHaveBeenCalled(); expect((await view(second)).suggestion).toMatchObject({ status: "FAILED", errorCode: "UNAVAILABLE" });
  const good = { db: connection.db, env: { ...bad.env, AIDTRACE_RECEIPT_AI_PROVIDER: "claude" } };
  const third = await draft();
  expect((await handleReceiptAction(await request(await suggestFields(third), third), third, good)).headers.get("location")).toContain("notice=suggested");
  expect(fetchStub).toHaveBeenCalledTimes(1);
  const audit = (await view(third)).suggestion!.audit!; expect(audit).toMatchObject({ provider: "claude", model: "claude-haiku-5-5" }); expect(audit).not.toHaveProperty("modelSha256");
  expect(JSON.stringify((await view(third)).suggestion)).not.toContain(KEY);
  expect(await connection.db.select().from(s.approvals)).toHaveLength(0); expect(await connection.db.select().from(s.disbursements)).toHaveLength(0);
});

it("CAI-34 the preparation action selects Claude from the environment and stores the Claude audit; an invalid selection makes no model call", async () => {
  const fetchStub = vi.fn(async () => new Response(JSON.stringify(message()), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchStub); vi.spyOn(console, "error").mockImplementation(() => {});
  const base = { AI_RECEIPT_ENABLED: "true", AI_EXPENSE_PROPOSALS_ENABLED: "true", ANTHROPIC_API_KEY: KEY };
  const run = async (id: string, env: Record<string, string>) => {
    const v = await view(id); const p = await readExpenseProposal(connection.db, id, "maria");
    const fields = { action: "prepare", reviewId: v.review.id, draftHash: v.review.draftHash, suggestionHash: suggestionHash(v.suggestion), runHash: p.runHash };
    return handleExpenseProposal(await request(fields, id, `/api/receipts/${id}/proposal`), id, { db: connection.db, env });
  };
  const bad = await draft();
  const refused = await run(bad, { ...base, AIDTRACE_RECEIPT_AI_PROVIDER: "claude", AIDTRACE_CLAUDE_MODEL: "claude-opus-5-5" });
  expect(refused.status).toBe(200); expect((await refused.json()).run.state).toBe("UNAVAILABLE");
  expect(fetchStub).not.toHaveBeenCalled(); expect((await view(bad)).suggestion).toMatchObject({ status: "FAILED", errorCode: "UNAVAILABLE", audit: null });
  const id = await draft();
  const prepared = await run(id, { ...base, AIDTRACE_RECEIPT_AI_PROVIDER: "claude", AIDTRACE_CLAUDE_MODEL: "claude-haiku-5-5" });
  expect(prepared.status).toBe(200); expect(fetchStub).toHaveBeenCalledTimes(1);
  expect((await view(id)).suggestion).toMatchObject({ status: "READY", audit: { provider: "claude", model: "claude-haiku-5-5", sourceSha256: digest(input.source) } });
  expect(await connection.db.select().from(s.approvals)).toHaveLength(0); expect(await connection.db.select().from(s.disbursements)).toHaveLength(0);
});
