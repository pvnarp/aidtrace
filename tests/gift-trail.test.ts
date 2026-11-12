import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GIFT_ATTRIBUTION_POLICY } from "../src/donation/attribution";
import { NOTE_FACT_SET, renderTemplateNote, type NoteFacts, type PayoutNoteStatus } from "../src/donation/note";
import {
  GIFT_METHOD_SENTENCE, GIFT_STATE_SENTENCES, MAX_DESCRIPTION_CHARACTERS, MAX_VENDOR_CHARACTERS, TrailInvariantError, buildGiftTrail, donorPageSentence, rollupPayout,
  type TrailApplication, type TrailInput,
} from "../src/donation/trail";

// IAC-413 PR A (tests GT-06 to GT-15 and GT-18). Pure: no database, no clock, no network.
const BATCH = "PAYOUTBATCH1234567890ABCDEF";
const app = (over: Partial<TrailApplication> = {}): TrailApplication => ({ lineDescription: "Robot kit parts", vendor: "Maker Supply", appliedCents: 2500n, lineCents: 5000n, approvalCount: 2, payout: "NO_PAYMENT", batchId: null, ...over });
const input = (over: Partial<TrailInput> = {}): TrailInput => ({ grossCents: 2500n, unspentCents: 0n, fundName: "Tallow Creek Robot Kit Initiative", effectiveOn: "2026-10-22", applications: [app()], ...over });
const text = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
const states = (trail: ReturnType<typeof buildGiftTrail>) => trail.steps.map(step => step.state);

describe("GT-06 WAITING", () => {
  it("shows step 2 current, steps 3 and 4 future, with the exact sentence and details", () => {
    const trail = buildGiftTrail(input({ unspentCents: 2500n, applications: [] }));
    expect(trail.state).toBe("WAITING");
    expect(trail.stateSentence).toBe("Your gift has arrived. It is waiting for a matching receipt.");
    expect(states(trail)).toEqual(["done", "cur", "fut", "fut"]);
    expect(trail.steps.map(step => step.detail)).toEqual(["$25.00 to Tallow Creek Robot Kit Initiative, October 22, 2026", "Waiting for a matching receipt", "Not started", "Not sent yet"]);
    expect(trail.steps.map(step => step.title)).toEqual(["Gift received", "Matched to a receipt", "Approved by two people", "Paid through PayPal"]);
    expect(trail.waiting).toBe("Still waiting: $25.00 of your gift has no matching receipt yet.");
    expect(trail.lines).toEqual([]);
    expect(donorPageSentence(trail)).toBeNull();
  });
});

describe("GT-07 MATCHED and APPROVED with no payment", () => {
  it("APPROVED: steps 1 to 3 done, step 4 future with Not sent yet", () => {
    const trail = buildGiftTrail(input());
    expect(trail.state).toBe("APPROVED");
    expect(trail.stateSentence).toBe(GIFT_STATE_SENTENCES.APPROVED);
    expect(states(trail)).toEqual(["done", "done", "done", "fut"]);
    expect(trail.steps[1]!.detail).toBe("1 receipt line from Maker Supply");
    expect(trail.steps[2]!.detail).toBe("Two people approved");
    expect(trail.steps[3]).toMatchObject({ detail: "Not sent yet", state: "fut" });
    expect(trail.waiting).toBeNull();
    expect(trail.lines[0]).toMatchObject({ payout: "NO_PAYMENT", payoutSentence: "No payment has been sent in this environment.", batchTail: null, share: "Your $25.00 of the $50.00 line" });
  });
  it("MATCHED: one approval is not enough, so step 3 is current and step 4 is future", () => {
    const trail = buildGiftTrail(input({ applications: [app({ approvalCount: 1 })] }));
    expect(trail.state).toBe("MATCHED");
    expect(trail.stateSentence).toBe("Your gift was applied to a receipt line. It is waiting for approvals.");
    expect(states(trail)).toEqual(["done", "done", "cur", "fut"]);
    expect(trail.steps[2]!.detail).toBe("Waiting for approvals");
    expect(donorPageSentence(trail)).toBeNull();
  });
  it("one unapproved line among approved ones keeps the whole gift MATCHED", () => {
    const trail = buildGiftTrail(input({ grossCents: 3000n, applications: [app({ appliedCents: 1500n }), app({ appliedCents: 1500n, approvalCount: 0, lineDescription: "Other" })] }));
    expect(trail.state).toBe("MATCHED");
  });
});

