import { and, desc, eq, inArray } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AllocationEdge, AllocationInput } from "../domain/model";
import { buildDecisionPayload } from "../domain/hash";
import type { LedgerTransaction } from "./journal";

export async function readSnapshot(tx: LedgerTransaction, claimId: string, version?: number, includeCapacity = true) {
  const [claim] = await tx.select().from(s.claims).where(version ? and(eq(s.claims.id, claimId), eq(s.claims.version, version)) : eq(s.claims.id, claimId)).orderBy(desc(s.claims.version)).limit(1);
  if (!claim) throw new Error("Claim not found");
  const [organization] = await tx.select().from(s.organizations).where(eq(s.organizations.id, claim.organizationId));
  if (!organization) throw new Error("Organization not found");
  const lines = await tx.select().from(s.claimLines).where(and(eq(s.claimLines.claimId, claim.id), eq(s.claimLines.claimVersion, claim.version)));
  const funds = await tx.select().from(s.funds).where(eq(s.funds.organizationId, organization.id));
  const fundIds = funds.map(fund => fund.id);
  if (!fundIds.length || !lines.length) throw new Error("Claim requires funds and lines");
  const [priority] = await tx.select().from(s.solverPriorityVersions).where(eq(s.solverPriorityVersions.organizationId, organization.id)).orderBy(desc(s.solverPriorityVersions.version)).limit(1);
  if (!priority || !Number.isSafeInteger(priority.version) || priority.version < 1) throw new Error("Supported approved solver priority required");
  const policies = await tx.select().from(s.fundPolicyVersions).where(inArray(s.fundPolicyVersions.fundId, fundIds));
  const budgets = await tx.select().from(s.fundBudgetLines).where(inArray(s.fundBudgetLines.fundId, fundIds));
  const credits = includeCapacity ? await tx.select().from(s.fundCredits).where(inArray(s.fundCredits.fundId, fundIds)) : [];
  const debits = includeCapacity ? await tx.select().from(s.fundDebits).where(inArray(s.fundDebits.fundId, fundIds)) : [];
  const reservations = includeCapacity ? await tx.select().from(s.fundReservations).where(inArray(s.fundReservations.fundId, fundIds)) : [];
  const splits = reservations.length ? await tx.select().from(s.reservationBudgetLines).where(inArray(s.reservationBudgetLines.reservationId, reservations.map(row => row.id))) : [];
  const approvers = await tx.select({ id: s.users.id, role: s.users.role }).from(s.users).where(eq(s.users.organizationId, organization.id));
  const approved = (id: string) => approvers.some(user => user.id === id && user.role === "APPROVER");
  if (!approved(priority.approvedBy)) throw new Error("Solver policy approval is invalid");
  const input: AllocationInput = {
    program: claim.program, prohibitedCategories: organization.prohibitedCategories, solverPriority: { version: priority.version, approvedBy: priority.approvedBy },
    lines: lines.map(line => ({ ...line, incurredOn: claim.incurredOn })),
    funds: funds.map(fund => {
      const policy = policies.find(row => row.fundId === fund.id && row.version === fund.currentPolicyVersion);
      if (!policy || !approved(policy.approvedBy)) throw new Error("Current approved fund policy required");
      return { id: fund.id, name: fund.name, fundClass: fund.fundClass,
        balanceCents: credits.filter(row => row.fundId === fund.id).reduce((sum, row) => sum + row.amountCents, 0n) - debits.filter(row => row.fundId === fund.id).reduce((sum, row) => sum + row.amountCents, 0n),
        policy: { ...policy, programs: policy.programs ?? null, allowedCategories: policy.allowedCategories ?? null },
        budgetLines: budgets.filter(row => row.fundId === fund.id && row.policyVersion === policy.version).map(row => ({ id: row.budgetLine, capCents: row.capCents })) };
    }),
    priorDebits: debits.filter((row): row is typeof row & { budgetLine: string } => row.budgetLine !== null).map(row => ({ fundId: row.fundId, budgetLine: row.budgetLine, amountCents: row.amountCents })),
    reservations: reservations.flatMap(row => {
      const parts = splits.filter(part => part.reservationId === row.id);
      if (parts.reduce((sum, part) => sum + part.amountCents, 0n) !== row.amountCents) throw new Error("Reservation budget splits do not match reserved fund amount");
      return parts.map(part => ({ fundId: row.fundId, decisionId: row.decisionId, active: row.status === "ACTIVE", budgetLine: part.budgetLine, amountCents: part.amountCents }));
    }),
  };
  return { claim, organization, lines, funds, priority, input };
}
export type Snapshot = Awaited<ReturnType<typeof readSnapshot>>;
export function payloadFor(snapshot: Snapshot, edges: readonly AllocationEdge[]) {
  return buildDecisionPayload({ claimId: snapshot.claim.id, claimVersion: snapshot.claim.version, claimantId: snapshot.claim.claimantId,
    vendor: snapshot.claim.vendor, program: snapshot.claim.program, incurredOn: snapshot.claim.incurredOn,
    lines: snapshot.lines.map(line => ({ ...line, incurredOn: snapshot.claim.incurredOn })), edges,
    fundPolicyVersions: Object.fromEntries(snapshot.funds.map(fund => [fund.id, fund.currentPolicyVersion])), solverPriorityVersion: snapshot.priority.version, payeeEmail: snapshot.claim.payeeEmail });
}
