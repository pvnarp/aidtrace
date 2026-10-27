import { createHash } from "node:crypto";
import { CATEGORIES } from "../ai/receipt";
export const CLAIM_ID = /^R-[a-f0-9-]{36}$/;
export type DraftInput = { vendor: string; program: string; incurredOn: string; source: string; total: string; lines: { description: string; amount: string }[] };
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function parseUsd(value: string) {
  if (!/^(0|[1-9]\d{0,5})\.\d{2}$/.test(value)) throw new Error("Use USD with exactly two decimal places");
  const [whole, fraction] = value.split("."); const cents = BigInt(whole!) * 100n + BigInt(fraction!);
  if (cents <= 0n || cents > 50000n) throw new Error("Draft amounts must be positive and at most USD 500");
  return cents;
}
export function normalizeDraft(input: DraftInput) {
  if (!input || typeof input.vendor !== "string" || !input.vendor.trim() || input.vendor.trim().length > 120 ||
    typeof input.program !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(input.program) ||
    typeof input.incurredOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.incurredOn) ||
    !Number.isFinite(Date.parse(input.incurredOn)) || new Date(input.incurredOn).toISOString().slice(0, 10) !== input.incurredOn ||
    typeof input.source !== "string" || !input.source.trim() || Buffer.byteLength(input.source) > 16384 ||
    !Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 12) throw new Error("Invalid receipt draft");
  const lines = input.lines.map((line, i) => {
    if (!line || typeof line.description !== "string" || !line.description.trim() || Buffer.byteLength(line.description) > 256 || typeof line.amount !== "string") throw new Error("Invalid receipt line");
    return { id: `L${i + 1}`, description: line.description.trim(), amountCents: parseUsd(line.amount) };
  });
  const total = lines.reduce((sum, line) => sum + line.amountCents, 0n);
  if (total !== parseUsd(input.total)) throw new Error("Receipt total must equal entered line amounts");
  return { vendor: input.vendor.trim(), program: input.program, incurredOn: input.incurredOn, source: input.source, lines };
}
type ClaimTerms = { id: string; version: number; organizationId: string; claimantId: string; payeeEmail: string; vendor: string; program: string; incurredOn: string };
type LineTerms = { id: string; description: string; amountCents: bigint; category?: string; budgetLine?: string };
export function draftHash(claim: ClaimTerms, lines: LineTerms[], includeCategories = false) {
  return digest(JSON.stringify({ id: claim.id, version: claim.version, organizationId: claim.organizationId, claimantId: claim.claimantId, payeeEmail: claim.payeeEmail,
    vendor: claim.vendor, program: claim.program, incurredOn: claim.incurredOn,
    lines: [...lines].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(line => ({ id: line.id, description: line.description, amountCents: line.amountCents.toString(), ...(includeCategories ? { category: line.category, budgetLine: line.budgetLine } : {}) })) }));
}
export function budgetFor(category: string) {
  if (!(CATEGORIES as readonly string[]).includes(category) || category === "UNKNOWN") throw new Error("Every line requires a confirmed category");
  return category === "science_kits" || category === "notebooks" ? "supplies" : category === "hospitality" ? "hospitality" : "prohibited";
}
