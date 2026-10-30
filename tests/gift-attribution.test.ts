import { describe, expect, it } from "vitest";
import { attributeGifts, GIFT_ATTRIBUTION_POLICY, type AttributionClaim, type AttributionEdge, type AttributionGift, type AttributionInput } from "../src/donation/attribution";
import { DONATION_MAX_CENTS } from "../src/paypal/adapter";

// DON-05 (docs/plans/DONATION_LOOP_SCOPE.md sections 5 and 10). Pure function, no database.
// The edge amounts for the USD 500 claim are the real fixture edges, read from tests/fixture-allocation.integration.test.ts
// and db/fixture.ts: fund_a L1 8000 and L2 15000, fund_b L1 20000, fund_g L3 7000. Other claims use synthetic edges of the same shape.
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0, 0);
const at = (offsetMs: number) => new Date(T0 + offsetMs);
const gift = (captureId: string, fundId: string, grossCents: bigint, offsetMs: number): AttributionGift => ({ captureId, fundId, grossCents, recordedAt: at(offsetMs) });
const FIXTURE_EDGES = [{ lineId: "L1", fundId: "fund_a", amountCents: 8000n }, { lineId: "L2", fundId: "fund_a", amountCents: 15000n }, { lineId: "L1", fundId: "fund_b", amountCents: 20000n }, { lineId: "L3", fundId: "fund_g", amountCents: 7000n }];
const claim = (claimId: string, offsetMs: number, edges = FIXTURE_EDGES, claimVersion = 1): AttributionClaim => ({ claimId, claimVersion, decisionHash: "a".repeat(64), recognizedAt: at(offsetMs), edges });
const applied = (captureId: string, claimId: string, lineId: string, fundId: string, appliedCents: bigint, claimVersion = 1) => ({ captureId, claimId, claimVersion, lineId, fundId, appliedCents });

describe("DON-05 GIFT_ATTRIBUTION_V1: scope section 5 examples", () => {
  it("names the policy", () => { expect(GIFT_ATTRIBUTION_POLICY).toBe("GIFT_ATTRIBUTION_V1"); expect(attributeGifts({ gifts: [], claims: [] })).toEqual({ policy: "GIFT_ATTRIBUTION_V1", applications: [], unspent: [] }); });
  it("a USD 25 gift to fund_b then the USD 500 claim applies USD 25.00 to L1 of the fund_b share", () => {
    const result = attributeGifts({ gifts: [gift("CAP1", "fund_b", 2500n, 0)], claims: [claim("C-104", 1000)] });
    expect(result.applications).toEqual([applied("CAP1", "C-104", "L1", "fund_b", 2500n)]);
    expect(result.unspent).toEqual([]);
  });
  it("gifts of USD 100 and USD 150 to fund_b give 100 and 100 on L1 with 50 unspent", () => {
    const result = attributeGifts({ gifts: [gift("CAP1", "fund_b", 10000n, 0), gift("CAP2", "fund_b", 15000n, 10)], claims: [claim("C-104", 1000)] });
    expect(result.applications).toEqual([applied("CAP1", "C-104", "L1", "fund_b", 10000n), applied("CAP2", "C-104", "L1", "fund_b", 10000n)]);
    expect(result.unspent).toEqual([{ captureId: "CAP2", fundId: "fund_b", remainingCents: 5000n }]);
  });
  it("a gift to fund_a whose USD 230 edge spans L1 then L2 is consumed in line order", () => {
    const result = attributeGifts({ gifts: [gift("CAP1", "fund_a", 20000n, 0)], claims: [claim("C-104", 1000)] });
    expect(result.applications).toEqual([applied("CAP1", "C-104", "L1", "fund_a", 8000n), applied("CAP1", "C-104", "L2", "fund_a", 12000n)]);
    expect(result.unspent).toEqual([]);
  });
  it("a gift recorded after recognition does not attach and stays unspent in full", () => {
    const result = attributeGifts({ gifts: [gift("LATE", "fund_b", 2500n, 1001)], claims: [claim("C-104", 1000)] });
    expect(result.applications).toEqual([]);
    expect(result.unspent).toEqual([{ captureId: "LATE", fundId: "fund_b", remainingCents: 2500n }]);
  });
});

