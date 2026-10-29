import { createHash } from "node:crypto";

export type SourceSegment = { text: string; lineId?: string };
export type QuoteEvidence = { source: string; segments: SourceSegment[]; grounded: boolean };
type Review = { id: string; claimVersion: number; source: string; sourceHash: string };
type Suggestion = { reviewId: string; status: string; audit: Record<string, string | number> | null;
  proposals: { lineId: string; category: string; quote: string; start: number | null; end: number | null }[] | null };

// Display evidence only. Confirmation and financial authority remain on the server routes.
export function quoteEvidence(review: Review, claimVersion: number, lineIds: string[], suggestion?: Suggestion | null): QuoteEvidence {
  const plain = { source: review.source, segments: [{ text: review.source }], grounded: false };
  if (review.claimVersion !== claimVersion || !suggestion || suggestion.status !== "READY" ||
      suggestion.reviewId !== review.id || !suggestion.proposals || suggestion.proposals.length !== lineIds.length ||
      suggestion.audit?.sourceSha256 !== review.sourceHash ||
      createHash("sha256").update(review.source).digest("hex") !== review.sourceHash) return plain;
  const seen = new Set<string>();
  const ranges: { start: number; end: number; lineId: string }[] = [];
  for (const p of suggestion.proposals) {
    if (!lineIds.includes(p.lineId) || seen.has(p.lineId) || !/^[A-Za-z0-9_-]{1,32}$/.test(p.lineId)) return plain;
    seen.add(p.lineId);
    if (p.category === "UNKNOWN") {
      if (p.quote !== "" || p.start !== null || p.end !== null) return plain;
      continue;
    }
    if (!["science_kits", "notebooks", "hospitality", "alcohol"].includes(p.category) ||
        typeof p.quote !== "string" || !p.quote.trim() || p.quote.length > 400 ||
        !Number.isSafeInteger(p.start) || !Number.isSafeInteger(p.end) || p.start! < 0 ||
        p.end! <= p.start! || p.end! > review.source.length ||
        review.source.slice(p.start!, p.end!) !== p.quote || review.source.indexOf(p.quote) !== p.start ||
        review.source.lastIndexOf(p.quote) !== p.start) return plain;
    ranges.push({ start: p.start!, end: p.end!, lineId: p.lineId });
  }
  ranges.sort((a, b) => a.start - b.start);
  if (!ranges.length || ranges.some((r, i) => i > 0 && r.start < ranges[i - 1]!.end)) return plain;
  const segments: SourceSegment[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) segments.push({ text: review.source.slice(cursor, r.start) });
    segments.push({ text: review.source.slice(r.start, r.end), lineId: r.lineId }); cursor = r.end;
  }
  if (cursor < review.source.length) segments.push({ text: review.source.slice(cursor) });
  return { source: review.source, segments, grounded: true };
}
