import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../db/schema";
import { closeDatabase } from "../src/server/db";
import { SESSION_COOKIE } from "../src/server/auth";
import { handlePhotoText } from "../src/server/receipt-photo-actions";
import { createPhotoRateLimiter } from "../src/server/receipt-photo-rate-limit";
import { createClaudeBudget } from "../src/ai/budget";
import { createReceiptDraft, editReceiptDraft, readReceiptView } from "../src/receipt/service";
import { handleReceiptAction } from "../src/server/receipt-actions";
import { recordPhotoRead } from "../src/receipt/photo-reads";
import { FAKE_ENV, claudeMessage, stubClient } from "./support/claude-stub";
import { RECEIPT_PAYEE, createPolicyDatabase, sessionFor, type PolicyDatabase } from "./support/policy-db";
import { goodWire, pngBytes } from "./support/photo";

// IAC-384 review round, PH-51 to PH-56 (docs/GATE_REPORT.md section 72): the provenance flag, the database guard for the link, the concurrent create and the route sub-cap, on real Postgres
// with a stubbed model. No network, no key, no real model.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const ORIGIN = "http://127.0.0.1:3100";
const ENV = { ...FAKE_ENV, AI_RECEIPT_ENABLED: "true", AI_RECEIPT_PHOTO_ENABLED: "true", PAYPAL_SANDBOX_PAYEE_EMAIL: RECEIPT_PAYEE, PAYEE_ALLOWLIST: RECEIPT_PAYEE };
const HASH = "e".repeat(64);
let ctx: PolicyDatabase; let tokenCache: string | undefined;
const open: PolicyDatabase[] = [];
const savedOrigin = process.env.APP_ORIGIN;
beforeAll(() => { process.env.APP_ORIGIN = ORIGIN; });
beforeEach(async () => { ctx = await createPolicyDatabase("aidtrace_photo_prov"); open.push(ctx); tokenCache = undefined; }, 60_000);
afterEach(async () => { vi.restoreAllMocks(); while (open.length) await open.pop()!.close(); }, 60_000);
afterAll(async () => { if (savedOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = savedOrigin; await closeDatabase(); });

const maria = { id: "maria", organizationId: "cedar-hollow" };
const facts = { model: "claude-haiku-5-5" as const, promptVersion: "receipt-photo-v1", schemaVersion: "receipt-transcript-v1", photoSha256: "c".repeat(64), stopReason: "end_turn", inputTokens: 1, outputTokens: 1 };
const flagsOf = async (claimId: string) => (await ctx.client.unsafe(`select photo_unchanged, photo_read_id from receipt_reviews where claim_id = '${claimId}' order by revision`)).map(row => ({ unchanged: row.photo_unchanged as boolean, link: row.photo_read_id as string | null }));

const maria_token = async () => tokenCache ??= await sessionFor(ctx.db, "maria");

// A real read through the route, so the stored digest is the one the production code computes from the pre-fill the form receives.
async function realRead() {
  const stub = stubClient(() => claudeMessage(goodWire()));
  const request = new Request(`${ORIGIN}/api/receipts/photo-text`, { method: "POST", headers: { origin: ORIGIN, "content-type": "image/png", cookie: `${SESSION_COOKIE}=${await maria_token()}` }, body: pngBytes() as unknown as BodyInit });
  const response = await handlePhotoText(request, { db: ctx.db, env: ENV, client: stub.client, budget: createClaudeBudget(), rate: createPhotoRateLimiter() });
  const body = JSON.parse(await response.text()) as { readId: string; prefill: { vendor: string; incurredOn: string; total: string; source: string; lines: { description: string; amount: string }[] } };
  const input = { vendor: body.prefill.vendor, program: "robotics", incurredOn: body.prefill.incurredOn, source: body.prefill.source, total: body.prefill.total, lines: body.prefill.lines };
  return { readId: body.readId, input };
}
const create = (input: Awaited<ReturnType<typeof realRead>>["input"], readId: string) => createReceiptDraft(ctx.db, "maria", input, RECEIPT_PAYEE, false, readId);

describe("PH-51 photo_unchanged is computed by the server from the saved values", () => {
  it("is true for the pre-filled values, also when the browser posts CRLF, a different date and a different program", async () => {
    const { readId, input } = await realRead();
    const id = await create({ ...input, source: input.source.replace(/\n/g, "\r\n"), incurredOn: "2026-10-20", program: "arts" }, readId);
    expect(await flagsOf(id)).toEqual([{ unchanged: true, link: readId }]);
  });
  it("is false for one cent changed, a changed vendor, a changed description, a changed receipt text and an added line, and still links the read", async () => {
    const variants: ((i: Awaited<ReturnType<typeof realRead>>["input"]) => Awaited<ReturnType<typeof realRead>>["input"])[] = [
      i => ({ ...i, lines: i.lines.map((line, n) => n === 0 ? { ...line, amount: (Number(line.amount) + 0.01).toFixed(2) } : line), total: (Number(i.total) + 0.01).toFixed(2) }),
      i => ({ ...i, vendor: `${i.vendor} Two` }),
      i => ({ ...i, lines: i.lines.map((line, n) => n === 1 ? { ...line, description: `${line.description}s` } : line) }),
      i => ({ ...i, source: `${i.source}\nextra` }),
      i => ({ ...i, lines: [...i.lines, { description: "Extra", amount: "1.00" }], total: (Number(i.total) + 1).toFixed(2) }),
    ];
    for (const [n, vary] of variants.entries()) {
      const { readId, input } = await realRead();
      const id = await create(vary(input), readId);
      expect(await flagsOf(id), `variant ${n}`).toEqual([{ unchanged: false, link: readId }]);
    }
  });
  it("an edit after creation recomputes it against the read: a change flips it to false and putting the values back flips it to true", async () => {
    const { readId, input } = await realRead();
    const id = await create(input, readId);
    const edit = async (values: typeof input) => { const view = await readReceiptView(ctx.db, id, "maria"); await editReceiptDraft(ctx.db, id, "maria", view.review.id, view.review.draftHash, values); };
    await edit({ ...input, vendor: "Somewhere Else" });
    await edit(input);
    await edit({ ...input, source: `${input.source} ` });
    expect((await flagsOf(id)).map(row => row.unchanged)).toEqual([true, false, true, false]);
    expect((await flagsOf(id)).every(row => row.link === readId)).toBe(true);
  });
  it("a receipt with no link is never unchanged, and the database refuses unchanged without a link", async () => {
    const { input } = await realRead();
    const id = await createReceiptDraft(ctx.db, "maria", input, RECEIPT_PAYEE, false, null);
    expect(await flagsOf(id)).toEqual([{ unchanged: false, link: null }]);
    const view = await readReceiptView(ctx.db, id, "maria");
    await editReceiptDraft(ctx.db, id, "maria", view.review.id, view.review.draftHash, input);
    expect((await flagsOf(id)).map(row => row.unchanged)).toEqual([false, false]);
    await expect(ctx.client.unsafe(`insert into receipt_reviews (claim_id, claim_version, revision, source, source_hash, draft_hash, created_by, photo_unchanged) values ('${id}',1,3,'s','${HASH}','${HASH}','maria',true)`)).rejects.toMatchObject({ code: "23514" });
  });
  it("the client cannot set it: a posted photoUnchanged field is refused on create and edit, and a changed draft posted with a link is false", async () => {
    const { readId, input } = await realRead();
    const lineFields = Object.fromEntries(input.lines.flatMap((line, n) => [[`description${n + 1}`, line.description], [`amount${n + 1}`, line.amount]]));
    const post = async (body: URLSearchParams) => new Request(`${ORIGIN}/api/receipts`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", cookie: `${SESSION_COOKIE}=${await maria_token()}` }, body: body.toString() });
    const fields = (extra: Record<string, string>) => new URLSearchParams({ action: "create", vendor: input.vendor, program: "robotics", incurredOn: input.incurredOn, source: input.source, total: input.total, syntheticReceipt: "yes", ...lineFields, ...extra });
    const claimsBefore = (await ctx.client.unsafe("select 1 from claims where id like 'R-%'")).length;
    for (const name of ["photoUnchanged", "photo_unchanged", "unchanged"]) {
      const refused = await handleReceiptAction(await post(fields({ photoReadId: readId, [name]: "true" })), null, { db: ctx.db, env: ENV });
      expect(refused.status, name).toBe(400); expect(await refused.text()).toBe("Unexpected or repeated field");
    }
    expect((await ctx.client.unsafe("select 1 from claims where id like 'R-%'")).length).toBe(claimsBefore);
    const changed = await handleReceiptAction(await post(fields({ photoReadId: readId, vendor: "Changed Vendor" })), null, { db: ctx.db, env: ENV });
    expect(changed.status).toBe(303);
    const id = /\/claims\/(R-[0-9a-f-]{36})\/receipt/.exec(changed.headers.get("location")!)![1]!;
    expect(await flagsOf(id)).toEqual([{ unchanged: false, link: readId }]);
    const view = await readReceiptView(ctx.db, id, "maria");
    const edit = await handleReceiptAction(await post(new URLSearchParams({ action: "edit", reviewId: view.review.id, draftHash: view.review.draftHash, vendor: input.vendor, program: "robotics", incurredOn: input.incurredOn, source: input.source, total: input.total, syntheticReceipt: "yes", ...lineFields, photoUnchanged: "true" })), null, { db: ctx.db, env: ENV });
    expect(edit.status).toBe(400);
    expect((await flagsOf(id)).length).toBe(1);
  });
});

describe("PH-52 the database guard for the photo link", () => {
  async function bareClaim() {
    const id = `R-${randomUUID()}`;
    await ctx.db.insert(s.claims).values({ id, version: 1, organizationId: "cedar-hollow", claimantId: "maria", vendor: "Guard Test", program: "robotics", incurredOn: "2026-10-14", payeeEmail: RECEIPT_PAYEE, payeeIsPlaceholder: false, isFixture: true });
    return id;
  }
  const review = (claim: string, revision: number, link: string | null, by = "maria") => ctx.client.unsafe(`insert into receipt_reviews (claim_id, claim_version, revision, source, source_hash, draft_hash, created_by, photo_read_id) values ('${claim}',1,${revision},'s','${HASH}','${HASH}','${by}',${link ? `'${link}'` : "null"})`);
  it("refuses a first revision that links another user's read, a FAILED read, an unknown read, and accepts the creator's READ", async () => {
    await ctx.db.insert(s.users).values({ id: "maria2", organizationId: "cedar-hollow", username: "maria2", displayName: "Second Claimant", role: "CLAIMANT", passwordHash: "not-a-real-hash" });
    const other = await recordPhotoRead(ctx.db, { id: "maria2", organizationId: "cedar-hollow" }, facts, "READ", true, HASH);
    const failed = await recordPhotoRead(ctx.db, maria, facts, "FAILED", null);
    const own = await recordPhotoRead(ctx.db, maria, facts, "READ", true, HASH);
    await expect(review(await bareClaim(), 1, other)).rejects.toMatchObject({ code: "23514" });
    await expect(review(await bareClaim(), 1, failed)).rejects.toMatchObject({ code: "23514" });
    await expect(review(await bareClaim(), 1, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "23514" });
    await review(await bareClaim(), 1, own);
    expect((await ctx.client.unsafe("select 1 from receipt_reviews where photo_read_id is not null")).length).toBe(1);
  });
  it("refuses a second first revision for the same read with the named unique index, but not a null link or a later revision with the same link", async () => {
    const own = await recordPhotoRead(ctx.db, maria, facts, "READ", true, HASH);
    const first = await bareClaim(); await review(first, 1, own);
    await expect(review(await bareClaim(), 1, own)).rejects.toMatchObject({ code: "23505", constraint_name: "receipt_review_photo_read_first" });
    await review(first, 2, own);
    await review(await bareClaim(), 1, null); await review(await bareClaim(), 1, null);
  });
  it("makes a later revision keep exactly the link of the revision before it", async () => {
    const a = await recordPhotoRead(ctx.db, maria, facts, "READ", true, HASH);
    const b = await recordPhotoRead(ctx.db, maria, facts, "READ", true, HASH);
    const linked = await bareClaim(); await review(linked, 1, a);
    await expect(review(linked, 2, b)).rejects.toMatchObject({ code: "23514" });
    await expect(review(linked, 2, null)).rejects.toMatchObject({ code: "23514" });
    await review(linked, 2, a);
    const typed = await bareClaim(); await review(typed, 1, null);
    await expect(review(typed, 2, b)).rejects.toMatchObject({ code: "23514" });
    await review(typed, 2, null);
  });
});

describe("PH-53 two creates with one read id", () => {
  it("both receipts exist, exactly one carries the link and the other is saved without it", async () => {
    const { readId, input } = await realRead();
    const [first, second] = await Promise.all([create(input, readId), create(input, readId)]);
    expect(first).not.toBe(second);
    expect((await ctx.client.unsafe("select 1 from claims where id like 'R-%'")).length).toBe(2);
    expect((await ctx.client.unsafe("select 1 from receipt_reviews")).length).toBe(2);
    const links = [...await flagsOf(first), ...await flagsOf(second)].map(row => row.link).sort((x, y) => String(x).localeCompare(String(y)));
    expect(links.filter(link => link === readId)).toHaveLength(1); expect(links.filter(link => link === null)).toHaveLength(1);
    expect((await ctx.client.unsafe("select 1 from receipt_reviews where photo_read_id is not null and photo_unchanged")).length).toBe(1);
  });
});

describe("PH-54 the route sub-cap", () => {
  it("gives the failure line with no request, no row and no shared budget reserved when the sub-cap is spent", async () => {
    const stub = stubClient(() => claudeMessage(goodWire()));
    const photoBudget = createClaudeBudget(20); while (photoBudget.reserve());
    const budget = createClaudeBudget();
    const request = new Request(`${ORIGIN}/api/receipts/photo-text`, { method: "POST", headers: { origin: ORIGIN, "content-type": "image/png", cookie: `${SESSION_COOKIE}=${await maria_token()}` }, body: pngBytes() as unknown as BodyInit });
    const response = await handlePhotoText(request, { db: ctx.db, env: ENV, client: stub.client, budget, photoBudget, rate: createPhotoRateLimiter() });
    expect(response.status).toBe(503);
    expect(JSON.parse(await response.text())).toEqual({ ok: false, message: "Could not read this photo. Type the receipt instead." });
    expect(stub.calls).toHaveLength(0); expect(budget.used()).toBe(0);
    expect((await ctx.client.unsafe("select 1 from receipt_photo_reads")).length).toBe(0);
  });
});
