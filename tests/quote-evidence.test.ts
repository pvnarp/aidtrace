import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { quoteEvidence } from "../src/app/receipts/quote-evidence";
const source = "INVENTED RECEIPT\nScience experiment kit\nBlank notebook";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const review = { id: "review-one", claimVersion: 1, source, sourceHash: hash(source) };
const proposal = { lineId: "L1", category: "robot_kits_parts", quote: "Science experiment kit", start: source.indexOf("Science"), end: source.indexOf("Science") + "Science experiment kit".length };
const suggestion = { reviewId: review.id, status: "READY", audit: { sourceSha256: review.sourceHash }, proposals: [proposal] };
const build = (value: NonNullable<Parameters<typeof quoteEvidence>[3]> = suggestion) => quoteEvidence(review, 1, ["L1"], value);
it("highlights the exact saved range while preserving all receipt text", () => {
  const result = build(); expect(result.grounded).toBe(true);
  expect(result.segments.filter(s => s.lineId)).toEqual([{ text: proposal.quote, lineId: "L1" }]);
  expect(result.segments.map(s => s.text).join("")).toBe(source);
});
it.each(["RUNNING", "FAILED"])("does not highlight %s work", status => {
  expect(build({ ...suggestion, status }).grounded).toBe(false);
});
it("refuses a different review/version, absent evidence or a mismatched source digest", () => {
  for (const result of [quoteEvidence(review, 2, ["L1"], suggestion), quoteEvidence(review, 1, ["L1"]),
    build({ ...suggestion, reviewId: "older-review" }), build({ ...suggestion, audit: { sourceSha256: "old" } }),
    quoteEvidence({ ...review, source: "Changed receipt" }, 1, ["L1"], suggestion)]) {
    expect(result.grounded).toBe(false); expect(result.segments).toEqual([{ text: result.source }]);
  }
});
it.each([
  { start: -1 }, { start: 1.5 }, { start: null }, { end: null }, { end: 99999 },
  { end: proposal.start }, { quote: "Fabricated quote" }, { category: "unapproved" }, { lineId: "L9" },
])("fails closed for invalid quote evidence %j", change => {
  const result = build({ ...suggestion, proposals: [{ ...proposal, ...change }] });
  expect(result.grounded).toBe(false); expect(result.segments).toEqual([{ text: source }]);
});
it("rejects repeated source quotes even when one offset matches", () => {
  const repeated = source + "\n" + proposal.quote;
  expect(quoteEvidence({ ...review, source: repeated, sourceHash: hash(repeated) }, 1, ["L1"],
    { ...suggestion, audit: { sourceSha256: hash(repeated) } }).grounded).toBe(false);
});
it("rejects overlapping or duplicate-line highlights as a whole", () => {
  const start = source.indexOf("experiment");
  const nested = { lineId: "L2", category: "classroom_supplies", quote: "experiment", start, end: start + 10 };
  expect(quoteEvidence(review, 1, ["L1", "L2"], { ...suggestion, proposals: [proposal, nested] }).grounded).toBe(false);
  expect(quoteEvidence(review, 1, ["L1", "L2"], { ...suggestion, proposals: [proposal, proposal] }).grounded).toBe(false);
});
it("leaves UNKNOWN unhighlighted and preserves validated known quotes", () => {
  const unknown = { lineId: "L2", category: "UNKNOWN", quote: "", start: null, end: null };
  const result = quoteEvidence(review, 1, ["L1", "L2"], { ...suggestion, proposals: [proposal, unknown] });
  expect(result.grounded).toBe(true); expect(result.segments.filter(s => s.lineId)).toHaveLength(1);
  expect(quoteEvidence(review, 1, ["L1", "L2"], { ...suggestion, proposals: [proposal, { ...unknown, quote: "Blank" }] }).grounded).toBe(false);
});
it("uses saved UTF-16 offsets without changing Unicode, CRLF or HTML-shaped text", () => {
  const special = '🤖\r\n<img src="x" onerror="alert(1)">';
  const text = special.slice(4), start = 4;
  const result = quoteEvidence({ ...review, source: special, sourceHash: hash(special) }, 1, ["L1"],
    { ...suggestion, audit: { sourceSha256: hash(special) }, proposals: [{ ...proposal, quote: text, start, end: special.length }] });
  expect(result.grounded).toBe(true); expect(result.segments.map(s => s.text).join("")).toBe(special);
  expect(result.segments.find(s => s.lineId)?.text).toBe(text);
});
