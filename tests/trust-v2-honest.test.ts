import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aiCard, paypalCard, type Stage } from "../src/app/shell-copy";
import { TRACE_NAMES, traceSteps, type TraceState } from "../src/app/trace";
import { fundMeter, type SnapshotFund } from "../src/app/fund-meter";

// TV-06 to TV-08 (IAC-415 Trust v2 port PR 2, docs/plans/TRUST_V2_PORT_SCOPE.md sections 3.2, 4 and 5.2, docs/GATE_REPORT.md section 47).
// Pure functions and static file checks. No database, no network, no browser. The browser checks are e2e/trust-v2.spec.ts (TV-14, TV-15).
const ai = aiCard({ applicable: true, suggestion: "READY", confirmed: false, aiAccepted: false, savedModel: "Claude Haiku 5.5", configured: { name: "Claude Haiku 5.5", shellName: "Claude Haiku" } });
const paypal = paypalCard({ claimStatus: "DRAFT", approvals: 0, payout: null });
const STAGES: Stage[] = [1, 2, 3, 4, 5];

describe("TV-06 the trace has six exact steps and states only what the saved stage supports", () => {
  // The state table of section 3.2, written out. Rows are stages; blocked matters only at stage 3.
  const table = (stage: Stage, blocked: boolean): TraceState[] => {
    if (stage === 1) return ["current", "future", "future", "future", "future", "future"];
    if (stage === 2) return ["done", "current", "future", "future", "future", "future"];
    if (stage === 3) return blocked ? ["done", "done", "blocked", "future", "future", "future"] : ["done", "done", "done", "current", "future", "future"];
    if (stage === 4) return ["done", "done", "done", "done", "current", "future"];
    return ["done", "done", "done", "done", "done", "current"];
  };
  const run = (stage: Stage, policyBlocked: boolean, approvals: number | null = 0, typedReceipt = true) => traceSteps({ stage, typedReceipt, ai, approvals, paypal, policyBlocked });
  it("returns the six names in order", () => {
    expect([...TRACE_NAMES]).toEqual(["Receipt", "AI review", "Rule checks", "Fund split", "Approvals", "PayPal payout"]);
    for (const stage of STAGES) for (const blocked of [false, true]) expect(run(stage, blocked).map(step => step.name)).toEqual([...TRACE_NAMES]);
  });
  it("matches the state table for every (stage, blocked) pair", () => {
    for (const stage of STAGES) for (const blocked of [false, true]) expect(run(stage, blocked).map(step => step.state), `stage ${stage} blocked ${blocked}`).toEqual(table(stage, blocked));
  });
  it("marks a step blocked only at step 3 and only when the claim sits at stage 3 under a policy stop", () => {
    for (const stage of STAGES) for (const blocked of [false, true]) {
      const steps = run(stage, blocked);
      steps.forEach((step, index) => { if (step.state === "blocked") { expect(index).toBe(2); expect(stage).toBe(3); expect(blocked).toBe(true); } });
      expect(steps.filter(step => step.state === "blocked").length).toBe(stage === 3 && blocked ? 1 : 0);
    }
  });
  it("never marks a step done beyond the saved stage and keeps at most one current step", () => {
    for (const stage of STAGES) for (const blocked of [false, true]) {
      const steps = run(stage, blocked);
      for (const step of steps) if (step.state === "done") expect(step.stage).toBeLessThanOrEqual(stage);
      expect(steps.filter(step => step.state === "done").length).toBe([0, 1, 3, 4, 5][stage - 1]! - (stage === 3 && blocked ? 1 : 0));
      expect(steps.filter(step => step.state === "current").length).toBe(stage === 3 && blocked ? 0 : 1);
      // Fund split is done only once the claim is at stage 4 or later: stage 3 is the check, not the freeze.
      expect(steps[3]!.state === "done").toBe(stage >= 4);
    }
  });
  it("takes each detail only from the listed sources", () => {
    for (const stage of STAGES) for (const blocked of [false, true]) for (const approvals of [0, 1, 2, null]) for (const typedReceipt of [true, false]) {
      const steps = run(stage, blocked, approvals, typedReceipt); const lock = (index: number, text: string) => index + 1 > stage ? `Locked. ${text}` : text;
      expect(steps[0]!.detail).toBe(typedReceipt ? "Typed text and amounts" : "Preclassified example");
      expect(steps[1]!.detail).toBe(lock(1, ai.rail));
      expect(steps[2]!.detail).toBe(blocked && stage === 3 ? "Stopped by organization policy" : lock(2, "Rules, not AI"));
      expect(steps[3]!.detail).toBe(stage >= 4 ? undefined : stage === 3 && !blocked ? "Check, then freeze" : "Locked. Rules, not AI");
      // IAC-415 PR 4 and PR 5: a not-ready PayPal card (this file's DRAFT card) at stage 4 or earlier is the awaiting claim or a page before the freeze, so the rail says who, not how many.
      // Stage 5 keeps the count.
      expect(steps[4]!.detail).toBe(lock(3, approvals === null ? "People: see the claim" : stage === 4 ? "Two different people" : stage < 4 ? "Two approvers" : `People: ${approvals} of 2`));
      expect(steps[5]!.detail).toBe(lock(4, paypal.rail));
    }
  });
  it("says nothing about a count or amount the page did not load", () => {
    for (const step of run(2, false, null)) expect(step.detail ?? "").not.toMatch(/\$\d|\d+ of \d+ passed|Allowed|Passed/);
    expect(run(4, false, null)[4]!.detail).toBe("People: see the claim");
  });
});

