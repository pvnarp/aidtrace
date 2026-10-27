import { and, desc, eq, isNull } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "./db";
import { readSnapshot } from "../ledger/snapshot";
import { reconcile } from "../ledger/reconcile";
import { allocate } from "../domain/allocate";
import { naive } from "../domain/naive";

export async function loadClaimView(db: AppDatabase, claimId: string, actorId: string) {
  return db.transaction(async tx => {
    const snapshot = await readSnapshot(tx, claimId);
    const [actor] = await tx.select({ id: s.users.id, organizationId: s.users.organizationId, role: s.users.role }).from(s.users).where(eq(s.users.id, actorId));
    if (!actor || actor.organizationId !== snapshot.claim.organizationId || (actor.role === "CLAIMANT" && actor.id !== snapshot.claim.claimantId)) throw new Error("Organization and claim access required");
    const [decision] = await tx.select().from(s.allocationDecisions).where(and(eq(s.allocationDecisions.claimId, claimId), eq(s.allocationDecisions.claimVersion, snapshot.claim.version), isNull(s.allocationDecisions.invalidatedAt))).orderBy(desc(s.allocationDecisions.frozenAt)).limit(1);
    const input = { ...snapshot.input, decisionId: decision?.id };
    const storedEdges = decision ? await tx.select().from(s.allocationEdges).where(eq(s.allocationEdges.decisionId, decision.id)) : [];
    const optimized = decision ? undefined : allocate(input); const baseline = decision ? undefined : naive(input);
    const edges = decision ? storedEdges : optimized?.status === "FUNDED" ? optimized.edges : [];
    const generalCents = edges.filter(edge => snapshot.funds.find(fund => fund.id === edge.fundId)?.fundClass === "UNRESTRICTED").reduce((sum, edge) => sum + edge.amountCents, 0n);
    const comparison = decision?.comparison ?? (baseline ? { status: baseline.status, unrestrictedCents: baseline.status === "FUNDED" ? baseline.unrestrictedCents.toString() : undefined, edges: baseline.edges.map(edge => ({ fundId: edge.fundId, lineId: edge.lineId, amountCents: edge.amountCents.toString() })) } : null);
    const approvals = decision ? await tx.select({ approverId: s.approvals.approverId, displayName: s.users.displayName, approvedAt: s.approvals.approvedAt }).from(s.approvals).innerJoin(s.users, eq(s.users.id, s.approvals.approverId)).where(eq(s.approvals.decisionHash, decision.decisionHash)) : [];
    const [disbursement] = await tx.select().from(s.disbursements).where(and(eq(s.disbursements.claimId, claimId), eq(s.disbursements.claimVersion, snapshot.claim.version)));
    const [attempt] = disbursement ? await tx.select().from(s.disbursementAttempts).where(eq(s.disbursementAttempts.disbursementId, disbursement.id)).orderBy(desc(s.disbursementAttempts.attemptNumber)).limit(1) : [];
    const [retryAuthorization] = attempt ? await tx.select().from(s.retryAuthorizations).where(and(eq(s.retryAuthorizations.claimId, claimId), eq(s.retryAuthorizations.claimVersion, snapshot.claim.version), eq(s.retryAuthorizations.attemptNumber, attempt.attemptNumber + 1))).limit(1) : [];
    const donations = await tx.select().from(s.donationReceipts).where(eq(s.donationReceipts.organizationId, snapshot.organization.id));
    const rejections = await tx.select({ reason: s.claimRejections.reason, rejectedBy: s.users.displayName }).from(s.claimRejections).innerJoin(s.users, eq(s.users.id, s.claimRejections.rejectedBy)).where(and(eq(s.claimRejections.claimId, claimId), eq(s.claimRejections.claimVersion, snapshot.claim.version)));
    return { ...snapshot, decision, edges, generalCents, comparison, approvals, attempt, retryAuthorization, donations, rejections, report: await reconcile(tx, snapshot.organization.id), feasible: Boolean(decision) || optimized?.status === "FUNDED" };
  }, { isolationLevel: "repeatable read" });
}
