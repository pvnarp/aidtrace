import { payoutNoteStatus, type PayoutAttemptView, type PayoutNoteStatus } from "../donation/note";
import { TRACE_APPROVALS_AUTOPILOT } from "../fund-modes/review-copy";

// IAC-373 app shell. Pure wording and state mapping, no JSX, no I/O. Presentation only: every function here
// reads facts a page already loaded from the server and returns text. None of it grants authority or changes
// a claim. A fact the page did not load maps to a neutral "see the claim", never to a guess.

export type Stage = 1 | 2 | 3 | 4 | 5;
export const STAGES = ["Receipt", "AI review", "Funding", "Approvals", "PayPal"] as const;
export const STATUS_LABELS: Record<string, string> = { DRAFT: "Draft", AWAITING_APPROVAL: "Awaiting approval", APPROVED: "Approved", PAYOUT_PROCESSING: "Payout processing", PAID: "Paid", REJECTED: "Rejected", PAYOUT_ISSUE: "Payout issue" };

/**
 * Maps saved state to a rail position: an unconfirmed receipt is AI review, a confirmed DRAFT is Funding,
 * AWAITING_APPROVAL and REJECTED are Approvals, everything later is PayPal.
 */
export function claimStage(status: string, confirmed: boolean): Stage {
  return !confirmed ? 2 : status === "DRAFT" ? 3 : status === "AWAITING_APPROVAL" || status === "REJECTED" ? 4 : 5;
}

/** The "Current step" note. Wording only; it never reports a state the page did not load. */
export function currentNote(status: string | null): string {
  return status === "APPROVED" ? "Approved does not mean paid"
    : status === "PAYOUT_PROCESSING" ? "Submitted, not yet verified as paid"
    : status === "PAID" ? "Paid, verified by an independently fetched PayPal item"
    : status === "PAYOUT_ISSUE" ? "Payment issue: do not send again until resolved"
    : status === "REJECTED" ? "Rejected: nothing is paid"
    : "No payment has been submitted";
}

/** Approvals are only known on pages that loaded them. A claim at Approved or later has both. */
export function knownReviews(status: string): number | null {
  return status === "DRAFT" ? 0 : ["APPROVED", "PAYOUT_PROCESSING", "PAID", "PAYOUT_ISSUE"].includes(status) ? 2 : null;
}

/** Display name for the summary. The claimant's own name is loaded for them; otherwise only the id is loaded. */
export function claimantLabel(user: { id: string; displayName: string }, claimantId: string): string {
  return user.id === claimantId ? user.displayName : claimantId.charAt(0).toUpperCase() + claimantId.slice(1);
}

// ---- Header tag and footer: true to the configured receipt model ----
export type AiConfig = { name: string; shellName: string } | null;
/**
 * The receipt AI is hosted AI, or not configured (no key, request limit reached, or switched off).
 * The header tag and footer line follow what the server reads, so they never claim AI that is not running. configured is
 * null when AI is not available. IAC-416: the shell then says nothing about AI (an empty tag renders no tag element) and the
 * footer names only PayPal Payouts. The true reason still shows on the receipt and proposal panels, where AI would act.
 * IAC-416 PR 2: the shell names no model or vendor, only "AI". The model and its
 * provider are named once, in the disclosure lines where receipt or clause text leaves the app.
 */
export function shellWording(configured: AiConfig): { tag: string; line: string } {
  if (configured) return { tag: "AI + PayPal", line: "Built with PayPal Payouts and AI" };
  return { tag: "", line: "Built with PayPal Payouts." };
}
/**
 * IAC-416 PR 2: a model's display name for a screen that does not disclose the provider. A name of the form "Vendor Family 5.5" (the
 * stored display names, CLAUDE_NAMES) shows as "AI (Family 5.5)". Any other name, for example the retired-model label, passes through
 * unchanged. It formats the string it is given and names no vendor itself.
 */
const VENDOR_MODEL_NAME = /^\S+ (\S+ \d+\.\d+)$/;
export function aiModelLabel(name: string): string {
  const parts = VENDOR_MODEL_NAME.exec(name);
  return parts ? `AI (${parts[1]})` : name;
}
/** The name before "suggests:" on a per-line suggestion. A vendor-named model reads "AI"; the retired label ("Earlier AI") passes through. */
export function aiSuggesterName(short: string): string { return VENDOR_MODEL_NAME.test(short) ? "AI" : short; }
export const FOOTER_PROMISE = "AI suggests. Rules and people decide. PayPal pays.";

/** Splits text around the word PayPal so the component can color exactly that word. */
export function paypalParts(text: string): { text: string; paypal: boolean }[] {
  return text.split(/(PayPal)/).filter(part => part !== "").map(part => ({ text: part, paypal: part === "PayPal" }));
}

