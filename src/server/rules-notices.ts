// IAC-440 Package B (docs/ASSUMPTIONS.md section 72). The plain sentences the rule drafting screens show after an action.
// Only fixed application text crosses the HTTP boundary. A redirect carries a short code from the tables below (and at most two small integers and one
// refusal name), never an error, a database message, a model answer or the grant text. A page that reads a code it does not know shows nothing.
import { DRAFT_REFUSALS, type DraftRefusal } from "../rules-draft/draft-validate";
import type { DraftServiceRefusal } from "../rules-draft/drafts";
import type { AiOffReason } from "../ai/provider";

export type NoticeTone = "info" | "warning";
export type RulesNotice = { text: string; tone: NoticeTone };

const NOTICES = {
  // Creating a draft. Each says whether anything was sent.
  "draft-off": { tone: "warning", text: "AI drafting is off on this instance. Nothing was sent." },
  "draft-no-key": { tone: "warning", text: "AI drafting has no key set on this instance. Nothing was sent." },
  "draft-limit": { tone: "warning", text: "The AI request limit is used up for now. Nothing was sent. Try again later." },
  "draft-timeout": { tone: "warning", text: "The AI request did not finish. Nothing was stored. Try again." },
  "draft-error": { tone: "warning", text: "The AI request failed. Nothing was stored. Try again." },
  "draft-failed": { tone: "warning", text: "The draft could not be made. Nothing was stored. Try again." },
  "draft-invalid-text": { tone: "warning", text: "Paste between 1 and 20,000 characters of the grant, with some visible text. Nothing was sent." },
  "draft-malformed-text": { tone: "warning", text: "The text has a character that cannot be stored, such as half of an emoji. Copy it again. Nothing was sent." },
  "draft-not-restricted": { tone: "warning", text: "Only a restricted fund takes AI-drafted rules. Nothing was sent." },
  "draft-stale": { tone: "warning", text: "The fund's rules changed while the AI was working. Nothing was stored. Start again from the current rules." },
  "draft-guard": { tone: "warning", text: "The database refused that draft. Nothing was stored." },
  // Acting on a draft.
  "withdrawn": { tone: "info", text: "The draft is withdrawn. It takes no more approvals." },
  "edited": { tone: "info", text: "Your change is saved as a new draft. It needs its own two approvals." },
  "edit-nochange": { tone: "warning", text: "Nothing was changed, so no new draft was made." },
  "edit-fields": { tone: "warning", text: "That form was incomplete or changed. Nothing was saved. Reload the page and try again." },
  "edit-money": { tone: "warning", text: "A dollar amount must be above zero with at most two decimals, like 300 or 300.50. Nothing was saved." },
  "edit-days": { tone: "warning", text: "A number of days must be a whole number from 1 to 3650. Nothing was saved." },
  "edit-date": { tone: "warning", text: "A date must be a real day, like 2026-09-01. Nothing was saved." },
  "edit-summary": { tone: "warning", text: "The summary cannot be empty. Nothing was saved." },
  "edit-invalid": { tone: "warning", text: "That edit breaks a rule, so nothing was saved." },
  "act-same-approver": { tone: "warning", text: "You already approved this draft. A different approver must give the second approval." },
  "act-incomplete": { tone: "warning", text: "Some required fields are still not set. Fill them in with Save my changes before approving." },
  "act-thresholds": { tone: "warning", text: "Some limits are set in this draft but not all six, and the fund has no earlier limits to carry. Fill them in before approving." },
  "act-stale": { tone: "warning", text: "The fund moved to a newer version of its rules, so this draft can no longer be approved or edited." },
  "act-withdrawn": { tone: "warning", text: "This draft was withdrawn, so it takes no more approvals." },
  "act-bound": { tone: "warning", text: "This draft is already approved and in use." },
  "act-not-drafted": { tone: "warning", text: "The AI did not produce a draft from that text, so there is nothing to approve." },
  "act-invalid": { tone: "warning", text: "This draft no longer passes the checks, for example because a category was prohibited after it was made. Make a new draft." },
  "act-guard": { tone: "warning", text: "The database refused that change. Nothing was changed." },
  "act-failed": { tone: "warning", text: "That action could not be completed. Nothing was changed. Reload the page and try again." },
  // Changing how claims are approved (IAC-405 step 2 PR F).
  "mode-proposed": { tone: "info", text: "The change is proposed. A different approver must approve it before it takes effect." },
  "mode-approved": { tone: "info", text: "The change is approved and takes effect for claims frozen from now on. A waiting claim never becomes looser." },
  "mode-same-approver": { tone: "warning", text: "You proposed this change. A different approver must approve it." },
  "mode-stale": { tone: "warning", text: "The fund changed after this was proposed, so it can no longer be approved. Propose it again." },
  "mode-no-change": { tone: "warning", text: "The fund already works that way, so nothing was proposed." },
  "mode-done": { tone: "warning", text: "That change was already approved." },
  "mode-guard": { tone: "warning", text: "The database refused that change. Nothing was changed." },
  "mode-failed": { tone: "warning", text: "That change could not be completed. Nothing was changed. Reload the page and try again." },
  // The automation kill switch (IAC-405 step 3 PR P).
  "switch-proposed": { tone: "info", text: "Turning automation on is proposed. A different approver must confirm it before anything is recognized or sent without an approver." },
  "switch-on": { tone: "info", text: "Automation is on for the organization. Only claims that meet every guardrail are recognized and sent without an approver." },
  "switch-off": { tone: "info", text: "Automation is off. No claim is recognized or sent without an approver until two approvers turn it on again." },
  "switch-same-approver": { tone: "warning", text: "You proposed this. A different approver must confirm it." },
  "switch-stale": { tone: "warning", text: "The switch changed in the meantime, so that request no longer applies. Reload the page and look at its current state." },
  "switch-guard": { tone: "warning", text: "The database refused that change. Nothing was changed." },
  "switch-failed": { tone: "warning", text: "That change could not be completed. Nothing was changed. Reload the page and try again." },
} as const satisfies Record<string, RulesNotice>;
export type RulesNoticeCode = keyof typeof NOTICES | "bound";

