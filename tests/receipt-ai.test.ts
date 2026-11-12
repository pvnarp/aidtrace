import { expect, it } from "vitest";
import { validateProposals, type ReceiptInput } from "../src/ai/receipt";
import { claudeMessage, stubbedClaudeCategorizer } from "./support/claude-stub";
const input: ReceiptInput = { source: "INVENTED RECEIPT\nScience experiment kits\nBlank notebooks\n", lines: [{ id: "L1", description: "Science kits" }] };
const proposal = { lineId: "L1", category: "robot_kits_parts", quote: "Science experiment kits" };
it("locates exact quotes in the original source, with UTF-16 offsets and original line order", () => {
  const unicode = { source: "🤖\r\nScience experiment kits", lines: input.lines };
  const [result] = validateProposals(unicode, { proposals: [proposal] });
  expect(result).toMatchObject({ category: "robot_kits_parts", start: 4 });
  expect(unicode.source.slice(result!.start!, result!.end!)).toBe(proposal.quote);
  const multi = { ...input, lines: [...input.lines, { id: "L2", description: "Notebook" }] };
  expect(validateProposals(multi, { proposals: [{ lineId: "L2", category: "classroom_supplies", quote: "Blank notebooks" }, proposal] }).map(x => x.lineId)).toEqual(["L1", "L2"]);
});
it("keeps explicit model abstention separate from grounded suggestions", () => {
  expect(validateProposals(input, { proposals: [{ ...proposal, category: "UNKNOWN", quote: "" }] })).toEqual([{ lineId: "L1", category: "UNKNOWN", quote: "", start: null, end: null }]);
});
it.each([
  { ...proposal, amount: "500.00" }, { ...proposal, payee: "attacker@example.invalid" },
  { ...proposal, fundId: "fund_g" }, { ...proposal, approved: true },
  { ...proposal, lineId: "OTHER" }, { ...proposal, category: "fund_a" },
])("refuses extra authority fields and unknown identity/taxonomy: %j", value => {
  expect(() => validateProposals(input, { proposals: [value] })).toThrow("SHAPE");
});
it.each(["", "Science EXPERIMENT kits", "Imaginary item", " "])("refuses ungrounded quote %j", quote => {
  expect(() => validateProposals(input, { proposals: [{ ...proposal, quote }] })).toThrow("GROUNDING");
});
it("refuses ambiguous quotes, duplicate or missing IDs, unsolicited top-level fields and grounded UNKNOWN", () => {
  expect(() => validateProposals({ ...input, source: `${input.source}\nScience experiment kits` }, { proposals: [proposal] })).toThrow("GROUNDING");
  const multi = { ...input, lines: [...input.lines, { id: "L2", description: "Notebook" }] };
  expect(() => validateProposals(multi, { proposals: [proposal, proposal] })).toThrow("SHAPE");
  expect(() => validateProposals(multi, { proposals: [proposal] })).toThrow("SHAPE");
  expect(() => validateProposals(input, { proposals: [proposal], tool: "pay" })).toThrow("SHAPE");
  expect(() => validateProposals(input, { proposals: [{ ...proposal, category: "UNKNOWN" }] })).toThrow("GROUNDING");
});
it("validates bounded inputs before any model request, including forbidden input fields", async () => {
  const { categorize, calls } = stubbedClaudeCategorizer(() => claudeMessage({ proposals: [proposal] }));
  for (const bad of [{ ...input, source: "" }, { ...input, source: "x".repeat(16385) }, { ...input, payee: "private" },
    { ...input, lines: [{ ...input.lines[0], amount: "1.00" }] }, { ...input, lines: [input.lines[0], input.lines[0]] },
    { ...input, lines: [] }]) await expect(categorize(bad as ReceiptInput)).rejects.toMatchObject({ code: "INPUT" });
  expect(calls).toHaveLength(0);
});
// Removed with the local categorizer (Claude only): the tests of the private chat endpoint, its
// envelope and byte bounds, its single-flight guard, its timeout and its server error mapping. The Claude categorizer has the same
// guarantees under CAI-01, CAI-02, CAI-09, CAI-10, CAI-16, CAI-17 and CAI-18 in tests/claude-receipt.test.ts.