describe("DON-05 GIFT_ATTRIBUTION_V1: cases", () => {
  it("single gift covering a whole line: fund_a L1 exactly", () => {
    const result = attributeGifts({ gifts: [gift("CAP1", "fund_a", 8000n, 0)], claims: [claim("C-104", 1000)] });
    expect(result.applications).toEqual([applied("CAP1", "C-104", "L1", "fund_a", 8000n)]);
    expect(result.unspent).toEqual([]);
  });
  it("partial: a gift smaller than the edge covers part of one line", () => {
    const result = attributeGifts({ gifts: [gift("CAP1", "fund_a", 1n, 0)], claims: [claim("C-104", 1000)] });
    expect(result.applications).toEqual([applied("CAP1", "C-104", "L1", "fund_a", 1n)]);
  });
  it("a gift larger than the whole edge total leaves the remainder unspent", () => {
    const result = attributeGifts({ gifts: [gift("CAP1", "fund_a", 30000n, 0)], claims: [claim("C-104", 1000)] });
    expect(result.applications).toEqual([applied("CAP1", "C-104", "L1", "fund_a", 8000n), applied("CAP1", "C-104", "L2", "fund_a", 15000n)]);
    expect(result.unspent).toEqual([{ captureId: "CAP1", fundId: "fund_a", remainingCents: 7000n }]);
  });
  it("multi-gift and multi-line: a layer remainder carries to the next edge and several gifts share one line", () => {
    const gifts = [gift("CAP1", "fund_a", 5000n, 0), gift("CAP2", "fund_a", 5000n, 1), gift("CAP3", "fund_a", 9000n, 2)];
    const result = attributeGifts({ gifts, claims: [claim("C-104", 1000)] });
    expect(result.applications).toEqual([
      applied("CAP1", "C-104", "L1", "fund_a", 5000n), applied("CAP2", "C-104", "L1", "fund_a", 3000n),
      applied("CAP2", "C-104", "L2", "fund_a", 2000n), applied("CAP3", "C-104", "L2", "fund_a", 9000n),
    ]);
    expect(result.unspent).toEqual([]);
  });
  it("processes edges by line ID ascending whatever the input order", () => {
    const edges = [{ lineId: "L2", fundId: "fund_a", amountCents: 15000n }, { lineId: "L1", fundId: "fund_a", amountCents: 8000n }];
    const result = attributeGifts({ gifts: [gift("CAP1", "fund_a", 9000n, 0)], claims: [claim("C-104", 1000, edges)] });
    expect(result.applications).toEqual([applied("CAP1", "C-104", "L1", "fund_a", 8000n), applied("CAP1", "C-104", "L2", "fund_a", 1000n)]);
  });
  it("orders line IDs by code unit, not by locale or number: L10 sorts before L2", () => {
    const edges = [{ lineId: "L2", fundId: "fund_a", amountCents: 100n }, { lineId: "L10", fundId: "fund_a", amountCents: 100n }];
    const result = attributeGifts({ gifts: [gift("CAP1", "fund_a", 150n, 0)], claims: [claim("C-9", 1000, edges)] });
    expect(result.applications.map(row => [row.lineId, row.appliedCents])).toEqual([["L10", 100n], ["L2", 50n]]);
  });
  it("a gift recorded one millisecond before recognition counts", () => {
    expect(attributeGifts({ gifts: [gift("CAP1", "fund_b", 100n, 999)], claims: [claim("C-104", 1000)] }).applications).toEqual([applied("CAP1", "C-104", "L1", "fund_b", 100n)]);
  });
  it("exact-time tie: the claim is processed first, so the gift does not count", () => {
    const result = attributeGifts({ gifts: [gift("CAP1", "fund_b", 100n, 1000)], claims: [claim("C-104", 1000)] });
    expect(result.applications).toEqual([]);
    expect(result.unspent).toEqual([{ captureId: "CAP1", fundId: "fund_b", remainingCents: 100n }]);
  });
  it("same-time gifts are layered by capture ID", () => {
    const result = attributeGifts({ gifts: [gift("CAP_B", "fund_b", 15000n, 0), gift("CAP_A", "fund_b", 15000n, 0)], claims: [claim("C-104", 1000)] });
    expect(result.applications).toEqual([applied("CAP_A", "C-104", "L1", "fund_b", 15000n), applied("CAP_B", "C-104", "L1", "fund_b", 5000n)]);
    expect(result.unspent).toEqual([{ captureId: "CAP_B", fundId: "fund_b", remainingCents: 10000n }]);
  });
  it("two claims competing for one gift: the older recognition wins and the younger gets the rest", () => {
    const edges = (cents: bigint) => [{ lineId: "L1", fundId: "fund_b", amountCents: cents }];
    const result = attributeGifts({ gifts: [gift("CAP1", "fund_b", 10000n, 0)], claims: [claim("C-NEW", 3000, edges(8000n)), claim("C-OLD", 2000, edges(8000n))] });
    expect(result.applications).toEqual([applied("CAP1", "C-NEW", "L1", "fund_b", 2000n), applied("CAP1", "C-OLD", "L1", "fund_b", 8000n)]);
    expect(result.unspent).toEqual([]);
  });
  it("a gift recorded between two recognitions attaches only to the later claim", () => {
    const edges = [{ lineId: "L1", fundId: "fund_b", amountCents: 8000n }];
    const result = attributeGifts({ gifts: [gift("CAP1", "fund_b", 5000n, 2500)], claims: [claim("C-OLD", 2000, edges), claim("C-NEW", 3000, edges)] });
    expect(result.applications).toEqual([applied("CAP1", "C-NEW", "L1", "fund_b", 5000n)]);
  });
  it("claims recognized at the same instant are ordered by claim ID then version", () => {
    const edges = [{ lineId: "L1", fundId: "fund_b", amountCents: 100n }];
    const result = attributeGifts({ gifts: [gift("CAP1", "fund_b", 150n, 0)], claims: [claim("C-2", 1000, edges), claim("C-1", 1000, edges, 2), claim("C-1", 1000, edges, 1)] });
    expect(result.applications).toEqual([applied("CAP1", "C-1", "L1", "fund_b", 100n, 1), applied("CAP1", "C-1", "L1", "fund_b", 50n, 2)]);
  });
  it("gifts in two funds stay separate and never draw on another fund", () => {
    const result = attributeGifts({ gifts: [gift("CAP_A", "fund_a", 1000n, 0), gift("CAP_B", "fund_b", 2000n, 1), gift("CAP_G", "fund_g", 500n, 2)], claims: [claim("C-104", 1000)] });
    expect(result.applications).toEqual([applied("CAP_A", "C-104", "L1", "fund_a", 1000n), applied("CAP_B", "C-104", "L1", "fund_b", 2000n), applied("CAP_G", "C-104", "L3", "fund_g", 500n)]);
    const noEdges = attributeGifts({ gifts: [gift("CAP_X", "fund_x", 700n, 0)], claims: [claim("C-104", 1000)] });
    expect(noEdges.applications).toEqual([]);
    expect(noEdges.unspent).toEqual([{ captureId: "CAP_X", fundId: "fund_x", remainingCents: 700n }]);
  });
  it("a claim that draws on no gifted fund attributes nothing", () => {
    expect(attributeGifts({ gifts: [], claims: [claim("C-104", 1000)] }).applications).toEqual([]);
  });
  it("sorts unspent by fund then capture ID and applications by claim, line, fund, capture", () => {
    const result = attributeGifts({ gifts: [gift("Z", "fund_b", 50n, 5000), gift("A", "fund_b", 50n, 5000), gift("M", "fund_a", 50n, 5000)], claims: [] });
    expect(result.unspent.map(row => [row.fundId, row.captureId])).toEqual([["fund_a", "M"], ["fund_b", "A"], ["fund_b", "Z"]]);
  });
  it("does not mutate its input", () => {
    const input: AttributionInput = { gifts: [gift("CAP2", "fund_b", 15000n, 10), gift("CAP1", "fund_b", 10000n, 0)], claims: [claim("C-104", 1000, [...FIXTURE_EDGES].reverse())] };
    const before = structuredClone(input);
    attributeGifts(input);
    expect(input).toEqual(before);
    expect(input.gifts.map(row => row.captureId)).toEqual(["CAP2", "CAP1"]);
  });
});

