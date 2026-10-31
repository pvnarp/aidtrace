import { CATEGORIES, type Category } from "./categories";

export { CATEGORIES, type Category };
export type ReceiptInput = { source: string; lines: { id: string; description: string }[] };
export type GroundedProposal = { lineId: string; category: Category; quote: string; start: number | null; end: number | null };
export type AiErrorCode = "INPUT" | "BUSY" | "TIMEOUT" | "UNAVAILABLE" | "RESPONSE_SIZE" | "SHAPE" | "GROUNDING";
export class ReceiptAiError extends Error {
  constructor(public readonly code: AiErrorCode, public readonly responseSha256?: string) { super(`Receipt AI ${code}; review manually. No financial action performed.`); }
}
function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(","));
}
export function validateReceiptInput(value: unknown): asserts value is ReceiptInput {
  if (!exactKeys(value, ["source", "lines"]) || typeof value.source !== "string" ||
    !value.source.trim() || Buffer.byteLength(value.source) > 16384 || !Array.isArray(value.lines) ||
    value.lines.length < 1 || value.lines.length > 12) throw new ReceiptAiError("INPUT");
  const ids = new Set<string>();
  for (const line of value.lines) {
    if (!exactKeys(line, ["id", "description"]) || typeof line.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(line.id) || ids.has(line.id) ||
      typeof line.description !== "string" || !line.description.trim() ||
      Buffer.byteLength(line.description) > 256) throw new ReceiptAiError("INPUT");
    ids.add(line.id);
  }
}
export function validateProposals(input: ReceiptInput, value: unknown): GroundedProposal[] {
  validateReceiptInput(input);
  if (!exactKeys(value, ["proposals"]) || !Array.isArray(value.proposals) || value.proposals.length !== input.lines.length) throw new ReceiptAiError("SHAPE");
  const ids = new Set(input.lines.map(line => line.id));
  const found = new Map<string, GroundedProposal>();
  for (const item of value.proposals) {
    if (!exactKeys(item, ["lineId", "category", "quote"]) || typeof item.lineId !== "string" ||
      !ids.has(item.lineId) || found.has(item.lineId) || typeof item.category !== "string" ||
      !CATEGORIES.includes(item.category as Category) || typeof item.quote !== "string" || item.quote.length > 400) throw new ReceiptAiError("SHAPE");
    const category = item.category as Category;
    if (category === "UNKNOWN") {
      if (item.quote !== "") throw new ReceiptAiError("GROUNDING");
      found.set(item.lineId, { lineId: item.lineId, category, quote: "", start: null, end: null });
      continue;
    }
    const start = item.quote.trim() ? input.source.indexOf(item.quote) : -1;
    if (start < 0 || input.source.indexOf(item.quote, start + 1) !== -1) throw new ReceiptAiError("GROUNDING");
    found.set(item.lineId, { lineId: item.lineId, category, quote: item.quote, start, end: start + item.quote.length });
  }
  return input.lines.map(line => found.get(line.id)!);
}
