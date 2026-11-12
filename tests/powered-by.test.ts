import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { poweredByLine, poweredByNames, modelCheckDisclosure, ruleDraftFormDisclosure, ruleDraftReviewDisclosure } from "../src/app/ai-disclosure";
import { AiRecommendation, aiModelLine } from "../src/app/receipts/ai-recommendation";
import { ReceiptEvidence } from "../src/app/receipts/receipt-evidence";
import { aiCard } from "../src/app/shell-copy";
import { PolicyChecks } from "../src/app/claims/[claimId]/policy-checks";
import type { ReceiptAudit } from "../src/ai/audit";
import { calledModelsOf, modelStatusOf, type StoredModelLine, type StoredModelPair, type StoredModelRun } from "../src/policy/model-read";
import { modelAskedBy, modelCheckedBy } from "../src/policy/copy";
import type { StoredPolicyRun } from "../src/policy/service";

// PB-01 to PB-05 (November 5: a line that starts "Powered by" names the model wherever a specific model is used). Static and render checks only:
// no database, no network, no browser, no model. The database part (CALL rows read back from a real run) is PB-07 and PB-08 in tests/model-check.integration.test.ts, and the
// rendered pages are PB-09 to PB-12 in the e2e specs.
const HAIKU = "claude-haiku-5-5", SONNET = "claude-sonnet-5-5";
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("PB-01 the Powered by line builder", () => {
  it("names one model, two models in first-seen order and joins three with commas and a final and", () => {
    expect(poweredByLine([HAIKU])).toBe("Powered by Claude Haiku 5.5.");
    expect(poweredByLine([SONNET])).toBe("Powered by Claude Sonnet 5.5.");
    expect(poweredByLine([HAIKU, SONNET])).toBe("Powered by Claude Haiku 5.5 and Claude Sonnet 5.5.");
    expect(poweredByLine([SONNET, HAIKU])).toBe("Powered by Claude Sonnet 5.5 and Claude Haiku 5.5.");
  });
  it("names each model once, however many requests it was sent", () => {
    expect(poweredByLine([HAIKU, HAIKU])).toBe("Powered by Claude Haiku 5.5.");
    expect(poweredByLine([HAIKU, SONNET, HAIKU, SONNET])).toBe("Powered by Claude Haiku 5.5 and Claude Sonnet 5.5.");
  });
  it("gives an empty string for no model, and for any id it cannot name exactly, so a page renders nothing instead of a guess", () => {
    expect(poweredByLine([])).toBe("");
    expect(poweredByLine(["not-a-model-id"])).toBe("");
    expect(poweredByLine(["claude-opus-5-5"])).toBe("");
    expect(poweredByLine([HAIKU, "claude-opus-5-5"])).toBe("");
    expect(poweredByLine([""])).toBe("");
  });
  it("poweredByNames takes display names from the same table and refuses any other string", () => {
    expect(poweredByNames(["Claude Haiku 5.5"])).toBe("Powered by Claude Haiku 5.5.");
    expect(poweredByNames(["Claude Haiku 5.5", "Claude Sonnet 5.5", "Claude Haiku 5.5"])).toBe("Powered by Claude Haiku 5.5 and Claude Sonnet 5.5.");
    expect(poweredByNames([])).toBe("");
    for (const name of ["Earlier AI model, since retired", "Unrecognized AI record", "AI (Haiku 5.5)", "Claude Opus 5.5"]) expect(poweredByNames([name]), name).toBe("");
  });
});

