import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PolicyChecks } from "../src/app/claims/[claimId]/policy-checks";
import { approverLede } from "../src/app/home-copy";
import { aiCard, paypalCard, railLines, type Stage } from "../src/app/shell-copy";
import { traceSteps } from "../src/app/trace";
import * as review from "../src/fund-modes/review-copy";
import { POLICY_FOOTER } from "../src/policy/copy";

// IAC-405 PR A follow-up (docs/ASSUMPTIONS.md section 77 item 13), AS-35 to AS-39 and AS-42. A claim whose stored decision needs one approval (Assisted, no holds found) stops saying two.
// Every other claim, and every page with the flag off, keeps its old words byte for byte. The choice is made on the server from the stored decision (reviewMode), never from the client.
// Pure functions, one static render and source checks. No database, no network, no browser. The pages themselves are checked in e2e/fund-modes-bulk.spec.ts (AS-40, AS-41).
const ai = aiCard({ applicable: true, suggestion: "READY", confirmed: true, aiAccepted: false, savedModel: "Claude Haiku 5.5", configured: { name: "Claude Haiku 5.5", shellName: "Claude Haiku" } });
const STAGES: Stage[] = [1, 2, 3, 4, 5];
const paypalFor = (stage: Stage) => stage === 5 ? paypalCard({ claimStatus: "APPROVED", approvals: 2, payout: null }) : paypalCard({ claimStatus: "AWAITING_APPROVAL", approvals: 0, payout: null });
const page = readFileSync("src/app/claims/[claimId]/page.tsx", "utf8");
const render = (props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(PolicyChecks, { claimId: "c1", decisionHash: "a".repeat(64), run: { id: "r", startedAt: new Date("2026-10-31T12:00:00Z"), trigger: "APPROVER", flags: [], notChecked: [], model: null } as never, canRun: false, ...props }));

describe("AS-35 the approvals heading", () => {
  it("is Human review for a one-approval claim and Two independent approvals otherwise", () => {
    expect(review.APPROVALS_HEADING_ONE).toBe("Human review");
    expect(page).toContain('{oneApproval ? APPROVALS_HEADING_ONE : "Two independent approvals"}');
  });
});

describe("AS-36 the trace Approvals step shows the required count", () => {
  it("reads People: n of 1 at stage 5 with required 1, and People: n of 2 without it", () => {
    const paypal = paypalFor(5);
    expect(railLines({ stage: 5, typedReceipt: true, ai, approvals: 1, paypal, required: 1 })[3]!.state).toBe("People: 1 of 1");
    expect(railLines({ stage: 5, typedReceipt: true, ai, approvals: 1, paypal })[3]!.state).toBe("People: 1 of 2");
    const steps = traceSteps({ stage: 5, typedReceipt: true, ai, approvals: 1, paypal, required: 1 });
    expect(steps[4]!.detail).toBe("People: 1 of 1");
  });
  it("says one person or one approver before the approvals exist, and keeps the two-person words without required", () => {
    const paypal = paypalFor(4);
    expect(railLines({ stage: 4, typedReceipt: true, ai, approvals: 0, paypal, required: 1 })[3]!.state).toBe("One person");
    expect(railLines({ stage: 3, typedReceipt: true, ai, approvals: 0, paypal, required: 1 })[3]!.state).toBe("Locked. One approver");
    expect(railLines({ stage: 4, typedReceipt: true, ai, approvals: 0, paypal })[3]!.state).toBe("Two different people");
    expect(railLines({ stage: 3, typedReceipt: true, ai, approvals: 0, paypal })[3]!.state).toBe("Locked. Two approvers");
  });
});

describe("AS-37 the policy footer", () => {
  it("is the old Holds sentence by default and the fixed one-approver sentences when the page passes them", () => {
    expect(render()).toContain(`<p class="muted">${POLICY_FOOTER}</p>`);
    expect(render({ footer: review.FOOTER_NO_HOLDS_DONE })).toContain('<p class="muted">No holds found, so one approver was enough.</p>');
    expect(render({ footer: review.FOOTER_NO_HOLDS_DONE })).not.toContain("Two approvers are still required");
    expect(review.FOOTER_NO_HOLDS_WAITING).toBe("No holds found, so one approver is enough.");
    expect(render({ footer: review.FOOTER_NO_HOLDS_DONE }).replace(review.FOOTER_NO_HOLDS_DONE, POLICY_FOOTER)).toBe(render());
  });
  it("the page passes a footer only for a one-approval claim, waiting or done", () => {
    expect(page).toContain('{...(oneApproval ? { footer: claim.status === "AWAITING_APPROVAL" ? FOOTER_NO_HOLDS_WAITING : FOOTER_NO_HOLDS_DONE } : {})}');
  });
});

describe("AS-38 the reference sentence", () => {
  it("is The approval binds this reference for one approval and Both approvals bind this reference otherwise", () => {
    expect(review.REFERENCE_BINDS_ONE).toBe("The approval binds this reference.");
    expect(page).toContain('{oneApproval ? REFERENCE_BINDS_ONE : "Both approvals bind this reference."}');
  });
});

describe("AS-39 the queue introduction", () => {
  const base = "Check the items, the recipient and the funding. Two different approvers must approve the same frozen terms before anything is payable.";
  it("appends one fixed sentence only when the page read an assisted claim, and is unchanged otherwise", () => {
    expect(approverLede(3)).toBe(base); expect(approverLede(3, false)).toBe(base);
    expect(approverLede(3, true)).toBe(`${base} In Assisted funds, a claim with no holds needs one approver.`);
    expect(approverLede(0, true)).toBe(approverLede(0));
  });
  it("the home page passes the flag from the server read of the assisted map", () => {
    expect(readFileSync("src/app/page.tsx", "utf8")).toContain("approverLede(queue.rows.length, assisted !== undefined)");
  });
});

describe("AS-42 Manual and flag-off pages stay byte-identical, and the one-approval choice has one source", () => {
  it("every stage and count gives the same rail lines and trace with required absent as before", () => {
    for (const stage of STAGES) for (const approvals of [null, 0, 1, 2]) {
      const input = { stage, typedReceipt: true, ai, approvals, paypal: paypalFor(stage) };
      expect(railLines(input)).toEqual(railLines({ ...input, required: undefined } as never));
      expect(traceSteps(input)).toEqual(traceSteps({ ...input, required: undefined } as never));
      for (const line of railLines(input)) expect(line.state).not.toMatch(/One person|One approver| of 1$/);
    }
  });
  it("the old sentences are still in the source for the default path", () => {
    for (const old of ['"Two independent approvals"', '"Both approvals bind this reference."', '"Frozen. Awaiting two approvals."']) expect(page).toContain(old);
    expect(POLICY_FOOTER).toBe("Holds do not block approval. Two approvers are still required.");
  });
  it("oneApproval comes only from the server read reviewMode, never from the request", () => {
    expect(page.match(/const oneApproval = [^;]+;/g)).toEqual(['const oneApproval = view.reviewMode === "ASSISTED_NO_HOLDS";']);
  });
  it("the fixed sentences have no dash and none of the words cleared, passed or approved for a check", () => {
    for (const sentence of Object.values(review)) { expect(sentence).not.toMatch(/[\u2013\u2014]/); expect(sentence).not.toMatch(/\b(cleared|passed)\b/i); }
  });
});
