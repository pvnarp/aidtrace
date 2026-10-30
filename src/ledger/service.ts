import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import { allocate } from "../domain/allocate";
import { naive } from "../domain/naive";
import { hashDecision } from "../domain/hash";
import { policyEligibility, prepare, priorityCostsFor, validateAllocation, type AllocationEdge } from "../domain/model";
import { ACCOUNT_FOR_BUDGET_LINE, postJournal, type LedgerTransaction, type Posting } from "./journal";
import { ensureFixtureOpening } from "./opening";
import { payloadFor, readSnapshot, type Snapshot } from "./snapshot";
import { reconcile } from "./reconcile";
import { requireReceiptConfirmation } from "../receipt/guard";

type Decision = typeof s.allocationDecisions.$inferSelect;
function sqlState(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
}
export async function serializable<T>(db: AppDatabase, work: (tx: LedgerTransaction) => Promise<T>): Promise<T> {
  for (let retry = 0; ; retry++) {
    try { return await db.transaction(work, { isolationLevel: "serializable" }); }
    catch (error) { if (sqlState(error) !== "40001" || retry >= 3) throw error; }
  }
}
async function lockClaim(tx: LedgerTransaction, claimId: string, actorId: string) {
  const [claim] = await tx.select().from(s.claims).where(eq(s.claims.id, claimId)).orderBy(desc(s.claims.version)).limit(1);
  if (!claim) throw new Error("Claim not found");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${claim.organizationId})::bigint)`);
  await tx.execute(sql`select id from claims where id=${claim.id} and version=${claim.version} for update`);
  const [actor] = await tx.select({ id: s.users.id, organizationId: s.users.organizationId, role: s.users.role }).from(s.users).where(eq(s.users.id, actorId));
  if (!actor || actor.organizationId !== claim.organizationId) throw new Error("Authenticated organization member required");
  return { claim, actor };
}
async function edgesFor(tx: LedgerTransaction, decisionId: string): Promise<AllocationEdge[]> {
  const rows = await tx.select().from(s.allocationEdges).where(eq(s.allocationEdges.decisionId, decisionId));
  return rows.map(row => {
    if (!Number.isSafeInteger(row.solverPriorityVersion) || row.solverPriorityVersion < 1) throw new Error("Unsupported decision priority version");
    return { fundId: row.fundId, lineId: row.lineId, amountCents: row.amountCents, policyVersion: row.policyVersion, solverPriorityVersion: row.solverPriorityVersion, reason: row.reason };
  });
}
async function invalidate(tx: LedgerTransaction, decision: Decision) {
  if (decision.recognizedAt) throw new Error("Recognized decisions cannot be invalidated");
  if (!decision.invalidatedAt) await tx.update(s.allocationDecisions).set({ invalidatedAt: new Date() }).where(eq(s.allocationDecisions.id, decision.id));
  await tx.update(s.fundReservations).set({ status: "RELEASED" }).where(and(eq(s.fundReservations.decisionId, decision.id), eq(s.fundReservations.status, "ACTIVE")));
  await tx.update(s.claims).set({ status: "DRAFT" }).where(and(eq(s.claims.id, decision.claimId), eq(s.claims.version, decision.claimVersion), eq(s.claims.status, "AWAITING_APPROVAL")));
}
function expectedReservations(snapshot: Snapshot, edges: readonly AllocationEdge[]) {
  const result = new Map<string, Map<string, bigint>>();
  for (const edge of edges) {
    const line = snapshot.lines.find(line => line.id === edge.lineId); if (!line) throw new Error("Decision line is missing");
    const budgets = result.get(edge.fundId) ?? new Map<string, bigint>();
    budgets.set(line.budgetLine, (budgets.get(line.budgetLine) ?? 0n) + edge.amountCents); result.set(edge.fundId, budgets);
  }
  return result;
}
async function checkOwnReservations(tx: LedgerTransaction, snapshot: Snapshot, decision: Decision, edges: readonly AllocationEdge[]) {
  const expected = expectedReservations(snapshot, edges);
  const rows = await tx.select().from(s.fundReservations).where(eq(s.fundReservations.decisionId, decision.id));
  if (rows.length !== expected.size || rows.some(row => row.status !== "ACTIVE")) throw new Error("Decision requires its own active reservations");
  const splits = rows.length ? await tx.select().from(s.reservationBudgetLines).where(inArray(s.reservationBudgetLines.reservationId, rows.map(row => row.id))) : [];
  for (const row of rows) {
    const budgets = expected.get(row.fundId); const parts = splits.filter(part => part.reservationId === row.id);
    if (!budgets || row.amountCents !== [...budgets.values()].reduce((sum, amount) => sum + amount, 0n) || parts.length !== budgets.size || parts.some(part => budgets.get(part.budgetLine) !== part.amountCents)) throw new Error("Decision reservation amounts differ from its edges");
  }
  return expected;
}
export async function freezeDecision(db: AppDatabase, claimId: string, actorId: string) {
  return serializable(db, async tx => {
    const { claim, actor } = await lockClaim(tx, claimId, actorId);
    // The fixture's claimant submits their own claim; approvers cannot submit on their behalf.
    if (actor.id !== claim.claimantId || actor.role !== "CLAIMANT") throw new Error("Only the authenticated claimant may submit this claim");
    if (!["DRAFT", "AWAITING_APPROVAL"].includes(claim.status)) throw new Error("Claim is not open for allocation");
    await requireReceiptConfirmation(tx, claim);
    const previous = await tx.select().from(s.allocationDecisions).where(and(eq(s.allocationDecisions.claimId, claim.id), isNull(s.allocationDecisions.invalidatedAt)));
    if (previous.some(row => row.recognizedAt)) throw new Error("Claim already recognized");
    const sameVersion = previous.filter(row => row.claimVersion === claim.version);
    if (sameVersion.length > 1) throw new Error("Multiple active decisions violate claim integrity");
    let current: Decision | undefined = sameVersion[0];
    const policySnapshot = await readSnapshot(tx, claim.id, claim.version, false);
    // Release stale terms before solving, including when the replacement is infeasible.
    for (const old of previous) {
      if (old.claimVersion !== claim.version || hashDecision(payloadFor(policySnapshot, await edgesFor(tx, old.id))) !== old.decisionHash) {
        await invalidate(tx, old);
        if (old.id === current?.id) current = undefined;
      }
    }
    const snapshot = await readSnapshot(tx, claim.id, claim.version);
    const input = { ...snapshot.input, decisionId: current?.id };
    const context = prepare(input);
    if (Object.keys(snapshot.priority.costsPerCent).length !== context.costs.size) throw new Error("Approved priority must cover exactly the current funds");
    for (const [fund, cost] of context.costs) if (snapshot.priority.costsPerCent[fund] !== cost.toString()) throw new Error("Stored approved solver costs differ from priority policy v1");
    const allocation = allocate(input);
    if (allocation.status !== "FUNDED") return allocation;
    validateAllocation(input, allocation.edges);
    const payload = payloadFor(snapshot, allocation.edges); const decisionHash = hashDecision(payload);
    if (current?.decisionHash === decisionHash) {
      await checkOwnReservations(tx, snapshot, current, allocation.edges);
      return { status: "AWAITING_APPROVAL" as const, decisionId: current.id, decisionHash, edges: allocation.edges };
    }
    const [usedHash] = await tx.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.decisionHash, decisionHash));
    if (usedHash) throw new Error("Previously invalidated terms require a new claim version");
    for (const old of previous) if (old.id === current?.id) await invalidate(tx, old);
    await ensureFixtureOpening(tx, snapshot.organization.id);
    const baseline = naive(input);
    const comparison = { status: baseline.status, unrestrictedCents: baseline.status === "FUNDED" ? baseline.unrestrictedCents.toString() : undefined, edges: baseline.edges.map(edge => ({ fundId: edge.fundId, lineId: edge.lineId, amountCents: edge.amountCents.toString() })) };
    const [decision] = await tx.insert(s.allocationDecisions).values({ claimId: claim.id, claimVersion: claim.version, organizationId: claim.organizationId, solverPriorityVersion: snapshot.priority.version, payload, decisionHash, comparison }).returning();
    if (!decision) throw new Error("Decision was not created");
    await tx.insert(s.allocationEdges).values(allocation.edges.map(edge => ({ ...edge, decisionId: decision.id, claimId: claim.id, claimVersion: claim.version })));
    for (const [fundId, budgets] of expectedReservations(snapshot, allocation.edges)) {
      const [reservation] = await tx.insert(s.fundReservations).values({ decisionId: decision.id, fundId, amountCents: [...budgets.values()].reduce((sum, amount) => sum + amount, 0n), status: "ACTIVE" }).returning();
      if (!reservation) throw new Error("Reservation was not created");
      await tx.insert(s.reservationBudgetLines).values([...budgets].map(([budgetLine, amountCents]) => ({ reservationId: reservation.id, budgetLine, amountCents })));
    }
    await tx.update(s.claims).set({ status: "AWAITING_APPROVAL" }).where(and(eq(s.claims.id, claim.id), eq(s.claims.version, claim.version)));
    return { status: "AWAITING_APPROVAL" as const, decisionId: decision.id, decisionHash, edges: allocation.edges };
  });
}
async function recognize(tx: LedgerTransaction, decision: Decision, snapshot: Snapshot, edges: AllocationEdge[]) {
  if (decision.recognizedAt) return { status: "APPROVED" as const, decisionId: decision.id, decisionHash: decision.decisionHash, approvalCount: 2 };
  const rows = await tx.select().from(s.approvals).where(eq(s.approvals.decisionHash, decision.decisionHash));
  const users = rows.length ? await tx.select({ id: s.users.id, role: s.users.role, organizationId: s.users.organizationId }).from(s.users).where(inArray(s.users.id, rows.map(row => row.approverId))) : [];
  const valid = new Set(rows.filter(row => users.some(user => user.id === row.approverId && user.role === "APPROVER" && user.organizationId === snapshot.organization.id && user.id !== snapshot.claim.claimantId)).map(row => row.approverId));
  if (valid.size < 2) return { status: "AWAITING_APPROVAL" as const, decisionId: decision.id, decisionHash: decision.decisionHash, approvalCount: valid.size };
  // Accounting-inspired demo model, pending nonprofit accountant review.
  // Recheck policy only. Own ACTIVE reservations guarantee capacity; do not count them twice.
  for (const edge of edges) {
    const fund = snapshot.input.funds.find(row => row.id === edge.fundId); const line = snapshot.input.lines.find(row => row.id === edge.lineId);
    if (!fund || !line || fund.policy.version !== edge.policyVersion || !policyEligibility(snapshot.input, fund, line).eligible) throw new Error("Recorded allocation policy is no longer eligible");
  }
  const reserved = await checkOwnReservations(tx, snapshot, decision, edges);
  const recognition: Posting[] = snapshot.lines.map(line => {
    const accountCode = Object.hasOwn(ACCOUNT_FOR_BUDGET_LINE, line.budgetLine) ? ACCOUNT_FOR_BUDGET_LINE[line.budgetLine] : undefined;
    if (!accountCode) throw new Error("No approved expense account for this budget line");
    return { accountCode, subKey: line.id, debitCents: line.amountCents, creditCents: 0n };
  });
  recognition.push({ accountCode: "2010", subKey: snapshot.claim.claimantId, debitCents: 0n, creditCents: snapshot.lines.reduce((sum, line) => sum + line.amountCents, 0n) });
  await postJournal(tx, { sourceType: "claim_recognition", sourceId: decision.id, purpose: "recognition", effectiveOn: snapshot.claim.incurredOn, postings: recognition });
  const release: Posting[] = [];
  for (const [fundId, budgets] of reserved) {
    const amountCents = [...budgets.values()].reduce((sum, amount) => sum + amount, 0n);
    if (snapshot.funds.find(fund => fund.id === fundId)?.fundClass === "RESTRICTED") release.push({ accountCode: "3100", subKey: fundId, debitCents: amountCents, creditCents: 0n });
    for (const [budgetLine, amount] of budgets) await tx.insert(s.fundDebits).values({ fundId, budgetLine, amountCents: amount, sourceType: "claim_recognition", sourceId: decision.id, effectiveOn: snapshot.claim.incurredOn, decisionId: decision.id, purpose: `recognition:${budgetLine}` });
  }
  if (release.length) {
    release.push({ accountCode: "3200", debitCents: 0n, creditCents: release.reduce((sum, row) => sum + row.debitCents, 0n) });
    await postJournal(tx, { sourceType: "claim_recognition", sourceId: decision.id, purpose: "restriction_release", effectiveOn: snapshot.claim.incurredOn, postings: release });
  }
  await tx.update(s.fundReservations).set({ status: "CONSUMED" }).where(eq(s.fundReservations.decisionId, decision.id));
  await tx.update(s.allocationDecisions).set({ recognizedAt: new Date() }).where(eq(s.allocationDecisions.id, decision.id));
  await tx.update(s.claims).set({ status: "APPROVED" }).where(and(eq(s.claims.id, decision.claimId), eq(s.claims.version, decision.claimVersion)));
  if (!(await reconcile(tx, snapshot.organization.id)).matches) throw new Error("Recognition failed ledger tie-out");
  return { status: "APPROVED" as const, decisionId: decision.id, decisionHash: decision.decisionHash, approvalCount: valid.size };
}
async function decisionContext(tx: LedgerTransaction, decisionId: string, actorId: string) {
  const [decision] = await tx.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.id, decisionId));
  if (!decision) throw new Error("Decision not found");
  const { actor } = await lockClaim(tx, decision.claimId, actorId);
  const snapshot = await readSnapshot(tx, decision.claimId, undefined, false);
  if (actor.role !== "APPROVER" || actor.id === snapshot.claim.claimantId) throw new Error("Independent authenticated approver required");
  return { decision, snapshot, edges: await edgesFor(tx, decision.id), actor };
}
export async function approveDecision(db: AppDatabase, decisionId: string, actorId: string, expectedHash: string) {
  return serializable(db, async tx => {
    const { decision, snapshot, edges, actor } = await decisionContext(tx, decisionId, actorId);
    const existing = await tx.select().from(s.approvals).where(and(eq(s.approvals.decisionHash, decision.decisionHash), eq(s.approvals.approverId, actor.id)));
    if (existing.length) throw new Error("The same approver cannot approve twice");
    if (decision.recognizedAt) throw new Error("Decision already recognized");
    if (decision.invalidatedAt) throw new Error("Decision is invalidated");
    if (expectedHash !== decision.decisionHash) throw new Error("Approval hash does not match this decision");
    if (hashDecision(payloadFor(snapshot, edges)) !== decision.decisionHash) {
      await invalidate(tx, decision);
      return { status: "INVALIDATED" as const, decisionId, decisionHash: decision.decisionHash, approvalCount: 0, reason: "Claim or approved policy terms changed; reservations released" };
    }
    await tx.insert(s.approvals).values({ decisionHash: decision.decisionHash, approverId: actor.id });
    return recognize(tx, decision, snapshot, edges);
  });
}
export async function recognizeDecision(db: AppDatabase, decisionId: string, actorId: string) {
  return serializable(db, async tx => {
    const { decision, snapshot, edges } = await decisionContext(tx, decisionId, actorId);
    if (!decision.recognizedAt && (decision.invalidatedAt || hashDecision(payloadFor(snapshot, edges)) !== decision.decisionHash)) {
      if (!decision.invalidatedAt) await invalidate(tx, decision);
      return { status: "INVALIDATED" as const, decisionId, decisionHash: decision.decisionHash, approvalCount: 0 };
    }
    return recognize(tx, decision, snapshot, edges);
  });
}
export async function rejectClaim(db: AppDatabase, claimId: string, actorId: string, reason: string) {
  if (!reason.trim() || reason.trim().length > 500) throw new Error("A rejection reason of 1 to 500 characters is required");
  return serializable(db, async tx => {
    const { claim, actor } = await lockClaim(tx, claimId, actorId);
    if (actor.role !== "APPROVER" || actor.id === claim.claimantId) throw new Error("Independent approver required");
    const decisions = await tx.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.claimId, claim.id));
    if (decisions.some(row => row.recognizedAt)) throw new Error("Recognized obligation cannot be rejected");
    for (const decision of decisions.filter(row => !row.invalidatedAt)) await invalidate(tx, decision);
    await tx.insert(s.claimRejections).values({ claimId: claim.id, claimVersion: claim.version, rejectedBy: actor.id, reason: reason.trim() });
    await tx.update(s.claims).set({ status: "REJECTED" }).where(and(eq(s.claims.id, claim.id), eq(s.claims.version, claim.version)));
    return { status: "REJECTED" as const };
  });
}

// Administrative service only, with no web route or automatic invocation.
// Atomic organization-wide invalidation prevents old approvals or holds surviving a revision.
export async function advanceSolverPriority(db: AppDatabase, organizationId: string, actorId: string, expectedVersion: number) {
  return serializable(db, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${organizationId})::bigint)`);
    const [actor] = await tx.select().from(s.users).where(eq(s.users.id, actorId));
    if (!actor || actor.organizationId !== organizationId || actor.role !== "APPROVER") throw new Error("Organization approver required for priority revision");
    const [current] = await tx.select().from(s.solverPriorityVersions).where(eq(s.solverPriorityVersions.organizationId, organizationId)).orderBy(desc(s.solverPriorityVersions.version)).limit(1);
    if (!current || current.version !== expectedVersion || current.version >= 2147483647) throw new Error("Priority version changed or cannot advance");
    const funds = await tx.select().from(s.funds).where(eq(s.funds.organizationId, organizationId));
    if (!funds.length) throw new Error("Priority revision requires funds");
    const policies = await tx.select().from(s.fundPolicyVersions).where(inArray(s.fundPolicyVersions.fundId, funds.map(fund => fund.id)));
    const approvers = await tx.select({ id: s.users.id }).from(s.users).where(and(eq(s.users.organizationId, organizationId), eq(s.users.role, "APPROVER")));
    const costs = priorityCostsFor(funds.map(fund => {
      const policy = policies.find(row => row.fundId === fund.id && row.version === fund.currentPolicyVersion);
      if (!policy || !approvers.some(user => user.id === policy.approvedBy) || (fund.fundClass === "RESTRICTED" && (!policy.breadth || policy.breadth !== policy.allowedCategories?.length))) throw new Error("Current approved policy required for priority revision");
      return { ...fund, policy };
    }));
    const version = current.version + 1;
    await tx.insert(s.solverPriorityVersions).values({ organizationId, version, approvedBy: actor.id, costsPerCent: Object.fromEntries([...costs].map(([fund, cost]) => [fund, cost.toString()])) });
    const stale = await tx.select().from(s.allocationDecisions).where(and(eq(s.allocationDecisions.organizationId, organizationId), isNull(s.allocationDecisions.invalidatedAt), isNull(s.allocationDecisions.recognizedAt)));
    for (const decision of stale) await invalidate(tx, decision);
    return { version, invalidatedDecisions: stale.length };
  });
}