describe("PB-02 the rules draft lines", () => {
  it("the form line and a drafted review line start with Powered by, built from the id, and keep the Anthropic sentence", () => {
    expect(ruleDraftFormDisclosure(SONNET)).toBe("Powered by Claude Sonnet 5.5. Nothing is sent until you press Draft rules. Then the grant text above goes to Anthropic for the draft, which you review.");
    expect(ruleDraftReviewDisclosure(SONNET)).toBe("Powered by Claude Sonnet 5.5. The grant text was sent to Anthropic. The AI drafts only: it cannot approve or change a rule.");
    expect(ruleDraftReviewDisclosure(HAIKU)).toMatch(/^Powered by Claude Haiku 5\.5\. The grant text was sent to Anthropic\./);
  });
  it("a draft a person edited stores no model and shows no Powered by line", () => {
    expect(ruleDraftReviewDisclosure(null)).toBe("A person edited this draft. Saving the edit sent nothing to Anthropic.");
    expect(ruleDraftReviewDisclosure(null)).not.toMatch(/Powered by/);
  });
  it("a model id the table cannot name leaves the Anthropic sentence and no Powered by line", () => {
    expect(ruleDraftFormDisclosure("custom-model")).toBe("Nothing is sent until you press Draft rules. Then the grant text above goes to Anthropic for the draft, which you review.");
    expect(ruleDraftReviewDisclosure("custom-model")).not.toMatch(/Powered by|custom-model/);
  });
});

describe("PB-03 the policy model check line is built from the models that were sent a request", () => {
  const line = (over: Partial<StoredModelLine> = {}): StoredModelLine => ({ lineId: "L2", description: "Classroom markers", verdict: "OK", clauseId: null, clauseText: null, ...over });
  const pair = (over: Partial<StoredModelPair>): StoredModelPair => ({ fundId: "fund_a", fundName: "Fund A", policyVersion: 1, state: "CHECKED", reasonCode: null, model: HAIKU, effort: "low", lines: [line()], called: [HAIKU], ...over });
  const run = (pairs: StoredModelPair[], calledModels: string[]): StoredModelRun => ({
    id: "run-1", startedAt: new Date("2026-11-05T12:00:00Z"), model: `${HAIKU}>${SONNET}`, effort: "low", promptVersion: "compliance-v1", schemaVersion: "compliance-lines-v1",
    clauseSetHash: "b".repeat(64), state: "DONE", status: modelStatusOf("DONE", pairs), pairs, calledModels,
  });
  const render = (model: StoredModelRun) => text(renderToStaticMarkup(createElement(PolicyChecks, {
    claimId: "R-1", decisionHash: "a".repeat(64), canRun: false, modelEligible: true,
    run: { id: "rules-1", startedAt: new Date("2026-11-05T11:59:00Z"), startedByName: "Tara", ruleSetVersion: "rules-v1", settingsVersions: { fund_a: 1 }, complete: true, flags: [], notChecked: [], model } as StoredPolicyRun,
  })));

  it("Haiku only: the line names Haiku and not Sonnet, and the fund row names Haiku", () => {
    const body = render(run([pair({})], [HAIKU]));
    expect(body).toContain("Powered by Claude Haiku 5.5. Claim line and clause text was sent to Anthropic.");
    expect(body).toContain("Checked by AI (Haiku 5.5) at low effort."); expect(body).not.toMatch(/Sonnet/);
  });
  it("Haiku then Sonnet: the line names both, Haiku first, and the escalated fund row says Haiku 5.5, then Sonnet 5.5", () => {
    const escalated = pair({ model: SONNET, called: [HAIKU, SONNET] });
    const stayed = pair({ fundId: "fund_b", fundName: "Fund B", called: [HAIKU] });
    const body = render(run([escalated, stayed], [HAIKU, SONNET]));
    expect(body).toContain("Powered by Claude Haiku 5.5 and Claude Sonnet 5.5. Claim line and clause text was sent to Anthropic.");
    expect(body).toContain("Fund A Checked by AI (Haiku 5.5, then Sonnet 5.5) at low effort.");
    expect(body).toContain("Fund B Checked by AI (Haiku 5.5) at low effort.");
    expect(body.match(/Claim line and clause text was sent to Anthropic\./g)).toHaveLength(1);
    // The stored pair alone (Sonnet) is what the page named before November 5, and it left Haiku unnamed.
    expect(body.indexOf("Claude Haiku 5.5")).toBeLessThan(body.indexOf("Claude Sonnet 5.5"));
  });
  it("a fund that failed on both steps says it asked both models", () => {
    const body = render(run([pair({ state: "NOT_CHECKED", reasonCode: "INVALID", model: SONNET, lines: [], called: [HAIKU, SONNET] })], [HAIKU, SONNET]));
    expect(body).toContain("Asked AI (Haiku 5.5, then Sonnet 5.5) at low effort."); expect(body).not.toContain("Checked by");
  });
  it("a pair refused by the request limit sent nothing: no CALL row, so it is named nowhere", () => {
    const limited = render(run([pair({ state: "NOT_CHECKED", reasonCode: "LIMIT", model: SONNET, lines: [], called: [] })], []));
    expect(limited).not.toMatch(/Powered by|Anthropic|Claude|Asked AI|Sonnet/);
    // Haiku was sent a request, then Sonnet was refused: only Haiku is named.
    const half = render(run([pair({ state: "NOT_CHECKED", reasonCode: "LIMIT", model: SONNET, lines: [], called: [HAIKU] })], [HAIKU]));
    expect(half).toContain("Powered by Claude Haiku 5.5."); expect(half).toContain("Asked AI (Haiku 5.5) at low effort."); expect(half).not.toContain("Sonnet");
  });
  it("NOT_CHECKED with no call, a skipped General fund and a run with no calls show no Powered by line", () => {
    const none = render(run([pair({ state: "NOT_CHECKED", reasonCode: "NO_CLAUSES", model: null, effort: null, lines: [], called: [] }),
      pair({ fundId: "fund_g", fundName: "General fund", state: "SKIPPED", reasonCode: "GENERAL_FUND", model: null, effort: null, lines: [], called: [] })], []));
    expect(none).not.toMatch(/Powered by|Anthropic|Claude/);
    expect(modelCheckDisclosure([])).toBe("");
  });
  it("the stored CALL rows decide: only CALL entries with a model count, in sequence order, once each", () => {
    expect(calledModelsOf([{ entry: "CALL", model: HAIKU }, { entry: "LINE", model: SONNET }, { entry: "CALL", model: SONNET }, { entry: "CALL", model: HAIKU }, { entry: "RUN_END", model: null }])).toEqual([HAIKU, SONNET]);
    expect(calledModelsOf([{ entry: "SKIPPED", model: null }, { entry: "NOT_CHECKED", model: SONNET }])).toEqual([]);
    expect(modelCheckedBy([HAIKU, SONNET], "low")).toBe("Checked by AI (Haiku 5.5, then Sonnet 5.5) at low effort.");
    expect(modelCheckedBy([HAIKU, HAIKU], "low")).toBe("Checked by AI (Haiku 5.5) at low effort.");
    expect(modelAskedBy([HAIKU, SONNET], "low")).toBe("Asked AI (Haiku 5.5, then Sonnet 5.5) at low effort.");
  });
});

