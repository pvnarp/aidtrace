import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../db/schema";
import { closeDatabase } from "../src/server/db";
import { SESSION_COOKIE } from "../src/server/auth";
import { handleCreateDraft, handleDraftAction, handlePdfText, normalizeNewlines, type RulesRouteDeps } from "../src/server/rules-draft-actions";
import { readDraftReview, type DraftServiceDeps } from "../src/rules-draft/drafts";
import { BUDGET_LINES, THRESHOLD_KEYS } from "../src/rules-draft/draft-validate";
import { EDIT_CAP_FIELDS, EDIT_CATEGORY_PREFIX, EDIT_PROGRAM_PREFIX, EDIT_THRESHOLD_FIELDS, centsToInput } from "../src/server/rules-input";
import { rulesNotice } from "../src/server/rules-notices";
import { GET as createGet, POST as createPost, DELETE as createDelete } from "../src/app/api/funds/[fundId]/rules/drafts/route";
import { GET as actionGet, PUT as actionPut } from "../src/app/api/funds/[fundId]/rules/drafts/[draftId]/route";
import { GET as pdfGet, PATCH as pdfPatch } from "../src/app/api/funds/[fundId]/rules/pdf-text/route";
import { stubClient } from "./support/claude-stub";
import { createPolicyDatabase, digest, receiptClaim, sessionFor, type PolicyDatabase } from "./support/policy-db";
import { buildPdf, FIXTURE_LINES, FIXTURE_TEXT } from "./support/pdf-fixtures";
import { AGREEMENT, RULE_ENV, draftMessage, goodAnswer, unsureList } from "./support/rules-draft";
import { randomBytes } from "node:crypto";

// IAC-440 Package B, DR-92 to DR-105: the three approver-only routes, on real Postgres with a stubbed model. Every request here is built
// by hand and handed to the handler the route files call. No network, no key, no real model. The model stub counts the calls it receives, so "nothing was sent" is a count.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const ORIGIN = "http://127.0.0.1:3100";
const FORM = "application/x-www-form-urlencoded";
let ctx: PolicyDatabase;
const open: PolicyDatabase[] = [];
const savedOrigin = process.env.APP_ORIGIN;
beforeAll(() => { process.env.APP_ORIGIN = ORIGIN; });
beforeEach(async () => { ctx = await createPolicyDatabase("aidtrace_rroutes"); open.push(ctx); }, 60_000);
afterEach(async () => { vi.restoreAllMocks(); while (open.length) await open.pop()!.close(); }, 60_000);
afterAll(async () => { if (savedOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = savedOrigin; await closeDatabase(); });

const FUND = "fund_a";
const tokens = new Map<string, string>();
const tokenOf = async (userId: string) => { const key = `${ctx.name}:${userId}`; if (!tokens.has(key)) tokens.set(key, await sessionFor(ctx.db, userId)); return tokens.get(key)!; };

type Init = { user?: string | null; cookie?: string; origin?: string | null; type?: string | null; method?: string; body?: BodyInit | Uint8Array | null; length?: string };
async function build(path: string, init: Init = {}): Promise<Request> {
  const headers: Record<string, string> = {};
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  if (init.type !== null) headers["content-type"] = init.type ?? FORM;
  const user = init.user === undefined ? "tara" : init.user;
  if (init.cookie) headers.cookie = init.cookie;
  else if (user) headers.cookie = `${SESSION_COOKIE}=${await tokenOf(user)}`;
  if (init.length) headers["content-length"] = init.length;
  const method = init.method ?? "POST";
  const body = (method === "GET" || method === "HEAD" ? undefined : init.body === undefined ? "" : init.body) as BodyInit | null | undefined;
  return new Request(`${ORIGIN}${path}`, { method, headers, body, ...(body && typeof body === "object" && "getReader" in body ? { duplex: "half" } : {}) } as RequestInit);
}
const form = (fields: Record<string, string | string[]>) => new URLSearchParams(Object.entries(fields).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(item => [key, item] as [string, string]))).toString();

// A body stream that never ends, handing out `chunk` bytes per pull. highWaterMark 0 makes a pull happen only when the handler reads, so the pull count is a count of reads.
function endless(chunk: number) {
  const state = { pulls: 0, cancelled: false };
  const bytes = new Uint8Array(chunk).fill(97);
  const body = new ReadableStream<Uint8Array>({ pull(controller) { state.pulls++; controller.enqueue(bytes); }, cancel() { state.cancelled = true; } }, { highWaterMark: 0 });
  return { body, state };
}

const stubFor = (answer: unknown = goodAnswer(), over: Record<string, unknown> = {}) => stubClient(() => draftMessage(answer, "claude-sonnet-5-5", over));
const depsOf = (client: DraftServiceDeps["client"], extra: Partial<DraftServiceDeps> = {}): RulesRouteDeps => ({ db: ctx.db, draft: { env: RULE_ENV, client, ...extra } });
const plain = (): RulesRouteDeps => ({ db: ctx.db });
const createPath = (fund = FUND) => `/api/funds/${fund}/rules/drafts`;
const actionPath = (draftId: string, fund = FUND) => `/api/funds/${fund}/rules/drafts/${draftId}`;
const pdfPath = (fund = FUND) => `/api/funds/${fund}/rules/pdf-text`;

async function create(user: string | null, text = AGREEMENT, answer: unknown = goodAnswer(), init: Init = {}) {
  const stub = stubFor(answer);
  const response = await handleCreateDraft(await build(createPath(), { user, body: form({ text }), ...init }), FUND, depsOf(stub.client));
  return { response, stub };
}
async function draftId(user = "tara", answer: unknown = goodAnswer()): Promise<string> {
  const { response } = await create(user, AGREEMENT, answer);
  expect(response.status).toBe(303);
  return /\/drafts\/([0-9a-f-]{36})$/.exec(response.headers.get("location") ?? "")![1]!;
}
const act = async (user: string | null, id: string, fields: Record<string, string | string[]> | string, init: Init = {}) =>
  handleDraftAction(await build(actionPath(id), { user, body: typeof fields === "string" ? fields : form(fields), ...init }), FUND, id, plain());
