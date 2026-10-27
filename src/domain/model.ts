export interface ClaimLine {
  readonly id: string; readonly category: string; readonly budgetLine: string;
  readonly incurredOn: string; readonly amountCents: bigint;
}
export interface FundPolicy {
  readonly version: number; readonly approvedBy: string; readonly summary: string;
  readonly programs: readonly string[] | null; readonly allowedCategories: readonly string[] | null;
  readonly periodStart: string | null; readonly periodEnd: string | null; readonly breadth: number | null;
}
export interface FundSnapshot {
  readonly id: string; readonly name: string; readonly fundClass: "RESTRICTED" | "UNRESTRICTED";
  // Credits minus posted debits, before subtracting any active reservations.
  readonly balanceCents: bigint; readonly policy: FundPolicy;
  readonly budgetLines: readonly { readonly id: string; readonly capCents: bigint }[];
}
export interface AllocationInput {
  readonly program: string; readonly prohibitedCategories: readonly string[];
  readonly solverPriority: { readonly version: number; readonly approvedBy: string };
  readonly decisionId?: string; readonly lines: readonly ClaimLine[]; readonly funds: readonly FundSnapshot[];
  readonly priorDebits: readonly { readonly fundId: string; readonly budgetLine: string; readonly amountCents: bigint }[];
  readonly reservations: readonly { readonly fundId: string; readonly budgetLine: string; readonly decisionId: string; readonly active: boolean; readonly amountCents: bigint }[];
}
export interface AllocationEdge {
  readonly fundId: string; readonly lineId: string; readonly amountCents: bigint;
  readonly policyVersion: number; readonly solverPriorityVersion: number; readonly reason: string;
}
export type AllocationResult = {
  readonly status: "FUNDED"; readonly edges: readonly AllocationEdge[];
  readonly unrestrictedCents: bigint; readonly priorityCost: bigint;
} | {
  readonly status: "INFEASIBLE"; readonly edges: readonly [];
  readonly unfunded: readonly { readonly lineId: string; readonly amountCents: bigint }[];
};
export const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const minimum = (...values: bigint[]) => values.reduce((a, b) => a < b ? a : b);
const nonnegative = (value: bigint) => value < 0n ? 0n : value;
const requireText = (value: string) => { if (typeof value !== "string" || !value.trim()) throw new Error("Nonempty identifier or policy text required"); };
const cents = (value: bigint, positive = false) => { if (typeof value !== "bigint" || value < (positive ? 1n : 0n)) throw new Error("Money must be nonnegative bigint cents, with positive line and reservation amounts"); };
function unique(values: readonly string[]) { values.forEach(requireText); if (new Set(values).size !== values.length) throw new Error("Duplicate identifiers or policy values"); }
function date(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("Valid ISO calendar date required");
}
export function policyEligibility(input: Pick<AllocationInput, "program" | "prohibitedCategories">, fund: FundSnapshot, line: ClaimLine): { eligible: boolean; reason: string } {
  const prefix = `${fund.name} policy v${fund.policy.version}`;
  if (input.prohibitedCategories.includes(line.category)) return { eligible: false, reason: `${prefix}: organization prohibits ${line.category}.` };
  if (fund.fundClass === "UNRESTRICTED") return { eligible: true, reason: `${prefix}: permits ${line.category} for any program and date.` };
  if (!fund.policy.allowedCategories?.includes(line.category)) return { eligible: false, reason: `${prefix}: does not allow category ${line.category}. ${fund.policy.summary}` };
  if (!fund.policy.programs?.includes(input.program)) return { eligible: false, reason: `${prefix}: does not allow program ${input.program}. ${fund.policy.summary}` };
  if (!fund.policy.periodStart || !fund.policy.periodEnd || line.incurredOn < fund.policy.periodStart || line.incurredOn > fund.policy.periodEnd) return { eligible: false, reason: `${prefix}: ${line.incurredOn} is outside its approved period. ${fund.policy.summary}` };
  return { eligible: true, reason: `${prefix}: permits ${line.category} for ${input.program} on ${line.incurredOn}. ${fund.policy.summary}` };
}
// Revisions reapprove the specified v1 schedule; a new weighting algorithm needs a new contract.
export function priorityCostsFor(funds: readonly { id: string; fundClass: string; policy: { breadth: number | null } }[]) {
  return new Map([...funds].sort((a, b) => compareIds(a.id, b.id)).map((fund, index) => [fund.id, fund.fundClass === "UNRESTRICTED" ? 1000000n : 1000n * BigInt(fund.policy.breadth!) + BigInt(index)]));
}
export function prepare(input: AllocationInput) {
  requireText(input.program); requireText(input.solverPriority.approvedBy);
  if (!Number.isSafeInteger(input.solverPriority.version) || input.solverPriority.version < 1) throw new Error("Positive approved solver priority version required");
  if (input.decisionId !== undefined) requireText(input.decisionId);
  unique(input.lines.map(line => line.id)); unique(input.funds.map(fund => fund.id)); unique(input.prohibitedCategories);
  const lines = [...input.lines].sort((a, b) => compareIds(a.id, b.id));
  const funds = [...input.funds].sort((a, b) => compareIds(a.id, b.id));
  for (const line of lines) { requireText(line.category); requireText(line.budgetLine); date(line.incurredOn); cents(line.amountCents, true); }
  for (const fund of funds) {
    requireText(fund.name); cents(fund.balanceCents); requireText(fund.policy.approvedBy); requireText(fund.policy.summary);
    if (!Number.isSafeInteger(fund.policy.version) || fund.policy.version < 1) throw new Error("Positive policy version required");
    unique(fund.budgetLines.map(line => line.id)); fund.budgetLines.forEach(line => cents(line.capCents));
    if (fund.fundClass === "RESTRICTED") {
      if (!fund.policy.programs?.length || !fund.policy.allowedCategories?.length || fund.policy.breadth !== fund.policy.allowedCategories.length || !fund.policy.periodStart || !fund.policy.periodEnd) throw new Error("Restricted fund needs a complete approved policy and category breadth");
      unique(fund.policy.programs); unique(fund.policy.allowedCategories); date(fund.policy.periodStart); date(fund.policy.periodEnd);
      if (fund.policy.periodStart > fund.policy.periodEnd) throw new Error("Policy period is reversed");
      for (const line of lines) if (policyEligibility(input, fund, line).eligible && !fund.budgetLines.some(budget => budget.id === line.budgetLine)) throw new Error(`Missing ${fund.name} budget line ${line.budgetLine}`);
    } else if (fund.fundClass !== "UNRESTRICTED" || fund.policy.programs !== null || fund.policy.allowedCategories !== null || fund.policy.periodStart !== null || fund.policy.periodEnd !== null || fund.policy.breadth !== null || fund.budgetLines.length) throw new Error("Unrestricted policy must have no program, category, period, or budget restrictions");
  }
  const fundIds = new Set(funds.map(fund => fund.id));
  for (const row of [...input.priorDebits, ...input.reservations]) { if (!fundIds.has(row.fundId)) throw new Error("Capacity row references an unknown fund"); requireText(row.budgetLine); cents(row.amountCents, true); }
  for (const row of input.reservations) { requireText(row.decisionId); if (typeof row.active !== "boolean") throw new Error("Reservation active state required"); }
  const others = input.reservations.filter(row => row.active && row.decisionId !== input.decisionId);
  const balances = new Map(funds.map(fund => [fund.id, nonnegative(fund.balanceCents - others.filter(row => row.fundId === fund.id).reduce((sum, row) => sum + row.amountCents, 0n))]));
  const budgetKey = (fundId: string, budgetLine: string) => JSON.stringify([fundId, budgetLine]);
  const budgets = new Map<string, bigint>();
  for (const fund of funds) for (const budget of fund.budgetLines) budgets.set(budgetKey(fund.id, budget.id), nonnegative(budget.capCents - input.priorDebits.filter(row => row.fundId === fund.id && row.budgetLine === budget.id).reduce((sum, row) => sum + row.amountCents, 0n) - others.filter(row => row.fundId === fund.id && row.budgetLine === budget.id).reduce((sum, row) => sum + row.amountCents, 0n)));
  const costs = priorityCostsFor(funds);
  return { input, lines, funds, balances, budgets, costs, budgetKey, total: lines.reduce((sum, line) => sum + line.amountCents, 0n) };
}
export type Prepared = ReturnType<typeof prepare>;
export function edgeFor(context: Prepared, fund: FundSnapshot, line: ClaimLine, amountCents: bigint): AllocationEdge {
  const restrictedEligible = context.funds.some(candidate => candidate.fundClass === "RESTRICTED" && policyEligibility(context.input, candidate, line).eligible);
  const rationale = fund.fundClass === "RESTRICTED" ? `Restricted priority uses breadth ${fund.policy.breadth}; narrower eligible funds are preferred, then fund ID.` : restrictedEligible ? "General covers the remaining amount after restricted capacity is considered." : `General covers ${line.category}; no restricted fund policy permits this line.`;
  return { fundId: fund.id, lineId: line.id, amountCents, policyVersion: fund.policy.version, solverPriorityVersion: context.input.solverPriority.version, reason: `${policyEligibility(context.input, fund, line).reason} ${rationale}` };
}
export function funded(context: Prepared, edges: AllocationEdge[]): AllocationResult {
  edges.sort((a, b) => compareIds(a.lineId, b.lineId) || (context.costs.get(a.fundId)! < context.costs.get(b.fundId)! ? -1 : context.costs.get(a.fundId)! > context.costs.get(b.fundId)! ? 1 : compareIds(a.fundId, b.fundId)));
  return { status: "FUNDED", edges, unrestrictedCents: edges.filter(edge => context.funds.find(fund => fund.id === edge.fundId)!.fundClass === "UNRESTRICTED").reduce((sum, edge) => sum + edge.amountCents, 0n), priorityCost: edges.reduce((sum, edge) => sum + edge.amountCents * context.costs.get(edge.fundId)!, 0n) };
}
export function validateAllocation(input: AllocationInput, edges: readonly AllocationEdge[]) {
  const context = prepare(input); const totals = new Map<string, bigint>(); const usedFunds = new Map<string, bigint>(); const usedBudgets = new Map<string, bigint>(); const seen = new Set<string>();
  for (const edge of edges) {
    const fund = context.funds.find(fund => fund.id === edge.fundId); const line = context.lines.find(line => line.id === edge.lineId);
    if (!fund || !line) throw new Error("Allocation references an unknown fund or line");
    const eligible = policyEligibility(input, fund, line); if (!eligible.eligible) throw new Error(eligible.reason);
    cents(edge.amountCents, true); requireText(edge.reason);
    if (edge.policyVersion !== fund.policy.version || edge.solverPriorityVersion !== input.solverPriority.version) throw new Error("Allocation policy version differs from approved snapshot");
    const pair = JSON.stringify([edge.fundId, edge.lineId]); if (seen.has(pair)) throw new Error("Duplicate allocation edge"); seen.add(pair);
    totals.set(line.id, (totals.get(line.id) ?? 0n) + edge.amountCents);
    usedFunds.set(fund.id, (usedFunds.get(fund.id) ?? 0n) + edge.amountCents);
    if (usedFunds.get(fund.id)! > context.balances.get(fund.id)!) throw new Error(`${fund.name}: fund capacity exceeded`);
    if (fund.fundClass === "RESTRICTED") { const key = context.budgetKey(fund.id, line.budgetLine); usedBudgets.set(key, (usedBudgets.get(key) ?? 0n) + edge.amountCents); if (usedBudgets.get(key)! > context.budgets.get(key)!) throw new Error(`${fund.name}: shared budget-line capacity exceeded`); }
  }
  for (const line of context.lines) if (totals.get(line.id) !== line.amountCents) throw new Error(`Line ${line.id} is not fully and exactly funded`);
}