describe("PB-04 the receipt category suggestion lines", () => {
  const audit = { provider: "claude", model: SONNET, responseModel: SONNET, effort: "low", promptVersion: "p", schemaVersion: "receipt-s1" } as unknown as ReceiptAudit;
  it("the saved line, the idle strip, the card and the evidence note all start with Powered by and name the model from the stored record", () => {
    expect(aiModelLine(audit)).toBe("Powered by Claude Sonnet 5.5. The receipt text was sent to Anthropic for these suggestions.");
    const idle = renderToStaticMarkup(createElement(AiRecommendation, { lines: [], ready: false, audit: null, configured: { name: "Claude Haiku 5.5" }, running: false }));
    expect(text(idle)).toContain("Powered by Claude Haiku 5.5. The receipt text goes to Anthropic.");
    expect(aiCard({ applicable: true, suggestion: "READY", confirmed: false, aiAccepted: false, savedModel: "Claude Sonnet 5.5", configured: { name: "Claude Haiku 5.5", shellName: "Claude Haiku" } }).model).toBe("Powered by Claude Sonnet 5.5.");
    expect(aiCard({ applicable: true, suggestion: "NONE", confirmed: false, aiAccepted: false, savedModel: null, configured: { name: "Claude Haiku 5.5", shellName: "Claude Haiku" } }).model).toBe("Powered by Claude Haiku 5.5.");
    const evidence = { segments: [{ text: "Science kit", lineId: null }], grounded: false } as never;
    expect(text(renderToStaticMarkup(createElement(ReceiptEvidence, { evidence, modelLabel: poweredByNames(["Claude Haiku 5.5"]) })))).toContain("Powered by Claude Haiku 5.5. Text in, category suggestions out.");
  });
  it("the evidence note does not repeat a model line the page already shows in the same section", () => {
    const evidence = { segments: [{ text: "Science kit", lineId: null }], grounded: true } as never;
    const note = text(renderToStaticMarkup(createElement(ReceiptEvidence, { evidence, modelLabel: "" })));
    expect(note).not.toMatch(/Powered by|No AI suggestion/); expect(note).toContain("Text in, category suggestions out.");
    // November 10 cut 4: before any suggestion (modelLabel null) the note lines are left out entirely.
    expect(text(renderToStaticMarkup(createElement(ReceiptEvidence, { evidence, modelLabel: null })))).not.toMatch(/No AI suggestion|Text in, category suggestions|No current validated highlights/);
    const page = readFileSync("src/app/claims/[claimId]/receipt/page.tsx", "utf8");
    expect(page).toContain("const modelLineShown = confirmation ? aiAccepted : evidence.grounded;"); expect(page).toContain("modelLineShown ? \"\"");
  });
  it("no model is named where none was used: the AI-off strip, a person's own choice and an unrecognized or retired record", () => {
    const off = renderToStaticMarkup(createElement(AiRecommendation, { lines: [], ready: false, audit: null, configured: null, aiOff: "AI suggestions are off in this session: no AI key is configured.", running: false }));
    expect(text(off)).not.toMatch(/Powered by|Anthropic/);
    expect(aiCard({ applicable: true, suggestion: "NONE", confirmed: true, aiAccepted: false, savedModel: null, configured: { name: "Claude Haiku 5.5", shellName: "Claude Haiku" } }).model).toBeNull();
    expect(aiCard({ applicable: true, suggestion: "READY", confirmed: false, aiAccepted: false, savedModel: "Earlier AI model, since retired", configured: null }).model).toBe("Model: Earlier AI model, since retired");
    expect(aiModelLine(null)).not.toMatch(/Powered by/);
  });
});