describe("GT-08 PAYING while PROCESSING", () => {
  it("step 4 is current with Processing", () => {
    const trail = buildGiftTrail(input({ applications: [app({ payout: "PROCESSING" })] }));
    expect(trail.state).toBe("PAYING");
    expect(states(trail)).toEqual(["done", "done", "done", "cur"]);
    expect(trail.steps[3]!.detail).toBe("Processing");
    expect(trail.lines[0]!.payoutSentence).toBe("The payout is processing.");
    expect(trail.stateSentence).toBe("Your gift was applied and approved by two people. The payout is not complete yet.");
  });
});

describe("GT-09 UNKNOWN and NEEDS_ATTENTION are never shown as failed, paid or done", () => {
  it("UNKNOWN reads Being verified and The payout outcome is being verified.", () => {
    const trail = buildGiftTrail(input({ applications: [app({ payout: "UNKNOWN" })] }));
    expect(trail.state).toBe("PAYING");
    expect(trail.steps[3]).toMatchObject({ state: "cur", detail: "Being verified" });
    expect(trail.lines[0]!.payoutSentence).toBe("The payout outcome is being verified.");
    expect(text(trail)).not.toMatch(/failed|error|declined/i);
    for (const output of [trail.steps[3]!.detail, trail.lines[0]!.payoutSentence, trail.stateSentence, donorPageSentence(trail) ?? ""]) {
      expect(output).not.toMatch(/failed|error|declined|\bpaid\b/i);
    }
    expect(trail.steps.filter(step => step.state === "done").map(step => step.id)).toEqual([1, 2, 3]);
    expect(donorPageSentence(trail)).toContain("The payout outcome is being verified.");
  });
  it("NEEDS_ATTENTION reads Needs attention under the same rule", () => {
    const trail = buildGiftTrail(input({ applications: [app({ payout: "NEEDS_ATTENTION" })] }));
    expect(trail.steps[3]).toMatchObject({ state: "cur", detail: "Needs attention" });
    expect(trail.lines[0]!.payoutSentence).toBe("The payout needs attention.");
    expect(text(trail)).not.toMatch(/failed|error|declined/i);
    for (const output of [trail.steps[3]!.detail, trail.lines[0]!.payoutSentence, trail.stateSentence, donorPageSentence(trail) ?? ""]) expect(output).not.toMatch(/\bpaid\b/i);
    expect(trail.steps.filter(step => step.state === "done").map(step => step.id)).toEqual([1, 2, 3]);
  });
});

describe("GT-10 PAID shows only the six-character tail of the batch ID", () => {
  it("ends the detail with the tail and never prints the full batch ID", () => {
    const trail = buildGiftTrail(input({ applications: [app({ payout: "PAID", batchId: BATCH })] }));
    expect(trail.state).toBe("PAID");
    expect(states(trail)).toEqual(["done", "done", "done", "done"]);
    expect(trail.steps[3]!.detail).toBe("Paid, batch ending ABCDEF");
    expect(trail.lines[0]).toMatchObject({ batchTail: "ABCDEF", payoutSentence: "Paid. PayPal payout batch ending ABCDEF." });
    expect(trail.payout).toEqual({ status: "PAID", paidLines: 1, totalLines: 1, batchTail: "ABCDEF" });
    expect(text(trail)).not.toContain(BATCH);
    expect(text(trail)).not.toContain("PAYOUTBATCH");
    expect(donorPageSentence(trail)).not.toContain(BATCH);
    expect(donorPageSentence(trail)).toContain("ending ABCDEF");
  });
  it("a PAID line with no batch ID fails closed", () => {
    expect(() => buildGiftTrail(input({ applications: [app({ payout: "PAID", batchId: null })] }))).toThrow(TrailInvariantError);
  });
});

