// IAC-415 PR 8, "payout end states say what is true". The October 31 keyed rehearsal showed three passages on the claim page that read wrong after a send:
// an UNKNOWN attempt (the adapter failed before PayPal answered, so no batch id) was titled "Payment submitted"; its guide pointed at a Refresh status button
// that does not render without a batch id; and every attempt with no recorded balance repeated the pre-send "may reject the request for insufficient
// funds" warning, even on a PAID claim. Pure wording: it reads facts the page already loaded, grants nothing and decides no form. The Send, Refresh status
// and retry forms keep their own conditions in the page. `refreshForm` is the one boolean the page computes for the Refresh status form, passed here unchanged.
// Follow-up (same package): an ambiguous HTTP answer can keep a batch id on an UNKNOWN attempt, and then the Refresh status form does render, so the UNKNOWN detail says so;
// `note` is the one-line current-step wording for an UNKNOWN send (the page falls back to currentNote for every other state).

export type PayoutAttemptFacts = { state: string; providerBalanceCents: bigint | null | undefined };
export type PayoutWordsInput = {
  claimStatus: string;
  /** The latest disbursement attempt the page loaded, or null when none exists (a presentation fixture, or before a send). */
  attempt: PayoutAttemptFacts | null;
  canPay: boolean;
  /** True when the page renders the Refresh status form (payment configured, an independent approver and a recorded PayPal batch id). */
  refreshForm: boolean;
  usd: (cents: bigint) => string;
};
/** title, detail and note are set only while the claim is PAYOUT_PROCESSING (note only for an UNKNOWN send) and are null otherwise. balance is null when the page shows no balance line. */
export type PayoutWords = { title: string | null; detail: string | null; balance: string | null; note: string | null };

export const UNKNOWN_SEND_TITLE = "Send outcome unknown. Do not send again.";
export const SUBMITTED_TITLE = "Payment submitted. Not yet verified as paid.";
export const UNKNOWN_SEND_DETAIL = "PayPal did not confirm this send. It is neither paid nor failed. Reconcile it in PayPal; the saved sender IDs identify it.";
export const UNKNOWN_SEND_REFRESH_DETAIL = "PayPal did not confirm this send, but it returned a batch ID. It is neither paid nor failed. An approver can use Refresh status below.";
export const UNKNOWN_SEND_NOTE = "Send outcome unknown: do not send again";
export const REFRESH_DETAIL = "An approver can use Refresh status below. A batch acceptance or pending item is not proof of payment.";
export const CHECK_DETAIL = "An approver checks the result with PayPal. A batch acceptance or pending item is not proof of payment.";
export const BOOK_BALANCE_NOTE = "Book balances in this app are not proof of PayPal cash.";
export const BALANCE_UNAVAILABLE_BEFORE_SEND = "Provider balance is unavailable. PayPal may reject the request for insufficient funds.";
export const BALANCE_NOT_RECORDED = "No provider balance was recorded at submission.";

export function payoutWords(input: PayoutWordsInput): PayoutWords {
  const { attempt } = input;
  const processing = input.claimStatus === "PAYOUT_PROCESSING";
  const unknownSend = attempt?.state === "UNKNOWN";
  const title = !processing ? null : unknownSend ? UNKNOWN_SEND_TITLE : SUBMITTED_TITLE;
  const detail = !processing ? null : unknownSend ? (input.refreshForm ? UNKNOWN_SEND_REFRESH_DETAIL : UNKNOWN_SEND_DETAIL) : input.refreshForm ? REFRESH_DETAIL : CHECK_DETAIL;
  const note = processing && unknownSend ? UNKNOWN_SEND_NOTE : null;
  // The insufficient-funds warning belongs before a send. Once an attempt exists it is stale, and on a paid claim it is false.
  const balance = !input.canPay && !attempt ? null
    : !attempt ? `${BOOK_BALANCE_NOTE} ${BALANCE_UNAVAILABLE_BEFORE_SEND}`
    : attempt.providerBalanceCents === null || attempt.providerBalanceCents === undefined ? `${BOOK_BALANCE_NOTE} ${BALANCE_NOT_RECORDED}`
    : `${BOOK_BALANCE_NOTE} Provider available balance at submission: ${input.usd(attempt.providerBalanceCents)}. Reporting may lag up to three hours.`;
  return { title, detail, balance, note };
}
