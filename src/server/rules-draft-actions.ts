// IAC-440 Package B (docs/plans/AI_DRAFTED_RULES_SCOPE.md sections 3 to 5 and 7, docs/ASSUMPTIONS.md section 72). The three approver-only routes of the rule
// drafting screens: create a draft from pasted text, act on a draft (approve, withdraw or edit), and read the text out of an uploaded PDF.
// Each route runs its checks in one fixed order: method, origin, session, role, ids (and that the fund or draft is in the actor's organization), content type,
// bounded body, exact fields. Another organization's fund or draft looks the same as no fund or draft. A handler never answers with an error, a stack, a library
// message, a database message or a model answer: every redirect carries a code from src/server/rules-notices.ts and every refusal body is a fixed sentence.
// Nothing here is logged. These routes import no PayPal, ledger write, payout or claim approval module: the only writer they reach is the Package A service in
// src/rules-draft/drafts.ts, which stores a draft, records an approver's approval, and binds only on the second distinct approver.
import { and, eq } from "drizzle-orm";
import { funds, users } from "../../db/schema";
import { DRAFT_INPUT_MAX_CHARS, DRAFT_REFUSALS, type DraftRefusal } from "../rules-draft/draft-validate";
import { approveDraft, createDraft, editDraft, readDraft, withdrawDraft, type DraftServiceDeps } from "../rules-draft/drafts";
import { findSession, isSameOrigin, sessionToken } from "./auth";
import type { AppDatabase } from "./db";
import { PDF_MAX_BYTES, PDF_MAX_PAGES, extractPdfText, type PdfRefusal } from "./pdf-text";
import { keepOrder, parseEditForm, type EditFormError } from "./rules-input";
import { actionRefusalCode, createRefusalCode, createUnavailableCode, noticeQuery, type RulesNoticeCode } from "./rules-notices";

export type RulesRouteDeps = { db: AppDatabase; draft?: DraftServiceDeps };

// 20,000 code points is at most 80,000 bytes, which percent encoding can make 240,000 bytes. 256 KiB holds that and the field name.
export const CREATE_BODY_LIMIT = 256 * 1024;
// The edit form is a summary of at most 300 code points, a few dates, eleven numbers and the checkboxes.
export const ACTION_BODY_LIMIT = 16 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const FORM_TYPE = "application/x-www-form-urlencoded";
// The media type alone, lower case, with any parameter (a charset) dropped. Compared whole, so "application/x-www-form-urlencoded-x" is not a form.
const mediaType = (request: Request): string => (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
const HEADERS = { "Cache-Control": "no-store" };

type Body = { ok: true; bytes: Uint8Array } | { ok: false; status: 400 | 413 };
// Reads at most `limit` bytes. A declared length over the limit is refused before the body is read, and a body that outgrows the limit while streaming is
// cancelled at once, so an oversize upload is never buffered whole.
async function readBounded(request: Request, limit: number): Promise<Body> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^[0-9]{1,12}$/.test(declared)) { await request.body?.cancel().catch(() => undefined); return { ok: false, status: 400 }; }
    if (Number(declared) > limit) { await request.body?.cancel().catch(() => undefined); return { ok: false, status: 413 }; }
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400 };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel().catch(() => undefined); return { ok: false, status: 413 }; }
    chunks.push(value);
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

const text = (status: number, body: string, extra: Record<string, string> = {}) => new Response(body, { status, headers: { ...HEADERS, ...extra } });
const redirectTo = (path: string, code: RulesNoticeCode | null, extra: { v?: number; back?: number; why?: string } = {}) =>
  new Response(null, { status: 303, headers: { Location: `${path}${noticeQuery(code, extra)}`, ...HEADERS } });

