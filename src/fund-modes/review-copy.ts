// IAC-405 PR A follow-up (docs/ASSUMPTIONS.md section 77 item 13): the fixed sentences that change when a claim's stored decision needs one human approval because it is
// Assisted with no holds found. No imports, so browser and server share it. A caller picks the one-approval text only from the server's stored decision or audit fact
// (reviewLineMode); every other claim, and every page with the flag off, keeps the text it always had, which stays where it was.
export const APPROVALS_HEADING_ONE = "Human review";
export const FOOTER_NO_HOLDS_DONE = "No holds found, so one approver was enough.";
export const FOOTER_NO_HOLDS_WAITING = "No holds found, so one approver is enough.";
export const REFERENCE_BINDS_ONE = "The approval binds this reference.";
export const QUEUE_LEDE_ASSISTED = "In Assisted funds, a claim with no holds needs one approver.";
export const HEADING_AWAITING_ONE = "Frozen. Awaiting one approval.";

// IAC-405 PR P merge fix: the fixed sentences of a claim that Autopilot recognized (an AUTO_RECOGNIZED record, read from stored records by reviewLineMode). Shown only for the AUTOPILOT mode
// (recognized, no person has approved, a payout exists). A claim whose automatic payment did not go out, or that a person has begun to take over, reads in the ordinary two-person words.
export const APPROVALS_HEADING_AUTOPILOT = "Autopilot review";
export const REVIEW_COUNT_AUTOPILOT = "Human reviews: none required. Approved under Autopilot guardrails.";
export const REFERENCE_BINDS_AUTOPILOT = "The guardrail record binds this reference.";
export const TRACE_APPROVALS_AUTOPILOT = "Autopilot";
export const FOOTER_AUTOPILOT = "These checks ran before the claim was recognized. No person approval was required.";
export const TITLE_AUTO_NOT_SENT = "approved under Autopilot. Payment did not go out."; // follows the amount, for example "$67.00 approved under Autopilot. Payment did not go out."
