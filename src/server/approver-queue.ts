import { and, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "./db";
import { approvalsText } from "../ledger/view";

// IAC-414 Q1 (docs/plans/GRID_SURFACES_SCOPE.md section 3.2 step A): the approver queue loader.
// One transaction that starts `set transaction read only` at repeatable read, and SELECT statements only. It imports neither the PayPal
// adapter nor a ledger writer, and it never calls the approval code. Cents leave this module as decimal strings and the grid turns them
// into bigint. No floating point value holds money here. Today's membership rule is kept as it was on the home page: a practice receipt
// claim of the approver's organization that awaits approval, minus any claim this approver already approved, which waits for the second approver.
export class ApproverQueueAccessError extends Error {
  constructor(public readonly status: 403) { super("Approver access required"); this.name = "ApproverQueueAccessError"; }
}

export const UNKNOWN_AGE = "Unknown";
const MINUTE_MS = 60_000; const HOUR_MS = 60 * MINUTE_MS; const DAY_MS = 24 * HOUR_MS;

/** "Just now", "45m", "2h", "3d": the whole unit below the next one, as the Trust mock writes it. A time in the future reads as just now. */
export function formatAge(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < MINUTE_MS) return "Just now";
  if (elapsedMs < HOUR_MS) return `${Math.floor(elapsedMs / MINUTE_MS)}m`;
  if (elapsedMs < DAY_MS) return `${Math.floor(elapsedMs / HOUR_MS)}h`;
  return `${Math.floor(elapsedMs / DAY_MS)}d`;
}

/** One row per claim awaiting this approver. Cents are decimal strings. No claimant id, approver id, decision hash or payee email is here. */
export interface ApproverQueueRow {
  /** The claim id. Today's home already puts it in each card's link and data attribute. */
  id: string;
  claimant: string;
  vendor: string;
  /** The funds of the frozen split, largest first, joined with commas. The claim's program when no frozen split exists. */
  fund: string;
  amountCents: string;
  /** Distinct approvers on the claim's current frozen terms. It is a count only: no approver is named. */
  approvalCount: number;
  /** "Approvals: 1 of 2". */
  approvals: string;
  /** When the current terms were frozen as an ISO timestamp, or an empty string when no frozen terms exist. */
  waitingSince: string;
  age: string;
  href: string;
}
export interface ApproverQueue { observedAt: string; rows: ApproverQueueRow[] }

const claimKey = (id: string, version: number) => `${id}:${version}`;

