import { expect, it } from "vitest";
import fc from "fast-check";
import { allocate } from "../src/domain/allocate";
import { validateAllocation, type AllocationInput } from "../src/domain/model";
import { fixture } from "./fixtures/allocation";

// Independent exhaustive search of dollar-unit flows. All input capacities are whole
// dollars, so the integral flow optimum exists in these units. Production still receives
// cents. This oracle shares no graph, policy, cost, or capacity helpers with production.
function bruteForce(input: AllocationInput) {
  const funds = [...input.funds].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const dollars = (cents: bigint) => { if (cents % 100n) throw new Error("Whole-dollar oracle inputs only"); return Number(cents / 100n); };
  const others = input.reservations.filter(row => row.active && row.decisionId !== input.decisionId);
  const balances = funds.map(fund => Math.max(0, dollars(fund.balanceCents) - others.filter(row => row.fundId === fund.id).reduce((sum, row) => sum + dollars(row.amountCents), 0)));
  const cost = funds.map((fund, index) => fund.fundClass === "UNRESTRICTED" ? 1000000n : BigInt(1000 * fund.policy.allowedCategories!.length + index));
  const budgets = funds.flatMap((fund, fundIndex) => fund.budgetLines.map(line => ({ fundIndex, id: line.id, cap: Math.max(0, dollars(line.capCents) - input.priorDebits.filter(row => row.fundId === fund.id && row.budgetLine === line.id).reduce((sum, row) => sum + dollars(row.amountCents), 0) - others.filter(row => row.fundId === fund.id && row.budgetLine === line.id).reduce((sum, row) => sum + dollars(row.amountCents), 0)) })));
  const used = funds.map(() => 0); const budgetUsed = budgets.map(() => 0);
  const memo = new Map<string, { cost: bigint; unrestricted: number } | null>();
  function solve(lineIndex: number): { cost: bigint; unrestricted: number } | null {
    if (lineIndex === input.lines.length) return { cost: 0n, unrestricted: 0 };
    const key = JSON.stringify([lineIndex, used, budgetUsed]); if (memo.has(key)) return memo.get(key)!;
    const line = input.lines[lineIndex]!; let best: { cost: bigint; unrestricted: number } | null = null;
    function distribute(fundIndex: number, remaining: number, subtotal: bigint, unrestricted: number) {
      if (fundIndex === funds.length) {
        if (remaining) return;
        const tail = solve(lineIndex + 1); if (!tail) return;
        const candidate = { cost: subtotal + tail.cost, unrestricted: unrestricted + tail.unrestricted };
        // Minima are independent. The production result must attain BOTH, rather
        // than matching an oracle that hides a weighted-cost tradeoff lexicographically.
        best = best ? { cost: candidate.cost < best.cost ? candidate.cost : best.cost, unrestricted: Math.min(candidate.unrestricted, best.unrestricted) } : candidate;
        return;
      }
      const fund = funds[fundIndex]!;
      const allowed = !input.prohibitedCategories.includes(line.category) && (fund.fundClass === "UNRESTRICTED" || (fund.policy.allowedCategories!.includes(line.category) && fund.policy.programs!.includes(input.program) && fund.policy.periodStart! <= line.incurredOn && fund.policy.periodEnd! >= line.incurredOn));
      const budgetIndex = budgets.findIndex(row => row.fundIndex === fundIndex && row.id === line.budgetLine);
      const cap = fund.fundClass === "UNRESTRICTED" ? Infinity : budgetIndex < 0 ? 0 : budgets[budgetIndex]!.cap - budgetUsed[budgetIndex]!;
      const maximum = allowed ? Math.min(remaining, balances[fundIndex]! - used[fundIndex]!, cap) : 0;
      for (let amount = 0; amount <= maximum; amount++) {
        used[fundIndex]! += amount; if (budgetIndex >= 0) budgetUsed[budgetIndex]! += amount;
        distribute(fundIndex + 1, remaining - amount, subtotal + BigInt(amount * 100) * cost[fundIndex]!, unrestricted + (fund.fundClass === "UNRESTRICTED" ? amount : 0));
        used[fundIndex]! -= amount; if (budgetIndex >= 0) budgetUsed[budgetIndex]! -= amount;
      }
    }
    distribute(0, dollars(line.amountCents), 0n, 0); memo.set(key, best); return best;
  }
  return solve(0);
}