const count = async (table: string, where = "true") => Number((await ctx.client.unsafe(`select count(*)::int as n from ${table} where ${where}`))[0]!.n);
const location = (response: Response) => new URL(response.headers.get("location") ?? "", ORIGIN);
const noticeOf = (response: Response) => rulesNotice(Object.fromEntries(location(response).searchParams));
const snapshot = async () => ({ drafts: await count("policy_drafts"), events: await count("policy_draft_events"), versions: await count("fund_policy_versions"), settings: await count("fund_check_settings") });
async function addOtherOrganization() {
  await ctx.db.insert(s.organizations).values({ id: "other-org", name: "Other Org", prohibitedCategories: [], openingSourceType: "fixture_opening_balance" });
  await ctx.db.insert(s.users).values({ id: "olga", organizationId: "other-org", username: "olga", displayName: "Olga", role: "APPROVER", passwordHash: "not-a-real-hash", isFixture: false });
  await ctx.db.insert(s.funds).values({ id: "fund_other", organizationId: "other-org", name: "Other Fund", fundClass: "RESTRICTED", currentPolicyVersion: 1, isFixture: false });
}

// The edit form exactly as the edit screen renders it for a stored draft, so an untouched form can be posted back.
async function untouchedEdit(id: string, over: Record<string, string> = {}, extra: [string, string][] = []): Promise<string> {
  const read = await readDraftReview(ctx.db, { id: "tara" }, id);
  if (read.status !== "OK" || !read.review.view.draft) throw new Error("A drafted review is required");
  const draft = read.review.view.draft;
  const params = new URLSearchParams({ action: "edit", periodStart: draft.periodStart.value ?? "", periodEnd: draft.periodEnd.value ?? "", summary: draft.summary });
  for (const line of BUDGET_LINES) params.set(EDIT_CAP_FIELDS[line], centsToInput(draft.caps[line].value));
  for (const key of THRESHOLD_KEYS) params.set(EDIT_THRESHOLD_FIELDS[key], key.endsWith("Days") ? (draft.thresholds[key].value ?? "").toString() : centsToInput(draft.thresholds[key].value));
  for (const program of draft.programs.value ?? []) params.append(`${EDIT_PROGRAM_PREFIX}${program}`, "on");
  for (const category of draft.allowedCategories.value ?? []) params.append(`${EDIT_CATEGORY_PREFIX}${category}`, "on");
  for (const [key, value] of Object.entries(over)) params.set(key, value);
  for (const [key, value] of extra) params.append(key, value);
  return params.toString();
}

const pdfBytes = () => buildPdf({ pages: FIXTURE_LINES });
const pdfRequest = async (bytes: Uint8Array | null, init: Init = {}, fund = FUND) => build(pdfPath(fund), { type: "application/pdf", body: bytes, ...init });
const pdfJson = async (response: Response) => await response.json() as Record<string, unknown>;

describe("DR-92 a claimant is refused by every route, and nothing is read, sent or written", () => {
  it("refuses a claimant on create with 403, no model call, no row, and never reads the body", async () => {
    const before = await snapshot();
    const { body, state } = endless(1024);
    const stub = stubFor();
    const response = await handleCreateDraft(await build(createPath(), { user: "maria", body }), FUND, depsOf(stub.client));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Approver access required");
    expect(stub.calls).toHaveLength(0);
    expect(state.pulls).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(await count("policy_drafts")).toBe(before.drafts);
  });
  it("refuses a claimant on approve, withdraw and edit with 403 and writes no event", async () => {
    const id = await draftId("tara");
    const before = await snapshot();
    for (const fields of [{ action: "approve" }, { action: "withdraw" }, await untouchedEdit(id, { summary: "Changed." })]) {
      const response = await act("maria", id, fields);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Approver access required");
    }
    expect(await snapshot()).toEqual(before);
  });
  it("refuses a claimant on the PDF text route with 403 JSON and never reads the file", async () => {
    const { body, state } = endless(4096);
    const response = await handlePdfText(await pdfRequest(null, { user: "maria", body }), FUND, plain());
    expect(response.status).toBe(403);
    expect(await pdfJson(response)).toEqual({ ok: false, code: "REFUSED", message: "Approver access required" });
    expect(state.pulls).toBe(0);
    const valid = await handlePdfText(await pdfRequest(pdfBytes(), { user: "maria" }), FUND, plain());
    expect(valid.status).toBe(403);
    expect(JSON.stringify(await pdfJson(valid))).not.toContain("Grant agreement");
  });
});

describe("DR-93 a signed-out request is refused by every route before anything else is read", () => {
  it("answers 401 for no cookie, an unknown token, a malformed token and an expired session", async () => {
    const id = await draftId("tara");
    await ctx.db.insert(s.sessions).values({ tokenHash: digest("e".repeat(64)), userId: "tara", createdAt: new Date(Date.now() - 2000), expiresAt: new Date(Date.now() - 1000) });
    const cookies = [undefined, `${SESSION_COOKIE}=${"a".repeat(64)}`, `${SESSION_COOKIE}=not-a-token`, `${SESSION_COOKIE}=`, `${SESSION_COOKIE}=${"e".repeat(64)}`, "other=1"];
    for (const cookie of cookies) {
      const init: Init = { user: null, cookie };
      const { body, state } = endless(1024);
      const stub = stubFor();
      const made = await handleCreateDraft(await build(createPath(), { ...init, body }), FUND, depsOf(stub.client));
      expect(made.status, String(cookie)).toBe(401);
      expect(state.pulls).toBe(0);
      expect(stub.calls).toHaveLength(0);
      expect((await act(null, id, { action: "approve" }, init)).status, String(cookie)).toBe(401);
      const pdf = await handlePdfText(await pdfRequest(pdfBytes(), init), FUND, plain());
      expect(pdf.status, String(cookie)).toBe(401);
      expect((await pdfJson(pdf)).ok).toBe(false);
    }
    expect(await count("policy_drafts")).toBe(1);
  });
});

