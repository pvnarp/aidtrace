import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// TV-01 to TV-05 (IAC-415 Trust v2 port PR 1, docs/plans/TRUST_V2_PORT_SCOPE.md section 5.2, docs/GATE_REPORT.md section 44).
// Static checks of src/app/style.css and docs/DESIGN_LANGUAGE.md. No database, no network, no browser.
// The browser checks that need a running app (TV-09 to TV-17) arrive in PR 2 and PR 3.
const css = readFileSync("src/app/style.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const doc = readFileSync("docs/DESIGN_LANGUAGE.md", "utf8");

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({ selector: squash(match[1]!), body: match[2]! }));
const rootBlocks = rules.filter(rule => rule.selector === ":root");
const declarations = (body: string) => body.split(";").map(part => part.trim()).filter(Boolean).map(part => {
  const colon = part.indexOf(":");
  return [part.slice(0, colon).trim(), squash(part.slice(colon + 1))] as const;
});
const tokens = new Map<string, string>();
for (const block of rootBlocks) for (const [name, value] of declarations(block.body)) if (name.startsWith("--")) tokens.set(name, value);

function tableTokens(): Map<string, string> {
  const start = doc.search(/^<!-- tokens:start -->$/m), end = doc.search(/^<!-- tokens:end -->$/m);
  expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
  const rows = doc.slice(start, end).split("\n").filter(line => line.startsWith("|")).slice(2);
  const table = new Map<string, string>();
  for (const row of rows) {
    const cells = row.split("|").map(cell => cell.trim());
    const name = cells[2]!.replace(/`/g, ""), value = squash(cells[3]!.replace(/`/g, ""));
    expect(name.startsWith("--")).toBe(true); expect(table.has(name)).toBe(false);
    table.set(name, value);
  }
  return table;
}

describe("TV-01 the :root properties equal the token table in docs/DESIGN_LANGUAGE.md", () => {
  const table = tableTokens();
  it("reads a table and a stylesheet of the expected size", () => {
    expect(table.size).toBeGreaterThanOrEqual(30); expect(tokens.size).toBeGreaterThanOrEqual(30); expect(rootBlocks.length).toBeGreaterThanOrEqual(1);
  });
  it("has no custom property defined twice with different values across :root blocks", () => {
    const seen = new Map<string, string>(); const clashes: string[] = [];
    for (const block of rootBlocks) for (const [name, value] of declarations(block.body)) { if (name.startsWith("--") && seen.has(name) && seen.get(name) !== value) clashes.push(name); seen.set(name, value); }
    expect(clashes).toEqual([]);
  });
  it("has no missing, extra or changed value", () => {
    const missing = [...table.keys()].filter(name => !tokens.has(name));
    const extra = [...tokens.keys()].filter(name => !table.has(name));
    const changed = [...table].filter(([name, value]) => tokens.has(name) && tokens.get(name) !== value).map(([name, value]) => `${name}: table ${value}, css ${tokens.get(name)}`);
    expect({ missing, extra, changed }).toEqual({ missing: [], extra: [], changed: [] });
  });
});

