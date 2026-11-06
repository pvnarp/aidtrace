// Only fixed application messages cross the HTTP boundary. Never echo an exception,
// provider response, SQL error, recipient or credential into a redirect or notice.
export const claimFailureNotices = {
  "already-approved": "You already approved these terms. A different approver must provide the second approval.",
  "terms-changed": "These terms are no longer current. Reload the claim and review its current decision before acting. An approval cannot be reused for changed terms.",
  "receipt-review-required": "Confirm the current receipt categories before freezing this allocation.",
  "rejection-reason-required": "Enter a rejection reason between 1 and 500 characters.",
  "claim-not-open": "This claim is no longer open for that action. Reload its current status. Do not send another payment.",
  "recipient-not-payable": "This fixture uses a non-payable recipient. Continue the no-payment review; do not replace approved terms or use the owner's PayPal account.",
  "provider-balance-short": "The readable PayPal balance is too short for this reimbursement. No new payout was submitted by this action. Review funding before any separately authorized submission.",
  "payout-review-required": "An existing or unresolved payout needs status review or manual reconciliation. Do not send again or change saved sender IDs.",
  "provider-review-required": "The provider result could not be safely reconciled with the saved payment. Preserve the records for manual review. Do not send again.",
  "takeover-needed": "Two approvers must finish this claim before anyone sends it.",
  "action-failed": "That action could not be completed. Review the current state before acting again. Payment failures do not authorize another send.",
} as const;
// IAC-416: the keys are the exact error strings the ledger throws (src/ledger/payout.ts, retry.ts). They are never shown; only the fixed notices above are.
const knownFailures = new Map<string, keyof typeof claimFailureNotices>([
  ["The same approver cannot approve twice", "already-approved"],
  ["Approval hash does not match this decision", "terms-changed"],
  ["Decision is invalidated", "terms-changed"],
  ["Current recognized decision hash required", "terms-changed"],
  ["Current receipt categories require human confirmation", "receipt-review-required"],
  ["A rejection reason of 1 to 500 characters is required", "rejection-reason-required"],
  ["Claim is not open for allocation", "claim-not-open"],
  ["Decision already recognized", "claim-not-open"],
  ["No automatically recognized decision to finish", "claim-not-open"],
  ["This claim already holds two approvals", "claim-not-open"],
  ["A payout already exists for this claim", "payout-review-required"],
  ["Two approvers must take over this claim before it is sent", "takeover-needed"],
  ["Recognized obligation cannot be rejected", "claim-not-open"],
  ["Only an approved claim may be paid", "claim-not-open"],
  ["A real sandbox recipient is required", "recipient-not-payable"],
  ["Readable provider balance is short; fund the sandbox account first", "provider-balance-short"],
  ["A payout already exists; refresh or resolve it without sending again", "payout-review-required"],
  ["Latest payout is not retryable; reconcile or keep polling", "payout-review-required"],
  ["An unresolved or settled attempt prevents retry", "payout-review-required"],
  ["An open historical PayPal event review prevents retry; reconcile it first", "payout-review-required"],
  ["Provider batch binding failed; no accounting change", "provider-review-required"],
  ["Provider item binding failed; no accounting change", "provider-review-required"],
  ["Provider fee changed; manual review required", "provider-review-required"],
]);
export function claimFailureNotice(error: unknown): keyof typeof claimFailureNotices {
  return error instanceof Error ? knownFailures.get(error.message) ?? "action-failed" : "action-failed";
}