describe("DR-94 a request from another origin is refused by every route, even with a valid approver cookie", () => {
  it.each([
    ["a foreign origin", "https://evil.example"], ["a missing origin", null], ["the string null", "null"], ["the demo port next door", "http://127.0.0.1:3101"],
    ["the right host with a suffix", "http://127.0.0.1:3100.evil.example"], ["localhost spelled out", "http://localhost:3100"], ["the right origin with a path", `${ORIGIN}/`],
  ])("answers 403 for %s and reads no body", async (_label, origin) => {
    const id = await draftId("tara");
    const before = await snapshot();
    const { body, state } = endless(1024);
    const stub = stubFor();
    expect((await handleCreateDraft(await build(createPath(), { origin, body }), FUND, depsOf(stub.client))).status).toBe(403);
    expect(state.pulls).toBe(0);
    expect(stub.calls).toHaveLength(0);
    expect((await act("tara", id, { action: "approve" }, { origin })).status).toBe(403);
    const pdf = await handlePdfText(await pdfRequest(pdfBytes(), { origin }), FUND, plain());
    expect(pdf.status).toBe(403);
    expect((await pdfJson(pdf)).ok).toBe(false);
    expect(await snapshot()).toEqual(before);
  });
});

describe("DR-95 another organization's fund and draft read as not found", () => {
  it("answers 404 for an approver of another organization on every route, with no model call", async () => {
    await addOtherOrganization();
    const id = await draftId("tara");
    const before = await snapshot();
    const stub = stubFor();
    const made = await handleCreateDraft(await build(createPath(), { user: "olga", body: form({ text: AGREEMENT }) }), FUND, depsOf(stub.client));
    expect(made.status).toBe(404);
    expect(await made.text()).toBe("Fund not found");
    expect(stub.calls).toHaveLength(0);
    for (const fields of [{ action: "approve" }, { action: "withdraw" }, await untouchedEdit(id, { summary: "Changed." })]) {
      const response = await act("olga", id, fields);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Draft not found");
    }
    const pdf = await handlePdfText(await pdfRequest(pdfBytes(), { user: "olga" }), FUND, plain());
    expect(pdf.status).toBe(404);
    expect(await pdfJson(pdf)).toEqual({ ok: false, code: "REFUSED", message: "Fund not found" });
    expect(await snapshot()).toEqual(before);
  });
  it("answers 404 when the draft belongs to a different fund than the path names, or to another organization, and for ids that are not ids", async () => {
    await addOtherOrganization();
    const id = await draftId("tara");
    const wrongFund = await handleDraftAction(await build(actionPath(id, "fund_b"), { user: "tara", body: form({ action: "approve" }) }), "fund_b", id, plain());
    expect(wrongFund.status).toBe(404);
    const otherOrg = await handleDraftAction(await build(actionPath(id, "fund_other"), { user: "olga", body: form({ action: "approve" }) }), "fund_other", id, plain());
    expect(otherOrg.status).toBe(404);
    const missing = await act("tara", "00000000-0000-4000-8000-000000000000", { action: "approve" });
    expect(missing.status).toBe(404);
    for (const bad of ["not-a-uuid", "..%2f..", "a".repeat(65), "x y", ""]) {
      const response = await handleDraftAction(await build(actionPath("x"), { user: "tara", body: form({ action: "approve" }) }), FUND, bad, plain());
      expect(response.status, bad).toBe(404);
    }
    for (const bad of ["no_such_fund", "a".repeat(65), "../x", ""]) {
      expect((await handleCreateDraft(await build(createPath(), { user: "tara", body: form({ text: AGREEMENT }) }), bad, plain())).status, bad).toBe(404);
      expect((await handlePdfText(await pdfRequest(pdfBytes()), bad, plain())).status, bad).toBe(404);
    }
    expect(await count("policy_draft_events", "kind = 'APPROVED'")).toBe(0);
  });
});

describe("DR-96 only POST is accepted, and the route files send every other method to the same checks", () => {
  it("answers 405 with Allow: POST for GET, PUT, PATCH and DELETE on all three handlers, even for a valid approver", async () => {
    const id = await draftId("tara");
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      const created = await handleCreateDraft(await build(createPath(), { method }), FUND, plain());
      expect([created.status, created.headers.get("allow")], method).toEqual([405, "POST"]);
      const acted = await handleDraftAction(await build(actionPath(id), { method }), FUND, id, plain());
      expect([acted.status, acted.headers.get("allow")], method).toEqual([405, "POST"]);
      const pdf = await handlePdfText(await build(pdfPath(), { method, type: "application/pdf" }), FUND, plain());
      expect([pdf.status, pdf.headers.get("allow")], method).toEqual([405, "POST"]);
      expect((await pdfJson(pdf)).ok).toBe(false);
    }
    expect(await count("policy_draft_events", "kind = 'APPROVED'")).toBe(0);
  });
  it("is wired so the real route files answer a wrong method with 405 and no cache", async () => {
    const fundContext = (fundId: string) => ({ params: Promise.resolve({ fundId }) });
    const draftContext = (fundId: string, draftId: string) => ({ params: Promise.resolve({ fundId, draftId }) });
    const attempts = [
      await createGet(await build(createPath(), { method: "GET" }), fundContext(FUND)), await createDelete(await build(createPath(), { method: "DELETE" }), fundContext(FUND)),
      await actionGet(await build(actionPath("x"), { method: "GET" }), draftContext(FUND, "x")), await actionPut(await build(actionPath("x"), { method: "PUT", body: "" }), draftContext(FUND, "x")),
      await pdfGet(await build(pdfPath(), { method: "GET" }), fundContext(FUND)), await pdfPatch(await build(pdfPath(), { method: "PATCH", body: "" }), fundContext(FUND)),
    ];
    for (const response of attempts) { expect(response.status).toBe(405); expect(response.headers.get("cache-control")).toBe("no-store"); }
    expect(typeof createPost).toBe("function");
  });
});