describe("TV-07 fundMeter turns one snapshot fund into an honest meter", () => {
  const fund = (over: Partial<SnapshotFund> = {}): SnapshotFund => ({ name: "Fund", restriction: "RESTRICTED", bookCents: "100000", reservedCents: "25000", availableCents: "75000", ...over });
  it("computes the reserved share as an integer percent with bigint division", () => {
    expect(fundMeter(fund()).percent).toBe(25);
    expect(fundMeter(fund({ bookCents: "300", reservedCents: "100" })).percent).toBe(33);
    expect(fundMeter(fund({ bookCents: "300", reservedCents: "299" })).percent).toBe(99);
    expect(fundMeter(fund({ reservedCents: "0" })).percent).toBe(0);
    expect(Number.isInteger(fundMeter(fund({ bookCents: "7", reservedCents: "3" })).percent)).toBe(true);
    // Beyond Number.MAX_SAFE_INTEGER: a Number division would round, the bigint division is exact.
    expect(fundMeter(fund({ bookCents: "9007199254740993000", reservedCents: "4503599627370496500" })).percent).toBe(50);
  });
  it("clamps to 0 through 100", () => {
    expect(fundMeter(fund({ reservedCents: "100000" })).percent).toBe(100);
    expect(fundMeter(fund({ reservedCents: "250000" })).percent).toBe(100);
    expect(fundMeter(fund({ reservedCents: "-5000" })).percent).toBe(0);
  });
  it("is 0 when the book balance is zero or negative", () => {
    expect(fundMeter(fund({ bookCents: "0", reservedCents: "5000" })).percent).toBe(0);
    expect(fundMeter(fund({ bookCents: "-100", reservedCents: "5000" })).percent).toBe(0);
    expect(fundMeter(fund({ bookCents: "-100", reservedCents: "-5000" })).percent).toBe(0);
  });
  it("labels the restriction from the stored value only and formats every amount with usd()", () => {
    expect(fundMeter(fund()).label).toBe("Restricted");
    expect(fundMeter(fund({ restriction: "UNRESTRICTED" })).label).toBe("Unrestricted");
    const meter = fundMeter(fund({ bookCents: "123456789", reservedCents: "2345", availableCents: "123454444" }));
    expect(meter.book).toBe("$1,234,567.89"); expect(meter.reserved).toBe("$23.45"); expect(meter.available).toBe("$1,234,544.44");
    expect(meter.ariaLabel).toBe("99 percent of book balance still available"); // November 10: the label names the available share, which the bar shows
  });
  it("carries no mode word and no extra field beyond the meter", () => {
    const meter = fundMeter(fund());
    expect(Object.keys(meter).sort()).toEqual(["ariaLabel", "available", "availablePercent", "book", "label", "name", "percent", "reserved"]);
    expect(JSON.stringify(meter)).not.toMatch(/Autopilot|Assisted|Manual/i);
    expect(readFileSync("src/app/fund-meter.ts", "utf8")).not.toMatch(/Autopilot|Assisted|Passed every check|Design preview/);
  });
});

