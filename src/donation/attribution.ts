// IAC-379 step 2: policy GIFT_ATTRIBUTION_V1.
// A pure, read-only computation of which recorded gifts were applied to which approved receipt lines.
// It touches no database and no clock, moves no money and posts nothing. It is a narrative, not an accounting method and
// not GAAP: a restricted fund is fungible, so the result says "applied to", never "bought this exact item".
// All money is bigint integer cents. The only other numbers are claim versions and millisecond timestamps.
export const GIFT_ATTRIBUTION_POLICY = "GIFT_ATTRIBUTION_V1" as const;

export interface AttributionGift { captureId: string; fundId: string; grossCents: bigint; recordedAt: Date; }
export interface AttributionEdge { lineId: string; fundId: string; amountCents: bigint; }
// decisionHash identifies the frozen decision the edges came from. It is carried for later immutable rows and does not
// change the computation.
export interface AttributionClaim { claimId: string; claimVersion: number; decisionHash: string; recognizedAt: Date; edges: readonly AttributionEdge[]; }
export interface AttributionInput { gifts: readonly AttributionGift[]; claims: readonly AttributionClaim[]; }
export interface GiftApplication { captureId: string; claimId: string; claimVersion: number; lineId: string; fundId: string; appliedCents: bigint; }
export interface GiftUnspent { captureId: string; fundId: string; remainingCents: bigint; }
export interface AttributionResult { policy: typeof GIFT_ATTRIBUTION_POLICY; applications: GiftApplication[]; unspent: GiftUnspent[]; }

// Plain code-unit comparison, like src/domain/allocate.ts. Never localeCompare: a locale must not change who gets a gift.
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const compareNumber = (a: number, b: number) => a < b ? -1 : a > b ? 1 : 0;
const key = (...parts: (string | number)[]) => JSON.stringify(parts);

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}
function requirePositiveCents(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value <= 0n) throw new Error(`${label} must be positive integer cents as a bigint`);
  return value;
}
function requireTime(value: unknown, label: string): number {
  const time = value instanceof Date ? value.getTime() : NaN;
  if (!Number.isFinite(time)) throw new Error(`${label} must be a valid Date`);
  return time;
}

interface Layer { captureId: string; fundId: string; time: number; grossCents: bigint; remainingCents: bigint; }
interface PreparedClaim { claimId: string; claimVersion: number; time: number; edges: { lineId: string; amountCents: bigint }[]; }

export function attributeGifts(input: AttributionInput): AttributionResult {
  if (!input || !Array.isArray(input.gifts) || !Array.isArray(input.claims)) throw new Error("Attribution input needs gifts and claims arrays");
  const layers: Layer[] = []; const seenGifts = new Set<string>();
  for (const gift of input.gifts) {
    const captureId = requireText(gift.captureId, "Gift capture ID"); const fundId = requireText(gift.fundId, "Gift fund ID");
    const grossCents = requirePositiveCents(gift.grossCents, "Gift amount"); const time = requireTime(gift.recordedAt, "Gift recorded time");
    if (seenGifts.has(captureId)) throw new Error("Gift capture IDs must be unique");
    seenGifts.add(captureId); layers.push({ captureId, fundId, time, grossCents, remainingCents: grossCents });
  }
  const claimsByFund = new Map<string, PreparedClaim[]>(); const seenClaims = new Set<string>();
  for (const claim of input.claims) {
    const claimId = requireText(claim.claimId, "Claim ID"); requireText(claim.decisionHash, "Decision hash");
    if (!Number.isSafeInteger(claim.claimVersion) || claim.claimVersion < 1) throw new Error("Claim version must be a positive integer");
    const time = requireTime(claim.recognizedAt, "Claim recognition time");
    if (!Array.isArray(claim.edges)) throw new Error("Claim edges must be an array");
    if (seenClaims.has(key(claimId, claim.claimVersion))) throw new Error("Claim ID and version pairs must be unique");
    seenClaims.add(key(claimId, claim.claimVersion));
    const seenEdges = new Set<string>(); const byFund = new Map<string, { lineId: string; amountCents: bigint }[]>();
    for (const edge of claim.edges) {
      const lineId = requireText(edge.lineId, "Edge line ID"); const fundId = requireText(edge.fundId, "Edge fund ID");
      const amountCents = requirePositiveCents(edge.amountCents, "Edge amount");
      if (seenEdges.has(key(lineId, fundId))) throw new Error("A claim may have one edge for each line and fund");
      seenEdges.add(key(lineId, fundId)); byFund.set(fundId, [...byFund.get(fundId) ?? [], { lineId, amountCents }]);
    }
    for (const [fundId, edges] of byFund) {
      edges.sort((a, b) => compareText(a.lineId, b.lineId));
      claimsByFund.set(fundId, [...claimsByFund.get(fundId) ?? [], { claimId, claimVersion: claim.claimVersion, time, edges }]);
    }
  }

  const applications: GiftApplication[] = [];
  const fundIds = new Set([...layers.map(layer => layer.fundId), ...claimsByFund.keys()]);
  for (const fundId of fundIds) {
    // Gifts never draw on another fund: each fund has its own chronological layers and its own claims.
    const gifts = layers.filter(layer => layer.fundId === fundId).sort((a, b) => compareNumber(a.time, b.time) || compareText(a.captureId, b.captureId));
    const claims = [...claimsByFund.get(fundId) ?? []].sort((a, b) => compareNumber(a.time, b.time) || compareText(a.claimId, b.claimId) || compareNumber(a.claimVersion, b.claimVersion));
    const open: Layer[] = []; let next = 0;
    for (const claim of claims) {
      // A gift counts only if it was recorded strictly before the recognition. On an exact tie the claim goes first.
      while (next < gifts.length && gifts[next]!.time < claim.time) open.push(gifts[next++]!);
      for (const edge of claim.edges) {
        let need = edge.amountCents;
        // Oldest unspent layer first. Whatever no gift covers is opening balance or other non-gift credit, never a donor's.
        for (const layer of open) {
          if (need === 0n) break;
          if (layer.remainingCents === 0n) continue;
          const applied = layer.remainingCents < need ? layer.remainingCents : need;
          layer.remainingCents -= applied; need -= applied;
          applications.push({ captureId: layer.captureId, claimId: claim.claimId, claimVersion: claim.claimVersion, lineId: edge.lineId, fundId, appliedCents: applied });
        }
      }
    }
  }
  applications.sort((a, b) => compareText(a.claimId, b.claimId) || compareNumber(a.claimVersion, b.claimVersion) || compareText(a.lineId, b.lineId) || compareText(a.fundId, b.fundId) || compareText(a.captureId, b.captureId));
  const unspent = layers.filter(layer => layer.remainingCents > 0n).map(layer => ({ captureId: layer.captureId, fundId: layer.fundId, remainingCents: layer.remainingCents }))
    .sort((a, b) => compareText(a.fundId, b.fundId) || compareText(a.captureId, b.captureId));
  return { policy: GIFT_ATTRIBUTION_POLICY, applications, unspent };
}
