import { edgeFor, funded, minimum, policyEligibility, prepare, type AllocationInput, type AllocationResult, type Prepared } from "./model";
interface Arc { to: number; reverse: number; remaining: bigint; initial: bigint; cost: bigint; }
function solve(context: Prepared, stage: "unrestricted" | "priority", unrestrictedLimit: bigint) {
  const graph: Arc[][] = [];
  const node = () => { graph.push([]); return graph.length - 1; };
  const source = node(); const unrestrictedPool = node();
  const fundNodes = new Map(context.funds.map(fund => [fund.id, node()]));
  const budgetNodes = new Map<string, number>();
  for (const fund of context.funds) for (const budget of [...fund.budgetLines].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) budgetNodes.set(context.budgetKey(fund.id, budget.id), node());
  const lineNodes = new Map(context.lines.map(line => [line.id, node()])); const sink = node();
  function add(from: number, to: number, capacity: bigint, cost = 0n) {
    const forward: Arc = { to, reverse: graph[to]!.length, remaining: capacity, initial: capacity, cost };
    const backward: Arc = { to: from, reverse: graph[from]!.length, remaining: 0n, initial: 0n, cost: -cost };
    graph[from]!.push(forward); graph[to]!.push(backward); return forward;
  }
  add(source, unrestrictedPool, unrestrictedLimit);
  const outputs: { fund: Prepared["funds"][number]; line: Prepared["lines"][number]; arc: Arc }[] = [];
  for (const fund of context.funds) {
    const from = fundNodes.get(fund.id)!;
    add(fund.fundClass === "UNRESTRICTED" ? unrestrictedPool : source, from, context.balances.get(fund.id)!);
    for (const budget of [...fund.budgetLines].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) add(from, budgetNodes.get(context.budgetKey(fund.id, budget.id))!, context.budgets.get(context.budgetKey(fund.id, budget.id))!);
    for (const line of context.lines) if (policyEligibility(context.input, fund, line).eligible) {
      const cost = stage === "priority" ? context.costs.get(fund.id)! : fund.fundClass === "UNRESTRICTED" ? 1n : 0n;
      const arc = add(fund.fundClass === "UNRESTRICTED" ? from : budgetNodes.get(context.budgetKey(fund.id, line.budgetLine))!, lineNodes.get(line.id)!, line.amountCents, cost);
      outputs.push({ fund, line, arc });
    }
  }
  const demands = context.lines.map(line => ({ line, arc: add(lineNodes.get(line.id)!, sink, line.amountCents) }));
  let total = 0n;
  while (total < context.total) {
    const distance: (bigint | null)[] = graph.map(() => null); distance[source] = 0n;
    const parents: ({ from: number; index: number } | undefined)[] = graph.map(() => undefined);
    // Bellman-Ford handles negative reverse costs using exact bigint arithmetic.
    for (let pass = 0; pass < graph.length - 1; pass++) {
      let changed = false;
      for (let from = 0; from < graph.length; from++) {
        const base = distance[from]; if (base === null || base === undefined) continue;
        for (let index = 0; index < graph[from]!.length; index++) {
          const arc = graph[from]![index]!; if (arc.remaining <= 0n) continue;
          const candidate = base + arc.cost; const previous = distance[arc.to];
          if (previous === null || previous === undefined || candidate < previous) { distance[arc.to] = candidate; parents[arc.to] = { from, index }; changed = true; }
        }
      }
      if (!changed) break;
    }
    if (distance[sink] === null) break;
    let amount = context.total - total; const path: { from: number; arc: Arc }[] = [];
    for (let current = sink; current !== source;) {
      const parent = parents[current]; if (!parent || path.length >= graph.length) throw new Error("Invalid residual path");
      const arc = graph[parent.from]![parent.index]!; path.push({ from: parent.from, arc }); amount = minimum(amount, arc.remaining); current = parent.from;
    }
    for (const { from, arc } of path) { arc.remaining -= amount; graph[arc.to]![arc.reverse]!.remaining += amount; void from; }
    total += amount;
  }
  const edges = outputs.filter(output => output.arc.initial > output.arc.remaining).map(output => edgeFor(context, output.fund, output.line, output.arc.initial - output.arc.remaining));
  const unrestricted = outputs.filter(output => output.fund.fundClass === "UNRESTRICTED").reduce((sum, output) => sum + output.arc.initial - output.arc.remaining, 0n);
  return { total, edges, unrestricted, unfunded: demands.filter(demand => demand.arc.remaining > 0n).map(demand => ({ lineId: demand.line.id, amountCents: demand.arc.remaining })) };
}
export function allocate(input: AllocationInput): AllocationResult {
  const context = prepare(input);
  // First fix the minimum unrestricted total, then apply the approved v1 costs.
  // This preserves the primary objective even beyond the spec's small weight range.
  const first = solve(context, "unrestricted", context.total);
  if (first.total < context.total) return { status: "INFEASIBLE", edges: [], unfunded: first.unfunded };
  const second = solve(context, "priority", first.unrestricted);
  if (second.total !== context.total) throw new Error("Priority solve lost a feasible minimum-unrestricted allocation");
  return funded(context, second.edges);
}