describe("GT-11 one gift, two lines of one claim", () => {
  it("shows two cards, step 2 names the count and vendor, and the applied cents sum to matched", () => {
    const trail = buildGiftTrail(input({ grossCents: 4000n, applications: [app({ appliedCents: 1500n, lineDescription: "Servo motors" }), app({ appliedCents: 2500n, lineDescription: "Chassis" })] }));
    expect(trail.lines).toHaveLength(2);
    expect(trail.steps[1]!.detail).toBe("2 receipt lines from Maker Supply");
    expect(trail.lines.reduce((sum, line) => sum + line.appliedCents, 0n)).toBe(trail.matchedCents);
    expect(trail.matchedCents).toBe(4000n);
    expect(trail.steps[3]!.detail).toBe("Not sent yet");
  });
  it("names the vendor count when the lines have different vendors", () => {
    const trail = buildGiftTrail(input({ grossCents: 4000n, applications: [app({ appliedCents: 1500n }), app({ appliedCents: 2500n, vendor: "Other Supply" })] }));
    expect(trail.steps[1]!.detail).toBe("2 receipt lines from 2 vendors");
  });
});

describe("GT-12 one gift across two claims, one PAID and one NO_PAYMENT", () => {
  it("rolls up to partly paid with step 4 current", () => {
    const trail = buildGiftTrail(input({ grossCents: 4000n, applications: [app({ appliedCents: 1500n, payout: "PAID", batchId: BATCH }), app({ appliedCents: 2500n, vendor: "Other Supply" })] }));
    expect(trail.payout).toEqual({ status: "PARTLY_PAID", paidLines: 1, totalLines: 2, batchTail: null });
    expect(trail.state).toBe("PAYING");
    expect(trail.steps[3]).toMatchObject({ state: "cur", detail: "Paid for 1 of 2 lines" });
    expect(donorPageSentence(trail)).toContain("Paid for 1 of 2 lines.");
    expect(text(trail)).not.toContain(BATCH);
  });
  it("two paid lines roll up to PAID with the count and no single tail", () => {
    const trail = buildGiftTrail(input({ grossCents: 4000n, applications: [app({ appliedCents: 1500n, payout: "PAID", batchId: BATCH }), app({ appliedCents: 2500n, payout: "PAID", batchId: "OTHERBATCH987654321" })] }));
    expect(trail.state).toBe("PAID");
    expect(trail.steps[3]!.detail).toBe("Paid, all 2 lines");
    expect(trail.payout.batchTail).toBeNull();
    expect(donorPageSentence(trail)).toContain("Paid. All 2 lines were paid.");
  });
});

describe("GT-13 partly matched gifts and the invariant", () => {
  it("shows the exact remainder and matched plus unspent equals gross in BigInt", () => {
    const trail = buildGiftTrail(input({ grossCents: 10000n, unspentCents: 7500n }));
    expect(trail.waiting).toBe("Still waiting: $75.00 of your gift has no matching receipt yet.");
    expect(trail.matchedCents + trail.unspentCents).toBe(trail.grossCents);
    expect(typeof trail.matchedCents).toBe("bigint");
    expect(trail.steps[1]!.detail).toBe("$25.00 of $100.00 matched");
    expect(donorPageSentence(trail)).toContain("Part of your $100.00 gift was applied to");
  });
  it("throws TrailInvariantError for a forced mismatch and for impossible stored amounts", () => {
    expect(() => buildGiftTrail(input({ grossCents: 10000n, unspentCents: 7400n }))).toThrow(TrailInvariantError);
    expect(() => buildGiftTrail(input({ grossCents: 10000n, unspentCents: 7600n }))).toThrow(TrailInvariantError);
    expect(() => buildGiftTrail(input({ grossCents: 0n, unspentCents: 0n, applications: [] }))).toThrow(TrailInvariantError);
    expect(() => buildGiftTrail(input({ grossCents: 2500n, unspentCents: -1n, applications: [app({ appliedCents: 2501n })] }))).toThrow(TrailInvariantError);
    expect(() => buildGiftTrail(input({ grossCents: 2500n, unspentCents: 2500n, applications: [app({ appliedCents: 0n })] }))).toThrow(TrailInvariantError);
    expect(() => buildGiftTrail(input({ unspentCents: 2500n }))).toThrow(TrailInvariantError);
  });
});