type Prelude = { ok: true; userId: string } | { ok: false; response: Response };
// Method, origin, session and role, in that order, for a handler whose refusals are plain text. fail() lets the PDF route answer in JSON instead.
async function prelude(request: Request, deps: RulesRouteDeps, fail: (status: number, message: string, extra?: Record<string, string>) => Response): Promise<Prelude> {
  if (request.method !== "POST") return { ok: false, response: fail(405, "Method not allowed", { Allow: "POST" }) };
  if (!isSameOrigin(request)) return { ok: false, response: fail(403, "Request origin rejected") };
  const user = await findSession(sessionToken(request), deps.db);
  if (!user) return { ok: false, response: fail(401, "Sign in first") };
  if (user.role !== "APPROVER") return { ok: false, response: fail(403, "Approver access required") };
  return { ok: true, userId: user.id };
}

// The fund, only when it belongs to the actor's organization. Another organization's fund id reads as not found.
async function fundOf(db: AppDatabase, userId: string, fundId: string): Promise<{ fundClass: "RESTRICTED" | "UNRESTRICTED" } | null> {
  const [row] = await db.select({ fundClass: funds.fundClass }).from(funds).innerJoin(users, eq(users.organizationId, funds.organizationId)).where(and(eq(funds.id, fundId), eq(users.id, userId)));
  return row ?? null;
}

// A browser sends a newline in a textarea as CR LF. The grant text is stored and quoted with plain newlines, so a quote that spans lines still matches.
export const normalizeNewlines = (value: string): string => value.replace(/\r\n?/g, "\n");

function decodeForm(bytes: Uint8Array): URLSearchParams | null {
  try { return new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return null; }
}
const exactly = (form: URLSearchParams, keys: readonly string[]) => keys.every(key => form.getAll(key).length === 1) && [...form.keys()].every(key => keys.includes(key));

// POST /api/funds/[fundId]/rules/drafts: field "text" only. One hosted AI request at most. A stored draft (or a stored refusal) goes to the review screen,
// anything else goes back to the fund rules page with one plain sentence that says whether anything was sent.
export async function handleCreateDraft(request: Request, fundId: string, deps: RulesRouteDeps): Promise<Response> {
  try {
    const checked = await prelude(request, deps, text);
    if (!checked.ok) return checked.response;
    if (!ID.test(fundId)) return text(404, "Fund not found");
    const fund = await fundOf(deps.db, checked.userId, fundId);
    if (!fund) return text(404, "Fund not found");
    const rulesPath = `/funds/${fundId}/rules`;
    if (mediaType(request) !== FORM_TYPE) return text(415, "Form submission required");
    const body = await readBounded(request, CREATE_BODY_LIMIT);
    if (!body.ok) return text(body.status, body.status === 413 ? "Form too large" : "Missing form");
    const form = decodeForm(body.bytes);
    if (!form || !exactly(form, ["text"])) return text(400, "Invalid draft fields");
    try {
      const result = await createDraft(deps.db, { id: checked.userId }, fundId, normalizeNewlines(form.get("text")!), deps.draft);
      switch (result.status) {
        case "DRAFTED":
        case "DRAFT_REFUSED": return new Response(null, { status: 303, headers: { Location: `${rulesPath}/drafts/${result.draftId}`, ...HEADERS } });
        case "UNAVAILABLE": return redirectTo(rulesPath, createUnavailableCode(result.reason));
        case "REFUSED":
          if (result.reason === "NOT_FOUND") return text(404, "Fund not found");
          if (result.reason === "APPROVER_REQUIRED") return text(403, "Approver access required");
          return redirectTo(rulesPath, createRefusalCode(result.reason));
      }
    } catch { return redirectTo(rulesPath, "draft-failed"); }
  } catch { return text(500, "That request could not be completed"); }
}

const ACTIONS = ["approve", "withdraw", "edit"] as const;
const EDIT_ERROR_CODES: Record<Exclude<EditFormError, "FIELDS">, RulesNoticeCode> = { MONEY: "edit-money", DAYS: "edit-days", DATE: "edit-date", SUMMARY: "edit-summary" };
const isRefusal = (value: string): value is DraftRefusal => (DRAFT_REFUSALS as readonly string[]).includes(value);