const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
describe("TV-08 no unbacked mode or verdict wording under src/app", () => {
  const files = walk("src/app").filter(path => /\.(tsx?|css|md)$/.test(path));
  it("has no unbacked Autopilot, Assisted, Passed every check or Design preview string", () => {
    expect(files.length).toBeGreaterThan(20);
    // IAC-405 PR F (docs/ASSUMPTIONS.md section 76): "Assisted" is allowed in exactly one file, the mode change section, which shows a mode only from the stored view the page reads
    // with the flag on. "Passed every check" and "Design preview" stay banned everywhere, including that file.
    const MODE_SECTION = join("src", "app", "rules-ui", "fund-mode-section.tsx");
    // IAC-405 PR A (docs/ASSUMPTIONS.md section 77): "Assisted" is also allowed in the Assisted queue files, in the two files that wire them and in the claim page, whose one line reads
    // "Human reviews: 1 of 1, Assisted, no holds found". Each shows a mode only from a server read made with the flag on.
    // IAC-405 PR P (docs/ASSUMPTIONS.md section 78): "Autopilot" is allowed in exactly three files, the mode change section (it offers Autopilot only with the second flag), the kill switch section and
    // the claim page trail for a claim recognized by an AUTO_RECOGNIZED record. Each reads stored data only. "Passed every check" and "Design preview" stay banned everywhere.
    const ASSISTED_FILES = [MODE_SECTION, join("src", "app", "page.tsx"), join("src", "app", "approver-queue", "client.tsx"), join("src", "app", "claims", "[claimId]", "page.tsx"), ...files.filter(path => path.startsWith(join("src", "app", "assisted-queue") + "/"))];
    const AUTOPILOT_FILES = [MODE_SECTION, join("src", "app", "rules-ui", "automation-switch-section.tsx"), join("src", "app", "claims", "[claimId]", "automated-trail.tsx")];
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      const banned = [...(AUTOPILOT_FILES.includes(path) ? [] : [/Autopilot/]), ...(ASSISTED_FILES.includes(path) ? [] : [/Assisted/]), /Passed every check/, /Design preview/];
      for (const pattern of banned) expect(pattern.test(text), `${path} ${pattern}`).toBe(false);
    }
  });
  it("shows an Assisted label only from a stored mode, and only with the flag on", () => {
    const section = readFileSync("src/app/rules-ui/fund-mode-section.tsx", "utf8");
    // A regex, not a quoted import text: the export guard reads a quoted relative specifier in a test file as an import of the test itself (IAC-442). Same line, same strength.
    expect(section).toMatch(/import type \{ FundModeView \} from "\.\.\/\.\.\/fund-modes\/change"/);
    expect(section).toContain("view.mode");
    const page = readFileSync("src/app/funds/[fundId]/rules/page.tsx", "utf8");
    expect(page).toMatch(/fundModesEnabled\(\) \? await readFundMode\(/);
    expect(page).toMatch(/mode\?\.status === "OK" && <FundModeSection/);
    const others = files.filter(path => path !== join("src", "app", "rules-ui", "fund-mode-section.tsx") && readFileSync(path, "utf8").includes("FundModeSection"));
    expect(others.map(path => path.replace(/\\/g, "/"))).toEqual(["src/app/funds/[fundId]/rules/page.tsx"]);
  });
  it("keeps src/app/page.tsx free of dollar literals and builds the meters from the snapshot", () => {
    const page = readFileSync("src/app/page.tsx", "utf8");
    expect(page).not.toMatch(/\$\d[\d,]*\.\d\d/);
    expect(page).toContain("loadAnalyticsSnapshot"); expect(page).toContain("fundMeter");
  });
  it("shows no Allowed verdict and no Hold for review control on the claim page source", () => {
    const claim = readFileSync("src/app/claims/[claimId]/page.tsx", "utf8");
    expect(claim).not.toMatch(/Hold for review/); expect(claim).not.toMatch(/>\s*Allowed|"Allowed|\bAllowed\./);
    expect(claim).toContain("Not allowed by organization policy.");
  });
});