// Why an edit was refused, one plain sentence per validator code. A code with no entry gets the generic sentence.
const EDIT_REASONS: Partial<Record<DraftRefusal, string>> = {
  DATE_INVALID: "A date is not a real day in the allowed years.",
  DATE_ORDER: "The period must start on or before the day it ends.",
  MONEY_INVALID: "A dollar amount is out of range.",
  DAYS_INVALID: "A number of days is out of range.",
  SUMMARY_INVALID: "The summary must be 1 to 300 characters with no line breaks.",
  PROGRAM_UNKNOWN: "A program is not one of the fund's known programs.",
  CATEGORY_UNKNOWN: "A category is not one the organization allows.",
  PROHIBITED_CATEGORY: "A category is on the organization's prohibited list.",
  PREPARE_REJECTED: "Those values do not make a rule set the claim checks accept.",
  MALFORMED_TEXT: "The text has a character that cannot be stored.",
};
const isRefusal = (value: unknown): value is DraftRefusal => typeof value === "string" && (DRAFT_REFUSALS as readonly string[]).includes(value);

export const createUnavailableCode = (reason: AiOffReason | "TIMEOUT" | "ERROR"): RulesNoticeCode =>
  reason === "SWITCHED_OFF" ? "draft-off" : reason === "NO_KEY" ? "draft-no-key" : reason === "LIMIT" ? "draft-limit" : reason === "TIMEOUT" ? "draft-timeout" : "draft-error";

// Refusals of createDraft. NOT_FOUND and APPROVER_REQUIRED never reach here: the route answers 404 and 403 for them.
export function createRefusalCode(reason: DraftServiceRefusal): RulesNoticeCode {
  switch (reason) {
    case "MALFORMED_TEXT": return "draft-malformed-text";
    case "INVALID_REQUEST": return "draft-invalid-text";
    case "FUND_NOT_RESTRICTED": return "draft-not-restricted";
    case "STALE_BASE": return "draft-stale";
    case "GUARD_REFUSED": return "draft-guard";
    default: return "draft-failed";
  }
}

// Refusals of approve, withdraw and edit.
export function actionRefusalCode(reason: DraftServiceRefusal): RulesNoticeCode {
  switch (reason) {
    case "SAME_APPROVER": return "act-same-approver";
    case "INCOMPLETE": return "act-incomplete";
    case "THRESHOLDS_INCOMPLETE": return "act-thresholds";
    case "STALE_BASE": return "act-stale";
    case "WITHDRAWN": return "act-withdrawn";
    case "BOUND": return "act-bound";
    case "NOT_DRAFTED": return "act-not-drafted";
    case "DRAFT_INVALID": return "act-invalid";
    case "GUARD_REFUSED": return "act-guard";
    default: return "act-failed";
  }
}

