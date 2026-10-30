import { expect, it } from "vitest";
import { proposalMoney, proposalPresentation } from "../src/proposal/presentation";
import type { ProposalResult } from "../src/proposal/types";
const result: ProposalResult = { summary: "HUMAN_REVIEW_REQUIRED", generalCents: "100", edges: [{ lineId: "L1", fundId: "fund_b", amountCents: "500", policyVersion: 1, solverPriorityVersion: 1, reason: "Approved policy permits this category." }], issues: [], steps: ["CATEGORIES_VALIDATED", "POLICY_PREVIEWED", "HUMAN_CONFIRMATION_REQUIRED"] };
it("AP-08: provisional money is exact server formatting and cannot imply approval", () => {
  const value = proposalPresentation({ state: "READY_FOR_REVIEW", errorCode: null, result }, { fund_b: "Tallow Creek Robot Kit Initiative" }, 600n);
  expect(value.split).toBe("$5.00 from restricted funds, $1.00 from General."); expect(value.heading).toBe("Provisional funding available");
  expect(value.edges[0]!.fund).toBe("Tallow Creek Robot Kit Initiative"); expect(value.message).toContain("does not reserve funds"); expect(value.steps.at(-1)).toContain("Waiting for your category confirmation");
  expect(proposalMoney(1n)).toBe("$0.01"); for (const value of ["1.2", "1e2", "-1", "NaN"]) expect(() => proposalMoney(value)).toThrow();
  expect(() => proposalPresentation({ state: "READY_FOR_REVIEW", errorCode: null, result }, {}, 50n)).toThrow();
});
it("AP-04/09: stale results hide all old financial content; unavailable and unknown stay actionable", () => {
  const stale = proposalPresentation({ state: "STALE", errorCode: null, result }, {}, 600n);
  expect(stale.split).toBeNull(); expect(stale.edges).toEqual([]); expect(stale.steps).toEqual([]);
  for (const code of ["TIMEOUT", "BUSY", "UNAVAILABLE"]) expect(proposalPresentation({ state: "UNAVAILABLE", errorCode: code, result: null }, {}, 600n).message).toMatch(/manually/);
  const unresolved = proposalPresentation({ state: "NEEDS_REVIEW", errorCode: "VALIDATION", result: null }, {}, 600n);
  expect(unresolved.heading).toBe("Category review needed"); expect(unresolved.split).toBeNull();
});