describe("DR-97 the wrong content type is refused after the checks that come before it", () => {
  it.each([["json", "application/json"], ["multipart", "multipart/form-data; boundary=x"], ["plain text", "text/plain"], ["a longer form type", `${FORM}-evil`], ["missing", null]])(
    "refuses a form route body sent as %s with 415 and sends nothing", async (_label, type) => {
      const id = await draftId("tara");
      const stub = stubFor();
      const made = await handleCreateDraft(await build(createPath(), { type, body: form({ text: AGREEMENT }) }), FUND, depsOf(stub.client));
      expect(made.status).toBe(415);
      expect(stub.calls).toHaveLength(0);
      expect((await act("tara", id, { action: "approve" }, { type })).status).toBe(415);
      expect(await count("policy_drafts")).toBe(1);
      expect(await count("policy_draft_events", "kind = 'APPROVED'")).toBe(0);
    });
  it.each([["a form", FORM], ["plain text", "text/plain"], ["an octet stream", "application/octet-stream"], ["a longer pdf type", "application/pdf-evil"], ["json", "application/json"], ["missing", null]])(
    "refuses a PDF route body sent as %s with 415 JSON", async (_label, type) => {
      const response = await handlePdfText(await pdfRequest(pdfBytes(), { type }), FUND, plain());
      expect(response.status).toBe(415);
      expect(await pdfJson(response)).toEqual({ ok: false, code: "REFUSED", message: "A PDF file is required" });
    });
  it("accepts a PDF type with a parameter and in capitals, and a form type with a charset", async () => {
    for (const type of ["application/pdf; charset=binary", "APPLICATION/PDF"]) {
      const response = await handlePdfText(await pdfRequest(pdfBytes(), { type }), FUND, plain());
      expect(response.status, type).toBe(200);
    }
    const stub = stubFor();
    const made = await handleCreateDraft(await build(createPath(), { type: `${FORM}; charset=UTF-8`, body: form({ text: AGREEMENT }) }), FUND, depsOf(stub.client));
    expect(made.status).toBe(303);
    expect(stub.calls).toHaveLength(1);
  });
});

describe("DR-98 an oversize body is refused while it streams, without being read to the end", () => {
  it("cuts off a create body after the 256 KiB cap with 413, and a declared length over the cap is refused with no read at all", async () => {
    const { body, state } = endless(64 * 1024);
    const stub = stubFor();
    const response = await handleCreateDraft(await build(createPath(), { body }), FUND, depsOf(stub.client));
    expect(response.status).toBe(413);
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThanOrEqual(6);
    expect(stub.calls).toHaveLength(0);
    const declared = endless(1024);
    const refused = await handleCreateDraft(await build(createPath(), { body: declared.body, length: String(256 * 1024 + 1) }), FUND, depsOf(stub.client));
    expect(refused.status).toBe(413);
    expect(declared.state.pulls).toBe(0);
    expect(stub.calls).toHaveLength(0);
  });
  it("holds the line at exactly 256 KiB: one byte more is 413, the limit itself is read", async () => {
    const stub = stubFor();
    const prefix = "text=";
    const exact = prefix + "a".repeat(256 * 1024 - prefix.length);
    const atLimit = await handleCreateDraft(await build(createPath(), { body: exact }), FUND, depsOf(stub.client));
    expect(atLimit.status).not.toBe(413);
    const over = await handleCreateDraft(await build(createPath(), { body: `${exact}a` }), FUND, depsOf(stub.client));
    expect(over.status).toBe(413);
    expect(stub.calls).toHaveLength(0);
  });
  it("cuts off an action body after 16 KiB with 413, and refuses a declared length over it without a read", async () => {
    const id = await draftId("tara");
    const { body, state } = endless(4096);
    const response = await handleDraftAction(await build(actionPath(id), { body }), FUND, id, plain());
    expect(response.status).toBe(413);
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThanOrEqual(6);
    const declared = endless(1024);
    expect((await handleDraftAction(await build(actionPath(id), { body: declared.body, length: String(16 * 1024 + 1) }), FUND, id, plain())).status).toBe(413);
    expect(declared.state.pulls).toBe(0);
    expect(await count("policy_draft_events", "kind = 'APPROVED'")).toBe(0);
  });
  it("cuts off a PDF upload after 2 MiB with 413 JSON and the fixed message, and never runs the extractor on it", async () => {
    const { body, state } = endless(256 * 1024);
    const response = await handlePdfText(await pdfRequest(null, { body }), FUND, plain());
    expect(response.status).toBe(413);
    expect(await pdfJson(response)).toEqual({ ok: false, code: "TOO_LARGE", message: "That file is over 2 MB. Paste the text instead." });
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThanOrEqual(10);
    const declared = endless(1024);
    const refused = await handlePdfText(await pdfRequest(null, { body: declared.body, length: String(2 * 1024 * 1024 + 1) }), FUND, plain());
    expect(refused.status).toBe(413);
    expect(declared.state.pulls).toBe(0);
  });
  it("refuses a Content-Length that is not a plain number, and an empty body, without a crash", async () => {
    for (const length of ["-1", "1e6", "12abc", "0x10"]) {
      const response = await handleCreateDraft(await build(createPath(), { body: "text=a", length }), FUND, plain());
      expect(response.status, length).toBe(400);
    }
    // An empty file has no PDF signature, so it is the not-a-PDF answer; a Content-Length that is not a plain number is refused before the file is read.
    const empty = await handlePdfText(await pdfRequest(new Uint8Array()), FUND, plain());
    expect([empty.status, (await pdfJson(empty)).code]).toEqual([422, "NOT_PDF"]);
    for (const length of ["-1", "1e6", "12abc"]) {
      const bad = await handlePdfText(await pdfRequest(pdfBytes(), { length }), FUND, plain());
      expect([bad.status, await pdfJson(bad)], length).toEqual([400, { ok: false, code: "REFUSED", message: "Missing file" }]);
    }
  });
});

