import { randomBytes } from "node:crypto";
import { beforeEach, afterEach, afterAll, expect, it } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import * as s from "../db/schema";
import { createReceiptDraft, readReceiptView, editReceiptDraft, suggestReceipt, confirmReceipt, suggestionHash, configuredReceiptPayee } from "../src/receipt/service";
import { digest, normalizeDraft, parseUsd, type DraftInput } from "../src/receipt/terms";
import { createReceiptCategorizer, validateProposals, ReceiptAiError, PROMPT_VERSION } from "../src/ai/receipt";
import { freezeDecision, approveDecision } from "../src/ledger/service";
import { loadClaimView } from "../src/server/claim-view";
import { handleReceiptAction } from "../src/server/receipt-actions";
import { handleClaimAction } from "../src/server/claim-actions";
import { SESSION_COOKIE } from "../src/server/auth";
import lock from "../ai/model-lock.json";

const adminUrl = new URL(process.env.DATABASE_URL!); adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 });
let connection: ReturnType<typeof connectDatabase>; let name: string;
const input: DraftInput = { vendor: "Fictional shop", program: "robotics", incurredOn: "2026-10-14", source: "Science experiment kit", total: "3.00", lines: [{ description: "Science experiment kit", amount: "3.00" }] };
const payee = "receipt-test@personal.example.com";
const env = { PAYPAL_SANDBOX_PAYEE_EMAIL: payee, PAYEE_ALLOWLIST: payee };
beforeEach(async () => {
  name = `aidtrace_iac211_test_${randomBytes(6).toString("hex")}`;
  await admin`create database ${admin(name)}`;
  const url = new URL(adminUrl); url.pathname = `/${name}`; connection = connectDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: "db/migrations" });
  await seedFixture(connection.db, { passwords: { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") }, payeeEmail: payee, payeeAllowlist: [payee] });
  const [maria] = await connection.db.select().from(s.users).where(eq(s.users.id, "maria"));
  await connection.db.insert(s.users).values({ ...maria!, id: "other", username: "other" });
  process.env.APP_ORIGIN = "http://127.0.0.1:3100";
}, 30000);
afterEach(async () => { await connection?.client.end(); if (/^aidtrace_iac211_test_[a-f0-9]{12}$/.test(name)) await admin`drop database ${admin(name)} with (force)`; }, 30000);
afterAll(async () => { await admin.end(); });
async function draft() { return createReceiptDraft(connection.db, "maria", input, payee); }
async function view(id: string) { return readReceiptView(connection.db, id, "maria"); }
async function confirm(id: string, category = "science_kits", reason = "Checked synthetic source") {
  const v = await view(id); return confirmReceipt(connection.db, id, "maria", v.review.id, v.review.draftHash, v.suggestion?.id ?? null, suggestionHash(v.suggestion), [{ lineId: "L1", category, reason }]);
}
const stub: ReturnType<typeof createReceiptCategorizer> = async value => ({ proposals: validateProposals(value, { proposals: [{ lineId: "L1", category: "science_kits", quote: "Science experiment kit" }] }), audit: { sourceSha256: digest(value.source), requestSha256: "a".repeat(64), responseSha256: "b".repeat(64), promptVersion: PROMPT_VERSION, modelSha256: lock.modelSha256, modelRevision: lock.modelRevision, latencyMs: 1 } });
async function suggest(id: string, categorize = stub) { const v = await view(id); return suggestReceipt(connection.db, id, "maria", v.review.id, v.review.draftHash, categorize, suggestionHash(v.suggestion)); }
async function request(actor: string | null, fields: Record<string, string>, id: string | null = null, origin = "http://127.0.0.1:3100") {
  let token = "";
  if (actor) { token = randomBytes(32).toString("hex"); await connection.db.insert(s.sessions).values({ tokenHash: digest(token), userId: actor, expiresAt: new Date(Date.now() + 60000) }); }
  return new Request(`http://127.0.0.1:3100/api/receipts${id ? `/${id}` : ""}`, { method: "POST", headers: { origin, cookie: `${SESSION_COOKIE}=${token}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
}
const createFields = () => ({ action: "create", vendor: input.vendor, program: input.program, incurredOn: input.incurredOn, source: input.source, total: input.total, description1: input.lines[0]!.description, amount1: "3.00", syntheticReceipt: "yes" });

it("GB-01: exact cents, total, date, text and sandbox configuration boundaries", () => {
  expect(parseUsd("0.01")).toBe(1n); expect(normalizeDraft(input).lines[0]!.amountCents).toBe(300n);
  for (const amount of ["1", "1.001", "1e2", "-1.00", "0.00", "500.01", "01.00"]) expect(() => parseUsd(amount)).toThrow();
  for (const patch of [{ total: "4.00" }, { incurredOn: "2026-02-30" }, { source: "é".repeat(8193) }, { lines: [] }]) expect(() => normalizeDraft({ ...input, ...patch })).toThrow();
  expect(configuredReceiptPayee(env)).toBe(payee);
  for (const bad of [{ ...env, PAYEE_ALLOWLIST: "" }, { ...env, PAYPAL_SANDBOX_PAYEE_EMAIL: "real@example.com", PAYEE_ALLOWLIST: "real@example.com" }]) expect(() => configuredReceiptPayee(bad)).toThrow();
});
it("GB-01: draft cannot freeze until human confirmation; existing solver and independent approvals remain", async () => {
  const id = await draft(); const before = await view(id);
  expect(before.claim).toMatchObject({ organizationId: "cedar-hollow", claimantId: "maria", payeeEmail: payee, status: "DRAFT" });
  expect(before.lines[0]!.category).toBe("UNKNOWN"); await expect(freezeDecision(connection.db, id, "maria")).rejects.toThrow("confirmation");
  expect(await suggest(id)).toBe(true); await confirm(id, "science_kits", "");
  expect((await view(id)).confirmation!.selections[0]!.provenance).toBe("AI_ACCEPTED");
  expect((await loadClaimView(connection.db, id, "maria")).edges[0]!.fundId).toBe("fund_b");
  const frozen = await freezeDecision(connection.db, id, "maria"); if (frozen.status !== "AWAITING_APPROVAL") throw new Error("Expected funded");
  expect((await approveDecision(connection.db, frozen.decisionId, "tara", frozen.decisionHash)).status).toBe("AWAITING_APPROVAL");
  expect((await approveDecision(connection.db, frozen.decisionId, "ben", frozen.decisionHash)).status).toBe("APPROVED");
  expect((await connection.db.select().from(s.disbursements))).toHaveLength(0);
  expect((await connection.db.select().from(s.journalEntries)).filter(r => r.sourceType !== "fixture_opening_balance").map(r => r.purpose).sort()).toEqual(["recognition", "restriction_release"]);
  await expect(confirm(id)).rejects.toThrow(); await expect(editReceiptDraft(connection.db, id, "maria", before.review.id, before.review.draftHash, input)).rejects.toThrow();
});
it("AI-04: source and amount edits invalidate suggestions, confirmation and old forms without editing C-104", async () => {
  const id = await draft(); await suggest(id); await confirm(id);
  const old = await view(id); const c104 = await loadClaimView(connection.db, "C-104", "maria");
  const changed = { ...input, source: "New science experiment kit", total: "4.00", lines: [{ description: "New science experiment kit", amount: "4.00" }] };
  await editReceiptDraft(connection.db, id, "maria", old.review.id, old.review.draftHash, changed);
  const next = await view(id); expect(next.review.revision).toBe(2); expect(next.review.sourceHash).not.toBe(old.review.sourceHash); expect(next.review.draftHash).not.toBe(old.review.draftHash);
  expect(next.confirmation).toBeUndefined(); expect(next.suggestion).toBeUndefined(); expect(next.lines[0]!.category).toBe("UNKNOWN");
  await expect(confirmReceipt(connection.db, id, "maria", old.review.id, old.review.draftHash, old.suggestion!.id, suggestionHash(old.suggestion), [{ lineId: "L1", category: "science_kits", reason: "" }])).rejects.toThrow("stale");
  await expect(freezeDecision(connection.db, id, "maria")).rejects.toThrow();
  expect((await connection.db.select().from(s.receiptConfirmations))).toHaveLength(1);
  expect((await loadClaimView(connection.db, "C-104", "maria")).lines).toEqual(c104.lines);
});
it("AI-02/05: unavailable model and manual corrections remain human choices; UNKNOWN stays unresolved", async () => {
  const id = await draft(); expect(await suggest(id, async () => { throw new ReceiptAiError("TIMEOUT"); })).toBe(false);
  expect((await view(id)).suggestion).toMatchObject({ status: "FAILED", errorCode: "TIMEOUT", proposals: null });
  await expect(confirm(id, "UNKNOWN")).rejects.toThrow(); await expect(confirm(id, "science_kits", "")).rejects.toThrow("Explain");
  await confirm(id); expect((await view(id)).confirmation!.selections[0]!.provenance).toBe("HUMAN");
  const corrected = await draft(); await suggest(corrected); await confirm(corrected, "notebooks", "Manual correction from synthetic source");
  expect((await view(corrected)).confirmation!.selections[0]!.provenance).toBe("HUMAN");
  const invalid = await draft(); expect(await suggest(invalid, async value => ({ ...(await stub(value)), proposals: [{ lineId: "L1", category: "science_kits", quote: "not in source", start: 0, end: 13 }] }))).toBe(false);
  expect((await view(invalid)).suggestion!.errorCode).toBe("VALIDATION");
});
it("IAC-346: approvers receive the current manual correction and original AI quote with the bound terms", async () => {
  const id = await draft(); await suggest(id); await confirm(id, "notebooks", "Human correction from the invented source");
  const frozen = await freezeDecision(connection.db, id, "maria");
  expect(frozen.status).toBe("AWAITING_APPROVAL");
  const view = await loadClaimView(connection.db, id, "tara");
  expect(view.lines[0]).toMatchObject({ description: "Science experiment kit", category: "notebooks", amountCents: 300n });
  expect(view.receiptReview?.lines[0]).toMatchObject({ category: "notebooks", provenance: "HUMAN", reason: "Human correction from the invented source", proposal: { category: "science_kits", quote: "Science experiment kit" } });
  expect(view.decision?.decisionHash).toBe(frozen.status === "AWAITING_APPROVAL" ? frozen.decisionHash : "unexpected");
  await expect(loadClaimView(connection.db, id, "other")).rejects.toThrow();
  expect(await connection.db.select().from(s.approvals)).toHaveLength(0);
  expect(await connection.db.select().from(s.disbursements)).toHaveLength(0);
});
it("GB-01: alcohol confirmation records the fact but cannot fund or reserve reimbursement", async () => {
  const id = await draft(); await confirm(id, "alcohol", "Synthetic alcohol receipt");
  expect((await view(id)).lines[0]!.budgetLine).toBe("prohibited");
  expect((await freezeDecision(connection.db, id, "maria")).status).toBe("INFEASIBLE");
  expect(await connection.db.select().from(s.fundReservations)).toHaveLength(0);
});
it("AI-04: only the current claimant can edit/confirm; other claimant and organization cannot read routes", async () => {
  const [maria] = await connection.db.select().from(s.users).where(eq(s.users.id, "maria"));
  await connection.db.insert(s.organizations).values({ id: "elsewhere", name: "Other test organization", prohibitedCategories: ["alcohol"], openingSourceType: "fixture_opening_balance" });
  await connection.db.insert(s.users).values({ ...maria!, id: "outsider", username: "outsider", organizationId: "elsewhere" });
  const id = await draft(); const v = await view(id);
  for (const actor of ["other", "outsider", "tara"]) await expect(confirmReceipt(connection.db, id, actor, v.review.id, v.review.draftHash, null, suggestionHash(undefined), [{ lineId: "L1", category: "science_kits", reason: "Checked" }])).rejects.toThrow();
  for (const actor of ["other", "outsider"]) {
    await expect(readReceiptView(connection.db, id, actor)).rejects.toThrow(); await expect(loadClaimView(connection.db, id, actor)).rejects.toThrow();
    expect((await handleClaimAction(await request(actor, { action: "freeze" }, id), id, { db: connection.db, provider() { throw new Error("Never call provider"); } })).status).toBe(404);
  }
  expect((await readReceiptView(connection.db, id, "tara")).canEdit).toBe(false);
});
it("AI-04: model completion after an edit is stale and cannot populate the new review", async () => {
  const id = await draft(); let release!: () => void; let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const work = suggest(id, async value => { started(); await gate; return stub(value); }); await running;
  const v = await view(id); await editReceiptDraft(connection.db, id, "maria", v.review.id, v.review.draftHash, { ...input, source: "Edited source" });
  release(); expect(await work).toBe(false); expect((await view(id)).suggestion).toBeUndefined();
  expect((await connection.db.select().from(s.receiptSuggestions))[0]).toMatchObject({ status: "FAILED", errorCode: "STALE" });
});
it("AI-04: form opened during inference cannot accept a category as AI after it finishes", async () => {
  const id = await draft(); let release!: () => void; let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const work = suggest(id, async value => { started(); await gate; return stub(value); }); await running;
  const old = await view(id); release(); await work;
  await expect(confirmReceipt(connection.db, id, "maria", old.review.id, old.review.draftHash, old.suggestion!.id, suggestionHash(old.suggestion), [{ lineId: "L1", category: "science_kits", reason: "Manual while running" }])).rejects.toThrow("stale");
  expect((await view(id)).confirmation).toBeUndefined();
});
it("GB-02: migration enforces immutable review and terminal proposal/confirmation history", async () => {
  const id = await draft(); await suggest(id); await confirm(id); const v = await view(id);
  await expect(connection.db.update(s.receiptReviews).set({ source: "replacement" }).where(eq(s.receiptReviews.id, v.review.id))).rejects.toThrow();
  await expect(connection.db.delete(s.receiptConfirmations)).rejects.toThrow();
  await expect(connection.db.update(s.receiptSuggestions).set({ status: "FAILED" })).rejects.toThrow();
  await expect(connection.db.execute(sql`truncate receipt_suggestions cascade`)).rejects.toThrow();
  await expect(connection.db.update(s.claimLines).set({ amountCents: 400n }).where(eq(s.claimLines.claimId, id))).resolves.toBeDefined();
  await expect(freezeDecision(connection.db, id, "maria")).rejects.toThrow("confirmation");
});
it("GB-02: HTTP requires session, claimant, same origin, explicit human review and server-owned identity", async () => {
  const deps = { db: connection.db, env };
  expect((await handleReceiptAction(await request(null, createFields()), null, deps)).status).toBe(401);
  expect((await handleReceiptAction(await request("tara", createFields()), null, deps)).status).toBe(403);
  expect((await handleReceiptAction(await request("maria", createFields(), null, "https://evil.invalid"), null, deps)).status).toBe(403);
  expect((await handleReceiptAction(await request("maria", { ...createFields(), payeeEmail: "bad@example.invalid" }), null, deps)).status).toBe(400);
  expect((await handleReceiptAction(await request("maria", { ...createFields(), syntheticReceipt: "no" }), null, deps)).status).toBe(409);
  const created = await handleReceiptAction(await request("maria", createFields()), null, deps); expect(created.status).toBe(303);
  const id = created.headers.get("location")!.split("/")[2]!; const v = await view(id);
  const fields = { action: "confirm", reviewId: v.review.id, draftHash: v.review.draftHash, suggestionHash: suggestionHash(undefined), categoryL1: "science_kits", reasonL1: "Checked" };
  const incomplete = await handleReceiptAction(await request("maria", fields, id), id, deps);
  expect(incomplete.status).toBe(303); expect(incomplete.headers.get("location")).toContain("notice=review-changed");
  expect((await handleReceiptAction(await request("other", { ...fields, confirm: "yes" }, id), id, deps)).status).toBe(404);
  expect((await handleReceiptAction(await request("maria", { ...fields, confirm: "yes" }, id), id, deps)).status).toBe(303);
  expect((await view(id)).confirmation!.selections[0]!.provenance).toBe("HUMAN");
  expect(await connection.db.select().from(s.journalEntries)).toHaveLength(0);
});
it("GB-02: overlapping and later duplicate HTTP suggestions reuse one attempt and one inference", async () => {
  const id = await draft(); const v = await view(id); let calls = 0; let release!: () => void; let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const deps = { db: connection.db, env, categorize: (async value => { calls++; started(); await gate; return stub(value); }) as typeof stub };
  const fields = { action: "suggest", reviewId: v.review.id, draftHash: v.review.draftHash, suggestionHash: suggestionHash(v.suggestion) };
  const first = handleReceiptAction(await request("maria", fields, id), id, deps); await running;
  const overlapping = await handleReceiptAction(await request("maria", fields, id), id, deps);
  expect(overlapping.status).toBe(303); expect(overlapping.headers.get("location")).toContain("notice=running"); expect(calls).toBe(1);
  release(); expect((await first).headers.get("location")).toContain("notice=suggested");
  const before = await view(id); const duplicate = await handleReceiptAction(await request("maria", fields, id), id, deps);
  expect(duplicate.status).toBe(303); expect(duplicate.headers.get("location")).toContain("notice=suggested"); expect(calls).toBe(1);
  expect((await view(id)).suggestion).toEqual(before.suggestion); expect(await connection.db.select().from(s.receiptSuggestions)).toHaveLength(1);
  expect(await connection.db.select().from(s.receiptConfirmations)).toHaveLength(0); expect(await connection.db.select().from(s.disbursements)).toHaveLength(0);
});
it("GB-02: failed attempt replay cannot start another inference; a freshly reviewed retry can", async () => {
  const id = await draft(); const v = await view(id); let calls = 0;
  const deps = { db: connection.db, env, categorize: (async () => { calls++; throw new ReceiptAiError("UNAVAILABLE"); }) as typeof stub };
  const fields = { action: "suggest", reviewId: v.review.id, draftHash: v.review.draftHash, suggestionHash: suggestionHash(v.suggestion) };
  expect((await handleReceiptAction(await request("maria", fields, id), id, deps)).headers.get("location")).toContain("notice=manual");
  expect((await handleReceiptAction(await request("maria", fields, id), id, deps)).headers.get("location")).toContain("notice=review-changed");
  expect(calls).toBe(1); const failed = await view(id);
  const retried = await handleReceiptAction(await request("maria", { ...fields, suggestionHash: suggestionHash(failed.suggestion) }, id), id, { ...deps, categorize: async value => { calls++; return stub(value); } });
  expect(retried.headers.get("location")).toContain("notice=suggested"); expect(calls).toBe(2); expect(await connection.db.select().from(s.receiptSuggestions)).toHaveLength(2);
});
it("GB-02: simultaneous serializable snapshots deduplicate before starting the model", async () => {
  const id = await draft(); const v = await view(id); let calls = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const categorize: typeof stub = async value => { calls++; await gate; return stub(value); };
  let work!: PromiseSettledResult<boolean | null>[];
  let requests!: Promise<PromiseSettledResult<boolean | null>[]>;
  await connection.client.begin(async lockTx => {
    await lockTx`select pg_advisory_xact_lock(hashtext('cedar-hollow')::bigint)`;
    requests = Promise.allSettled([0, 1].map(() => suggestReceipt(connection.db, id, "maria", v.review.id, v.review.draftHash, categorize, suggestionHash(v.suggestion))));
    let waiting = 0;
    for (let poll = 0; poll < 200; poll++) {
      const rows = await lockTx`select count(*)::int as n from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())`;
      waiting = Number(rows[0]!.n); if (waiting === 2) break; await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(2);
  });
  for (let poll = 0; poll < 200 && calls === 0; poll++) await new Promise(resolve => setTimeout(resolve, 10));
  release(); work = await requests;
  expect(work.every(result => result.status === "fulfilled")).toBe(true); expect(calls).toBe(1);
  expect(await connection.db.select().from(s.receiptSuggestions)).toHaveLength(1);
}, 15000);
