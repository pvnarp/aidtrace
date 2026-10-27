import { edgeFor, funded, minimum, policyEligibility, prepare, type AllocationEdge, type AllocationInput, type AllocationResult } from "./model";

// Comparison only. The baseline must never authorize a payment.
export function naive(input: AllocationInput): AllocationResult {
  const context = prepare(input); const balances = new Map(context.balances); const budgets = new Map(context.budgets);
  const edges: AllocationEdge[] = []; const unfunded: { lineId: string; amountCents: bigint }[] = [];
  for (const line of context.lines) {
    let remaining = line.amountCents;
    for (const fund of context.funds) {
      if (!remaining || !policyEligibility(input, fund, line).eligible) continue;
      const key = context.budgetKey(fund.id, line.budgetLine);
      const amount = minimum(remaining, balances.get(fund.id)!, fund.fundClass === "UNRESTRICTED" ? remaining : budgets.get(key)!);
      if (amount <= 0n) continue;
      const edge = edgeFor(context, fund, line, amount);
      edges.push({ ...edge, reason: `${fund.name} selected by the comparison-only first-eligible fund ID order. ${policyEligibility(input, fund, line).reason}` });
      balances.set(fund.id, balances.get(fund.id)! - amount);
      if (fund.fundClass === "RESTRICTED") budgets.set(key, budgets.get(key)! - amount);
      remaining -= amount;
    }
    if (remaining) unfunded.push({ lineId: line.id, amountCents: remaining });
  }
  return unfunded.length ? { status: "INFEASIBLE", edges: [], unfunded } : funded(context, edges);
}
