// IAC-405 step 2 PR A. The closed list of reasons the bulk approval route skips a claim, with the
// plain sentence each one shows. No imports: the browser queue and the server service both read this file, and only these fixed sentences cross the HTTP boundary.
export const BULK_LIMIT = 25;
export const BULK_SKIP_REASONS = ["STALE_VERSION", "NOT_FOUND", "NOT_WAITING", "NOT_ASSISTED", "HOLD_FOUND", "NOT_CHECKED", "OWN_CLAIM", "ALREADY_APPROVED", "CHANGED", "FAILED"] as const;
export type BulkSkipReason = (typeof BULK_SKIP_REASONS)[number];
export const BULK_SKIP_TEXT: Readonly<Record<BulkSkipReason, string>> = {
  STALE_VERSION: "the claim changed after this page loaded. Open it and review the new terms.",
  NOT_FOUND: "this claim was not found.",
  NOT_WAITING: "this claim is no longer waiting for approval.",
  NOT_ASSISTED: "this claim needs its own review, because not every fund that pays it is Assisted.",
  HOLD_FOUND: "a hold was found after this page loaded. Open the claim to review it.",
  NOT_CHECKED: "the checks have not finished for these terms. Open the claim to review it.",
  OWN_CLAIM: "you cannot approve your own claim.",
  ALREADY_APPROVED: "you already approved this claim.",
  CHANGED: "the terms changed, so the old terms were released and the claimant must submit again.",
  FAILED: "this approval could not be completed. Nothing was changed.",
};
export const BULK_SAVED_TEXT = "your approval is saved, but a hold appeared while it was recorded, so a second approver is still needed.";
export type BulkSkip = { claimId: string; reason: BulkSkipReason };
export type BulkOutcome = { approved: string[]; saved: string[]; skipped: BulkSkip[] };