const usd = fc.integer({ min: 0, max: 20 });
const sampleArbitrary = fc.record({
  fundCount: fc.integer({ min: 1, max: 3 }), lineCount: fc.integer({ min: 1, max: 3 }),
  balances: fc.tuple(usd, usd, usd), capsA: fc.tuple(usd, usd), capsB: fc.tuple(usd, usd), capped: fc.boolean(),
  maskA: fc.integer({ min: 1, max: 7 }), maskB: fc.integer({ min: 1, max: 7 }),
  amounts: fc.tuple(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 20 })),
  categories: fc.tuple(fc.integer({ min: 0, max: 2 }), fc.integer({ min: 0, max: 2 }), fc.integer({ min: 0, max: 2 })),
  prior: fc.integer({ min: 0, max: 5 }), held: fc.integer({ min: 0, max: 5 }), own: fc.integer({ min: 0, max: 5 }),
  active: fc.boolean(), prohibited: fc.boolean(), wrongProgram: fc.boolean(), outOfPeriod: fc.boolean(),
});
type Sample = typeof sampleArbitrary extends fc.Arbitrary<infer Value> ? Value : never;
function instance(sample: Sample): AllocationInput {
  const original = fixture(); const names = ["robot_kits_parts", "classroom_supplies", "participant_meals"];
  const toCents = (amount: number) => BigInt(amount * 100);
  // One fund is General Operating; two add Ashmere County Afterschool STEM Subgrant; three add Tallow Creek Robot Kit Initiative as well.
  const selected = sample.fundCount === 1 ? [original.funds[2]!] : sample.fundCount === 2 ? [original.funds[0]!, original.funds[2]!] : [...original.funds];
  return { ...original, decisionId: "own", program: sample.wrongProgram ? "football" : "robotics", prohibitedCategories: sample.prohibited ? ["participant_meals"] : [],
    lines: original.lines.slice(0, sample.lineCount).map((line, index) => ({ ...line, category: names[sample.categories[index]!]!, budgetLine: sample.categories[index] === 2 ? "other" : "supplies", incurredOn: sample.outOfPeriod ? "2028-01-01" : line.incurredOn, amountCents: toCents(sample.amounts[index]!) })),
    funds: selected.map(fund => {
      const index = original.funds.findIndex(row => row.id === fund.id);
      const categories = names.filter((_name, bit) => ((fund.id === "fund_a" ? sample.maskA : sample.maskB) & (1 << bit)) !== 0);
      const caps = fund.id === "fund_a" ? sample.capsA : sample.capsB;
      return { ...fund, balanceCents: toCents(sample.balances[index]!), ...(fund.fundClass === "RESTRICTED" ? { policy: { ...fund.policy, allowedCategories: categories, breadth: categories.length }, budgetLines: ["supplies", "other"].map((id, bit) => ({ id, capCents: toCents(sample.capped ? caps[bit]! : 20) })) } : {}) };
    }),
    priorDebits: sample.capped && sample.fundCount > 1 && sample.prior ? [{ fundId: "fund_a", budgetLine: "supplies", amountCents: toCents(sample.prior) }] : [],
    reservations: sample.fundCount > 1 ? [...(sample.held ? [{ fundId: "fund_a", budgetLine: "supplies", decisionId: "other", active: sample.active, amountCents: toCents(sample.held) }] : []), ...(sample.own ? [{ fundId: "fund_a", budgetLine: "supplies", decisionId: "own", active: true, amountCents: toCents(sample.own) }] : [])] : [],
  };
}
function check(input: AllocationInput) {
  const expected = bruteForce(input); const actual = allocate(input);
  if (!expected) { expect(actual.status).toBe("INFEASIBLE"); expect(actual.edges).toEqual([]); }
  else {
    if (actual.status !== "FUNDED") throw new Error("Exhaustive feasible allocation was lost");
    expect(actual.priorityCost).toBe(expected.cost); expect(actual.unrestrictedCents).toBe(BigInt(expected.unrestricted * 100));
    expect(() => validateAllocation(input, actual.edges)).not.toThrow();
  }
  expect(allocate(input)).toEqual(actual);
  expect(allocate({ ...input, lines: [...input.lines].reverse(), funds: [...input.funds].reverse().map(fund => ({ ...fund, budgetLines: [...fund.budgetLines].reverse() })), reservations: [...input.reservations].reverse() })).toEqual(actual);
}
it("SOL-06: matches independent exhaustive minima on 200 whole-dollar instances up to 3 funds, 3 lines and USD 20", () => {
  fc.assert(fc.property(sampleArbitrary, sample => check(instance(sample))), { numRuns: 200, seed: 1382026 });
}, 30_000);
it("SOL-06: covers feasible maximum boundaries and binding distinct/shared budgets", () => {
  const source = fixture();
  const input: AllocationInput = { ...source, lines: source.lines.map(line => ({ ...line, amountCents: 2000n })), funds: source.funds.map(fund => ({ ...fund, balanceCents: 2000n, budgetLines: fund.budgetLines.map(line => ({ ...line, capCents: 2000n })) })) };
  check(input); check({ ...input, funds: input.funds.map(fund => fund.id === "fund_a" ? { ...fund, budgetLines: [{ id: "supplies", capCents: 1000n }] } : fund) });
});
