import { payoutNoteStatus, type PayoutAttemptView, type PayoutNoteStatus } from "../donation/note";

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
export type AiOff = "NO_KEY" | "LIMIT" | "SWITCHED_OFF";
/**
 * The receipt AI is Claude through the Claude API, or off (no key, request limit reached, or switched off). The header tag and
 * footer line follow what the server reads, so they never claim AI that is not running. configured is null when AI is off;
 * off then says why (no key is the usual reason, and the default).
 */
export function shellWording(configured: AiConfig, off: AiOff = "NO_KEY"): { tag: string; line: string } {
  if (configured) return { tag: "Claude AI + PayPal sandbox", line: `Built with PayPal Payouts (sandbox) and ${configured.shellName}` };
  const line = off === "NO_KEY" ? "Built with PayPal Payouts (sandbox). AI suggestions are off: no Claude key is configured."
    : off === "LIMIT" ? "Built with PayPal Payouts (sandbox). AI suggestions are off: the Claude request limit for this process was reached."
    : "Built with PayPal Payouts (sandbox). AI suggestions are switched off in this session.";
  return { tag: "PayPal sandbox, AI off", line };
}
export const FOOTER_PROMISE = "AI suggests. People decide. PayPal pays.";

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
  const configured = input.configured ? `Configured model: ${input.configured.name} (Claude API)` : null;
  const saved = input.savedModel ? `Model: ${input.savedModel}` : null;
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
      : { key: "not-run", state: "AI is off in this session. A person chooses each category", rail: "AI off", model: null, note: AI_NOTE };
  }
}

// ---- PayPal status card ----
export const PAYOUT_LABELS: Record<PayoutNoteStatus, string> = {
  NO_PAYMENT: "No payment sent in this environment", PROCESSING: "PayPal payout processing", UNKNOWN: "PayPal payout outcome being verified", NEEDS_ATTENTION: "Payout needs attention", PAID: "Paid, verified by PayPal",
};
export const PAYPAL_NOTE = "Approved does not mean paid.";
export const PAYPAL_PAID_NOTE = "Paid appears only after PayPal's own item reports success.";
export type PayPalInput = {
  /** Null on the new-receipt page, where no claim exists yet. */
  claimStatus: string | null;
  /** Approvals the page loaded, or null when it did not load them. */
  approvals: number | null;
  /** Payment facts, or null when the page did not load them. attempt null means no attempt row exists. */
  payout: { attempt: PayoutAttemptView | null; keyless: boolean } | null;
  amount?: string;
};
export type PayPalKey = "not-ready" | "rejected" | "ready-keyless" | "ready" | "processing" | "verifying" | "needs-attention" | "paid" | "see-claim";
export type PayPalCard = { key: PayPalKey; state: string; rail: string; note: string; batchId: string | null };

export function paypalCard(input: PayPalInput): PayPalCard {
  const status = input.claimStatus;
  if (status === null || status === "DRAFT" || status === "AWAITING_APPROVAL") {
    const n = input.approvals ?? (status === null || status === "DRAFT" ? 0 : null);
    return n === null ? { key: "see-claim", state: "See the claim for approvals and payment status", rail: "See the claim", note: PAYPAL_NOTE, batchId: null }
      : { key: "not-ready", state: `Not ready: ${n} of 2 approvals`, rail: "Not ready", note: PAYPAL_NOTE, batchId: null };
  }
  if (status === "REJECTED") return { key: "rejected", state: "Rejected. Nothing will be sent", rail: "Rejected", note: PAYPAL_NOTE, batchId: null };
  if (!input.payout) return { key: "see-claim", state: "See the claim for payment status", rail: "See the claim", note: PAYPAL_NOTE, batchId: null };
  const { attempt, keyless } = input.payout;
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
export type RailLine = { name: (typeof STAGES)[number]; tag?: "AI" | "PayPal"; state: string };
export function railLines(input: { stage: Stage; typedReceipt: boolean; ai: AiCard; approvals: number | null; paypal: PayPalCard }): RailLine[] {
  const lines: RailLine[] = [
    { name: "Receipt", state: input.typedReceipt ? "Typed text and amounts" : "Preclassified example" },
    { name: "AI review", tag: "AI", state: input.ai.rail },
    { name: "Funding", state: "Rules, not AI" },
    { name: "Approvals", state: input.approvals === null ? "People: see the claim" : `People: ${input.approvals} of 2` },
    { name: "PayPal", tag: "PayPal", state: input.paypal.rail },
  ];
  return lines.map((line, index) => index + 1 > input.stage ? { ...line, state: `Locked. ${line.state}` } : line);
}