export async function loadApproverQueue(db: AppDatabase, actorId: string, now: Date = new Date()): Promise<ApproverQueue> {
  return db.transaction(async tx => {
    await tx.execute(sql`set transaction read only`);
    const [actor] = await tx.select({ id: s.users.id, organizationId: s.users.organizationId, role: s.users.role }).from(s.users).where(eq(s.users.id, actorId));
    if (!actor || actor.role !== "APPROVER") throw new ApproverQueueAccessError(403);
    const observedAt = now.toISOString();

    // The organization's practice receipt claims, newest version of each. Only a claim whose newest version awaits approval can be in the queue.
    const all = await tx.select().from(s.claims).where(and(eq(s.claims.organizationId, actor.organizationId), like(s.claims.id, "R-%")));
    const newest = new Map<string, (typeof all)[number]>();
    for (const row of all) { const seen = newest.get(row.id); if (!seen || row.version > seen.version) newest.set(row.id, row); }
    const awaiting = [...newest.values()].filter(row => row.status === "AWAITING_APPROVAL");
    if (awaiting.length === 0) return { observedAt, rows: [] };
    const ids = awaiting.map(row => row.id);

    const lineRows = await tx.select({ claimId: s.claimLines.claimId, claimVersion: s.claimLines.claimVersion, amountCents: s.claimLines.amountCents }).from(s.claimLines).where(inArray(s.claimLines.claimId, ids));
    const totals = new Map<string, bigint>();
    for (const line of lineRows) totals.set(claimKey(line.claimId, line.claimVersion), (totals.get(claimKey(line.claimId, line.claimVersion)) ?? 0n) + line.amountCents);

    // The current frozen terms of each claim version: its newest decision that is not invalidated, in this organization.
    const decisionRows = await tx.select({ id: s.allocationDecisions.id, claimId: s.allocationDecisions.claimId, claimVersion: s.allocationDecisions.claimVersion, decisionHash: s.allocationDecisions.decisionHash, frozenAt: s.allocationDecisions.frozenAt })
      .from(s.allocationDecisions).where(and(inArray(s.allocationDecisions.claimId, ids), eq(s.allocationDecisions.organizationId, actor.organizationId), isNull(s.allocationDecisions.invalidatedAt))).orderBy(desc(s.allocationDecisions.frozenAt));
    const decisionOf = new Map<string, (typeof decisionRows)[number]>();
    for (const decision of decisionRows) { const key = claimKey(decision.claimId, decision.claimVersion); if (!decisionOf.has(key)) decisionOf.set(key, decision); }
    const current = awaiting.map(claim => decisionOf.get(claimKey(claim.id, claim.version)));

    const hashes = current.flatMap(decision => (decision ? [decision.decisionHash] : []));
    const approvalRows = hashes.length ? await tx.select({ decisionHash: s.approvals.decisionHash, approverId: s.approvals.approverId }).from(s.approvals).where(inArray(s.approvals.decisionHash, hashes)) : [];
    const approversOf = new Map<string, Set<string>>();
    for (const approval of approvalRows) approversOf.set(approval.decisionHash, (approversOf.get(approval.decisionHash) ?? new Set<string>()).add(approval.approverId));

    const decisionIds = current.flatMap(decision => (decision ? [decision.id] : []));
    const edgeRows = decisionIds.length ? await tx.select({ decisionId: s.allocationEdges.decisionId, fundId: s.allocationEdges.fundId, amountCents: s.allocationEdges.amountCents }).from(s.allocationEdges).where(inArray(s.allocationEdges.decisionId, decisionIds)) : [];
    const fundRows = await tx.select({ id: s.funds.id, name: s.funds.name }).from(s.funds).where(eq(s.funds.organizationId, actor.organizationId));
    const fundName = new Map(fundRows.map(fund => [fund.id, fund.name] as const));
    const userRows = await tx.select({ id: s.users.id, displayName: s.users.displayName }).from(s.users).where(and(eq(s.users.organizationId, actor.organizationId), inArray(s.users.id, [...new Set(awaiting.map(claim => claim.claimantId))])));
    const claimantName = new Map(userRows.map(user => [user.id, user.displayName] as const));

    const fundLabel = (decisionId: string | undefined, program: string): string => {
      if (!decisionId) return program;
      const byFund = new Map<string, bigint>();
      for (const edge of edgeRows) if (edge.decisionId === decisionId) byFund.set(edge.fundId, (byFund.get(edge.fundId) ?? 0n) + edge.amountCents);
      const names = [...byFund.entries()].flatMap(([fundId, cents]) => (fundName.has(fundId) ? [{ name: fundName.get(fundId)!, cents }] : []))
        .sort((a, b) => (a.cents === b.cents ? a.name.localeCompare(b.name) : a.cents > b.cents ? -1 : 1)).map(entry => entry.name);
      return names.length ? names.join(", ") : program;
    };

    const rows: ApproverQueueRow[] = [];
    awaiting.forEach((claim, index) => {
      const decision = current[index];
      const approvers = decision ? approversOf.get(decision.decisionHash) ?? new Set<string>() : new Set<string>();
      // A claim this approver already approved waits for the second approver, so it is not counted as needing this person's review.
      if (approvers.has(actor.id)) return;
      const waitingSince = decision ? decision.frozenAt.toISOString() : "";
      rows.push({
        id: claim.id,
        claimant: claimantName.get(claim.claimantId) ?? "Claimant",
        vendor: claim.vendor,
        fund: fundLabel(decision?.id, claim.program),
        amountCents: (totals.get(claimKey(claim.id, claim.version)) ?? 0n).toString(),
        approvalCount: approvers.size,
        approvals: `Approvals: ${approvalsText(approvers.size)}`,
        waitingSince,
        age: decision ? formatAge(now.getTime() - decision.frozenAt.getTime()) : UNKNOWN_AGE,
        href: `/claims/${claim.id}`,
      });
    });
    // Longest waiting first. A claim with no frozen terms has no time and sorts last.
    rows.sort((a, b) => (a.waitingSince === b.waitingSince ? a.id.localeCompare(b.id) : !a.waitingSince ? 1 : !b.waitingSince ? -1 : a.waitingSince < b.waitingSince ? -1 : 1));
    return { observedAt, rows };
  }, { isolationLevel: "repeatable read" });
}
