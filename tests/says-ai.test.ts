import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AiRecommendation, aiModelLine } from "../src/app/receipts/ai-recommendation";
import { aiCard, aiModelLabel, aiSuggesterName, shellWording } from "../src/app/shell-copy";
import { modelCheckDisclosure } from "../src/app/ai-disclosure";
import { architectureStages } from "../src/app/architecture/stages";
import { CLAUDE_NAMES, RETIRED_MODEL_LABEL, type ReceiptAudit } from "../src/ai/audit";
import { CLAUDE_LIMIT_MESSAGE } from "../src/ai/budget";
import { AI_OFF_MESSAGES } from "../src/ai/provider";
import { modelAskedBy, modelCheckedBy, modelFullName } from "../src/policy/copy";

// AW-01 (IAC-416 PR 2, docs/GATE_REPORT.md section 57). Pavan, November 1: "drop sanbox, drop fictional, drop the word "claude" we need to just say "AI"
// so drive home the point". Static checks only: no database, no network, no browser. The rendered-text check at 1440 px is e2e/says-ai.spec.ts (AW-02),
// which is the real guard, because model names are built at run time (CLAUDE_NAMES, stored model ids) and no scan of string literals can see them.
// What these tests pin: screens say "AI", never "Claude" or "fictional" in a visible literal; the provider is named in the disclosure lines only;
// "No real money moves." is on Give alone; the old header tag and the old gift footer line are gone.
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
// Comments never reach a visitor. A // comment starts at line start or after a space, so "https://" inside a string survives.
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w"'`])\/\/.*$/gm, "$1");
// Import and export specifiers are module paths, not screen text.
const withoutModulePaths = (text: string) => text.replace(/\b(?:import|export)\b[^;\n]*?\bfrom\s*["'][^"']*["']/g, "").replace(/\bimport\s*["'][^"']*["']/g, "").replace(/\bimport\(\s*["'][^"']*["']\s*\)/g, "");
/** Every string literal and every run of JSX text in a source file: the places visible words can sit as written text. */
function visibleLiterals(source: string): string[] {
  const code = withoutModulePaths(stripComments(source));
  // A ${...} interpolation inside a template literal is code (an identifier such as CLAUDE_NAMES), not written text, so it is removed before the words are tested.
  const strings = (code.match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? []).map(text => text.replace(/\$\{[^}]*\}/g, ""));
  const jsxText = [...code.matchAll(/>([^<>{}=;]+)</g)].map(match => match[1]!);
  return [...strings, ...jsxText];
}
const appFiles = walk("src/app").filter(path => /\.tsx?$/.test(path) && !/^src\/app\/lab\//.test(path));
const hits = (pattern: RegExp, files: string[] = appFiles) => files.flatMap(path => visibleLiterals(readFileSync(path, "utf8")).filter(text => pattern.test(text)).map(text => `${path}: ${text.slice(0, 80)}`));
// The one non-visible hit allowed: the name of the confirmation form field, which the server reads and the browser never shows.
const notFieldName = (list: string[]) => list.filter(entry => !/^[^:]+: ["'`]confirmSandbox["'`]$/.test(entry));

describe("AW-01 the screens say AI", () => {
  it("the scanner sees a planted Claude string, a planted fictional string and JSX text, so an empty result means something", () => {
    const planted = visibleLiterals('const tag = "Claude AI + PayPal"; export const x = <p>Fictional vendor</p>; import { y } from "../src/ai/claude-receipt";');
    expect(planted).toContain('"Claude AI + PayPal"'); expect(planted.some(text => /Fictional vendor/.test(text))).toBe(true); expect(planted.some(text => /claude-receipt/.test(text))).toBe(false);
    expect(visibleLiterals("const a = `Model ${CLAUDE_NAMES[x]}. Sent to Anthropic.`;").some(text => /claude/i.test(text))).toBe(false); expect(visibleLiterals("const a = `Claude ${x}`;").some(text => /claude/i.test(text))).toBe(true);
    expect(appFiles.length).toBeGreaterThan(30); expect(appFiles.some(path => path.endsWith("shell-copy.ts"))).toBe(true); expect(appFiles.some(path => path.endsWith("ai-disclosure.ts"))).toBe(true);
  });
  it("has no Claude, fictional or sandbox in any visible string or JSX text under src/app outside the owner lab", () => {
    expect(notFieldName(hits(/claude/i))).toEqual([]);
    expect(notFieldName(hits(/fictional/i))).toEqual([]);
    expect(notFieldName(hits(/sandbox/i))).toEqual([]);
  });
  it("says AI in the header tag and the footer, whatever model is configured", () => {
    for (const name of ["Claude Haiku 5.5", "Claude Sonnet 5.5"]) expect(shellWording({ name, shellName: name })).toEqual({ tag: "AI + PayPal", line: "Built with PayPal Payouts and AI" });
    expect(shellWording(null)).toEqual({ tag: "", line: "Built with PayPal Payouts." });
    expect(readFileSync("src/app/brand.tsx", "utf8")).toContain('tag: "AI + PayPal"');
  });
  it("shows a stored model as AI plus its family and version, passes any other label through, and never builds the Claude name on a screen", () => {
    expect(aiModelLabel("Claude Haiku 5.5")).toBe("AI (Haiku 5.5)"); expect(aiModelLabel("Claude Sonnet 5.5")).toBe("AI (Sonnet 5.5)");
    expect(aiModelLabel(RETIRED_MODEL_LABEL.model)).toBe(RETIRED_MODEL_LABEL.model); expect(aiModelLabel("Unrecognized AI record")).toBe("Unrecognized AI record");
    expect(aiSuggesterName("Claude Haiku 5.5")).toBe("AI"); expect(aiSuggesterName(RETIRED_MODEL_LABEL.short)).toBe(RETIRED_MODEL_LABEL.short);
    for (const name of Object.values(CLAUDE_NAMES)) expect(aiModelLabel(name), name).not.toMatch(/claude/i);
    const card = aiCard({ applicable: true, suggestion: "READY", confirmed: false, aiAccepted: false, savedModel: "Claude Haiku 5.5", configured: { name: "Claude Haiku 5.5", shellName: "Claude Haiku" } });
    expect(card.model).toBe("Model: AI (Haiku 5.5)"); expect(aiCard({ applicable: true, suggestion: "NONE", confirmed: false, aiAccepted: false, savedModel: null, configured: { name: "Claude Haiku 5.5", shellName: "Claude Haiku" } }).model).toBe("Configured model: AI (Haiku 5.5)");
  });
  it("says AI in the model check rows and keeps the full model name for the one disclosure line", () => {
    for (const id of ["claude-haiku-5-5", "claude-sonnet-5-5"]) { expect(modelCheckedBy(id, "low")).not.toMatch(/claude/i); expect(modelAskedBy(id, "low")).not.toMatch(/claude/i); }
    expect(modelCheckedBy("claude-haiku-5-5", "low")).toBe("Checked by AI (Haiku 5.5) at low effort."); expect(modelAskedBy("claude-sonnet-5-5", "low")).toBe("Asked AI (Sonnet 5.5) at low effort.");
    expect(modelFullName("claude-haiku-5-5")).toBe("Claude Haiku 5.5"); expect(modelFullName("not-a-model-id")).toBe("not-a-model-id");
  });
  it("says AI in the two fixed AI-off messages and the architecture stages, with no Claude, sandbox or fictional", () => {
    for (const text of [...Object.values(AI_OFF_MESSAGES), CLAUDE_LIMIT_MESSAGE]) expect(text).not.toMatch(/claude|sandbox|fictional/i);
    expect(AI_OFF_MESSAGES.NO_KEY).toBe("AI suggestions are off in this session: no AI key is configured.");
    for (const on of [true, false]) for (const stage of architectureStages({ on })) expect(`${stage.title} ${stage.path} ${stage.text}`, `stage ${stage.title} on=${on}`).not.toMatch(/claude|sandbox|fictional|test funds/i);
  });
});

describe("AW-01 the provider is named where text leaves the app, and only there", () => {
  it("the model check disclosure names each asked model once, in first-seen order, and the provider", () => {
    expect(modelCheckDisclosure(["claude-haiku-5-5"])).toBe("Model check: Claude Haiku 5.5. Claim line and clause text was sent to Anthropic.");
    expect(modelCheckDisclosure(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"])).toBe("Model check: Claude Haiku 5.5 and Claude Sonnet 5.5. Claim line and clause text was sent to Anthropic.");
    expect(modelCheckDisclosure(["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"])).toBe("Model check: Claude Sonnet 5.5, Claude Haiku 5.5 and Claude Opus 5.5. Claim line and clause text was sent to Anthropic.");
    expect(modelCheckDisclosure([])).toBe("");
  });
  it("the saved suggestion line and the idle strip name the model and Anthropic, and the retired and unrecognized records name no provider", () => {
    const audit = { provider: "claude", model: "claude-haiku-5-5", responseModel: "claude-haiku-5-5", effort: "low", promptVersion: "receipt-category-claude-v2", schemaVersion: "receipt-s1" } as unknown as ReceiptAudit;
    expect(aiModelLine(audit)).toBe("Model: Claude Haiku 5.5. The receipt text was sent to Anthropic for these suggestions.");
    expect(aiModelLine(null)).toBe("Model: the saved AI record is not recognized, so no provider is named.");
    expect(aiModelLine({ provider: "local" } as unknown as ReceiptAudit)).toBe("Model: Earlier AI model, since retired. This suggestion was saved before AidTrace changed AI models.");
    const idle = renderToStaticMarkup(createElement(AiRecommendation, { lines: [], ready: false, audit: null, configured: { name: "Claude Haiku 5.5" }, running: false }));
    expect(idle).toContain("Model: Claude Haiku 5.5. The receipt text goes to Anthropic.");
    expect(renderToStaticMarkup(createElement(AiRecommendation, { lines: [], ready: false, audit: null, configured: null, aiOff: AI_OFF_MESSAGES.NO_KEY, running: false }))).not.toMatch(/Anthropic/);
    const ready = renderToStaticMarkup(createElement(AiRecommendation, { lines: [], ready: true, audit, configured: { name: "Claude Haiku 5.5" }, running: false }));
    expect(ready).toContain("sent to Anthropic"); expect(ready).toContain("Saved record: model AI (Haiku 5.5), schema receipt-s1."); expect(ready).not.toContain("receipt-category-claude-v2");
  });
  it("the claim page model check section wires the disclosure, which refuses to name a pair that sent no request", () => {
    const section = stripComments(readFileSync("src/app/claims/[claimId]/policy-checks.tsx", "utf8"));
    expect(section).toContain("modelCheckDisclosure("); expect(section).toContain('pair.state !== "SKIPPED"'); expect(section).toContain('pair.reasonCode !== "LIMIT"');
    expect(visibleLiterals(readFileSync("src/app/ai-disclosure.ts", "utf8")).some(text => /sent to Anthropic/.test(text))).toBe(true);
  });
});

describe("AW-01 the one money line is on Give, and the old footer and tag are gone", () => {
  it("says No real money moves. on Give and nowhere else in src/app", () => {
    expect(readFileSync("src/app/give/page.tsx", "utf8")).toContain('<p className="muted">No real money moves.</p>');
    const files = appFiles.filter(path => visibleLiterals(readFileSync(path, "utf8")).some(text => /no real money|test payments|test accounts|test funds|test money/i.test(text)));
    expect(files.map(path => path.replace(/\\/g, "/"))).toEqual(["src/app/give/page.tsx"]);
  });
  it("has no Test payments only. line on the gift trail, no Claude tag in the brand and no old checkbox wording", () => {
    expect(readFileSync("src/app/gift/[token]/trail-view.tsx", "utf8")).not.toMatch(/Test payments/i);
    expect(readFileSync("src/app/brand.tsx", "utf8")).not.toMatch(/Claude/);
    expect(readFileSync("src/app/receipts/draft-form.tsx", "utf8")).toContain("This receipt is sample data with no real personal details.");
    expect(readFileSync("src/app/receipts/draft-form.tsx", "utf8")).toContain('name="syntheticReceipt"');
  });
});