// POST /api/funds/[fundId]/rules/drafts/[draftId]: field "action" (approve, withdraw or edit), and for edit the edit fields. Approving twice as the same person is
// refused with its own sentence. Only a second, different approver binds, and the redirect then says which version is live and how many frozen receipts went back
// to draft. An edit is a new draft row with its own two approvals.
export async function handleDraftAction(request: Request, fundId: string, draftId: string, deps: RulesRouteDeps): Promise<Response> {
  try {
    const checked = await prelude(request, deps, text);
    if (!checked.ok) return checked.response;
    if (!ID.test(fundId) || !ID.test(draftId)) return text(404, "Draft not found");
    if (!(await fundOf(deps.db, checked.userId, fundId))) return text(404, "Draft not found");
    const actor = { id: checked.userId };
    // The draft must belong to the fund named in the path and to the actor's organization. Package A answers not found for another organization's draft.
    const read = await readDraft(deps.db, actor, draftId);
    if (read.status !== "OK") return read.reason === "APPROVER_REQUIRED" ? text(403, "Approver access required") : text(404, "Draft not found");
    if (read.view.fundId !== fundId) return text(404, "Draft not found");
    const rulesPath = `/funds/${fundId}/rules`, reviewPath = `${rulesPath}/drafts/${draftId}`;
    if (mediaType(request) !== FORM_TYPE) return text(415, "Form submission required");
    const body = await readBounded(request, ACTION_BODY_LIMIT);
    if (!body.ok) return text(body.status, body.status === 413 ? "Form too large" : "Missing form");
    const form = decodeForm(body.bytes);
    if (!form || form.getAll("action").length !== 1) return text(400, "Invalid draft fields");
    const action = form.get("action")!;
    if (!(ACTIONS as readonly string[]).includes(action)) return text(400, "Invalid draft fields");

    if (action === "edit") {
      const parsed = parseEditForm(form);
      if (!parsed.ok) return parsed.error === "FIELDS" ? text(400, "Invalid draft fields") : redirectTo(reviewPath, EDIT_ERROR_CODES[parsed.error]);
      const drafted = read.view.draft;
      const edit = { ...parsed.edit, programs: keepOrder(parsed.edit.programs, drafted?.programs.value ?? null), allowedCategories: keepOrder(parsed.edit.allowedCategories, drafted?.allowedCategories.value ?? null) };
      try {
        const result = await editDraft(deps.db, actor, draftId, edit);
        if (result.status === "EDITED") return new Response(null, { status: 303, headers: { Location: `${rulesPath}/drafts/${result.draftId}${noticeQuery("edited")}`, ...HEADERS } });
        if (result.status === "INVALID_EDIT") return result.reason === "NO_CHANGE" ? redirectTo(reviewPath, "edit-nochange") : redirectTo(reviewPath, "edit-invalid", { why: isRefusal(result.reason) ? result.reason : undefined });
        return refusedAction(result.reason, reviewPath);
      } catch { return redirectTo(reviewPath, "act-failed"); }
    }

    // Approve and withdraw carry no other field.
    if (!exactly(form, ["action"])) return text(400, "Invalid draft fields");
    try {
      if (action === "withdraw") {
        const result = await withdrawDraft(deps.db, actor, draftId);
        return result.status === "WITHDRAWN" ? redirectTo(rulesPath, "withdrawn") : refusedAction(result.reason, reviewPath);
      }
      const result = await approveDraft(deps.db, actor, draftId);
      // The first approval carries no notice code. The review page's own second-approver notice already says it once, and it stays on every later visit.
      if (result.status === "APPROVED") return redirectTo(reviewPath, null);
      if (result.status === "BOUND") return redirectTo(rulesPath, "bound", { v: result.policyVersion, ...(result.priorityVersion === null ? {} : { back: result.invalidatedDecisions }) });
      return refusedAction(result.reason, reviewPath);
    } catch { return redirectTo(reviewPath, "act-failed"); }
  } catch { return text(500, "That request could not be completed"); }
}