describe("TV-02 no hex color literal outside :root and @font-face", () => {
  // Selectors that may still hold a literal. Empty after PR 1: every color in the stylesheet reads a token.
  const LEGACY_UNPORTED: string[] = [];
  const hex = /#[0-9a-f]{3,8}(?![0-9a-z_-])/i;
  it("parses the stylesheet", () => expect(rules.length).toBeGreaterThan(300));
  it("writes every hex literal inside :root only", () => {
    const loose = rules.filter(rule => hex.test(rule.body) && rule.selector !== ":root" && !rule.selector.startsWith("@font-face") && !LEGACY_UNPORTED.includes(rule.selector));
    expect(loose.map(rule => rule.selector)).toEqual([]);
  });
  it("keeps the allow list free of selectors that no longer hold a literal", () => {
    for (const selector of LEGACY_UNPORTED) expect(rules.some(rule => rule.selector === selector && hex.test(rule.body))).toBe(true);
  });
  it("never writes a rgb or hsl color outside :root", () => {
    const loose = rules.filter(rule => /\b(?:rgba?|hsla?)\(/i.test(rule.body) && rule.selector !== ":root");
    expect(loose.map(rule => rule.selector)).toEqual([]);
  });
});

describe("TV-03 computed contrast of the Trust v2 pairs", () => {
  const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const luminance = (hex: string) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255); };
  const color = (token: string) => { const value = tokens.get(token); expect(value, token).toMatch(/^#[0-9a-f]{6}$/i); return value!; };
  const ratio = (fg: string, bg: string) => { const [hi, lo] = [luminance(color(fg)), luminance(color(bg))].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };

  // Text pairs, 4.5 to 1 (scope section 2.3). Quote text uses --navy, so the --navy pairs on --mark and --warm cover it.
  const text: [string, string][] = [
    ["--navy", "--paper"], ["--navy", "--bg"], ["--navy", "--tint"], ["--navy", "--mark"], ["--navy", "--warm"],
    ["--muted", "--paper"], ["--muted", "--bg"], ["--muted", "--tint"], ["--muted", "--paypal-bg"], ["--muted", "--block-bg"],
    ["--cents", "--paper"], ["--cents", "--bg"],
    ["--accent-ink", "--paper"], ["--accent-ink", "--bg"], ["--accent-ink", "--tint"], ["--accent-ink", "--paypal-bg"],
    ["--paper", "--accent"], ["--paper", "--accent-ink"], ["--accent", "--paper"],
    ["--ok", "--paper"], ["--ok", "--bg"], ["--ok", "--tint"],
    ["--hold", "--paper"], ["--hold", "--bg"], ["--hold", "--tint"], ["--hold", "--warm"],
    ["--block", "--paper"], ["--block", "--bg"], ["--block", "--tint"], ["--block", "--block-bg"],
    ["--paypal", "--paper"], ["--paypal", "--bg"], ["--paypal", "--paypal-bg"], ["--paper", "--paypal"],
  ];
  it.each(text)("text %s on %s is at least 4.5", (fg, bg) => expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5));

  // Marks that carry information, 3 to 1: focus ring, dots, meter fill, split bar segments, field borders.
  const marks: [string, string][] = [
    ["--accent", "--paper"], ["--accent", "--bg"], ["--accent", "--tint"], ["--accent", "--meter-track"],
    ["--dot-ok", "--paper"], ["--dot-ok", "--bg"], ["--dot-block", "--paper"], ["--dot-block", "--bg"],
    ["--dot-hold", "--paper"], ["--dot-hold", "--bg"], ["--dot-hold", "--tint"],
    ["--grey", "--paper"], ["--grey", "--bg"], ["--grey", "--tint"], ["--field-line", "--paper"],
    ["--navy", "--paper"], ["--accent", "--navy"],
  ];
  it.each(marks)("mark %s on %s is at least 3", (fg, bg) => expect(ratio(fg, bg)).toBeGreaterThanOrEqual(3));

  it("keeps --accent below 4.5 on --bg and --tint, which is why it is a fill and large-text color only", () => {
    for (const bg of ["--bg", "--tint"]) { expect(ratio("--accent", bg)).toBeLessThan(4.5); expect(ratio("--accent", bg)).toBeGreaterThanOrEqual(3); }
  });
  it("matches the ratios the scope computed with awk, within 0.02", () => {
    const expected: [string, string, number][] = [
      ["--navy", "--paper", 16.52], ["--muted", "--paper", 5.44], ["--cents", "--bg", 4.8], ["--accent-ink", "--paper", 6.93], ["--accent", "--paper", 4.82],
      ["--accent", "--bg", 4.45], ["--dot-hold", "--paper", 4.22], ["--grey", "--paper", 3.89], ["--grey", "--bg", 3.59], ["--accent", "--navy", 3.43],
    ];
    for (const [fg, bg, value] of expected) expect(Math.abs(ratio(fg, bg) - value), `${fg} on ${bg}`).toBeLessThanOrEqual(0.02);
  });
  it("has the corrected values and none of the failing mock values", () => {
    expect(tokens.get("--dot-hold")).toBe("#b36a00"); expect(tokens.get("--grey")).toBe("#74829a"); expect(tokens.get("--field-line")).toBe("#74829a");
    for (const failing of ["#d98a1a", "#b4bfce", "#c9d2df", "#9db4d6"]) expect(css.toLowerCase()).not.toContain(failing);
  });
  it("draws the General split segment in --navy", () => {
    const general = rules.filter(rule => /fund_g|fund-general/.test(rule.selector));
    expect(general.length).toBeGreaterThan(0);
    for (const rule of general) expect(rule.body).toMatch(/var\(--navy\)/);
  });
});

describe("TV-04 accent text under 24 px uses --accent-ink", () => {
  // Selectors whose text is at least 24 px. c2 uses --accent text once, on the 32 px headline count.
  const ALLOWED_ACCENT_TEXT = [".act"];
  const accentText = rules.filter(rule => /(^|;)\s*color\s*:\s*var\(--accent\)/.test(rule.body));
  it("puts --accent text only on allow-listed selectors", () => {
    const loose = accentText.filter(rule => !rule.selector.split(",").every(part => ALLOWED_ACCENT_TEXT.includes(part.trim())));
    expect(loose.map(rule => rule.selector)).toEqual([]);
  });
  it("sets at least 24 px on every allow-listed rule that exists", () => {
    for (const rule of accentText) { const size = /font-size\s*:\s*(\d+(?:\.\d+)?)px/.exec(rule.body); expect(size, rule.selector).not.toBeNull(); expect(Number(size![1])).toBeGreaterThanOrEqual(24); }
  });
  it("does not set accent text inline in a component", () => {
    const source = (path: string) => readFileSync(path, "utf8");
    for (const path of ["src/app/trace.tsx", "src/app/brand.tsx", "src/app/app-header.tsx", "src/app/primary-nav.tsx", "src/app/workspace.tsx", "src/app/amount.tsx", "src/app/journey.tsx"]) expect(source(path), path).not.toMatch(/color\s*:\s*["']?var\(--accent\)/);
  });
});

describe("TV-05 PayPal blue stays in PayPal-scoped rules and the accent stays out of them", () => {
  // SHELL-06 tests two and three (tests/shell-copy.test.ts) are kept: PayPal blue only in selectors that say paypal, never on a button.
  const says = (rule: { selector: string }) => rule.selector.split(",").some(part => /paypal/i.test(part));
  it("finds PayPal-scoped rules to check", () => expect(rules.filter(says).length).toBeGreaterThanOrEqual(3));
  it("uses no --accent or --accent-ink inside a selector that says paypal", () => {
    const mixed = rules.filter(rule => says(rule) && /var\(--accent(?:-ink)?\)/.test(rule.body));
    expect(mixed.map(rule => rule.selector)).toEqual([]);
  });
  it("gives the word PayPal its blue", () => {
    const word = rules.filter(rule => rule.selector.split(",").some(part => part.trim() === ".paypal-word"));
    expect(word.some(rule => /color\s*:\s*var\(--paypal\)/.test(rule.body))).toBe(true);
  });
});
