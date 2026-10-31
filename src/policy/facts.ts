// Reads the stored facts the rules need, inside one transaction snapshot. Read-only: nothing here writes, and nothing here
// calls a provider, a model or the clock. The frozen decision, its edges and the claim are read as stored.
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import { COUNTED_STATUSES } from "./rules";
import { normalizeVendor } from "./text";
import type { PolicyFacts, PolicyPeer, PolicyThresholds } from "./types";

export type PolicyReader = Pick<Parameters<Parameters<AppDatabase["transaction"]>[0]>[0], "select">;
const RECEIPT_CLAIM = /^R-[a-f0-9-]{36}$/;

export async function loadPolicyFacts(tx: PolicyReader, decisionHash: string): Promise<PolicyFacts | null> {
  const [decision] = await tx.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.decisionHash, decisionHash));
  if (!decision) return null;
  const [claim] = await tx.select().from(s.claims).where(and(eq(s.claims.id, decision.claimId), eq(s.claims.version, decision.claimVersion)));
  if (!claim) return null;
  const lines = await tx.select().from(s.claimLines).where(and(eq(s.claimLines.claimId, claim.id), eq(s.claimLines.claimVersion, claim.version)));
  const edges = await tx.select({ lineId: s.allocationEdges.lineId, fundId: s.allocationEdges.fundId }).from(s.allocationEdges).where(eq(s.allocationEdges.decisionId, decision.id));
  const fundIds = [...new Set(edges.map(edge => edge.fundId))].sort();
  // Latest settings version per funding fund. A fund with no row is simply absent.
  const settingsRows = fundIds.length ? await tx.select().from(s.fundCheckSettings).where(inArray(s.fundCheckSettings.fundId, fundIds)).orderBy(desc(s.fundCheckSettings.version)) : [];
  const latest = new Map<string, PolicyThresholds>();
  for (const row of settingsRows) if (!latest.has(row.fundId)) latest.set(row.fundId, {
    fundId: row.fundId, version: row.version, suppliesLimitCents: row.suppliesLimitCents, equipmentLimitCents: row.equipmentLimitCents, claimLimitCents: row.claimLimitCents,
    staleReceiptDays: row.staleReceiptDays, duplicateWindowDays: row.duplicateWindowDays, splitWindowDays: row.splitWindowDays });

  // Other claims in the same organization, newest version of each claim id, kept only when the vendor matches after normalization.
  const key = normalizeVendor(claim.vendor);
  let peers: PolicyPeer[] = [];
  if (key) {
    const others = await tx.select().from(s.claims).where(and(eq(s.claims.organizationId, claim.organizationId), ne(s.claims.id, claim.id)));
    const newest = new Map<string, typeof others[number]>();
    for (const row of others) { const seen = newest.get(row.id); if (!seen || row.version > seen.version) newest.set(row.id, row); }
    const related = [...newest.values()].filter(row => COUNTED_STATUSES.includes(row.status) && normalizeVendor(row.vendor) === key);
    const peerLines = related.length ? await tx.select().from(s.claimLines).where(inArray(s.claimLines.claimId, related.map(row => row.id))) : [];
    peers = related.map(row => ({ claimId: row.id, version: row.version, vendor: row.vendor, incurredOn: row.incurredOn, claimantId: row.claimantId, status: row.status,
      lines: peerLines.filter(line => line.claimId === row.id && line.claimVersion === row.version).map(line => ({ budgetLine: line.budgetLine, amountCents: line.amountCents })) }));
  }

  // The screen stored at confirmation, newest review revision first. Rows from before migration 0013 hold null: no screen part, no error.
  let receiptScreen: PolicyFacts["receiptScreen"] = null;
  if (RECEIPT_CLAIM.test(claim.id)) {
    const [stored] = await tx.select({ screen: s.receiptConfirmations.prohibitedScreen }).from(s.receiptConfirmations)
      .innerJoin(s.receiptReviews, eq(s.receiptReviews.id, s.receiptConfirmations.reviewId))
      .where(and(eq(s.receiptReviews.claimId, claim.id), eq(s.receiptReviews.claimVersion, claim.version))).orderBy(desc(s.receiptReviews.revision)).limit(1);
    if (stored?.screen && Array.isArray(stored.screen.matches)) receiptScreen = stored.screen.matches.filter(match => typeof match?.category === "string" && typeof match?.term === "string").map(match => ({ category: match.category, term: match.term }));
  }

  return {
    claim: { id: claim.id, version: claim.version, vendor: claim.vendor, incurredOn: claim.incurredOn, claimantId: claim.claimantId, organizationId: claim.organizationId },
    frozenOn: decision.frozenAt.toISOString().slice(0, 10),
    lines: lines.map(line => ({ id: line.id, description: line.description, category: line.category, budgetLine: line.budgetLine, amountCents: line.amountCents })),
    funding: edges, thresholds: [...latest.values()], peers, receiptScreen,
  };
}