// A small seeded generator so a failure is reproducible. It produces integers only.
function lcg(seed: number) { let state = seed >>> 0; return (limit: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; }; }
function shuffled<T>(items: readonly T[], next: (limit: number) => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) { const j = next(i + 1); [copy[i], copy[j]] = [copy[j]!, copy[i]!]; }
  return copy;
}
function scenario(next: (limit: number) => number): AttributionInput {
  const funds = ["fund_a", "fund_b", "fund_g"];
  const gifts = Array.from({ length: 1 + next(7) }, (_, i) => gift(`CAP${i}`, funds[next(3)]!, BigInt(1 + next(30000)), next(6) * 500));
  const claims = Array.from({ length: 1 + next(4) }, (_, i) => claim(`C-${i}`, next(6) * 500, [...new Set(Array.from({ length: 1 + next(4) }, () => `L${1 + next(4)}|${funds[next(3)]}`))].map(pair => { const [lineId, fundId] = pair.split("|"); return { lineId: lineId!, fundId: fundId!, amountCents: BigInt(1 + next(25000)) }; }), 1 + next(2)));
  return { gifts, claims: [...new Map(claims.map(row => [`${row.claimId}/${row.claimVersion}`, row])).values()] };
}

describe("DON-05 GIFT_ATTRIBUTION_V1: order independence and conservation", () => {
  it("returns the same output for 40 shuffles of gifts, claims and edges", () => {
    const base: AttributionInput = {
      gifts: [gift("CAP1", "fund_b", 10000n, 0), gift("CAP2", "fund_b", 15000n, 10), gift("CAP3", "fund_a", 9000n, 20), gift("CAP4", "fund_a", 9000n, 20), gift("LATE", "fund_a", 10n, 5000)],
      claims: [claim("C-104", 1000), claim("C-105", 2000, [{ lineId: "L1", fundId: "fund_b", amountCents: 9000n }, { lineId: "L2", fundId: "fund_a", amountCents: 100n }]), claim("C-104", 3000, FIXTURE_EDGES, 2)],
    };
    const expected = attributeGifts(base); const next = lcg(20261030);
    expect(expected.applications.length).toBeGreaterThan(4);
    for (let round = 0; round < 40; round++) {
      const permuted: AttributionInput = { gifts: shuffled(base.gifts, next), claims: shuffled(base.claims, next).map(row => ({ ...row, edges: shuffled(row.edges, next) })) };
      expect(attributeGifts(permuted)).toEqual(expected);
    }
  });
  it("conserves cents over 300 seeded scenarios: applied plus unspent equals gross, applied never exceeds an edge, and order never matters", () => {
    const next = lcg(379);
    for (let round = 0; round < 300; round++) {
      const input = scenario(next); const result = attributeGifts(input);
      for (const g of input.gifts) {
        const used = result.applications.filter(row => row.captureId === g.captureId).reduce((sum, row) => sum + row.appliedCents, 0n);
        const left = result.unspent.find(row => row.captureId === g.captureId)?.remainingCents ?? 0n;
        expect(used + left).toBe(g.grossCents);
        for (const row of result.applications.filter(a => a.captureId === g.captureId)) expect(row.fundId).toBe(g.fundId);
      }
      for (const c of input.claims) for (const edge of c.edges) {
        const used = result.applications.filter(row => row.claimId === c.claimId && row.claimVersion === c.claimVersion && row.lineId === edge.lineId && row.fundId === edge.fundId).reduce((sum, row) => sum + row.appliedCents, 0n);
        expect(used <= edge.amountCents).toBe(true);
      }
      for (const row of result.applications) {
        const g = input.gifts.find(x => x.captureId === row.captureId)!; const c = input.claims.find(x => x.claimId === row.claimId && x.claimVersion === row.claimVersion)!;
        expect(row.appliedCents > 0n).toBe(true); expect(g.recordedAt.getTime() < c.recognizedAt.getTime()).toBe(true);
      }
      expect(attributeGifts({ gifts: shuffled(input.gifts, next), claims: shuffled(input.claims, next) })).toEqual(result);
    }
  });
});

