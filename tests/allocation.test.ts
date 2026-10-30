import { expect, it } from "vitest";
import { allocate } from "../src/domain/allocate";
import { naive } from "../src/domain/naive";
import { policyEligibility, validateAllocation, type AllocationInput, type AllocationResult } from "../src/domain/model";
import { fixture } from "./fixtures/allocation";
const pairs = (result: AllocationResult) => result.edges.map(edge => [edge.fundId, edge.lineId, edge.amountCents]);
const encode = (input: unknown) => JSON.stringify(input, (_key, value) => typeof value === "bigint" ? value.toString() : value);
it("SOL-01: computes the unique fixture split with versioned reasons and exact totals", () => {
  const input = fixture(); const result = allocate(input);
  expect(result.status).toBe("FUNDED");
  expect(pairs(result)).toEqual([["fund_b", "L1", 20000n], ["fund_a", "L1", 8000n], ["fund_a", "L2", 15000n], ["fund_g", "L3", 7000n]]);
  if (result.status !== "FUNDED") return;
  expect(result.unrestrictedCents).toBe(7000n);
  for (const edge of result.edges) { expect(edge.policyVersion).toBe(1); expect(edge.solverPriorityVersion).toBe(1); expect(edge.reason).toContain(input.funds.find(fund => fund.id === edge.fundId)!.name); }
  expect(result.edges[0]!.reason).toContain("breadth 1");
  expect(result.edges.at(-1)!.reason).toContain("no restricted fund policy");
  expect(() => validateAllocation(input, result.edges)).not.toThrow();
});
it("SOL-02: follows the comparison-only baseline and preserves the expected 130 dollars", () => {
  const input = fixture(); const baseline = naive(input); const optimal = allocate(input);
  expect(pairs(baseline)).toEqual([["fund_a", "L1", 28000n], ["fund_a", "L2", 2000n], ["fund_g", "L2", 13000n], ["fund_g", "L3", 7000n]]);
  if (baseline.status !== "FUNDED" || optimal.status !== "FUNDED") throw new Error("Fixture must be feasible");
  expect(baseline.unrestrictedCents).toBe(20000n); expect(baseline.unrestrictedCents - optimal.unrestrictedCents).toBe(13000n);
  expect(() => validateAllocation(input, baseline.edges)).not.toThrow();
});
it("SOL-03: rejects a forced participant meals edge with the STEM policy reason", () => {
  const input = fixture();
  expect(() => validateAllocation(input, [{ fundId: "fund_b", lineId: "L3", amountCents: 7000n, policyVersion: 1, solverPriorityVersion: 1, reason: "Forced edge" }])).toThrow(/Tallow Creek Robot Kit Initiative policy v1: does not allow category participant_meals/);
});
it("IAC-346: the fixture comparison advantage disappears when kit-only funding sorts first", () => {
  const original = fixture();
  const input = { ...original, funds: original.funds.map(fund => ({ ...fund, id: fund.id === "fund_b" ? "fund_0" : fund.id })) };
  const baseline = naive(input); const optimal = allocate(input);
  if (baseline.status !== "FUNDED" || optimal.status !== "FUNDED") throw new Error("Fixture must be feasible");
  expect(baseline.unrestrictedCents).toBe(7000n);
  expect(optimal.unrestrictedCents).toBe(7000n);
});
it("shares one remaining budget cap across kits and notebooks after prior debits", () => {
  const original = fixture();
  const input: AllocationInput = { ...original, funds: original.funds.map(fund => fund.id === "fund_b" ? { ...fund, balanceCents: 0n } : fund), priorDebits: [{ fundId: "fund_a", budgetLine: "supplies", amountCents: 20000n }] };
  const result = allocate(input);
  if (result.status !== "FUNDED") throw new Error("General covers the remainder");
  expect(result.edges.filter(edge => edge.fundId === "fund_a").reduce((sum, edge) => sum + edge.amountCents, 0n)).toBe(10000n);
  expect(result.unrestrictedCents).toBe(40000n);
  expect(() => validateAllocation(input, result.edges)).not.toThrow();
  expect(() => validateAllocation(input, [{ fundId: "fund_a", lineId: "L1", amountCents: 11000n, policyVersion: 1, solverPriorityVersion: 1, reason: "Too much" }])).toThrow("shared budget-line capacity");
});
it("excludes its own reservations but subtracts other active reservations from fund and budget capacities", () => {
  const original = fixture();
  const input: AllocationInput = { ...original, decisionId: "own", priorDebits: [{ fundId: "fund_a", budgetLine: "supplies", amountCents: 5000n }], reservations: [
    { decisionId: "own", fundId: "fund_a", budgetLine: "supplies", active: true, amountCents: 20000n },
    { decisionId: "other", fundId: "fund_a", budgetLine: "supplies", active: true, amountCents: 1000n },
    { decisionId: "inactive", fundId: "fund_a", budgetLine: "supplies", active: false, amountCents: 30000n },
  ] };
  const result = allocate(input); if (result.status !== "FUNDED") throw new Error("Fixture remains feasible");
  expect(result.unrestrictedCents).toBe(7000n);
  const withoutOwner = allocate({ ...input, decisionId: undefined });
  if (withoutOwner.status !== "FUNDED") throw new Error("General still covers it");
  expect(withoutOwner.unrestrictedCents).toBe(26000n);
});
it("returns no partial allocations and a deterministic per-line deficit when demand cannot be funded", () => {
  const original = fixture(); const input = { ...original, funds: original.funds.map(fund => fund.id === "fund_g" ? { ...fund, balanceCents: 0n } : fund) };
  expect(allocate(input)).toEqual({ status: "INFEASIBLE", edges: [], unfunded: [{ lineId: "L3", amountCents: 7000n }] });
  expect(naive(input).status).toBe("INFEASIBLE"); expect(naive(input).edges).toEqual([]);
});
it.each(["category", "program", "period"])("applies the %s policy rule before considering money", rule => {
  const original = fixture(); const line = original.lines[0]!;
  const input: AllocationInput = rule === "program" ? { ...original, program: "football", funds: original.funds.slice(0, 2) } : rule === "period" ? { ...original, lines: original.lines.map(row => ({ ...row, incurredOn: "2028-01-01" })), funds: original.funds.slice(0, 2) } : { ...original, prohibitedCategories: [line.category] };
  expect(allocate(input).status).toBe("INFEASIBLE");
});
it("includes both policy boundary dates", () => {
  const input = fixture(); const fund = input.funds[1]!;
  for (const incurredOn of ["2026-10-01", "2026-12-31"]) expect(policyEligibility(input, fund, { ...input.lines[0]!, incurredOn }).eligible).toBe(true);
});
it("is deterministic across repeated calls and input permutations without mutating snapshots", () => {
  const input = fixture(); const before = encode(input); const expected = allocate(input);
  for (let i = 0; i < 5; i++) expect(allocate(input)).toEqual(expected);
  expect(allocate({ ...input, funds: [...input.funds].reverse(), lines: [...input.lines].reverse() })).toEqual(expected);
  expect(encode(input)).toBe(before);
});
it("preserves minimum unrestricted spend when scalar v1 weights exceed their small-instance range", () => {
  const original = fixture(); const broad = original.funds[0]!;
  const categories = ["robot_kits_parts", ...Array.from({ length: 1000 }, (_, index) => `category_${index}`)];
  const input: AllocationInput = { ...original, lines: [{ ...original.lines[0]!, amountCents: 1n }], funds: [{ ...broad, balanceCents: 1n, policy: { ...broad.policy, allowedCategories: categories, breadth: categories.length }, budgetLines: [{ id: "supplies", capCents: 1n }] }, { ...original.funds[2]!, balanceCents: 1n }] };
  const result = allocate(input); if (result.status !== "FUNDED") throw new Error("One cent is feasible");
  expect(result.unrestrictedCents).toBe(0n); expect(result.priorityCost).toBe(1001000n);
  expect(result.priorityCost).toBeGreaterThan(1000000n); // Scalar-only minimization would prefer General.
});
it("keeps amounts exact beyond Number.MAX_SAFE_INTEGER", () => {
  const original = fixture(); const amountCents = 9007199254740993n;
  const input = { ...original, funds: [{ ...original.funds[2]!, balanceCents: amountCents }], lines: [{ ...original.lines[0]!, amountCents }] };
  const result = allocate(input); if (result.status !== "FUNDED") throw new Error("General covers the full amount");
  expect(result.unrestrictedCents).toBe(amountCents); expect(result.priorityCost).toBe(amountCents * 1000000n);
});
it("refuses malformed money, dates, duplicate IDs, and incomplete budget snapshots", () => {
  const input = fixture();
  expect(() => allocate({ ...input, lines: [{ ...input.lines[0]!, amountCents: 0n }] })).toThrow("bigint cents");
  expect(() => allocate({ ...input, lines: [{ ...input.lines[0]!, incurredOn: "2026-02-30" }] })).toThrow("calendar date");
  expect(() => allocate({ ...input, lines: [input.lines[0]!, input.lines[0]!] })).toThrow("Duplicate");
  expect(() => allocate({ ...input, funds: input.funds.map(fund => fund.id === "fund_a" ? { ...fund, budgetLines: [] } : fund) })).toThrow("Missing Ashmere County Afterschool STEM Subgrant budget line");
});
