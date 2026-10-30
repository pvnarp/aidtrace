import { expect, it } from "vitest";
import fc from "fast-check";
import { allocate } from "../src/domain/allocate";
import { validateAllocation, type AllocationInput } from "../src/domain/model";
import { fixture } from "./fixtures/allocation";

// Independent bounded enumeration, using numeric integer cents only in these tiny cases.
// It does not call the production graph, policy evaluator, or capacity preparation.
function exhaustive(input: AllocationInput) {
  const funds = [...input.funds].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const other = input.reservations.filter(row => row.active && row.decisionId !== input.decisionId);
  const balances = funds.map(fund => Math.max(0, Number(fund.balanceCents) - other.filter(row => row.fundId === fund.id).reduce((sum, row) => sum + Number(row.amountCents), 0)));
  const caps = funds.map(fund => fund.fundClass === "UNRESTRICTED" ? Infinity : Math.max(0, Number(fund.budgetLines[0]!.capCents) - input.priorDebits.filter(row => row.fundId === fund.id).reduce((sum, row) => sum + Number(row.amountCents), 0) - other.filter(row => row.fundId === fund.id).reduce((sum, row) => sum + Number(row.amountCents), 0)));
  const costs = funds.map((fund, index) => fund.fundClass === "UNRESTRICTED" ? 1000000n : BigInt(fund.policy.allowedCategories!.length * 1000 + index));
  const used = funds.map(() => 0); let best: { unrestricted: number; cost: bigint } | null = null;
  function visit(lineIndex: number, fundIndex: number, remaining: number, unrestricted: number, cost: bigint) {
    if (lineIndex === input.lines.length) { if (!best || unrestricted < best.unrestricted || (unrestricted === best.unrestricted && cost < best.cost)) best = { unrestricted, cost }; return; }
    if (!remaining) { const next = lineIndex + 1; visit(next, 0, next === input.lines.length ? 0 : Number(input.lines[next]!.amountCents), unrestricted, cost); return; }
    if (fundIndex === funds.length) return;
    const fund = funds[fundIndex]!; const line = input.lines[lineIndex]!;
    const permitted = !input.prohibitedCategories.includes(line.category) && (fund.fundClass === "UNRESTRICTED" || (fund.policy.allowedCategories!.includes(line.category) && fund.policy.programs!.includes(input.program) && fund.policy.periodStart! <= line.incurredOn && fund.policy.periodEnd! >= line.incurredOn));
    const maximum = permitted ? Math.min(remaining, balances[fundIndex]! - used[fundIndex]!, caps[fundIndex]! - used[fundIndex]!) : 0;
    for (let amount = 0; amount <= maximum; amount++) {
      used[fundIndex]! += amount;
      visit(lineIndex, fundIndex + 1, remaining - amount, unrestricted + (fund.fundClass === "UNRESTRICTED" ? amount : 0), cost + BigInt(amount) * costs[fundIndex]!);
      used[fundIndex]! -= amount;
    }
  }
  visit(0, 0, Number(input.lines[0]!.amountCents), 0, 0n);
  return best as { unrestricted: number; cost: bigint } | null;
}
it("matches exhaustive feasibility and both objective levels on 250 bounded policy/cap/reservation cases", () => {
  const small = fc.integer({ min: 0, max: 6 });
  fc.assert(fc.property(fc.record({ a: small, b: small, g: small, capA: small, capB: small, debit: fc.integer({ min: 0, max: 3 }), other: fc.integer({ min: 0, max: 3 }), own: fc.integer({ min: 0, max: 3 }), active: fc.boolean(), maskA: fc.integer({ min: 1, max: 3 }), maskB: fc.integer({ min: 1, max: 3 }), first: fc.integer({ min: 1, max: 4 }), second: fc.integer({ min: 1, max: 4 }), prohibited: fc.integer({ min: 0, max: 9 }) }), sample => {
    const original = fixture(); const categories = ["robot_kits_parts", "classroom_supplies"];
    const input: AllocationInput = { ...original, decisionId: "current", prohibitedCategories: sample.prohibited ? [] : ["classroom_supplies"],
      lines: original.lines.slice(0, 2).map((line, index) => ({ ...line, amountCents: BigInt(index ? sample.second : sample.first) })),
      funds: original.funds.map((fund, index) => {
        const allowed = categories.filter((_category, bit) => ((index ? sample.maskB : sample.maskA) & (1 << bit)) !== 0);
        return { ...fund, balanceCents: BigInt([sample.a, sample.b, sample.g][index]!), ...(fund.fundClass === "RESTRICTED" ? { policy: { ...fund.policy, allowedCategories: allowed, breadth: allowed.length }, budgetLines: [{ id: "supplies", capCents: BigInt(index ? sample.capB : sample.capA) }] } : {}) };
      }),
      priorDebits: sample.debit ? [{ fundId: "fund_a", budgetLine: "supplies", amountCents: BigInt(sample.debit) }] : [],
      reservations: [...(sample.other ? [{ fundId: "fund_a", budgetLine: "supplies", decisionId: "other", active: sample.active, amountCents: BigInt(sample.other) }] : []), ...(sample.own ? [{ fundId: "fund_b", budgetLine: "supplies", decisionId: "current", active: true, amountCents: BigInt(sample.own) }] : [])],
    };
    const expected = exhaustive(input); const actual = allocate(input);
    if (!expected) { expect(actual.status).toBe("INFEASIBLE"); expect(actual.edges).toEqual([]); }
    else {
      if (actual.status !== "FUNDED") throw new Error("Solver lost an exhaustively feasible allocation");
      expect(actual.unrestrictedCents).toBe(BigInt(expected.unrestricted)); expect(actual.priorityCost).toBe(expected.cost);
      expect(() => validateAllocation(input, actual.edges)).not.toThrow();
    }
    expect(allocate({ ...input, funds: [...input.funds].reverse(), lines: [...input.lines].reverse(), reservations: [...input.reservations].reverse() })).toEqual(actual);
  }), { numRuns: 250, seed: 1342026 });
});