describe("DON-05 GIFT_ATTRIBUTION_V1: validation", () => {
  const mutableEdges = (input: AttributionInput) => input.claims[0]!.edges as AttributionEdge[];

  const good = (): AttributionInput => ({ gifts: [gift("CAP1", "fund_b", 100n, 0)], claims: [claim("C-104", 1000, FIXTURE_EDGES.map(edge => ({ ...edge })))] });
  const bad: [string, (input: AttributionInput) => void][] = [
    ["zero gift", input => { (input.gifts as AttributionGift[])[0]!.grossCents = 0n; }],
    ["negative gift", input => { (input.gifts as AttributionGift[])[0]!.grossCents = -1n; }],
    ["number gift", input => { (input.gifts as AttributionGift[])[0]!.grossCents = 100 as unknown as bigint; }],
    ["empty capture ID", input => { (input.gifts as AttributionGift[])[0]!.captureId = ""; }],
    ["empty gift fund", input => { (input.gifts as AttributionGift[])[0]!.fundId = ""; }],
    ["invalid gift time", input => { (input.gifts as AttributionGift[])[0]!.recordedAt = new Date("not a date"); }],
    ["string gift time", input => { (input.gifts as AttributionGift[])[0]!.recordedAt = "2026-10-30" as unknown as Date; }],
    ["duplicate capture ID", input => { (input.gifts as AttributionGift[]).push(gift("CAP1", "fund_a", 1n, 1)); }],
    ["zero edge", input => { mutableEdges(input)[0]!.amountCents = 0n; }],
    ["negative edge", input => { mutableEdges(input)[0]!.amountCents = -5n; }],
    ["number edge", input => { mutableEdges(input)[0]!.amountCents = 5 as unknown as bigint; }],
    ["empty line ID", input => { mutableEdges(input)[0]!.lineId = ""; }],
    ["duplicate line and fund inside one claim", input => { mutableEdges(input).push({ ...input.claims[0]!.edges[0]! }); }],
    ["duplicate claim and version", input => { (input.claims as AttributionClaim[]).push(claim("C-104", 2000)); }],
    ["claim version zero", input => { (input.claims as AttributionClaim[])[0]!.claimVersion = 0; }],
    ["fractional claim version", input => { (input.claims as AttributionClaim[])[0]!.claimVersion = 1.5; }],
    ["invalid claim time", input => { (input.claims as AttributionClaim[])[0]!.recognizedAt = new Date(NaN); }],
    ["empty decision hash", input => { (input.claims as AttributionClaim[])[0]!.decisionHash = ""; }],
    ["edges not an array", input => { (input.claims as AttributionClaim[])[0]!.edges = null as unknown as []; }],
  ];
  it("accepts the base input", () => { expect(() => attributeGifts(good())).not.toThrow(); });
  it.each(bad)("throws on %s", (_name, mutate) => { const input = good(); mutate(input); expect(() => attributeGifts(input)).toThrow(); });
  it("allows the same line in two funds and the same claim ID at two versions", () => {
    const edges = [{ lineId: "L1", fundId: "fund_a", amountCents: 1n }, { lineId: "L1", fundId: "fund_b", amountCents: 1n }];
    expect(() => attributeGifts({ gifts: [], claims: [claim("C-1", 1, edges, 1), claim("C-1", 1, edges, 2)] })).not.toThrow();
  });
  it("throws when the input is not the expected shape", () => { expect(() => attributeGifts(undefined as unknown as AttributionInput)).toThrow(); expect(() => attributeGifts({ gifts: [], claims: null } as unknown as AttributionInput)).toThrow(); });
});

