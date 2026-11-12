import { describe, expect, it } from "vitest";
import {
  APPROVAL_PHRASES, GIFT_STATE_SENTENCES, GIFT_STATE_SENTENCES_BY_PATH, STEP3_APPROVED, STEP3_PENDING_TITLE, buildGiftTrail, donorPageSentence, type TrailApplication, type TrailInput,
} from "../src/donation/trail";
import { autoRecognizedSent, classifyApprovalPath } from "../src/fund-modes/recorded-path";

// IAC-405 PR GT ("Gift trail names the approval path"), tests GTA-01 onward. The ids GT-06 to GT-18 belong to tests/gift-trail.test.ts (IAC-413), so these use GTA.
// Pure: no database, no clock, no network.
const BATCH = "PAYOUTBATCH1234567890ABCDEF";
const app = (over: Partial<TrailApplication> = {}): TrailApplication => ({ lineDescription: "Classroom supplies", vendor: "Maple Street Stationers", appliedCents: 2500n, lineCents: 5000n, approvalCount: 0, approvalPath: null, payout: "NO_PAYMENT", batchId: null, ...over });
const input = (applications: TrailApplication[], over: Partial<TrailInput> = {}): TrailInput => ({
  grossCents: applications.reduce((sum, row) => sum + row.appliedCents, 0n), unspentCents: 0n, fundName: "Ashmere", effectiveOn: "2026-11-04", applications, ...over });
const AUTO = (over: Partial<TrailApplication> = {}) => app({ approvalPath: "AUTOPILOT", approvalCount: 0, ...over });
const ONE = (over: Partial<TrailApplication> = {}) => app({ approvalPath: "ONE_PERSON", approvalCount: 1, ...over });
const TWO = (over: Partial<TrailApplication> = {}) => app({ approvalPath: "TWO_PEOPLE", approvalCount: 2, ...over });
const PAID = { payout: "PAID", batchId: BATCH } as const;

describe("GTA-01 to GTA-03 each path names itself", () => {
  it("GTA-01: an Autopilot PAID line reads approved under Autopilot guardrails, state PAID, step 4 done with the batch tail", () => {
    const trail = buildGiftTrail(input([AUTO(PAID)]));
    expect(trail.state).toBe("PAID"); expect(trail.approval).toBe("AUTOPILOT");
    expect(trail.steps[2]).toEqual({ id: 3, state: "done", title: "Approved under Autopilot guardrails", detail: "Every rule passed. No person was needed" });
    expect(trail.steps[3]).toEqual({ id: 4, state: "done", title: "Paid through PayPal", detail: `Paid, batch ending ${trail.lines[0]!.batchTail}` });
    expect(trail.lines[0]!.batchTail).toBeTruthy();
    expect(trail.stateSentence).toBe("Your gift was applied, approved under Autopilot guardrails and paid through PayPal.");
    expect(donorPageSentence(trail)).toContain("It was approved under Autopilot guardrails.");
    expect(donorPageSentence(trail)).not.toContain("Two people");
  });
  it("GTA-02: an Autopilot line before and during payout gives the APPROVED and PAYING sentences", () => {
    expect(buildGiftTrail(input([AUTO()])).stateSentence).toBe("Your gift was applied to a receipt line and approved under Autopilot guardrails.");
    const paying = buildGiftTrail(input([AUTO({ payout: "PROCESSING" })]));
    expect(paying.state).toBe("PAYING");
    expect(paying.stateSentence).toBe("Your gift was applied and approved under Autopilot guardrails. The payout is not complete yet.");
    expect(paying.steps[3]!.state).toBe("cur");
  });
  it("GTA-03: one person after AI checks and two people each get their own step 3 and sentences", () => {
    const one = buildGiftTrail(input([ONE(PAID)]));
    expect(one.steps[2]).toEqual({ id: 3, state: "done", title: "Approved by one person after AI checks", detail: "One person approved, no holds found" });
    expect(one.stateSentence).toBe("Your gift was applied, approved by one person after AI checks and paid through PayPal.");
    expect(donorPageSentence(one)).toContain("One person approved it after AI checks.");
    const two = buildGiftTrail(input([TWO(PAID)]));
    expect(two.steps[2]).toEqual({ id: 3, state: "done", title: "Approved by two people", detail: "Two people approved" });
    expect(two.stateSentence).toBe(GIFT_STATE_SENTENCES.PAID);
    expect(donorPageSentence(two)).toContain("Two people approved it.");
  });
});

