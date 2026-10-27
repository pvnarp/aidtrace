export type ProposalState = "RUNNING" | "READY_FOR_REVIEW" | "NEEDS_REVIEW" | "POLICY_BLOCKED" | "UNAVAILABLE" | "STALE";
export type ProposalResult = {
  summary: "HUMAN_REVIEW_REQUIRED" | "UNRESOLVED_CATEGORIES" | "PROHIBITED_CATEGORY" | "INSUFFICIENT_ELIGIBLE_CAPACITY";
  edges: { fundId: string; lineId: string; amountCents: string; reason: string; policyVersion: number; solverPriorityVersion: number }[];
  generalCents: string | null;
  issues: { lineId: string; code: "UNKNOWN" | "PROHIBITED" | "UNFUNDED"; amountCents: string }[];
  steps: ("CATEGORIES_VALIDATED" | "POLICY_PREVIEWED" | "HUMAN_CONFIRMATION_REQUIRED")[];
};