describe("DON-05 GIFT_ATTRIBUTION_V1: very large cents", () => {
  it("near DONATION_MAX_CENTS keeps exact cents with no overflow", () => {
    const max = DONATION_MAX_CENTS;
    const edges = [{ lineId: "L1", fundId: "fund_b", amountCents: max }, { lineId: "L2", fundId: "fund_b", amountCents: max - 1n }];
    const result = attributeGifts({ gifts: [gift("BIG1", "fund_b", max, 0), gift("BIG2", "fund_b", max, 1)], claims: [claim("C-BIG", 1000, edges)] });
    expect(result.applications).toEqual([applied("BIG1", "C-BIG", "L1", "fund_b", max), applied("BIG2", "C-BIG", "L2", "fund_b", max - 1n)]);
    expect(result.unspent).toEqual([{ captureId: "BIG2", fundId: "fund_b", remainingCents: 1n }]);
  });
  it("beyond 2^53 loses no precision where a number would", () => {
    const huge = 2n ** 80n + 12345n; const edges = [{ lineId: "L1", fundId: "fund_b", amountCents: 2n ** 79n + 7n }];
    const result = attributeGifts({ gifts: [gift("HUGE", "fund_b", huge, 0)], claims: [claim("C-HUGE", 1000, edges)] });
    expect(result.applications).toEqual([applied("HUGE", "C-HUGE", "L1", "fund_b", 2n ** 79n + 7n)]);
    expect(result.unspent).toEqual([{ captureId: "HUGE", fundId: "fund_b", remainingCents: huge - (2n ** 79n + 7n) }]);
    expect(typeof result.applications[0]!.appliedCents).toBe("bigint");
  });
});