const SMALL_INTEGER = /^[0-9]{1,6}$/;
const smallInteger = (value: string | undefined): number | null => (value !== undefined && SMALL_INTEGER.test(value) ? Number(value) : null);

// The query string of a redirect. Every value is a table code, a small integer or a validator refusal name, so nothing else can ride a redirect.
// A null code is no notice at all: the first approval redirects to the review page with no query, because that page's state notice already says what is next.
export function noticeQuery(code: RulesNoticeCode | null, extra: { v?: number; back?: number; why?: string } = {}): string {
  if (code === null) return "";
  const params = new URLSearchParams({ notice: code });
  if (extra.v !== undefined && Number.isSafeInteger(extra.v) && extra.v >= 0 && extra.v <= 999_999) params.set("v", String(extra.v));
  if (extra.back !== undefined && Number.isSafeInteger(extra.back) && extra.back >= 0 && extra.back <= 999_999) params.set("back", String(extra.back));
  if (extra.why !== undefined && isRefusal(extra.why)) params.set("why", extra.why);
  return `?${params.toString()}`;
}

export type NoticeParams = { notice?: string | string[]; v?: string | string[]; back?: string | string[]; why?: string | string[] };
const single = (value: string | string[] | undefined): string | undefined => (typeof value === "string" ? value : undefined);

// The notice a page shows for its query string, or null when there is none or the code is not in the table.
export function rulesNotice(params: NoticeParams): RulesNotice | null {
  const code = single(params.notice);
  if (code === "bound") {
    const version = smallInteger(single(params.v)), back = smallInteger(single(params.back));
    if (version === null) return null;
    let text = `Version ${version} is now the fund's approved rules. New claims use it.`;
    if (back !== null) text += back === 0
      ? " The pay order changed, and no receipt was waiting on two approvals."
      : ` The pay order changed. ${back} ${back === 1 ? "receipt that was" : "receipts that were"} frozen but not yet approved twice went back to draft and ${back === 1 ? "needs" : "need"} both approvals again. Paid claims are untouched.`;
    return { tone: "info", text };
  }
  if (code === undefined || !Object.prototype.hasOwnProperty.call(NOTICES, code)) return null;
  const notice: RulesNotice = NOTICES[code as keyof typeof NOTICES];
  const why = single(params.why);
  if (code === "edit-invalid" && isRefusal(why) && EDIT_REASONS[why]) return { tone: notice.tone, text: `${EDIT_REASONS[why]} Nothing was saved.` };
  return notice;
}

// What the review screen says about a draft that the model answered but the validator refused. One sentence per code, and never a drafted value.
const REFUSED_REASONS: Partial<Record<string, string>> = {
  SHAPE: "The AI answer did not have the expected form.",
  STOP_REASON: "The AI stopped before it finished its answer.",
  RESPONSE_SIZE: "The AI answer was too large.",
  JSON: "The AI answer could not be read.",
  TOOL_BLOCK: "The AI answer had a part that is not allowed.",
  NO_CLAUSES: "The AI quoted no part of the grant.",
  CLAUSE_COUNT: "The AI quoted too many parts of the grant.",
  CLAUSE_NOT_SUBSTRING: "The AI quoted words that are not in the grant text.",
  QUOTE_INVALID: "A value had a missing or empty quote.",
  QUOTE_NOT_IN_CLAUSE: "A value cited a quote that is not in the clause it names.",
  CITATION_MISSING: "A value had no clause to cite.",
  PROGRAM_UNKNOWN: "The AI named a program the fund does not know.",
  CATEGORY_UNKNOWN: "The AI named a category the organization does not allow.",
  PROHIBITED_CATEGORY: "The AI named a category on the prohibited list.",
  DATE_INVALID: "The AI gave a date that is not a real day.",
  DATE_ORDER: "The AI gave a period that ends before it starts.",
  MONEY_INVALID: "The AI gave a dollar amount that is out of range.",
  DAYS_INVALID: "The AI gave a number of days that is out of range.",
  BREADTH_MISMATCH: "The AI category count did not match its category list.",
  SUMMARY_INVALID: "The AI summary was empty or too long.",
  PREPARE_REJECTED: "The drafted values do not make a rule set the claim checks accept.",
  MALFORMED_TEXT: "The AI answer had a character that cannot be stored.",
};
export const refusedDraftReason = (code: string | null | undefined): string =>
  `${(code && REFUSED_REASONS[code]) || "The AI answer broke a rule of the draft check."} No values are shown, because a refused answer is not a draft.`;