describe("GT-14 roll-up precedence", () => {
  const order: PayoutNoteStatus[] = ["UNKNOWN", "NEEDS_ATTENTION", "PROCESSING", "NO_PAYMENT"];
  const permutations = <T,>(items: T[]): T[][] => items.length <= 1 ? [items] : items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest]));
  const subsets = <T,>(items: T[]): T[][] => items.reduce<T[][]>((all, item) => [...all, ...all.map(subset => [...subset, item])], [[]]).filter(subset => subset.length > 0);
  it("the first status in the order UNKNOWN, NEEDS_ATTENTION, PROCESSING, NO_PAYMENT wins for every subset in every arrangement", () => {
    let checked = 0;
    for (const subset of subsets(order)) for (const arrangement of permutations(subset)) {
      expect(rollupPayout(arrangement)).toBe(order.find(status => subset.includes(status)));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(30);
    expect(rollupPayout(["UNKNOWN", "NEEDS_ATTENTION"])).toBe("UNKNOWN");
    expect(rollupPayout(["NEEDS_ATTENTION", "PROCESSING"])).toBe("NEEDS_ATTENTION");
    expect(rollupPayout(["PROCESSING", "NO_PAYMENT"])).toBe("PROCESSING");
  });
  it("PAID wins only when every line is paid, otherwise it is partly paid", () => {
    expect(rollupPayout([])).toBe("NO_PAYMENT");
    expect(rollupPayout(["PAID"])).toBe("PAID");
    expect(rollupPayout(["PAID", "PAID"])).toBe("PAID");
    for (const other of order) expect(rollupPayout(["PAID", other])).toBe("PARTLY_PAID");
    expect(rollupPayout(["UNKNOWN", "PAID", "NO_PAYMENT"])).toBe("PARTLY_PAID");
  });
  it("an UNKNOWN line is never softened by a PROCESSING or NO_PAYMENT neighbour in a built trail", () => {
    const trail = buildGiftTrail(input({ grossCents: 4000n, applications: [app({ appliedCents: 1500n, payout: "PROCESSING" }), app({ appliedCents: 2500n, payout: "UNKNOWN" })] }));
    expect(trail.payout.status).toBe("UNKNOWN");
    expect(trail.steps[3]!.detail).toBe("Being verified");
  });
});

describe("GT-15 large amounts stay exact", () => {
  it("formats the donation order bound with no number conversion", () => {
    const bound = 9_999_999_999_999n;
    const trail = buildGiftTrail(input({ grossCents: bound, applications: [app({ appliedCents: bound, lineCents: bound })] }));
    expect(trail.gift.amount).toBe("$99,999,999,999.99");
    expect(trail.lines[0]!.share).toBe("Your $99,999,999,999.99 of the $99,999,999,999.99 line");
  });
  it("keeps cents beyond 2^53 exact", () => {
    const big = 9_007_199_254_740_993n;
    const trail = buildGiftTrail(input({ grossCents: big + 1n, unspentCents: 1n, applications: [app({ appliedCents: big, lineCents: big })] }));
    expect(trail.matchedCents).toBe(big);
    expect(trail.gift.amount).toBe("$90,071,992,547,409.94");
    expect(trail.waiting).toBe("Still waiting: $0.01 of your gift has no matching receipt yet.");
  });
  it("the trail module contains no Number(, parseFloat or toFixed", () => {
    const source = readFileSync("src/donation/trail.ts", "utf8");
    for (const banned of ["Number(", "parseFloat", "toFixed"]) expect(source.includes(banned)).toBe(false);
  });
});