// ---- AI status card ----
export type SuggestionKind = "NONE" | "RUNNING" | "READY" | "UNUSABLE";
/** The latest saved suggestion as the receipt page already reads it. Stale RUNNING and ungrounded READY rows are not usable. */
export function suggestionKind(status: string | undefined, running: boolean, grounded: boolean): SuggestionKind {
  return status === undefined ? "NONE" : status === "RUNNING" ? running ? "RUNNING" : "UNUSABLE" : status === "READY" ? grounded ? "READY" : "UNUSABLE" : "UNUSABLE";
}
export type AiInput = {
  /** False for a preclassified fixture claim that never had a receipt review. */
  applicable: boolean; suggestion: SuggestionKind; confirmed: boolean;
  /** True when a confirmed review accepted at least one AI suggestion (provenance AI_ACCEPTED). Read only after confirmation. */
  aiAccepted: boolean;
  /** The saved suggestion's own audited model name, when one is READY. */
  savedModel: string | null; configured: AiConfig;
};
export type AiKey = "not-applicable" | "not-run" | "running" | "suggested" | "confirmed" | "person-chose" | "unusable";
export type AiCard = { key: AiKey; state: string; rail: string; model: string | null; note: string };
export const AI_NOTE = "No financial tools. It cannot approve, choose funds or pay.";

export function aiCard(input: AiInput): AiCard {
  // November 5: a stored display name of the form "Vendor Family 5.5" (from CLAUDE_NAMES) reads "Powered by <name>." This file cannot import src/ai (GT-30 closure), so it checks the shape only. Any other name, for example the retired-model label, keeps the plain "Model:" line.
  const modelLine = (name: string) => VENDOR_MODEL_NAME.test(name) ? `Powered by ${name}.` : `Model: ${aiModelLabel(name)}`;
  const configured = input.configured ? modelLine(input.configured.name) : null;
  const saved = input.savedModel ? modelLine(input.savedModel) : null;
  if (!input.applicable) return { key: "not-applicable", state: "Not used. Preclassified example", rail: "Not used", model: null, note: AI_NOTE };
  if (input.confirmed) {
    if (input.aiAccepted) return { key: "confirmed", state: "Suggestion confirmed by a person", rail: "Confirmed by a person", model: saved, note: AI_NOTE };
    return { key: "person-chose", state: "Categories chosen by a person", rail: "Person chose", model: null, note: AI_NOTE };
  }
  switch (input.suggestion) {
    case "READY": return { key: "suggested", state: "Suggestion awaiting confirmation", rail: "Suggested, awaiting you", model: saved, note: AI_NOTE };
    case "RUNNING": return { key: "running", state: "Reading the typed receipt text", rail: "Reading receipt text", model: configured, note: AI_NOTE };
    case "UNUSABLE": return { key: "unusable", state: "No usable suggestion. A person chooses each category", rail: "No usable suggestion", model: configured, note: AI_NOTE };
    default: return input.configured ? { key: "not-run", state: "Not run yet", rail: "Not run yet", model: configured, note: AI_NOTE }
      : { key: "not-run", state: "A person chooses each category", rail: "Person chooses", model: null, note: AI_NOTE };
  }
}

// ---- PayPal status card ----
export const PAYOUT_LABELS: Record<PayoutNoteStatus, string> = {
  NO_PAYMENT: "No payment sent in this environment", PROCESSING: "PayPal payout processing", UNKNOWN: "PayPal payout outcome being verified", NEEDS_ATTENTION: "Payout needs attention", PAID: "Paid, verified by PayPal",
};
export const PAYPAL_NOTE = "Approved does not mean paid.";
export const PAYPAL_PAID_NOTE = "Paid appears only after PayPal's own item reports success.";
// IAC-405 takeover wording (ASSUMPTIONS section 82): shown while an auto-recognized claim whose automatic send did not go out has fewer than two takeover approvals.
export const PAYPAL_TAKEOVER_WAITING = "Not ready: two approvers must take over";
export type PayPalInput = {
  /** Null on the new-receipt page, where no claim exists yet. */
  claimStatus: string | null;
  /** Approvals the page loaded, or null when it did not load them. */
  approvals: number | null;
  /** Payment facts, or null when the page did not load them. attempt null means no attempt row exists. */
  payout: { attempt: PayoutAttemptView | null; keyless: boolean } | null;
  amount?: string;
  /** True only when the claim page read an auto-recognized claim waiting for two takeover approvals (stored records). Absent or false changes nothing. */
  takeoverWaiting?: boolean;
};
export type PayPalKey = "not-ready" | "rejected" | "ready-keyless" | "ready" | "processing" | "verifying" | "needs-attention" | "paid" | "see-claim";
export type PayPalCard = { key: PayPalKey; state: string; rail: string; note: string; batchId: string | null };

