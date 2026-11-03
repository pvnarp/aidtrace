// IAC-405 step 3 PR P review item 7 (docs/ASSUMPTIONS.md section 78). What the claim page says about an automated payment, from the stored attempt state alone.
export function paymentLine(state: string | null): string {
  if (state === null) return "Payment: not sent yet.";
  if (state === "SETTLED") return "Payment: Paid.";
  if (state === "UNKNOWN" || state === "UNKNOWN_STATUS" || state === "MANUAL_REVIEW") return "Payment: the outcome is unknown. It is not shown as paid.";
  if (state === "SUBMITTED" || state === "PREPARED") return "Payment: sent to PayPal, not paid yet.";
  return "Payment: not paid.";
}
