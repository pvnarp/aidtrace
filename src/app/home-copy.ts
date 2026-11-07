import { usd } from "../analytics/model";
import { STATUS_LABELS } from "./shell-copy";
import { QUEUE_LEDE_ASSISTED } from "../fund-modes/review-copy";

// IAC-403 home screens. Pure wording and arithmetic, no JSX, no I/O. Presentation only: every function reads facts the page
// already loaded from the server (a claim status, integer cents, whether this approver already approved) and returns text.
// None of it grants authority or changes a claim. A fact the page did not load is omitted, never guessed.

export type HomeRole = "CLAIMANT" | "APPROVER";
const NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"] as const;

/** The approver home heading from the count of expenses that still need this approver's decision. */
export function approverHeading(count: number): string {
  if (count === 0) return "No expense needs your review.";
  if (count === 1) return "One expense needs your review.";
  return `${Number.isInteger(count) && count >= 0 && count <= 10 ? NUMBER_WORDS[count]! : String(count)} expenses need your review.`;
}

/** The line under the approver heading. */
export function approverLede(count: number, assistedNote = false): string {
  if (count === 0) return "Nothing is waiting for your decision. A claimant must confirm categories and freeze the funding terms before an expense appears here.";
  // IAC-405 PR A follow-up: the note is added only when the page read at least one listed claim as needing one approval (flag on, server read), so every other page is byte-identical.
  const base = "Check the items, the recipient and the funding. Two different approvers must approve the same frozen terms before anything is payable.";
  return assistedNote ? `${base} ${QUEUE_LEDE_ASSISTED}` : base;
}

export const CLAIMANT_LEDE = "Every grant has its own limits. AI helps prepare, rules calculate funding, two other people approve and PayPal remains a separate decision.";
// IAC-405: with the fund modes flag on, a fund can need one approval or none, so the flag-off sentence above would be wrong.
export const CLAIMANT_LEDE_FUND_MODES = "Every grant has its own limits. AI helps prepare, rules calculate funding, and each fund's approval setting decides who signs off before PayPal pays.";

/** Plain status label, the same labels the claim pages use. */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.toLowerCase().replaceAll("_", " ");
}

/** One-line next step for a claim card, from the claim status alone. */
export function nextStep(role: HomeRole, status: string): string {
  switch (status) {
    case "DRAFT": return role === "CLAIMANT" ? "Unpaid draft. Confirm each category, then review funding." : "Draft. The claimant has not frozen the funding terms yet.";
    case "AWAITING_APPROVAL": return role === "CLAIMANT" ? "Frozen. Two other people must approve the same terms." : "Frozen terms await two approvals.";
    case "APPROVED": return "Approved does not mean paid. Open the claim for the PayPal handoff.";
    case "PAYOUT_PROCESSING": return "Submitted, not yet verified as paid.";
    case "PAID": return "Paid. Open the claim for the verified PayPal result.";
    case "REJECTED": return "Rejected. Nothing is paid.";
    case "PAYOUT_ISSUE": return "Payment issue. Do not send again until resolved.";
    default: return "Open the claim for its current status.";
  }
}

/**
 * The frozen split of an expense, only when the page loaded a frozen decision whose edges add up exactly to the claim total
 * and whose General part lies inside it. Same validity rule as the claim page's funding summary. Null means: say nothing.
 */
export function frozenSplit(input: { total: bigint; generalCents: bigint; frozen: boolean; edges: readonly { amountCents: string | bigint }[] }): string | null {
  const { total, generalCents, frozen, edges } = input;
  if (!frozen || total <= 0n || generalCents < 0n || generalCents > total) return null;
  if (edges.reduce((sum, edge) => sum + BigInt(edge.amountCents), 0n) !== total) return null;
  return `Frozen terms: ${usd(total - generalCents)} restricted, ${usd(generalCents)} General.`;
}

/** The approver card line: the frozen split when loaded, then what the approver does next. */
export function approverReviewLine(split: string | null, approvedByMe: boolean): string {
  if (approvedByMe) return `${split ? `${split} ` : ""}You approved these terms. One more approver is needed.`;
  return `${split ? `${split} ` : ""}Review items, recipient and funding before approving.`;
}

/** The claimant primary link label. A judge session has one receipt, always Maria's. */
export function claimActionLabel(judge: boolean): string {
  return judge ? "Continue Maria's receipt" : "Open this expense";
}

/** Heading for the claimant home: the signed-in claimant's first name from the session. */
export function claimantHeading(displayName: string): string {
  const first = displayName.trim().split(/\s+/)[0] ?? "";
  return first ? `Which fund can pay ${first} back?` : "Which fund can pay you back?";
}