function refusedAction(reason: Parameters<typeof actionRefusalCode>[0], reviewPath: string): Response {
  if (reason === "NOT_FOUND" || reason === "INVALID_REQUEST") return text(404, "Draft not found");
  if (reason === "APPROVER_REQUIRED") return text(403, "Approver access required");
  return redirectTo(reviewPath, actionRefusalCode(reason));
}

// ---- PDF text ----
const PDF_MESSAGES: Record<PdfRefusal | "TOO_LARGE" | "FAILED", string> = {
  NOT_PDF: "That file is not a PDF. Paste the grant text instead.",
  ENCRYPTED: "That PDF is password protected. Paste the grant text instead.",
  MALFORMED: "That PDF could not be read. Paste the grant text instead.",
  TOO_MANY_PAGES: `That PDF has more than ${PDF_MAX_PAGES} pages. Paste the part of the grant that sets the rules instead.`,
  NO_TEXT: "That PDF has no text to read, like a scan of paper. Paste the text instead.",
  TOO_LONG: `The text in that PDF is longer than ${DRAFT_INPUT_MAX_CHARS.toLocaleString("en-US")} characters. Paste the part of the grant that sets the rules instead.`,
  TOO_SLOW: "Reading that PDF took too long. Paste the text instead.",
  BUSY: "Another PDF is being read. Try again in a moment.",
  TOO_LARGE: `That file is over ${PDF_MAX_BYTES / (1024 * 1024)} MB. Paste the text instead.`,
  FAILED: "That PDF could not be read. Paste the grant text instead.",
};
const PDF_STATUS: Record<PdfRefusal, number> = { NOT_PDF: 422, ENCRYPTED: 422, MALFORMED: 422, TOO_MANY_PAGES: 422, NO_TEXT: 422, TOO_LONG: 422, TOO_SLOW: 422, BUSY: 429 };

const json = (status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", ...HEADERS, ...extra } });
const jsonFail = (status: number, message: string, extra: Record<string, string> = {}) => json(status, { ok: false, code: "REFUSED", message }, extra);

// POST /api/funds/[fundId]/rules/pdf-text: the raw bytes of one PDF with Content-Type application/pdf. It answers with the text for the approver to read and
// edit. Nothing is stored and nothing is sent to the model here: the text goes to the model only when the approver presses Draft rules.
export async function handlePdfText(request: Request, fundId: string, deps: RulesRouteDeps): Promise<Response> {
  try {
    const checked = await prelude(request, deps, jsonFail);
    if (!checked.ok) return checked.response;
    if (!ID.test(fundId)) return jsonFail(404, "Fund not found");
    const fund = await fundOf(deps.db, checked.userId, fundId);
    if (!fund) return jsonFail(404, "Fund not found");
    if (fund.fundClass !== "RESTRICTED") return jsonFail(409, "Only a restricted fund takes AI-drafted rules");
    const type = mediaType(request);
    if (type !== "application/pdf") return jsonFail(415, "A PDF file is required");
    const body = await readBounded(request, PDF_MAX_BYTES);
    if (!body.ok) return body.status === 413 ? json(413, { ok: false, code: "TOO_LARGE", message: PDF_MESSAGES.TOO_LARGE }) : jsonFail(400, "Missing file");
    const result = await extractPdfText(body.bytes, { maxCodePoints: DRAFT_INPUT_MAX_CHARS });
    if (result.ok) return json(200, { ok: true, text: result.text, pages: result.pages });
    return json(PDF_STATUS[result.code], { ok: false, code: result.code, message: PDF_MESSAGES[result.code] });
  } catch { return json(500, { ok: false, code: "FAILED", message: PDF_MESSAGES.FAILED }); }
}
