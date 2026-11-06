import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiRecommendation } from "../src/app/receipts/ai-recommendation";
import { CLAUDE_EFFORT } from "../src/ai/claude-receipt";
import type { ReceiptAudit } from "../src/ai/audit";

// FT-04 (IAC-415 PR 5, "flow tidy", docs/GATE_REPORT.md section 52). Static markup of the AI recommendation header. No database, no network, no browser.
// The browser checks are FT-02 and FT-02b (the receipt page says the instruction once) and FT-03 (the re-check after changed terms).
const SENTENCE = "Edit the receipt to request a new review.";
const audit: ReceiptAudit = { provider: "claude", model: "claude-haiku-5-5", responseModel: "claude-haiku-5-5", effort: CLAUDE_EFFORT, promptVersion: "receipt-p1", schemaVersion: "receipt-s1",
  sourceSha256: "a".repeat(64), requestSha256: "b".repeat(64), responseSha256: "c".repeat(64), latencyMs: 1200, inputTokens: 812, outputTokens: 57 };
const lines = [{ id: "L1", description: "Robot kit", amount: "$3.00", proposal: { category: "robot_kits_parts", quote: "Robot kit" } }, { id: "L2", description: "Notebook", amount: "$3.00", proposal: null }];
const count = (text: string, part: string) => text.split(part).length - 1;
const header = (extra: Partial<Parameters<typeof AiRecommendation>[0]> = {}) => renderToStaticMarkup(createElement(AiRecommendation, { lines, ready: true, audit, configured: { name: "Claude Haiku 5.5" }, running: false, ...extra }));

describe("FT-04 the AI recommendation header carries the one 'request a new review' instruction, only while the receipt is editable", () => {
  it("states the instruction once, after the saved record line, when the receipt is editable", () => {
    const html = header({ editable: true });
    expect(count(html, SENTENCE)).toBe(1);
    expect(html.indexOf("Saved record:")).toBeGreaterThan(-1); expect(html.indexOf(SENTENCE)).toBeGreaterThan(html.indexOf("Saved record:"));
    expect(html).not.toContain("AI suggestions are saved for this receipt");
  });
  it("states it still once when no saved record can be named, and never when the receipt is not editable", () => {
    expect(count(header({ editable: true, audit: null }), SENTENCE)).toBe(1);
    expect(count(header({ editable: false }), SENTENCE)).toBe(0);
    expect(count(header(), SENTENCE), "editable defaults to false, so the page must pass it").toBe(0);
  });
  it("keeps the rest of the header: model line, count, limits and saved record", () => {
    const html = header({ editable: true });
    expect(html).toContain("Powered by Claude Haiku 5.5. The receipt text was sent to Anthropic for these suggestions.");
    expect(html).toContain("Suggested a category for 1 of 2 lines."); expect(html).toContain("A person confirms each category."); expect(html).toContain("Saved record: model AI (Haiku 5.5), schema receipt-s1.");
  });
  it("does not add the instruction to the idle strip, which is not a READY header", () => {
    expect(count(header({ editable: true, ready: false, audit: null }), SENTENCE)).toBe(0);
  });
});