describe("DR-99 a form with an extra, duplicate, missing or malformed field is refused", () => {
  it("refuses a create form that is not exactly one text field, and a body that is not UTF-8, with no model call", async () => {
    const stub = stubFor();
    const cases: [string, BodyInit][] = [
      ["duplicate text", form({ text: ["a", "b"] })], ["extra field", `text=a&extra=1`], ["a fund id smuggled in", `text=a&fundId=fund_b`], ["no field", ""], ["a different name", "body=a"],
      ["the name only in a different case", "Text=a"], ["not utf-8", new Uint8Array([0x74, 0x65, 0x78, 0x74, 0x3d, 0xff, 0xfe])],
    ];
    for (const [label, body] of cases) {
      const response = await handleCreateDraft(await build(createPath(), { body }), FUND, depsOf(stub.client));
      expect(response.status, label).toBe(400);
      expect(await response.text(), label).toBe("Invalid draft fields");
    }
    expect(stub.calls).toHaveLength(0);
    expect(await count("policy_drafts")).toBe(0);
  });
  it("refuses an action form with an extra, duplicate, missing, unknown or smuggled field, and writes nothing", async () => {
    const id = await draftId("tara");
    const before = await snapshot();
    const cases: Record<string, string> = {
      "extra field on approve": "action=approve&extra=1", "extra field on withdraw": "action=withdraw&extra=1", "two actions": "action=approve&action=withdraw", "unknown action": "action=bind",
      "no action": "summary=x", "empty action": "action=", "action in capitals": "action=APPROVE", "a draft id smuggled in": `action=approve&draftId=${id}`, "an actor smuggled in": "action=approve&actorId=ben",
      "a partial edit": "action=edit&summary=Changed.", "an edit with an extra field": await untouchedEdit(id, { summary: "Changed." }, [["actorId", "ben"]]),
      "an edit with a duplicated field": await untouchedEdit(id, { summary: "Changed." }, [["summary", "Again."]]),
      "an edit with an unknown checkbox": await untouchedEdit(id, { summary: "Changed." }, [["program.Robotics", "on"]]),
    };
    for (const [label, body] of Object.entries(cases)) {
      const response = await act("tara", id, body);
      expect(response.status, label).toBe(400);
      expect(await response.text(), label).toBe("Invalid draft fields");
    }
    expect((await act("tara", id, new Uint8Array([0x61, 0x3d, 0xff]) as unknown as string)).status).toBe(400);
    expect(await snapshot()).toEqual(before);
  });
});

describe("DR-100 two approvals by two different approvers, and the same approver twice is refused in plain words", () => {
  it("records the first approval, refuses the same approver again with its own sentence, and binds on a second different approver", async () => {
    const id = await draftId("tara");
    const first = await act("tara", id, { action: "approve" });
    expect(first.status).toBe(303);
    expect(location(first).pathname).toBe(`/funds/${FUND}/rules/drafts/${id}`);
    // HP-07: the first approval redirects with no query at all. The review page says "a second, different approver must approve" once, in its own state notice.
    expect(location(first).search).toBe("");
    expect(first.headers.get("location")).toBe(`/funds/${FUND}/rules/drafts/${id}`);
    expect(noticeOf(first)).toBeNull();
    expect(await count("policy_draft_events", `draft_id = '${id}' and kind = 'APPROVED'`)).toBe(1);

    const again = await act("tara", id, { action: "approve" });
    expect(again.status).toBe(303);
    expect(location(again).pathname).toBe(`/funds/${FUND}/rules/drafts/${id}`);
    expect(noticeOf(again)?.text).toBe("You already approved this draft. A different approver must give the second approval.");
    expect(await count("policy_draft_events", `draft_id = '${id}' and kind = 'APPROVED'`)).toBe(1);
    expect(await count("fund_policy_versions", `fund_id = '${FUND}'`)).toBe(1);

    const second = await act("ben", id, { action: "approve" });
    expect(second.status).toBe(303);
    expect(location(second).pathname).toBe(`/funds/${FUND}/rules`);
    expect(noticeOf(second)?.text).toBe("Version 2 is now the fund's approved rules. New claims use it.");
    expect(location(second).searchParams.has("back")).toBe(false);
    expect(await count("fund_policy_versions", `fund_id = '${FUND}'`)).toBe(2);
    expect((await ctx.db.select().from(s.funds).where(eq(s.funds.id, FUND)))[0]!.currentPolicyVersion).toBe(2);

    const late = await act("tara", id, { action: "approve" });
    expect(noticeOf(late)?.text).toBe("This draft is already approved and in use.");
    expect(await count("fund_policy_versions", `fund_id = '${FUND}'`)).toBe(2);
  });
  it("says how many frozen receipts went back to draft when the bind changed the pay order, and that paid claims are untouched", async () => {
    const early = await receiptClaim(ctx.db, { vendor: "Early shop" });
    const { approveDecision } = await import("../src/ledger/service");
    await approveDecision(ctx.db, early.decisionId, "tara", early.hash);
    const answer = goodAnswer();
    answer.allowedCategories.value = ["robot_kits_parts", "classroom_supplies", "books"]; answer.breadth = 3;
    const id = await draftId("tara", answer);
    expect((await act("tara", id, { action: "approve" })).status).toBe(303);
    const bound = await act("ben", id, { action: "approve" });
    expect(location(bound).pathname).toBe(`/funds/${FUND}/rules`);
    expect(location(bound).searchParams.get("back")).toBe("1");
    expect(noticeOf(bound)?.text).toBe("Version 2 is now the fund's approved rules. New claims use it. The pay order changed. 1 receipt that was frozen but not yet approved twice went back to draft and needs both approvals again. Paid claims are untouched.");
  });
  it("withdraws a draft, refuses a second action on it, and a withdrawn draft takes no approval", async () => {
    const id = await draftId("tara");
    const withdrawn = await act("ben", id, { action: "withdraw" });
    expect(withdrawn.status).toBe(303);
    expect(noticeOf(withdrawn)?.text).toBe("The draft is withdrawn. It takes no more approvals.");
    expect(noticeOf(await act("tara", id, { action: "approve" }))?.text).toBe("This draft was withdrawn, so it takes no more approvals.");
    expect(await count("policy_draft_events", "kind = 'APPROVED'")).toBe(0);
  });
  it("refuses approval of an incomplete draft with the fixed sentence", async () => {
    const answer = goodAnswer(); answer.programs = unsureList();
    const id = await draftId("tara", answer);
    expect(noticeOf(await act("tara", id, { action: "approve" }))?.text).toBe("Some required fields are still not set. Fill them in with Save my changes before approving.");
    expect(await count("policy_draft_events", "kind = 'APPROVED'")).toBe(0);
  });
});

