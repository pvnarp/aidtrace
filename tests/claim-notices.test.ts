import { describe, expect, it } from "vitest";
import { claimFailureNotice, claimFailureNotices } from "../src/server/claim-notices";

describe("Safe claim action feedback", () => {
  it("distinguishes reviewable application failures without returning exception text", () => {
    expect(claimFailureNotice(new Error("The same approver cannot approve twice"))).toBe("already-approved");
    expect(claimFailureNotice(new Error("Current receipt categories require human confirmation"))).toBe("receipt-review-required");
    expect(claimFailureNotice(new Error("Provider item binding failed; no accounting change"))).toBe("provider-review-required");
    expect(claimFailureNotices["provider-review-required"]).toContain("Do not send again");
  });
  it("withholds arbitrary, nested and provider-shaped errors", () => {
    const privateText = "recipient=private@example.invalid credential=do-not-print";
    for (const error of [new Error(privateText), { message: privateText }, new Error("database failed", { cause: new Error(privateText) }), null]) {
      const code = claimFailureNotice(error);
      expect(code).toBe("action-failed");
      expect(claimFailureNotices[code]).not.toContain(privateText);
    }
  });
});