describe("GT-18 the page sentence names no person", () => {
  it("has no approver name, donor name, claim ID, decision hash or Approved by", () => {
    const trail = buildGiftTrail(input({ applications: [app({ payout: "PAID", batchId: BATCH })] }));
    const sentence = donorPageSentence(trail)!;
    expect(sentence).toBe("Your $25.00 gift was applied to Robot kit parts from Maker Supply: $25.00 of the $50.00 line. Two people approved it. Paid. PayPal payout batch ending ABCDEF.");
    for (const forbidden of ["Approved by", "Thank you,", "Tara", "Ben", "Maria", "C-104", "A donor", "decision"]) expect(sentence).not.toContain(forbidden);
  });
  it("is null until every applied line is approved, and never invents a payout", () => {
    expect(donorPageSentence(buildGiftTrail(input({ unspentCents: 2500n, applications: [] })))).toBeNull();
    expect(donorPageSentence(buildGiftTrail(input({ applications: [app({ approvalCount: 1 })] })))).toBeNull();
    expect(donorPageSentence(buildGiftTrail(input()))).toContain("No payment has been sent in this environment.");
  });
});

describe("untrusted claimant text is cleaned and clipped, never trusted", () => {
  it("replaces control and bidirectional characters with spaces", () => {
    const trail = buildGiftTrail(input({ applications: [app({ lineDescription: "Servo\u0000motors\n‮evil done", vendor: "Maker\tSupply" })] }));
    expect(trail.lines[0]!.description).toBe("Servo motors evil done");
    expect(trail.lines[0]!.vendor).toBe("Maker Supply");
  });
  it("clips by code point at 120 and 80 characters and never splits a surrogate pair", () => {
    const emoji = "\u{1F600}";
    const description = `${"a".repeat(MAX_DESCRIPTION_CHARACTERS - 1)}${emoji}bbb`;
    const clipped = buildGiftTrail(input({ applications: [app({ lineDescription: description, vendor: "v".repeat(200) })] })).lines[0]!;
    expect(Array.from(clipped.description)).toHaveLength(MAX_DESCRIPTION_CHARACTERS);
    expect(clipped.description.endsWith(emoji)).toBe(true);
    expect(Array.from(clipped.vendor)).toHaveLength(MAX_VENDOR_CHARACTERS);
    expect(clipped.description).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
  it("falls back to fixed words when nothing printable is left", () => {
    const line = buildGiftTrail(input({ applications: [app({ lineDescription: "\u0000\n ", vendor: "\u0007" })] })).lines[0]!;
    expect(line.description).toBe("Receipt line");
    expect(line.vendor).toBe("A vendor");
  });
  it("keeps markup characters as plain text for the page to escape", () => {
    const line = buildGiftTrail(input({ applications: [app({ lineDescription: "<script>alert(1)</script>" })] })).lines[0]!;
    expect(line.description).toBe("<script>alert(1)</script>");
  });
});

describe("the method sentence matches the owner-accepted note sentence", () => {
  it("equals the sentence renderTemplateNote writes for the method fact", () => {
    const facts: NoteFacts = {
      version: NOTE_FACT_SET, gift: { donorName: "A donor", amountCents: "2500", fundName: "Tallow Creek Robot Kit Initiative", capturedOn: "2026-10-22" },
      lines: [{ lineId: "L1", description: "Robot kit parts", lineAmountCents: "5000", appliedCents: "2500", vendor: "Maker Supply" }],
      approvals: [{ name: "Tara", approvedOn: "2026-10-23" }, { name: "Ben", approvedOn: "2026-10-23" }],
      payout: { status: "NO_PAYMENT", batchId: null },
      optional: { "fund-policy": { fundName: "Tallow Creek Robot Kit Initiative", summary: "" }, "claim-total": { totalCents: "5000", split: [{ fundName: "Tallow Creek Robot Kit Initiative", amountCents: "5000" }] }, method: { policy: GIFT_ATTRIBUTION_POLICY } },
    };
    expect(renderTemplateNote(facts, { templateId: "thanks-first", optional: ["method"] })).toContain(GIFT_METHOD_SENTENCE);
  });
});