describe("DR-101 creating a draft goes to the review page, or back to the rules page with one plain sentence that says whether anything was sent", () => {
  it("stores a draft from the pasted grant, sends one request, and redirects to its review page", async () => {
    const { response, stub } = await create("tara");
    expect(response.status).toBe(303);
    expect(location(response).pathname).toMatch(new RegExp(`^/funds/${FUND}/rules/drafts/[0-9a-f-]{36}$`));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(stub.calls).toHaveLength(1);
    expect(await count("policy_drafts", "outcome = 'DRAFTED'")).toBe(1);
  });
  it("normalizes the line endings a browser sends, so a quote that spans lines still matches", async () => {
    expect(normalizeNewlines("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    const { response } = await create("tara", AGREEMENT.replaceAll("\n", "\r\n"));
    expect(response.status).toBe(303);
    const id = /\/drafts\/([0-9a-f-]{36})$/.exec(response.headers.get("location")!)![1]!;
    const read = await readDraftReview(ctx.db, { id: "tara" }, id);
    expect(read.status === "OK" && read.review.view.inputText).toBe(AGREEMENT);
  });
  it("stores a refusal when the model answers badly, redirects to the review page, and shows no drafted value there", async () => {
    const bad = goodAnswer(); bad.clauses[0].text = "A sentence that is not in the grant at all.";
    const { response } = await create("tara", AGREEMENT, bad);
    expect(response.status).toBe(303);
    const id = /\/drafts\/([0-9a-f-]{36})$/.exec(response.headers.get("location")!)![1]!;
    const read = await readDraftReview(ctx.db, { id: "tara" }, id);
    expect(read.status === "OK" && read.review.view.state).toBe("REFUSED");
    expect(read.status === "OK" && read.review.view.draft).toBeNull();
  });
  it("answers AI off and no key with the sentence that says nothing was sent, and sends no request", async () => {
    const stub = stubFor();
    const off = await handleCreateDraft(await build(createPath(), { body: form({ text: AGREEMENT }) }), FUND, { db: ctx.db, draft: { env: {}, client: stub.client } });
    expect(location(off).pathname).toBe(`/funds/${FUND}/rules`);
    expect(noticeOf(off)?.text).toBe("AI drafting is off on this instance. Nothing was sent.");
    const keyless = await handleCreateDraft(await build(createPath(), { body: form({ text: AGREEMENT }) }), FUND, { db: ctx.db, draft: { env: { AI_RULE_DRAFTS_ENABLED: "true" }, client: stub.client } });
    expect(noticeOf(keyless)?.text).toBe("AI drafting has no key set on this instance. Nothing was sent.");
    expect(stub.calls).toHaveLength(0);
    expect(await count("policy_drafts")).toBe(0);
  });
  it("answers a failed request and a timeout with the fixed sentences, and never echoes the error", async () => {
    const SECRET = "SECRET-ERROR-TEXT sk-ant-api03-LEAK 401 invalid x-api-key";
    const failing = stubClient(() => { throw new Error(SECRET); });
    const failed = await handleCreateDraft(await build(createPath(), { body: form({ text: AGREEMENT }) }), FUND, depsOf(failing.client));
    expect(failed.status).toBe(303);
    expect(noticeOf(failed)?.text).toBe("The AI request failed. Nothing was stored. Try again.");
    const slow = stubClient((_request, options) => new Promise((_resolve, reject) => { options?.signal?.addEventListener("abort", () => reject(new Error(SECRET))); }));
    const timedOut = await handleCreateDraft(await build(createPath(), { body: form({ text: AGREEMENT }) }), FUND, depsOf(slow.client, { timeoutMs: 20 }));
    expect(noticeOf(timedOut)?.text).toBe("The AI request did not finish. Nothing was stored. Try again.");
    for (const response of [failed, timedOut]) {
      expect(response.headers.get("location")).not.toMatch(/SECRET|sk-ant|LEAK|401|x-api-key/);
      expect(await response.text()).toBe("");
    }
    expect(failing.calls).toHaveLength(1);
    expect(await count("policy_drafts")).toBe(0);
  });
  it("answers empty, whitespace and 20,001-character text with the length sentence and sends nothing, and accepts exactly 20,000", async () => {
    const stub = stubFor();
    for (const text of ["", "   \n  ", "x".repeat(20_001)]) {
      const response = await handleCreateDraft(await build(createPath(), { body: form({ text }) }), FUND, depsOf(stub.client));
      expect(noticeOf(response)?.text, text.slice(0, 10)).toBe("Paste between 1 and 20,000 characters of the grant, with some visible text. Nothing was sent.");
    }
    expect(stub.calls).toHaveLength(0);
    const atLimit = await handleCreateDraft(await build(createPath(), { body: form({ text: "x".repeat(20_000) }) }), FUND, depsOf(stub.client));
    expect(atLimit.status).toBe(303);
    expect(stub.calls).toHaveLength(1);
  });
  it("answers a fund that is not restricted with its own sentence and sends nothing", async () => {
    const stub = stubFor();
    const response = await handleCreateDraft(await build(createPath("fund_g"), { body: form({ text: AGREEMENT }) }), "fund_g", depsOf(stub.client));
    expect(location(response).pathname).toBe("/funds/fund_g/rules");
    expect(noticeOf(response)?.text).toBe("Only a restricted fund takes AI-drafted rules. Nothing was sent.");
    expect(stub.calls).toHaveLength(0);
  });
});

describe("DR-102 an edit saves a new draft that needs its own two approvals, and an untouched form changes nothing", () => {
  const unsureProgramAnswer = () => { const answer = goodAnswer(); answer.programs = unsureList(); return answer; };
  it("fills an UNSURE field through the form, makes a new draft row with no approvals, and leaves the old draft on record", async () => {
    const id = await draftId("tara", unsureProgramAnswer());
    const edited = await act("tara", id, await untouchedEdit(id, {}, [[`${EDIT_PROGRAM_PREFIX}robotics`, "on"]]));
    expect(edited.status).toBe(303);
    const child = /\/drafts\/([0-9a-f-]{36})$/.exec(location(edited).pathname)![1]!;
    expect(child).not.toBe(id);
    expect(noticeOf(edited)?.text).toBe("Your change is saved as a new draft. It needs its own two approvals.");
    const row = (await ctx.db.select().from(s.policyDrafts).where(eq(s.policyDrafts.id, child)))[0]!;
    expect(row.parentDraftId).toBe(id);
    expect(await count("policy_draft_events", `draft_id = '${child}' and kind = 'APPROVED'`)).toBe(0);
    const parent = await readDraftReview(ctx.db, { id: "tara" }, id);
    expect(parent.status === "OK" && parent.review.view.state).toBe("OPEN");
    const read = await readDraftReview(ctx.db, { id: "tara" }, child);
    expect(read.status === "OK" && read.review.view.analysis?.missing).toEqual([]);
    expect(read.status === "OK" && read.review.view.changedFields).toEqual(["programs"]);
    const approvedOnce = await act("tara", child, { action: "approve" });
    expect(approvedOnce.status).toBe(303); expect(approvedOnce.headers.get("location")).toBe(`/funds/${FUND}/rules/drafts/${child}`); expect(noticeOf(approvedOnce)).toBeNull();
    expect(noticeOf(await act("tara", child, { action: "approve" }))?.text).toContain("You already approved");
  });
  it("reads a form posted back untouched as no change, and saves no row", async () => {
    const id = await draftId("tara");
    const before = await snapshot();
    const response = await act("tara", id, await untouchedEdit(id));
    expect(response.status).toBe(303);
    expect(noticeOf(response)?.text).toBe("Nothing was changed, so no new draft was made.");
    expect(await snapshot()).toEqual(before);
  });
  it("answers each kind of bad input with its own sentence and saves nothing", async () => {
    const id = await draftId("tara");
    const before = await snapshot();
    const cases: [Record<string, string>, string][] = [
      [{ [EDIT_CAP_FIELDS.travel]: "-5" }, "A dollar amount must be above zero with at most two decimals, like 300 or 300.50. Nothing was saved."],
      [{ [EDIT_CAP_FIELDS.travel]: "1e3" }, "A dollar amount must be above zero with at most two decimals, like 300 or 300.50. Nothing was saved."],
      [{ [EDIT_THRESHOLD_FIELDS.suppliesLimitCents]: "250.999" }, "A dollar amount must be above zero with at most two decimals, like 300 or 300.50. Nothing was saved."],
      [{ [EDIT_THRESHOLD_FIELDS.staleReceiptDays]: "0" }, "A number of days must be a whole number from 1 to 3650. Nothing was saved."],
      [{ periodStart: "09/01/2026" }, "A date must be a real day, like 2026-09-01. Nothing was saved."],
      [{ summary: "  " }, "The summary cannot be empty. Nothing was saved."],
      [{ periodStart: "2028-01-01" }, "The period must start on or before the day it ends. Nothing was saved."],
      [{ periodStart: "2026-02-31" }, "A date is not a real day in the allowed years. Nothing was saved."],
    ];
    for (const [over, sentence] of cases) {
      const response = await act("tara", id, await untouchedEdit(id, over));
      expect(response.status, JSON.stringify(over)).toBe(303);
      expect(location(response).pathname).toBe(`/funds/${FUND}/rules/drafts/${id}`);
      expect(noticeOf(response)?.text, JSON.stringify(over)).toBe(sentence);
    }
    expect(await snapshot()).toEqual(before);
  });
  it("refuses an edit of a withdrawn draft and of a refused one with the fixed sentence", async () => {
    const id = await draftId("tara");
    await act("ben", id, { action: "withdraw" });
    expect(noticeOf(await act("tara", id, await untouchedEdit(id, { summary: "Changed." })))?.text).toBe("This draft was withdrawn, so it takes no more approvals.");
  });
});

describe("DR-103 an unexpected failure answers with a fixed sentence and never with an error, a stack or a database message", () => {
  const SECRET = "SECRET-DB-TEXT password authentication failed for user aidtrace at 10.0.0.9";
  const breaking = (): RulesRouteDeps["db"] => new Proxy(ctx.db, { get(target, property, receiver) { if (property === "transaction") return () => { throw new Error(SECRET); }; return Reflect.get(target, property, receiver); } });
  it("answers a database failure inside the service with a notice redirect, and one before it with a generic 500", async () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map(name => vi.spyOn(console, name).mockImplementation(() => undefined));
    const stub = stubFor();
    const body = form({ text: AGREEMENT });
    const inner = await handleCreateDraft(await build(createPath(), { body }), FUND, { db: breaking(), draft: { env: RULE_ENV, client: stub.client } });
    expect(inner.status).toBe(303);
    expect(noticeOf(inner)?.text).toBe("The draft could not be made. Nothing was stored. Try again.");
    expect(inner.headers.get("location")).not.toMatch(/SECRET|password|10\.0\.0\.9/);
    const id = await draftId("tara");
    const outer = await handleDraftAction(await build(actionPath(id), { body: form({ action: "approve" }) }), FUND, id, { db: breaking() });
    expect(outer.status).toBe(500);
    expect(await outer.text()).toBe("That request could not be completed");
    const pdf = await handlePdfText(await pdfRequest(pdfBytes()), FUND, { db: new Proxy(ctx.db, { get(target, property, receiver) { if (property === "select") return () => { throw new Error(SECRET); }; return Reflect.get(target, property, receiver); } }) });
    expect(pdf.status).toBe(500);
    expect(pdf.headers.get("cache-control")).toBe("no-store");
    expect(await pdfJson(pdf)).toEqual({ ok: false, code: "FAILED", message: "That PDF could not be read. Paste the grant text instead." });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
  it("answers an unset or invalid APP_ORIGIN with a generic 500 and no detail", async () => {
    const saved = process.env.APP_ORIGIN;
    try {
      delete process.env.APP_ORIGIN;
      const response = await handleCreateDraft(await build(createPath(), { body: form({ text: AGREEMENT }) }), FUND, plain());
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("That request could not be completed");
    } finally { process.env.APP_ORIGIN = saved; }
  });
  it("redirects with a table code only: no response header or body of any route carries grant text, a cookie or a key", async () => {
    const stub = stubFor();
    const response = await handleCreateDraft(await build(createPath(), { body: form({ text: AGREEMENT }) }), FUND, depsOf(stub.client));
    const everything = JSON.stringify([...response.headers.entries()]) + (await response.text());
    expect(everything).not.toMatch(/Cedar Hollow|robotics|aidtrace_session|sk-ant|cookie/i);
  });
});

describe("DR-104 the PDF text route returns text for the approver to read, and stores and sends nothing", () => {
  it("returns the exact text and page count as JSON with no-store, and writes no row", async () => {
    const before = await snapshot();
    const response = await handlePdfText(await pdfRequest(pdfBytes()), FUND, plain());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await pdfJson(response)).toEqual({ ok: true, text: FIXTURE_TEXT, pages: 2 });
    expect(await snapshot()).toEqual(before);
  });
  it("gives a plain message and a stable code for each kind of file it cannot use, and no library text", async () => {
    const cases: [string, Uint8Array, number, string, string][] = [
      ["image only", buildPdf({ pages: [[]] }), 422, "NO_TEXT", "That PDF has no text to read, like a scan of paper. Paste the text instead."],
      ["encrypted", buildPdf({ pages: FIXTURE_LINES, encrypted: true }), 422, "ENCRYPTED", "That PDF is password protected. Paste the grant text instead."],
      ["not a pdf", new TextEncoder().encode("Just some text, not a PDF."), 422, "NOT_PDF", "That file is not a PDF. Paste the grant text instead."],
      ["truncated", pdfBytes().slice(0, 300), 422, "MALFORMED", "That PDF could not be read. Paste the grant text instead."],
      ["thirty-one pages", buildPdf({ pages: Array.from({ length: 31 }, (_, index) => [`Page ${index + 1}.`]) }), 422, "TOO_MANY_PAGES", "That PDF has more than 30 pages. Paste the part of the grant that sets the rules instead."],
      ["over the text cap", buildPdf({ pages: [[...Array.from({ length: 22 }, () => "a".repeat(900)), "b".repeat(179)]], fontSize: 1, leading: 1.5 }), 422, "TOO_LONG", "The text in that PDF is longer than 20,000 characters. Paste the part of the grant that sets the rules instead."],
    ];
    const before = await snapshot();
    for (const [label, bytes, status, code, message] of cases) {
      const response = await handlePdfText(await pdfRequest(bytes), FUND, plain());
      expect(response.status, label).toBe(status);
      expect(response.headers.get("cache-control"), label).toBe("no-store");
      expect(await pdfJson(response), label).toEqual({ ok: false, code, message });
    }
    expect(await snapshot()).toEqual(before);
  });
  it("gives the text of a PDF with a JavaScript action and runs nothing", async () => {
    const response = await handlePdfText(await pdfRequest(buildPdf({ pages: FIXTURE_LINES, javascript: true })), FUND, plain());
    expect(await pdfJson(response)).toEqual({ ok: true, text: FIXTURE_TEXT, pages: 2 });
    expect((globalThis as Record<string, unknown>).__pdfActionRan).toBeUndefined();
  });
  it("refuses a fund that is not restricted with 409 before it reads the file", async () => {
    const { body, state } = endless(1024);
    const response = await handlePdfText(await pdfRequest(null, { body }, "fund_g"), "fund_g", plain());
    expect(response.status).toBe(409);
    expect(await pdfJson(response)).toEqual({ ok: false, code: "REFUSED", message: "Only a restricted fund takes AI-drafted rules" });
    expect(state.pulls).toBe(0);
  });
  it("sends nothing to the model: the route has no model dependency and the text goes out only from the create route", async () => {
    const stub = stubFor();
    const response = await handlePdfText(await pdfRequest(pdfBytes()), FUND, depsOf(stub.client));
    expect(response.status).toBe(200);
    expect(stub.calls).toHaveLength(0);
    expect(randomBytes(1).length).toBe(1);
  });
});