describe("PB-05 a Powered by line is built in one place", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
  const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w"'`])\/\/.*$/gm, "$1");
  const files = [...walk("src")].filter(path => /\.tsx?$/.test(path) && !/^src\/app\/lab\//.test(path));
  it("only src/app/ai-disclosure.ts writes the words Powered by, so no page can type a model name into one", () => {
    const writers = files.filter(path => /Powered by/.test(strip(readFileSync(path, "utf8")))).map(path => path.replace(/\\/g, "/"));
    // The client dashboard and the photo reader only test that a server line starts with these words before showing it. shell-copy cannot import src/ai (the GT-30 closure), so it
    // adds the words to a display name that CLAUDE_NAMES already supplied.
    expect(writers.sort()).toEqual(["src/app/ai-disclosure.ts", "src/app/analytics/dashboard.tsx", "src/app/receipts/photo-reader.tsx", "src/app/shell-copy.ts"]);
    for (const path of ["src/app/analytics/dashboard.tsx", "src/app/receipts/photo-reader.tsx"]) {
      expect(strip(readFileSync(path, "utf8")), path).not.toMatch(/Haiku|Sonnet|Opus|Claude/);
    }
  });
  it("no page under src/app types a model family name in a string", () => {
    const pages = files.filter(path => path.startsWith("src/app/"));
    for (const path of pages) expect(strip(readFileSync(path, "utf8")), path).not.toMatch(/["'`][^"'`\n]*\b(Haiku|Sonnet|Opus)\b[^"'`\n]*["'`]/);
  });
});
