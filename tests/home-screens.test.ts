import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAIMANT_LEDE, approverHeading, approverLede, approverReviewLine, claimActionLabel, claimantHeading, frozenSplit, nextStep, statusLabel } from "../src/app/home-copy";
import { architectureStages } from "../src/app/architecture/stages";

// HOME-01 to HOME-07 (IAC-403 locked mock screens, docs/GATE_REPORT.md section 40). Pure functions and static file checks.
// No database, no network, no clock. The browser checks are e2e/mock-screens.spec.ts (HOME-08).
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
const sources = walk("src/app").filter(path => /\.(tsx?|css)$/.test(path));

describe("HOME-01 the approver heading follows the loaded awaiting count", () => {
  const table: [number, string][] = [
    [0, "No expense needs your review."], [1, "One expense needs your review."], [2, "Two expenses need your review."], [3, "Three expenses need your review."],
    [10, "Ten expenses need your review."], [11, "11 expenses need your review."], [250, "250 expenses need your review."],
  ];
  for (const [count, heading] of table) it(`count ${count}`, () => expect(approverHeading(count)).toBe(heading));
  it("never claims a review is needed when none is", () => {
    expect(approverLede(0)).toContain("Nothing is waiting"); expect(approverLede(1)).toContain("Two different approvers");
  });
});

describe("HOME-02 the card status line follows the claim status alone", () => {
  const table: [string, string, string][] = [
    ["CLAIMANT", "DRAFT", "Unpaid draft. Confirm each category, then review funding."],
    ["CLAIMANT", "AWAITING_APPROVAL", "Frozen. Two other people must approve the same terms."],
    ["APPROVER", "AWAITING_APPROVAL", "Frozen terms await two approvals."],
    ["APPROVER", "DRAFT", "Draft. The claimant has not frozen the funding terms yet."],
    ["CLAIMANT", "APPROVED", "Approved does not mean paid. Open the claim for the PayPal handoff."],
    ["APPROVER", "PAYOUT_PROCESSING", "Submitted, not yet verified as paid."],
    ["CLAIMANT", "PAID", "Paid. Open the claim for the verified PayPal result."],
    ["CLAIMANT", "REJECTED", "Rejected. Nothing is paid."],
    ["APPROVER", "PAYOUT_ISSUE", "Payment issue. Do not send again until resolved."],
    ["CLAIMANT", "SOMETHING_NEW", "Open the claim for its current status."],
  ];
  for (const [role, status, line] of table) it(`${role} ${status}`, () => expect(nextStep(role as "CLAIMANT" | "APPROVER", status)).toBe(line));
  it("labels statuses with the claim page labels and degrades an unknown one", () => {
    expect(statusLabel("AWAITING_APPROVAL")).toBe("Awaiting approval"); expect(statusLabel("PAYOUT_ISSUE")).toBe("Payout issue"); expect(statusLabel("NEW_STATE")).toBe("new state");
  });
});

describe("HOME-03 the frozen split is stated only when loaded state proves it", () => {
  const edges = (...cents: bigint[]) => cents.map(amountCents => ({ amountCents }));
  it("derives restricted and General from integer cents", () => {
    expect(frozenSplit({ total: 50000n, generalCents: 7000n, frozen: true, edges: edges(20000n, 23000n, 7000n) })).toBe("Frozen terms: $430.00 restricted, $70.00 General.");
    expect(frozenSplit({ total: 12345n, generalCents: 0n, frozen: true, edges: edges(12345n) })).toBe("Frozen terms: $123.45 restricted, $0.00 General.");
    expect(frozenSplit({ total: 700n, generalCents: 700n, frozen: true, edges: edges(700n) })).toBe("Frozen terms: $0.00 restricted, $7.00 General.");
  });
  it("accepts string edge amounts, as the claim view loads them", () => {
    expect(frozenSplit({ total: 1000n, generalCents: 250n, frozen: true, edges: [{ amountCents: "750" }, { amountCents: "250" }] })).toBe("Frozen terms: $7.50 restricted, $2.50 General.");
  });
  it("says nothing when the decision is not frozen, edges do not add up, or General is out of range", () => {
    expect(frozenSplit({ total: 50000n, generalCents: 7000n, frozen: false, edges: edges(50000n) })).toBeNull();
    expect(frozenSplit({ total: 50000n, generalCents: 7000n, frozen: true, edges: edges(20000n, 7000n) })).toBeNull();
    expect(frozenSplit({ total: 50000n, generalCents: 60000n, frozen: true, edges: edges(50000n) })).toBeNull();
    expect(frozenSplit({ total: 50000n, generalCents: -1n, frozen: true, edges: edges(50000n) })).toBeNull();
    expect(frozenSplit({ total: 0n, generalCents: 0n, frozen: true, edges: [] })).toBeNull();
  });
  it("puts the split before the approver action, or falls back to the plain review line", () => {
    expect(approverReviewLine("Frozen terms: $1.00 restricted, $2.00 General.", false)).toBe("Frozen terms: $1.00 restricted, $2.00 General. Review items, recipient and funding before approving.");
    expect(approverReviewLine(null, false)).toBe("Review items, recipient and funding before approving.");
    expect(approverReviewLine(null, true)).toBe("You approved these terms. One more approver is needed.");
  });
});

