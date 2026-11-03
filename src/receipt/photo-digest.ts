import { createHash } from "node:crypto";

// IAC-384 fix round (docs/ASSUMPTIONS.md section 83 item 16): one canonical serialization of the content a photo read pre-fills, so the server can tell whether a saved draft still
// holds what the AI read. Vendor, each line description and amount in order, the total and the receipt text count. The date and the program do not: the person chooses those.
// Only the SHA-256 is ever stored, never the serialization or the transcript. Pure, so the read route (which builds the pre-fill) and the receipt service (which saves the submitted values)
// share exactly one definition.
export type PhotoContent = { vendor: string; lines: { description: string; amountCents: bigint | number }[]; totalCents: bigint | number; source: string };
const text = (value: string) => value.trim();
// A browser sends a textarea's line breaks as CRLF, the server builds the pre-fill with LF. Nothing else about the text is changed.
const source = (value: string) => value.replace(/\r\n?/g, "\n");
export const photoContentDigest = (content: PhotoContent): string => createHash("sha256").update(JSON.stringify({
  vendor: text(content.vendor), lines: content.lines.map(line => [text(line.description), line.amountCents.toString()]), total: content.totalCents.toString(), source: source(content.source),
})).digest("hex");
// "12.50" to 1250. Only the two-decimal shape the form uses; anything else is not a pre-fill amount.
export function centsOfInput(value: string): bigint | null {
  const match = /^(0|[1-9]\d{0,9})\.(\d{2})$/.exec(value);
  return match ? BigInt(match[1]!) * 100n + BigInt(match[2]!) : null;
}
