import type { ProposalResult, ProposalState } from "./types";
export const proposalMoney = (cents: string | bigint) => {
  const value = typeof cents === "bigint" ? cents : /^\d+$/.test(cents) ? BigInt(cents) : -1n;
  if (value < 0n) throw new Error("Nonnegative USD cents required");
  return `$${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
};
const steps = { CATEGORIES_VALIDATED: "Category suggestions passed source-quote validation.", POLICY_PREVIEWED: "Current funding rules and capacity checked.", HUMAN_CONFIRMATION_REQUIRED: "Waiting for your category confirmation." };
export function proposalPresentation(run: { state: ProposalState; errorCode: string | null; result: ProposalResult | null } | null, fundNames: Record<string, string>, total: bigint) {
  const state = run?.state ?? null;
  const messages = {
    RUNNING: ["Preparation in progress", "Category suggestions and funding checks are running. Refresh status to see the result. No funds are reserved."],
    READY_FOR_REVIEW: ["Provisional funding available", "Human review required. This preview does not reserve funds, approve an expense or confirm PayPal cash."],
    NEEDS_REVIEW: ["Category review needed", "Some suggestions could not be resolved or validated. Choose each unresolved category yourself and explain your choice."],
    POLICY_BLOCKED: ["Funding blocked by current rules", "Review the reasons below. Confirming categories does not override funding rules or approve payment."],
    UNAVAILABLE: ["Preparation unavailable", run?.errorCode === "BUSY" ? "Another review is using the preparation slot. Review manually below, or make a new request when it is free." : run?.errorCode === "TIMEOUT" ? "Preparation timed out. Review manually below, or make a new request. No automatic retry was started." : "AI preparation could not finish. Review every category manually, or make a new request. No payment was requested."],
    STALE: ["Preview needs refreshing", "The receipt, category review or funding information changed. The earlier funding preview is hidden. Reload saved information before preparing again."],
  } as const;
  const [heading, message] = state ? messages[state] : ["Prepare this expense for review", "Prepare category suggestions and a provisional funding preview, or review categories manually below."];
  const result = state === "STALE" ? null : run?.result;
  const general = state === "READY_FOR_REVIEW" && result?.generalCents !== null && result?.generalCents !== undefined ? BigInt(result.generalCents) : null;
  if (general !== null && (general < 0n || general > total)) throw new Error("Invalid provisional total");
  return { heading, message, state, steps: result?.steps.map(step => steps[step]) ?? [],
    split: general === null ? null : `${proposalMoney(total - general)} from restricted funds, ${proposalMoney(general)} from General.`,
    edges: result?.edges.map(edge => ({ lineId: edge.lineId, fund: fundNames[edge.fundId] ?? "Eligible fund", amount: proposalMoney(edge.amountCents), reason: edge.reason })) ?? [],
    issues: result?.issues.map(issue => ({ lineId: issue.lineId, message: issue.code === "UNKNOWN" ? "Choose and confirm a category manually." : issue.code === "PROHIBITED" ? `${proposalMoney(issue.amountCents)} is in a prohibited category.` : `${proposalMoney(issue.amountCents)} has no available eligible funding.` })) ?? [],
  };
}
export type ProposalPanel = ReturnType<typeof proposalPresentation>;