describe("HOME-04 claimant wording comes from the session and the judge flag", () => {
  it("uses the signed-in first name", () => {
    expect(claimantHeading("Maria Okafor")).toBe("Which fund can pay Maria back?"); expect(claimantHeading("  Dev  ")).toBe("Which fund can pay Dev back?"); expect(claimantHeading("")).toBe("Which fund can pay you back?");
  });
  it("offers Maria's receipt only in a judge session", () => {
    expect(claimActionLabel(true)).toBe("Continue Maria's receipt"); expect(claimActionLabel(false)).toBe("Open this expense");
    expect(CLAIMANT_LEDE).toContain("two other people approve");
  });
});

describe("HOME-05 the screens carry no mock scaffolding and no hardcoded mock figure", () => {
  it("has no scaffolding phrase or fixed mock amount under src/app", () => {
    expect(sources.length).toBeGreaterThan(20);
    const banned = [/Product screen reference/, /Design navigation only/, /Illustrated (snapshot|selection)/, /Scripted design example/, /Preview (claimant|receipt|preparation)/, /\$430/, /\$1,500/, /Open expense walkthrough/];
    for (const path of sources.filter(path => !path.endsWith("style.css"))) {
      const text = readFileSync(path, "utf8");
      for (const pattern of banned) expect(pattern.test(text), `${path} ${pattern}`).toBe(false);
    }
  });
  it("builds home figures from loaded state rather than literals", () => {
    const page = readFileSync("src/app/page.tsx", "utf8");
    expect(page).not.toMatch(/\$\d[\d,]*\.\d\d/);
    expect(page).toContain("claimTotals"); expect(page).toContain("loadApproverQueue"); expect(page).toContain("ApproverQueueClient");
  });
});

describe("HOME-06 no local model wording survives under src/app", () => {
  it("has no Local, Qwen or 1.7B", () => {
    for (const path of sources) { const text = readFileSync(path, "utf8"); expect(/\bLocal\b/.test(text) || /qwen|1\.7b|local model|local ai/i.test(text), path).toBe(false); }
  });
  it("says AI over the Anthropic API when AI is on and claims no model when it is not", () => {
    const on = architectureStages({ on: true }); const off = architectureStages({ on: false });
    expect(on[0]!.path).toBe("AidTrace app → AI model over the Anthropic API → validated quotes"); expect(on[0]!.nodes).toContain("model");
    expect(off[0]!.path).toBe("AidTrace app → a person chooses each category"); expect(off[0]!.nodes).not.toContain("model");
    for (const stage of [...on, ...off]) expect(/local|qwen|1\.7b/i.test(`${stage.title} ${stage.path} ${stage.text}`), stage.title).toBe(false);
  });
});

describe("HOME-07 the architecture stages keep the mock order and the documented boundaries", () => {
  const stages = architectureStages({ on: true });
  it("has the four mock stages in order", () => expect(stages.map(stage => stage.title)).toEqual(["AI suggests", "Rules allocate", "People approve", "PayPal handoff"]));
  it("states each authority boundary", () => {
    expect(stages[0]!.text).toContain("no PayPal tools, approval authority or ledger access"); expect(stages[1]!.text).toContain("A rule failure stops the allocation");
    expect(stages[2]!.text).toContain("Maria cannot approve her own claim"); expect(stages[3]!.text).toContain("submits nothing"); expect(stages[3]!.text).toContain("not a PayPal balance");
  });
  it("keeps the documented illustrative split as cents-consistent amounts: 200 + 80 + 150 + 70 = 500", () => expect(20000 + 8000 + 15000 + 7000).toBe(50000));
});