export function paypalCard(input: PayPalInput): PayPalCard {
  const status = input.claimStatus;
  if (status === null || status === "DRAFT" || status === "AWAITING_APPROVAL") {
    const n = input.approvals ?? (status === null || status === "DRAFT" ? 0 : null);
    return n === null ? { key: "see-claim", state: "See the claim for approvals and payment status", rail: "See the claim", note: PAYPAL_NOTE, batchId: null }
      // Say it once (IAC-415 PR 4, PR 6): a claim page states its approval count in the title and the approvals section, and before a claim is frozen no approval count
      // exists, so every not-ready card (no claim yet, DRAFT, AWAITING_APPROVAL) reads the same words and carries no digit.
      : { key: "not-ready", state: "Not ready: needs two approvals", rail: "Not ready", note: PAYPAL_NOTE, batchId: null };
  }
  if (status === "REJECTED") return { key: "rejected", state: "Rejected. Nothing will be sent", rail: "Rejected", note: PAYPAL_NOTE, batchId: null };
  if (!input.payout) return { key: "see-claim", state: "See the claim for payment status", rail: "See the claim", note: PAYPAL_NOTE, batchId: null };
  const { attempt, keyless } = input.payout;
  if (!attempt && status === "APPROVED" && input.takeoverWaiting === true) return { key: "not-ready", state: PAYPAL_TAKEOVER_WAITING, rail: "Not ready", note: PAYPAL_NOTE, batchId: null };
  if (!attempt && status === "APPROVED") {
    return keyless ? { key: "ready-keyless", state: `Ready${input.amount ? `: ${input.amount}` : ""}. Unpaid in this keyless session, no request is made`, rail: "Ready, unpaid", note: PAYPAL_NOTE, batchId: null }
      : { key: "ready", state: `Approved${input.amount ? `: ${input.amount}` : ""}. No payment has been sent yet`, rail: "Ready, not sent", note: PAYPAL_NOTE, batchId: null };
  }
  // The cautious reading of payoutNoteStatus wins: "Paid" needs a SETTLED attempt with an item SUCCESS and a usable batch ID,
  // and the claim itself must read PAID. Anything else with a payout in play reads as processing, verifying or needing attention.
  const note = payoutNoteStatus(attempt, status);
  const paid = note.status === "PAID" && status === "PAID" && note.batchId !== null;
  const mapped: PayoutNoteStatus = note.status === "PAID" && !paid ? "UNKNOWN" : note.status;
  switch (mapped) {
    case "PAID": return { key: "paid", state: `${PAYOUT_LABELS.PAID}. Batch ${note.batchId}`, rail: "Paid, verified", note: PAYPAL_PAID_NOTE, batchId: note.batchId };
    case "PROCESSING": return { key: "processing", state: `${PAYOUT_LABELS.PROCESSING}. Not yet verified as paid`, rail: "Processing", note: PAYPAL_NOTE, batchId: null };
    case "NEEDS_ATTENTION": return { key: "needs-attention", state: PAYOUT_LABELS.NEEDS_ATTENTION, rail: "Needs attention", note: PAYPAL_NOTE, batchId: null };
    default: return { key: "verifying", state: PAYOUT_LABELS.UNKNOWN, rail: "Verifying outcome", note: PAYPAL_NOTE, batchId: null };
  }
}

// ---- Rail lines ----
// IAC-384: the Receipt step when the current revision of the receipt links a photo read. Every other page keeps its old words.
export const RAIL_RECEIPT_PHOTO = "Read from a photo";
// IAC-384 (RS): the new receipt page when the photo reader is on, before any receipt exists. A saved photo link (photoReceipt) wins over this hint.
export const RAIL_RECEIPT_PHOTO_OR_TYPED = "Photo or typed text";
export type RailLine = { name: (typeof STAGES)[number]; tag?: "AI" | "PayPal"; state: string };
export function railLines(input: { stage: Stage; typedReceipt: boolean; photoReceipt?: boolean; photoIntake?: boolean; ai: AiCard; approvals: number | null; paypal: PayPalCard; required?: 1 | "auto" }): RailLine[] {
  // IAC-405 PR A (docs/ASSUMPTIONS.md section 77 item 13): required is 1 only for a decision that needs one approval (no holds found), read by the server from the stored decision. Absent, every line is as it always was.
  const one = input.required === 1;
  const lines: RailLine[] = [
    { name: "Receipt", state: input.photoReceipt ? RAIL_RECEIPT_PHOTO : input.photoIntake ? RAIL_RECEIPT_PHOTO_OR_TYPED : input.typedReceipt ? "Typed text and amounts" : "Preclassified example" },
    { name: "AI review", tag: "AI", state: input.ai.rail },
    { name: "Funding", state: "Rules, not AI" },
    // Say it once (IAC-415 PR 4, PR 5): while a claim awaits approval (stage 4) the count lives in the title and the approvals section, and before the freeze (stages 1 to 3)
    // no approval can exist, so a count says nothing: the locked line reads "Locked. Two approvers" (short enough to stay on one rail line at 1440) and stage 4 reads
    // "Two different people", both while the PayPal card is "not-ready". A REJECTED claim (card "rejected") and stage 5 keep the count.
    { name: "Approvals", state: input.required === "auto" ? TRACE_APPROVALS_AUTOPILOT : input.approvals === null ? "People: see the claim" : input.stage <= 4 && input.paypal.key === "not-ready" ? input.stage === 4 ? (one ? "One person" : "Two different people") : (one ? "One approver" : "Two approvers") : `People: ${input.approvals} of ${one ? 1 : 2}` },
    { name: "PayPal", tag: "PayPal", state: input.paypal.rail },
  ];
  return lines.map((line, index) => index + 1 > input.stage ? { ...line, state: `Locked. ${line.state}` } : line);
}
