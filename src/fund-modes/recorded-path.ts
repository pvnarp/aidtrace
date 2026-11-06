// IAC-405 PR GT (docs/ASSUMPTIONS.md, the gift trail approval path): the approval path a recognized decision recorded, read from stored rows only. Read only.
// It never reads the fund-modes flag and never recomputes a check, so a recognized claim's recorded path does not change when a flag changes. The Autopilot rule is the one
// reviewLineMode uses (autoRecognizedSent), so the claim page and the donor page cannot drift.
//   AUTOPILOT   an AUTO_RECOGNIZED record, no approval row, and a disbursement exists.
//   TWO_PEOPLE  at least two approval rows (a person takeover of an Autopilot claim, or the ordinary path).
//   ONE_PERSON  a NO_HOLDS record and one approval row.
//   null        anything else, including an Autopilot takeover with fewer than two approvals and an automatic payment that has not gone out.
import { inArray, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { PolicyReader } from "../policy/facts";

export type ApprovalPath = "AUTOPILOT" | "ONE_PERSON" | "TWO_PEOPLE";

// The shared Autopilot predicate: no person has approved and a payout exists.
export const autoRecognizedSent = (person: boolean, paid: boolean): boolean => !person && paid;

export function classifyApprovalPath(facts: { autoRecognized: boolean; noHolds: boolean; approvalCount: number; disbursed: boolean }): ApprovalPath | null {
  if (facts.approvalCount >= 2) return "TWO_PEOPLE";
  if (facts.autoRecognized && autoRecognizedSent(facts.approvalCount > 0, facts.disbursed)) return "AUTOPILOT";
  if (facts.noHolds && facts.approvalCount >= 1 && !facts.autoRecognized) return "ONE_PERSON";
  return null;
}

// One query each for approvals, automated decisions and disbursements, for a set of decision hashes. Keyed by decision hash.
export async function readRecordedApprovalPaths(db: PolicyReader, hashes: readonly string[]): Promise<Map<string, { approvalCount: number; path: ApprovalPath | null }>> {
  const result = new Map<string, { approvalCount: number; path: ApprovalPath | null }>();
  if (hashes.length === 0) return result;
  const list = [...hashes];
  const approvalRows = await db.select({ decisionHash: s.approvals.decisionHash, count: sql<number>`count(*)::int` }).from(s.approvals).where(inArray(s.approvals.decisionHash, list)).groupBy(s.approvals.decisionHash);
  const autoRows = await db.select({ decisionHash: s.automatedDecisions.decisionHash, kind: s.automatedDecisions.kind }).from(s.automatedDecisions)
    .where(inArray(s.automatedDecisions.decisionHash, list));
  const paidRows = await db.select({ decisionHash: s.disbursements.decisionHash }).from(s.disbursements).where(inArray(s.disbursements.decisionHash, list));
  const approvalCount = new Map(approvalRows.map(row => [row.decisionHash, row.count]));
  const auto = new Set(autoRows.filter(row => row.kind === "AUTO_RECOGNIZED").map(row => row.decisionHash));
  const noHolds = new Set(autoRows.filter(row => row.kind === "NO_HOLDS").map(row => row.decisionHash));
  const paid = new Set(paidRows.map(row => row.decisionHash));
  for (const hash of list) {
    const count = approvalCount.get(hash) ?? 0;
    result.set(hash, { approvalCount: count, path: classifyApprovalPath({ autoRecognized: auto.has(hash), noHolds: noHolds.has(hash), approvalCount: count, disbursed: paid.has(hash) }) });
  }
  return result;
}
