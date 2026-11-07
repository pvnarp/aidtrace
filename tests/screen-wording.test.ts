import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// SW-01 to SW-06 (IAC-232, Pavan, November 7: the app says "toy" on screen). The facts behind the old wording stay true and stay disclosed once (README, code comments, the
// /architecture page, the login notice); the screens stop repeating them. Static checks only: no database, no network, no browser. The browser checks are the e2e specs
// that click through the renamed controls. The privacy checkbox and its server check stay exactly as they were (SW-05).
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
// Whole-line // comments and /* */ blocks are dropped, so a sentence in a comment never trips a code check.
const code = (path: string) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map(line => line.replace(/^\s*\/\/.*$/, "")).join("\n");
const files = [...walk("src/app"), ...walk("src/donation")].filter(path => /\.tsx?$/.test(path));
const LOGIN = "src/app/login/page.tsx";
// Held back on purpose: the donor method sentence in these two files is mirrored by scripts/support/donor-note-eval.ts, and tests/gift-note-eval-parity.test.ts (DON-13) binds them to the recorded run 3 candidates. Changing it is an owner decision on the paid donor-note eval.
const HELD = ["src/donation/note.ts", "src/donation/trail.ts"];
const containing = (phrase: RegExp, skip: string[] = []) => files.filter(path => !skip.includes(path) && phrase.test(code(path)));

describe("SW-01 no practice or toy wording on any screen", () => {
  it("keeps the old phrases out of src/app and src/donation code", () => {
    expect(containing(/practice/i)).toEqual([]);
    expect(containing(/sample-data/i)).toEqual([]);
    expect(containing(/Invented receipt text/i)).toEqual([]);
    expect(containing(/invented receipt text only/i)).toEqual([]);
    expect(containing(/narrative, not a trace/i, HELD)).toEqual([]);
    expect(containing(/pending nonprofit accountant review/i)).toEqual([]);
  });
  it("keeps the sample-data sentence only in the login notice, the one hosted disclosure", () => {
    expect(containing(/sample data with no real personal details/i, [LOGIN])).toEqual([]);
    expect(code(LOGIN)).toContain("sample data with no real personal details");
  });
  it("uses the new home and example wording", () => {
    const home = code("src/app/page.tsx");
    expect(home).toContain("No expense yet"); expect(home).toContain("Start an expense");
    expect(code("src/app/receipts/new/page.tsx")).toContain("Use the $6 small example");
    expect(home).toContain("A receipt starts a new unpaid draft."); expect(home).toContain("The receipt you start is your own draft.");
    expect(code("src/app/receipts/new/page.tsx")).toContain("Check the personal-details box, then create the draft below.");
  });
  it("has no src/app/lab page that renders any of the old phrases (the lab holds only the PayPal return page)", () => {
    expect(walk("src/app/lab")).toEqual(["src/app/lab/paypal-return/page.tsx"]);
  });
});

describe("SW-02 the receipt form wording", () => {
  const form = code("src/app/receipts/draft-form.tsx");
  it("labels the text box and states the amount rule without the invented-text line", () => {
    expect(form).toContain(">Receipt text</label>");
    expect(form).toContain("<p>Amounts are entered by you, with two decimal places. Maximum total $500.00.</p>");
    expect(code("src/app/receipts/photo-copy.ts")).toContain('PHOTO_SOURCE_LABEL_TYPED = "Receipt text"');
  });
});

describe("SW-03 the page footers", () => {
  const footers: Array<[string, string]> = [
    ["src/app/ledger/page.tsx", "<footer>This view shows local journal facts"],
    ["src/app/donations/page.tsx", "<footer>This view shows local gift facts"],
    ["src/app/analytics/page.tsx", "<footer>This dashboard uses local journal facts"],
    ["src/app/analytics/report/page.tsx", "<footer>This report uses local records"],
    ["src/app/claims/[claimId]/page.tsx", "<footer>Paid appears only after an independently fetched payout item reports success."],
  ];
  it.each(footers)("%s drops the accountant-review sentence and keeps the rest", (path, start) => {
    const text = code(path);
    expect(text).not.toMatch(/accounting-inspired/i); expect(text).not.toMatch(/accountant review/i);
    expect(text).toContain(start);
  });
});

describe("SW-04 the claim page method line", () => {
  it("states the method once and drops the narrative disclaimer", () => {
    expect(code("src/app/claims/[claimId]/gift-notes.tsx")).toContain(">Gifts are applied to approved receipt lines, oldest gift first.</p>");
    expect(code("src/app/claims/[claimId]/gift-notes.tsx")).not.toMatch(/narrative/i);
  });
});

describe("SW-05 the privacy checkbox is not weakened", () => {
  it("keeps the checkbox name, required and the server check", () => {
    expect(code("src/app/receipts/draft-form.tsx")).toContain('<input type="checkbox" name="syntheticReceipt" value="yes" required /> This receipt holds no real personal details.');
    expect(code("src/server/receipt-actions.ts")).toContain('if (form.get("syntheticReceipt") !== "yes") throw new Error("Synthetic receipt confirmation required");');
  });
});

describe("SW-06 one accounting disclosure, on /architecture", () => {
  it("states it once there and nowhere else on a screen", () => {
    const sentence = "The accounting model has not been reviewed by a nonprofit accountant.";
    expect(files.filter(path => code(path).includes(sentence))).toEqual(["src/app/architecture/page.tsx"]);
  });
});