describe("GTA-04 to GTA-07 mixed, takeover, zero lines and legacy input", () => {
  it("GTA-04: mixed paths read Approved with All N lines approved, and the plain sentences", () => {
    const trail = buildGiftTrail(input([AUTO(PAID), TWO({ ...PAID, batchId: BATCH })]));
    expect(trail.approval).toBe("MIXED");
    expect(trail.steps[2]).toEqual({ id: 3, state: "done", title: "Approved", detail: "All 2 lines approved" });
    expect(trail.stateSentence).toBe("Your gift was applied, approved and paid through PayPal.");
    expect(donorPageSentence(trail)).toContain("It was approved.");
    expect(buildGiftTrail(input([ONE(), AUTO()])).approval).toBe("MIXED");
  });
  it("GTA-05: one line not approved keeps Waiting for approvals even when another is Autopilot, and a takeover with one approval stays waiting", () => {
    const partly = buildGiftTrail(input([AUTO(PAID), app()]));
    expect(partly.state).toBe("MATCHED"); expect(partly.approval).toBeNull();
    expect(partly.steps[2]).toEqual({ id: 3, state: "cur", title: STEP3_PENDING_TITLE, detail: "Waiting for approvals" });
    expect(partly.steps[3]).toEqual({ id: 4, state: "fut", title: "Paid through PayPal", detail: "Not sent yet" });
    const takeover = buildGiftTrail(input([app({ approvalCount: 1, approvalPath: classifyApprovalPath({ autoRecognized: true, noHolds: false, approvalCount: 1, disbursed: true }) })]));
    expect(takeover.state).toBe("MATCHED");
    expect(takeover.steps[2]).toEqual({ id: 3, state: "cur", title: "Approved by two people", detail: "Waiting for approvals" });
    expect(takeover.stateSentence).toBe("Your gift was applied to a receipt line. It is waiting for approvals.");
    expect(donorPageSentence(takeover)).toBeNull();
  });
  it("GTA-06: zero lines is unchanged, and an input with no path reads two approvals as two people and fewer as waiting", () => {
    const waiting = buildGiftTrail({ grossCents: 2500n, unspentCents: 2500n, fundName: "Ashmere", effectiveOn: "2026-11-04", applications: [] });
    expect(waiting.state).toBe("WAITING"); expect(waiting.approval).toBeNull();
    expect(waiting.steps.map(step => [step.title, step.state, step.detail])[2]).toEqual(["Approved by two people", "fut", "Not started"]);
    const legacy = (count: number) => buildGiftTrail(input([{ ...app(), approvalPath: undefined, approvalCount: count }]));
    expect(legacy(2).approval).toBe("TWO_PEOPLE"); expect(legacy(1).approval).toBeNull(); expect(legacy(0).state).toBe("MATCHED");
  });
  it("GTA-07: the exported wording is fixed, names no person count for Autopilot and no model output", () => {
    expect(APPROVAL_PHRASES).toEqual({ TWO_PEOPLE: "approved by two people", AUTOPILOT: "approved under Autopilot guardrails", ONE_PERSON: "approved by one person after AI checks", MIXED: "approved" });
    expect(STEP3_APPROVED.AUTOPILOT).toEqual({ title: "Approved under Autopilot guardrails", detail: "Every rule passed. No person was needed" });
    const autopilotText = JSON.stringify([STEP3_APPROVED.AUTOPILOT, GIFT_STATE_SENTENCES_BY_PATH.AUTOPILOT]);
    expect(autopilotText).not.toMatch(/two people|one person|\b[0-9]+ people|model|Claude|Qwen/i);
  });
});

describe("GTA-08 the recorded path classifier", () => {
  const facts = (over: Partial<Parameters<typeof classifyApprovalPath>[0]>) => classifyApprovalPath({ autoRecognized: false, noHolds: false, approvalCount: 0, disbursed: false, ...over });
  it("GTA-08: AUTO_RECOGNIZED with no approval and a disbursement is AUTOPILOT, and every other combination follows the table", () => {
    expect(facts({ autoRecognized: true, disbursed: true })).toBe("AUTOPILOT");
    expect(facts({ autoRecognized: true, disbursed: false })).toBeNull();
    expect(facts({ autoRecognized: true, disbursed: true, approvalCount: 1 })).toBeNull();
    expect(facts({ autoRecognized: true, disbursed: true, approvalCount: 2 })).toBe("TWO_PEOPLE");
    expect(facts({ noHolds: true, approvalCount: 1 })).toBe("ONE_PERSON");
    expect(facts({ noHolds: true, approvalCount: 0 })).toBeNull();
    expect(facts({ noHolds: true, approvalCount: 2 })).toBe("TWO_PEOPLE");
    expect(facts({ approvalCount: 1 })).toBeNull();
    expect(facts({ approvalCount: 2 })).toBe("TWO_PEOPLE");
    expect(facts({ disbursed: true })).toBeNull();
    expect(autoRecognizedSent(false, true)).toBe(true); expect(autoRecognizedSent(true, true)).toBe(false); expect(autoRecognizedSent(false, false)).toBe(false);
  });
});
