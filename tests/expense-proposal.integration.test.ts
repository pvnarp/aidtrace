import { randomBytes } from "node:crypto";
import { fork } from "node:child_process";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import * as s from "../db/schema";
import { createReceiptDraft, readReceiptView, editReceiptDraft, suggestReceipt, suggestionHash, confirmReceipt } from "../src/receipt/service";
import { digest, type DraftInput } from "../src/receipt/terms";
import { ReceiptAiError } from "../src/ai/receipt";
import type { ClaudeReceiptCategorizer } from "../src/ai/claude-receipt";
import { prepareExpenseProposal, readExpenseProposal } from "../src/proposal/service";
import { handleExpenseProposal } from "../src/server/proposal-actions";
import { freezeDecision, approveDecision } from "../src/ledger/service";
import { SESSION_COOKIE } from "../src/server/auth";
import { cannedCategorizer, claudeMessage, stubbedClaudeCategorizer } from "./support/claude-stub";

const adminUrl = new URL(process.env.DATABASE_URL!); adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 });
let connection: ReturnType<typeof connectDatabase>; let name: string; let url: URL;
const input: DraftInput = { vendor: "Invented shop", program: "robotics", incurredOn: "2026-10-14", source: "Science experiment kit", total: "3.00", lines: [{ description: "Science experiment kit", amount: "3.00" }] };
const payee = "proposal@example.invalid";
beforeEach(async () => {
  name = `aidtrace_iac244_test_${randomBytes(6).toString("hex")}`; await admin`create database ${admin(name)}`;
  url = new URL(adminUrl); url.pathname = `/${name}`; connection = connectDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: "db/migrations" });
  await seedFixture(connection.db, { passwords: { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") }, payeeEmail: payee, payeeAllowlist: [payee] });
  const [maria] = await connection.db.select().from(s.users).where(eq(s.users.id, "maria"));
  await connection.db.insert(s.users).values({ ...maria!, id: "other", username: "other" });
  process.env.APP_ORIGIN = "http://127.0.0.1:3100";
}, 30000);
afterEach(async () => { vi.restoreAllMocks(); await connection?.client.end(); if (/^aidtrace_iac244_test_[a-f0-9]{12}$/.test(name)) await admin`drop database ${admin(name)} with (force)`; }, 30000);
afterAll(async () => { await admin.end(); });
const draft = (value = input) => createReceiptDraft(connection.db, "maria", value, payee);
const view = (id: string) => readReceiptView(connection.db, id, "maria");
async function terms(id: string) { const v = await view(id); const p = await readExpenseProposal(connection.db, id, "maria"); return { reviewId: v.review.id, draftHash: v.review.draftHash, suggestionHash: suggestionHash(v.suggestion), runHash: p.runHash }; }
const fake = (category = "robot_kits_parts"): ClaudeReceiptCategorizer => cannedCategorizer(value => value.lines.map(line => ({ lineId: line.id, category, quote: category === "UNKNOWN" ? "" : value.source })));
async function prepare(id: string, categorize = fake()) { return prepareExpenseProposal(connection.db, id, "maria", await terms(id), categorize); }
async function financial() {
  const tables = ["claims", "claim_lines", "fund_credits", "fund_debits", "allocation_decisions", "allocation_edges", "fund_reservations", "reservation_budget_lines", "approvals", "journal_entries", "journal_postings", "disbursements", "disbursement_attempts", "donation_receipts", "retry_authorizations", "provider_events", "receipt_confirmations"];
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = await connection.client`select to_jsonb(r)::text as row from ${connection.client(table)} r order by (to_jsonb(r)::text) collate "C"`;
  return result;
}
async function request(id: string, actor: string | null, fields?: Record<string, string>, origin = "http://127.0.0.1:3100") {
  let token = ""; if (actor) { token = randomBytes(32).toString("hex"); await connection.db.insert(s.sessions).values({ tokenHash: digest(token), userId: actor, expiresAt: new Date(Date.now() + 60000) }); }
  return new Request(`http://127.0.0.1:3100/api/receipts/${id}/proposal`, { method: fields ? "POST" : "GET", headers: { origin, cookie: `${SESSION_COOKIE}=${token}`, "content-type": "application/x-www-form-urlencoded" }, ...(fields ? { body: new URLSearchParams(fields) } : {}) });
}

it("AP-01/07: validated suggestions and read-only policy preview never confirm or write financial records", async () => {
  const id = await draft(); const before = await financial(); const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
  const result = await prepare(id);
  expect(result.run).toMatchObject({ state: "READY_FOR_REVIEW", result: { summary: "HUMAN_REVIEW_REQUIRED", generalCents: "0", edges: [{ lineId: "L1", amountCents: "300", fundId: "fund_b" }], steps: ["CATEGORIES_VALIDATED", "POLICY_PREVIEWED", "HUMAN_CONFIRMATION_REQUIRED"] } });
  expect(await financial()).toEqual(before); expect(network).not.toHaveBeenCalled();
  expect((await view(id)).lines[0]!.category).toBe("UNKNOWN"); await expect(freezeDecision(connection.db, id, "maria")).rejects.toThrow("confirmation");
  expect(await connection.db.select().from(s.expenseProposals)).toHaveLength(1);
});
it("AP-01/06: reuses ready evidence and exact replays without inference", async () => {
  const id = await draft(); const v = await view(id); await suggestReceipt(connection.db, id, "maria", v.review.id, v.review.draftHash, fake(), suggestionHash(v.suggestion));
  const t = await terms(id); const noInference = vi.fn(fake()); const first = await prepareExpenseProposal(connection.db, id, "maria", t, noInference);
  const again = await prepareExpenseProposal(connection.db, id, "maria", t, noInference);
  expect(again).toEqual(first); expect(noInference).not.toHaveBeenCalled(); expect(await connection.db.select().from(s.receiptSuggestions)).toHaveLength(1);
});
it("AP-02/03: rejects malformed model financial fields and keeps UNKNOWN unresolved", async () => {
  const id = await draft(); const bad = stubbedClaudeCategorizer(() => claudeMessage({ proposals: [{ lineId: "L1", category: "robot_kits_parts", quote: input.source }], payee: "attacker@example.invalid" })).categorize;
  expect((await prepare(id, bad)).run?.state).toBe("UNAVAILABLE");
  const unknown = await draft(); expect((await prepare(unknown, fake("UNKNOWN"))).run).toMatchObject({ state: "NEEDS_REVIEW", result: { summary: "UNRESOLVED_CATEGORIES", edges: [] } });
});
it("AP-03: prohibited category blocks; exhausted restricted caps use General when allowed", async () => {
  const alcohol = await draft({ ...input, source: "Wine", lines: [{ description: "Wine", amount: "3.00" }] });
  expect((await prepare(alcohol, fake("alcohol"))).run).toMatchObject({ state: "POLICY_BLOCKED", result: { summary: "PROHIBITED_CATEGORY", issues: [{ lineId: "L1", code: "PROHIBITED", amountCents: "300" }] } });
  await connection.db.update(s.fundBudgetLines).set({ capCents: 0n });
  const id = await draft(); expect((await prepare(id)).run?.result).toMatchObject({ generalCents: "300", edges: [{ fundId: "fund_g" }] });
  await connection.db.update(s.fundCredits).set({ amountCents: 1n }).where(eq(s.fundCredits.fundId, "fund_g"));
  const short = await draft(); expect((await prepare(short)).run).toMatchObject({ state: "POLICY_BLOCKED", result: { summary: "INSUFFICIENT_ELIGIBLE_CAPACITY" } });
});
it("AP-04: later capacity, priority, payee and source changes invalidate preview without modifying financial state", async () => {
  const id = await draft(); await prepare(id); await connection.db.update(s.fundBudgetLines).set({ capCents: 1n }).where(eq(s.fundBudgetLines.fundId, "fund_b"));
  expect((await readExpenseProposal(connection.db, id, "maria")).run).toMatchObject({ state: "STALE", result: null });
  const p = await draft(); await prepare(p); await connection.db.update(s.claims).set({ payeeEmail: "different@example.invalid" }).where(eq(s.claims.id, p));
  expect((await readExpenseProposal(connection.db, p, "maria")).run?.state).toBe("STALE");
  const edited = await draft(); await prepare(edited); const v = await view(edited);
  await editReceiptDraft(connection.db, edited, "maria", v.review.id, v.review.draftHash, { ...input, source: "Changed kit" });
  expect((await readExpenseProposal(connection.db, edited, "maria")).run).toBeNull();
  const priority = await draft(); await prepare(priority); await connection.db.insert(s.solverPriorityVersions).values({ organizationId: "cedar-hollow", version: 2, approvedBy: "tara", costsPerCent: { fund_a: "2000", fund_b: "1001", fund_g: "1000000" } });
  expect((await readExpenseProposal(connection.db, priority, "maria")).run?.state).toBe("STALE");
  const policy = await draft(); await prepare(policy);
  const [oldPolicy] = await connection.db.select().from(s.fundPolicyVersions).where(eq(s.fundPolicyVersions.fundId, "fund_b"));
  await connection.db.insert(s.fundPolicyVersions).values({ ...oldPolicy!, version: 2, summary: "Reapproved synthetic policy" });
  await connection.db.insert(s.fundBudgetLines).values({ fundId: "fund_b", policyVersion: 2, budgetLine: "supplies", capCents: 20000n });
  await connection.db.update(s.funds).set({ currentPolicyVersion: 2 }).where(eq(s.funds.id, "fund_b"));
  expect((await readExpenseProposal(connection.db, policy, "maria")).run?.state).toBe("STALE");
});
it("AP-04/06: edit during inference and late completion cannot produce a ready proposal", async () => {
  const id = await draft(); let started!: () => void; let release!: () => void;
  const entered = new Promise<void>(r => { started = r; }); const gate = new Promise<void>(r => { release = r; });
  const work = prepare(id, async value => { started(); await gate; return fake()(value); }); await entered;
  const v = await view(id); await editReceiptDraft(connection.db, id, "maria", v.review.id, v.review.draftHash, { ...input, source: "Changed source" }); release(); await work;
  expect((await connection.db.select().from(s.expenseProposals))[0]!.state).toBe("STALE");
});
it("AP-05: authorization, origin and field checks happen before inference or run creation", async () => {
  const [maria] = await connection.db.select().from(s.users).where(eq(s.users.id, "maria"));
  await connection.db.insert(s.organizations).values({ id: "elsewhere", name: "Other fixture", prohibitedCategories: ["alcohol"], openingSourceType: "fixture_opening_balance" });
  await connection.db.insert(s.users).values({ ...maria!, id: "outsider", username: "outsider", organizationId: "elsewhere" });
  const id = await draft(); const categorize = vi.fn(fake()); const deps = { db: connection.db, categorize, env: { AI_EXPENSE_PROPOSALS_ENABLED: "true" } }; const fields = { action: "prepare", ...await terms(id) };
  expect((await handleExpenseProposal(await request(id, null, fields), id, deps)).status).toBe(401);
  expect((await handleExpenseProposal(await request(id, "tara", fields), id, deps)).status).toBe(403);
  for (const actor of ["other", "outsider"]) expect((await handleExpenseProposal(await request(id, actor, fields), id, deps)).status).toBe(404);
  expect((await handleExpenseProposal(await request(id, "maria", fields, "https://evil.invalid"), id, deps)).status).toBe(403);
  expect((await handleExpenseProposal(await request(id, "maria", { ...fields, payeeEmail: payee }), id, deps)).status).toBe(400);
  expect(categorize).not.toHaveBeenCalled(); expect(await connection.db.select().from(s.expenseProposals)).toHaveLength(0);
  const response = await handleExpenseProposal(await request(id, "maria", fields), id, deps); expect(response.status).toBe(200); expect((await response.json()).run.state).toBe("READY_FOR_REVIEW");
});
it("AP-06: two actual Node processes deduplicate inference using durable admission", async () => {
  const id = await draft(); const t = await terms(id);
  const worker = (hold: boolean) => {
    const child = fork("tests/support/proposal-worker.ts", [], { execArgv: ["--import", "tsx"], env: { ...process.env, DATABASE_URL: url.toString() }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const events: { started?: boolean; result?: Awaited<ReturnType<typeof readExpenseProposal>>; error?: boolean }[] = [];
    child.on("message", m => events.push(m as typeof events[number]));
    const done = new Promise<void>((resolve, reject) => { child.on("exit", code => code === 0 ? resolve() : reject(new Error("Worker failed"))); child.on("error", reject); });
    child.send({ id, terms: t, hold }); return { child, events, done };
  };
  const first = worker(true);
  try {
    for (let i = 0; i < 300 && !first.events.some(e => e.started); i++) await new Promise(r => setTimeout(r, 10));
    expect(first.events.some(e => e.started)).toBe(true);
    const second = worker(false); await second.done;
    expect(second.events.some(e => e.started)).toBe(false); expect(second.events.find(e => e.result)?.result?.run?.state).toBe("RUNNING");
    first.child.send({ release: true }); await first.done;
    expect(first.events.find(e => e.result)?.result?.run?.state).toBe("READY_FOR_REVIEW");
    expect(await connection.db.select().from(s.expenseProposals)).toHaveLength(1); expect(await connection.db.select().from(s.receiptSuggestions)).toHaveLength(1);
  } finally { if (first.child.connected) first.child.send({ release: true }); }
}, 15000);
it("AP-06: a crashed process requires a new reviewed request after lease expiry (advanced test clock)", async () => {
  const id = await draft(); const t = await terms(id);
  const child = fork("tests/support/proposal-worker.ts", [], { execArgv: ["--import", "tsx"], env: { ...process.env, DATABASE_URL: url.toString() }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const started = new Promise<void>((resolve, reject) => { child.on("message", (m: { started?: boolean }) => { if (m.started) resolve(); }); child.on("error", reject); });
  child.send({ id, terms: t, hold: true }); await started;
  const stopped = new Promise<void>(resolve => child.on("exit", () => resolve())); child.kill("SIGKILL"); await stopped;
  expect((await readExpenseProposal(connection.db, id, "maria")).run?.state).toBe("RUNNING");
  const noReplay = vi.fn(fake()); await prepareExpenseProposal(connection.db, id, "maria", t, noReplay); expect(noReplay).not.toHaveBeenCalled();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 66000);
  try {
    expect((await readExpenseProposal(connection.db, id, "maria")).run?.state).toBe("UNAVAILABLE");
    expect((await prepare(id)).run?.state).toBe("READY_FOR_REVIEW");
    expect((await connection.db.select().from(s.expenseProposals)).map(run => run.state).sort()).toEqual(["READY_FOR_REVIEW", "UNAVAILABLE"]);
  } finally { vi.useRealTimers(); }
}, 15000);
it("AP-06: legacy receipt inference shares the per-process adapter guard and preparation fails busy", async () => {
  const legacy = await draft(); const next = await draft(); let started!: () => void; let release!: () => void;
  const ready = new Promise<void>(r => { started = r; }); const gate = new Promise<void>(r => { release = r; }); let requests = 0;
  const shared = stubbedClaudeCategorizer(async () => { requests++; started(); await gate; return claudeMessage({ proposals: [{ lineId: "L1", category: "robot_kits_parts", quote: input.source }] }); }).categorize;
  const v = await view(legacy); const work = suggestReceipt(connection.db, legacy, "maria", v.review.id, v.review.draftHash, shared, suggestionHash(v.suggestion)); await ready;
  try { expect((await prepare(next, shared)).run).toMatchObject({ state: "UNAVAILABLE", errorCode: "BUSY" }); expect(requests).toBe(1); }
  finally { release(); await work; }
});
it("AP-06/09: busy and failed runs do not retry automatically; a reviewed new request can retry", async () => {
  const id = await draft(); const t = await terms(id); const fail = vi.fn(async () => { throw new ReceiptAiError("UNAVAILABLE"); });
  expect((await prepareExpenseProposal(connection.db, id, "maria", t, fail)).run?.state).toBe("UNAVAILABLE");
  await prepareExpenseProposal(connection.db, id, "maria", t, fail); expect(fail).toHaveBeenCalledTimes(1);
  expect((await prepare(id)).run?.state).toBe("READY_FOR_REVIEW");
  await expect(connection.db.delete(s.expenseProposals)).rejects.toThrow();
  await expect(connection.db.update(s.expenseProposals).set({ state: "UNAVAILABLE" })).rejects.toThrow();
});
it("AP-06: a second receipt is rejected as busy while preparation is running, without a model queue", async () => {
  const first = await draft(); const second = await draft(); let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
  const work = prepare(first, async value => { entered(); await gate; return fake()(value); }); await ready;
  const forbidden = vi.fn(fake());
  try { expect((await prepare(second, forbidden)).run).toMatchObject({ state: "UNAVAILABLE", errorCode: "BUSY" }); expect(forbidden).not.toHaveBeenCalled(); }
  finally { release(); await work; }
});
it("AP-03/04: mixed receipt honors category policy and a later reservation invalidates the preview", async () => {
  const mixed = await draft({ ...input, total: "6.00", source: "Science experiment kit\nBlank writing notebook\nSandwich", lines: [{ description: "Science experiment kit", amount: "3.00" }, { description: "Blank writing notebook", amount: "2.00" }, { description: "Sandwich", amount: "1.00" }] });
  const categories = ["robot_kits_parts", "classroom_supplies", "participant_meals"];
  const classify: ClaudeReceiptCategorizer = cannedCategorizer(value => value.lines.map((line, index) => ({ lineId: line.id, category: categories[index], quote: value.source.split("\n")[index] })));
  const result = await prepare(mixed, classify); expect(result.run?.result).toMatchObject({ generalCents: "100" });
  expect(result.run?.result?.edges.filter(edge => edge.lineId === "L3").map(edge => edge.fundId)).toEqual(["fund_g"]);
  const other = await draft(); await prepare(other); const v = await view(other);
  await confirmReceipt(connection.db, other, "maria", v.review.id, v.review.draftHash, v.suggestion!.id, suggestionHash(v.suggestion), [{ lineId: "L1", category: "robot_kits_parts", reason: "" }]);
  await freezeDecision(connection.db, other, "maria");
  expect((await readExpenseProposal(connection.db, mixed, "maria")).run?.state).toBe("STALE");
});
it("CAT-15: gift cards and alcohol are blocked as PROHIBITED_CATEGORY for every fund, with nothing reserved or written", async () => {
  for (const category of ["gift_cards", "alcohol"]) {
    const id = await draft(); const before = await financial(); const result = await prepare(id, fake(category));
    expect(result.run).toMatchObject({ state: "POLICY_BLOCKED", result: { summary: "PROHIBITED_CATEGORY", edges: [], generalCents: null, issues: [{ lineId: "L1", code: "PROHIBITED", amountCents: "300" }] } });
    expect(await financial()).toEqual(before); expect(await connection.db.select().from(s.fundReservations)).toHaveLength(0);
  }
});
it("AP-05: repeated fields and oversized bodies fail without run creation", async () => {
  const id = await draft(); const fields = { action: "prepare", ...await terms(id) };
  const base = await request(id, "maria", fields); const body = new URLSearchParams(fields); body.append("action", "prepare");
  const repeated = new Request(base.url, { method: "POST", headers: base.headers, body });
  expect((await handleExpenseProposal(repeated, id, { db: connection.db, env: { AI_EXPENSE_PROPOSALS_ENABLED: "true" } })).status).toBe(400);
  const oversized = new Request(base.url, { method: "POST", headers: base.headers, body: "a".repeat(4097) });
  expect((await handleExpenseProposal(oversized, id, { db: connection.db, env: { AI_EXPENSE_PROPOSALS_ENABLED: "true" } })).status).toBe(413);
  expect(await connection.db.select().from(s.expenseProposals)).toHaveLength(0);
});
it("AP-05: default-disabled route cannot invoke preparation or require the additive table", async () => {
  const id = await draft(); const categorize = vi.fn(fake());
  expect((await handleExpenseProposal(await request(id, "maria"), id, { db: connection.db, categorize, env: {} })).status).toBe(404);
  expect(categorize).not.toHaveBeenCalled(); expect(await connection.db.select().from(s.expenseProposals)).toHaveLength(0);
});
it("AP-08: proposal cannot replace claimant confirmation or either independent approval", async () => {
  const id = await draft(); await prepare(id); const v = await view(id);
  await expect(freezeDecision(connection.db, id, "maria")).rejects.toThrow("confirmation");
  await confirmReceipt(connection.db, id, "maria", v.review.id, v.review.draftHash, v.suggestion!.id, suggestionHash(v.suggestion), [{ lineId: "L1", category: "robot_kits_parts", reason: "" }]);
  expect((await readExpenseProposal(connection.db, id, "maria")).run?.state).toBe("STALE");
  const decision = await freezeDecision(connection.db, id, "maria"); if (decision.status !== "AWAITING_APPROVAL") throw new Error("Expected funded decision");
  await expect(approveDecision(connection.db, decision.decisionId, "maria", decision.decisionHash)).rejects.toThrow();
  expect((await approveDecision(connection.db, decision.decisionId, "tara", decision.decisionHash)).status).toBe("AWAITING_APPROVAL");
  await expect(approveDecision(connection.db, decision.decisionId, "tara", decision.decisionHash)).rejects.toThrow();
  expect((await approveDecision(connection.db, decision.decisionId, "ben", decision.decisionHash)).status).toBe("APPROVED");
  expect(await connection.db.select().from(s.disbursements)).toHaveLength(0);
});
