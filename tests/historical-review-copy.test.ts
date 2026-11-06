import { describe, expect, it } from "vitest";
import { historicalReviewLine } from "../src/app/claims/[claimId]/payment-line";

describe("historical PayPal event review wording", () => {
  it("HWR-09: the notice names the earlier attempt, says to check both in PayPal, says retries wait, and claims nothing about payment", () => {
    expect(historicalReviewLine(1)).toBe("PayPal reported on earlier attempt 1 after a retry. Check both attempts in PayPal before relying on this payment. Retries wait until a person records the check.");
    expect(historicalReviewLine(3)).toContain("earlier attempt 3");
    expect(historicalReviewLine(2)).not.toMatch(/\bpaid\b|settled|failed/i);
    expect(historicalReviewLine(2)).not.toMatch(/[\u2013\u2014]/);
  });
});
