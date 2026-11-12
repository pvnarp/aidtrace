import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Brand } from "../src/app/brand";
import { aiCard, shellWording, type AiConfig } from "../src/app/shell-copy";
import { entryTypeOf } from "../src/ledger/view";
import { GIFT_STATE_SENTENCES } from "../src/donation/trail";
import { claimFailureNotices } from "../src/server/claim-notices";

// CW-01 and CW-02 (IAC-416). Screen copy avoids the word "sandbox" and the "AI turned off" wording in headings;
// the sandbox status is stated once on /give and in the README. Static checks only: no database, no network, no browser. The browser check is
// e2e/copy-words.spec.ts (CW-03). Payments stay sandbox-only in code; these tests cover visible words.
const claude: AiConfig = { name: "Claude Haiku 5.5", shellName: "Claude Haiku" };
const sonnet: AiConfig = { name: "Claude Sonnet 5.5", shellName: "Claude Sonnet 5.5" };
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
// Comments never reach a visitor. A // comment starts at line start or after a space, so "https://" inside a string survives.
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w"'`])\/\/.*$/gm, "$1");
const code = (path: string) => stripComments(readFileSync(path, "utf8"));
// The one allowed non-visible hit: the name of the confirmation form field, which the server reads and the browser never shows.
const visible = (path: string) => code(path).replaceAll("confirmSandbox", "");
const EXCEPTION_DIRS = /^src\/app\/lab\//;
const appFiles = walk("src/app").filter(path => /\.tsx?$/.test(path) && !EXCEPTION_DIRS.test(path));
const architectureFiles = walk("src/app/architecture").filter(path => /\.tsx?$/.test(path));

describe("CW-01 no visible sandbox wording outside the owner lab", () => {
  it("scans the real source tree, not an empty list", () => {
    expect(appFiles.length).toBeGreaterThan(30); expect(architectureFiles.length).toBeGreaterThanOrEqual(3);
    expect(appFiles.some(path => path.endsWith("trace.tsx"))).toBe(true); expect(appFiles.some(path => path.endsWith("claims/[claimId]/page.tsx"))).toBe(true);
  });
  it("has no sandbox in any src/app .ts or .tsx outside src/app/lab, comments and the confirmSandbox field name aside", () => {
    for (const path of appFiles) expect(/sandbox/i.test(visible(path)), path).toBe(false);
  });
  it("has no sandbox in the displayed claim notices, the ledger tooltips, or the gift trail titles and sentences", () => {
    for (const [key, text] of Object.entries(claimFailureNotices)) expect(/sandbox/i.test(text), `notice ${key}`).toBe(false);
    for (const path of ["src/ledger/view.ts", "src/donation/trail.ts"]) expect(/sandbox/i.test(code(path)), path).toBe(false);
    for (const [state, text] of Object.entries(GIFT_STATE_SENTENCES)) expect(/sandbox/i.test(text), `trail sentence ${state}`).toBe(false);
    for (const key of ["fixture_opening_balance:opening", "claim_recognition:recognition", "claim_recognition:restriction_release", "paypal_capture:donation", "paypal_capture:donation_fee", "paypal_payout_item:settlement", "paypal_payout_item:payout_fee"]) {
      const [sourceType, purpose] = key.split(":") as [string, string]; const entry = entryTypeOf(sourceType, purpose);
      expect(/sandbox/i.test(`${entry.label} ${entry.tip}`), key).toBe(false); expect(entry.label, key).not.toMatch(/^Unrecognized|\//);
    }
  });
  it("keeps the matched server error keys, which are never shown, so the fixed notices still map", () => {
    expect(readFileSync("src/server/claim-notices.ts", "utf8")).toContain('["A real sandbox recipient is required", "recipient-not-payable"]');
    expect(readFileSync("src/ledger/payout.ts", "utf8")).toContain('"A real sandbox recipient is required"');
  });
  it("says what the brief asks for in the changed strings", () => {
    expect(GIFT_STATE_SENTENCES.PAID).toBe("Your gift was applied, approved by two people and paid through PayPal.");
    expect(readFileSync("src/app/gift/[token]/trail-view.tsx", "utf8")).not.toContain("Test payments only.");
    expect(readFileSync("src/app/give/page.tsx", "utf8")).toContain("No real money moves.");
    expect(readFileSync("src/app/login/page.tsx", "utf8")).toContain("Sign in separately for each role.");
    expect(readFileSync("src/app/receipts/draft-form.tsx", "utf8")).toContain("This receipt holds no real personal details.");
    expect(claimFailureNotices["provider-balance-short"]).toContain("The readable PayPal balance is too short");
  });
  it("has no sandbox sentence in How it works, since IAC-416 PR 2 moved the only test-money line to Give", () => {
    const hits = architectureFiles.flatMap(path => code(path).match(/sandbox/gi) ?? []);
    expect(hits).toHaveLength(0);
    expect(code("src/app/architecture/page.tsx")).not.toMatch(/test funds|no real money/i);
  });
});

describe("CW-02 the shell never says AI is off", () => {
  it("shellWording returns no off wording for a configured model, another model or no model", () => {
    for (const configured of [claude, sonnet, null]) { const wording = shellWording(configured); expect(/\boff\b|switched|sandbox/i.test(`${wording.tag} ${wording.line}`), String(configured?.name)).toBe(false); }
    expect(shellWording(claude)).toEqual({ tag: "AI + PayPal", line: "Built with PayPal Payouts and AI" });
    expect(shellWording(null)).toEqual({ tag: "", line: "Built with PayPal Payouts." });
  });
  it("renders no tag element for an empty tag and one tag element for a named tag", () => {
    expect(renderToStaticMarkup(createElement(Brand, { tag: "" }))).not.toContain("header-tag");
    const named = renderToStaticMarkup(createElement(Brand, { tag: "AI + PayPal" })); expect(named).toContain("header-tag"); expect(named).toContain("AI + ");
  });
  it("the header and footer take their wording only from shellWording", () => {
    for (const path of ["src/app/app-header.tsx", "src/app/app-footer.tsx"]) { const text = code(path); expect(text, path).toContain("shellWording(status.on ? status : null)"); expect(/\boff\b/i.test(text), path).toBe(false); }
  });
  it("the AI card says a person chooses when no AI is configured, without the word off", () => {
    const card = aiCard({ applicable: true, suggestion: "NONE", confirmed: false, aiAccepted: false, savedModel: null, configured: null });
    expect(card).toMatchObject({ key: "not-run", state: "A person chooses each category", rail: "Person chooses", model: null });
    expect(/\boff\b/i.test(`${card.state} ${card.rail}`)).toBe(false);
  });
});
