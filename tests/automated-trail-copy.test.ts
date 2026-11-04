import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { count, lineOf } from "../src/app/claims/[claimId]/automated-trail-copy";

// AU-54 and AU-55 (IAC-405 guardrail trail plurals, docs/ASSUMPTIONS.md section 78 wording, GATE_REPORT section 76). Pure functions and a static source pin: no database, network or clock.
const COPY = "src/app/claims/[claimId]/automated-trail-copy.ts";

describe("AU-54 the trail reads one line singular and every other count plural", () => {
  it("count: 1 and \"1\" are singular, other numbers and digit strings are plural, anything else is none", () => {
    expect(count(1, "line", "lines")).toBe("1 line");
    expect(count("1", "line", "lines")).toBe("1 line");
    expect(count(0, "line", "lines")).toBe("0 lines");
    expect(count(2, "line", "lines")).toBe("2 lines");
    expect(count("12", "line", "lines")).toBe("12 lines");
    expect(count(2.5, "line", "lines")).toBe("2.5 lines");
    for (const other of [undefined, null, "", "x", "1.0", true, {}, []]) expect(count(other, "line", "lines")).toBe("none lines");
  });
  it("G1 reads 1 line, 1 check for one pair and plural otherwise", () => {
    expect(lineOf("G1", { okLines: 1, checkedPairs: 1 })).toBe("Rules and AI agreed on every line (1 line, 1 check).");
    expect(lineOf("G1", { okLines: 2, checkedPairs: 3 })).toBe("Rules and AI agreed on every line (2 lines, 3 checks).");
    expect(lineOf("G1", { okLines: "1", checkedPairs: "2" })).toBe("Rules and AI agreed on every line (1 line, 2 checks).");
    expect(lineOf("G1", { okLines: "2", checkedPairs: "1" })).toBe("Rules and AI agreed on every line (2 lines, 1 check).");
    expect(lineOf("G1", {})).toBe("Rules and AI agreed on every line (none lines, none checks).");
  });
  it("G2 drops \"each\" for one line", () => {
    expect(lineOf("G2", { lines: 1, suppliesCapCents: "30000", equipmentCapCents: "50000" })).toBe("1 line, within its cap: supplies up to $300.00, equipment up to $500.00.");
    expect(lineOf("G2", { lines: "1", suppliesCapCents: "30000", equipmentCapCents: "50000" })).toBe("1 line, within its cap: supplies up to $300.00, equipment up to $500.00.");
    expect(lineOf("G2", { lines: 3, suppliesCapCents: "30000", equipmentCapCents: "50000" })).toBe("3 lines, each within its cap: supplies up to $300.00, equipment up to $500.00.");
  });
  it("G3 reads 1 paying fund and N paying funds", () => {
    expect(lineOf("G3", { capCents: "100000", funds: ["fund_a"] })).toBe("Fund total for the UTC day stays within $1,000.00 (1 paying fund).");
    expect(lineOf("G3", { capCents: "100000", funds: ["fund_a", "fund_b"] })).toBe("Fund total for the UTC day stays within $1,000.00 (2 paying funds).");
    expect(lineOf("G3", { capCents: "100000" })).toBe("Fund total for the UTC day stays within $1,000.00 (0 paying funds).");
  });
  it("G4 to G8 and the default branch are unchanged", () => {
    expect(lineOf("G4", { usedCents: "0", claimCents: "4200", capCents: "50000" })).toBe("This claimant's automated total over 7 days was $0.00 before this claim of $42.00; the limit is $500.00.");
    expect(lineOf("G5", { priorClaim: "clm_1" })).toBe("Earlier claim by the same claimant, paid after two human approvals: clm_1.");
    expect(lineOf("G6", { days: 14, anchorSeenAt: "2026-10-01T10:00:00Z" })).toBe("Payout email unchanged for 14 days, first seen 2026-10-01.");
    expect(lineOf("G6", { days: 14, anchorSeenAt: "2026-10-01T10:00:00Z", demoHistory: true })).toBe("Payout email unchanged for 14 days, from demo history first seen 2026-10-01.");
    expect(lineOf("G7", { draw: 42, samplePercent: 10 })).toBe("Audit draw 42 of 0 to 99; a draw below 10 goes to two approvers, so this claim was not sampled.");
    expect(lineOf("G8", {})).toBe("The automation switch was on and no automated payment was unresolved.");
    expect(lineOf("anything", {})).toBe("The automation switch was on and no automated payment was unresolved.");
  });
});

describe("AU-55 the wording module is pure", () => {
  it("imports no database, server or React module", () => {
    const source = readFileSync(COPY, "utf8");
    const imports = [...source.matchAll(/^import .* from "([^"]+)";?$/gm)].map(match => match[1]);
    expect(imports).toEqual(["../../../analytics/model"]);
    expect(source).not.toMatch(/drizzle|db\/schema|server\/db|from "react|next\/|server-only/);
  });
});
