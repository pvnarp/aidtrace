// IAC-405 step 2 PR F (docs/plans/FUND_MODES_SCOPE.md section 3 items 1 and 5; docs/ASSUMPTIONS.md section 76). Changing a fund's mode takes two distinct approvers of the fund's
// organization, the same two-step pattern as binding drafted rules: one proposes, a second approves. Both steps are append-only rows (migration 0019). It offers Manual
// and Assisted, and AUTOPILOT only while FUND_AUTOPILOT_ENABLED is on (PR P): with that flag off a proposal or an approval of AUTOPILOT is refused here, whatever the database would store. A proposal records the mode version the fund held when it was made
// (0 for none), and an approval must be the next version, so a proposal made before a later mode change is stale and cannot be approved. With the flag off every function refuses.
// Nothing here approves a claim, moves money or calls a provider. Refusals carry closed codes, never database text.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { FundMode } from "../../db/schema";
import { serializable } from "../ledger/service";
import { sqlState } from "../policy/service";
import type { AppDatabase } from "../server/db";
import { fundAutopilotEnabled, fundModesEnabled, type FlagEnv } from "./flag";
import { effectiveOf } from "./modes";

// The modes a person may choose. MANUAL and ASSISTED always. AUTOPILOT only when the second flag is on (fundAutopilotEnabled, docs/ASSUMPTIONS.md section 78): with it off a proposal or an approval of AUTOPILOT is refused.
export const OFFERED_MODES = ["MANUAL", "ASSISTED"] as const satisfies readonly FundMode[];
export type OfferedMode = FundMode;
export const isOfferedMode = (value: unknown, env?: FlagEnv): value is OfferedMode => typeof value === "string" && ((OFFERED_MODES as readonly string[]).includes(value) || (value === "AUTOPILOT" && fundAutopilotEnabled(env)));

export type FundModeRefusal = "FLAG_OFF" | "INVALID_REQUEST" | "APPROVER_REQUIRED" | "NOT_FOUND" | "MODE_NOT_OFFERED" | "NO_CHANGE" | "SAME_APPROVER" | "ALREADY_APPROVED" | "STALE_BASE" | "GUARD_REFUSED";
export type Refused = { status: "REFUSED"; reason: FundModeRefusal };
export type ProposeResult = Refused | { status: "PROPOSED"; proposalId: string; baseVersion: number };
export type ApproveResult = Refused | { status: "APPROVED"; fundId: string; mode: FundMode; version: number };
export type ChangeDeps = { env?: FlagEnv };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refuse = (reason: FundModeRefusal): Refused => ({ status: "REFUSED", reason });
type Tx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

// The actor must be an approver. The fund must belong to the actor's organization: another organization's fund reads as not found.
async function gate(tx: Tx, actorId: unknown, fundId: string): Promise<{ ok: true; organizationId: string } | { ok: false; refusal: Refused }> {
  if (typeof actorId !== "string" || actorId.length < 1 || actorId.length > 100) return { ok: false, refusal: refuse("APPROVER_REQUIRED") };
  const [actor] = await tx.select({ role: s.users.role, organizationId: s.users.organizationId }).from(s.users).where(eq(s.users.id, actorId));
  if (!actor || actor.role !== "APPROVER") return { ok: false, refusal: refuse("APPROVER_REQUIRED") };
  const [fund] = await tx.select({ id: s.funds.id }).from(s.funds).where(and(eq(s.funds.id, fundId), eq(s.funds.organizationId, actor.organizationId)));
  return fund ? { ok: true, organizationId: actor.organizationId } : { ok: false, refusal: refuse("NOT_FOUND") };
}
// The ledger organization lock, taken the same way. It serializes advisory-lock takers only. A serializable transaction snapshots at its first statement, which is before this
// lock is won, so a recognition that began before a mode approval committed can still read the old mode. approveFundMode closes that with a read of the organization's
// unrecognized decisions after the lock (see there). Approvers only.
async function lockOrganization(tx: Tx, actorId: unknown): Promise<void> {
  if (typeof actorId !== "string" || actorId.length < 1 || actorId.length > 100) return;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${s.users.organizationId})::bigint) from ${s.users} where ${s.users.id} = ${actorId} and ${s.users.role} = 'APPROVER'`);
}
async function latest(tx: Tx, fundId: string): Promise<{ mode: FundMode; version: number }> {
  const [row] = await tx.select({ mode: s.fundModes.mode, version: s.fundModes.version }).from(s.fundModes).where(eq(s.fundModes.fundId, fundId)).orderBy(desc(s.fundModes.version)).limit(1);
  return row ?? { mode: "MANUAL", version: 0 };
}

// First step: an approver proposes Manual or Assisted for a fund. Proposing the mode the fund already has is refused.
export async function proposeFundMode(db: AppDatabase, actor: { id: string }, fundId: string, mode: unknown, deps: ChangeDeps = {}): Promise<ProposeResult> {
  if (!fundModesEnabled(deps.env)) return refuse("FLAG_OFF");
  if (typeof fundId !== "string" || !ID.test(fundId)) return refuse("INVALID_REQUEST");
  if (!isOfferedMode(mode, deps.env)) return refuse("MODE_NOT_OFFERED");
  try {
    return await serializable(db, async tx => {
      await lockOrganization(tx, actor?.id);
      const gated = await gate(tx, actor?.id, fundId);
      if (!gated.ok) return gated.refusal;
      const current = await latest(tx, fundId);
      if (current.mode === mode) return refuse("NO_CHANGE");
      const [proposal] = await tx.insert(s.fundModeProposals).values({ fundId, mode, baseVersion: current.version, proposedBy: actor.id }).returning({ id: s.fundModeProposals.id });
      if (!proposal) throw new Error("Fund mode proposal was not created");
      return { status: "PROPOSED" as const, proposalId: proposal.id, baseVersion: current.version };
    });
  } catch (error) {
    if (sqlState(error) === "23514") return refuse("GUARD_REFUSED");
    throw error;
  }
}

// Second step: a different approver of the same organization approves the proposal, which writes the next fund_modes version. The database trigger enforces the same rules
// again (distinct approver, organization, one approval per proposal, the next version after the proposal's base), so a race that gets past these checks is still refused.
export async function approveFundMode(db: AppDatabase, actor: { id: string }, proposalId: string, deps: ChangeDeps = {}, fundId?: string): Promise<ApproveResult> {
  if (!fundModesEnabled(deps.env)) return refuse("FLAG_OFF");
  if (typeof proposalId !== "string" || !UUID.test(proposalId)) return refuse("INVALID_REQUEST");
  try {
    return await serializable(db, async tx => {
      await lockOrganization(tx, actor?.id);
      const [proposal] = await tx.select().from(s.fundModeProposals).where(eq(s.fundModeProposals.id, proposalId));
      if (!proposal) return refuse("NOT_FOUND");
      // The URL fund binds the proposal (as handleDraftAction does for drafts): a proposal of another fund reads as not found.
      if (fundId !== undefined && proposal.fundId !== fundId) return refuse("NOT_FOUND");
      const gated = await gate(tx, actor?.id, proposal.fundId);
      if (!gated.ok) return gated.refusal;
      // Tightening read. Read the organization unrecognized decisions after the lock so a concurrent Assisted recognition (which writes recognized_at on one of them) forms a
      // serializable conflict cycle with this approval; one of the two gets 40001 and is retried against the new mode. The result is not used.
      await tx.select({ id: s.allocationDecisions.id }).from(s.allocationDecisions).where(and(eq(s.allocationDecisions.organizationId, gated.organizationId), isNull(s.allocationDecisions.recognizedAt)));
      // Autopilot is refused with the second flag off even when a proposal row for it exists (inserted outside this service).
      if (!isOfferedMode(proposal.mode, deps.env)) return refuse("MODE_NOT_OFFERED");
      const [approved] = await tx.select({ version: s.fundModes.version }).from(s.fundModes).where(eq(s.fundModes.proposalId, proposal.id));
      if (approved) return refuse("ALREADY_APPROVED");
      if (proposal.proposedBy === actor.id) return refuse("SAME_APPROVER");
      const current = await latest(tx, proposal.fundId);
      if (current.version !== proposal.baseVersion) return refuse("STALE_BASE");
      const [row] = await tx.insert(s.fundModes).values({ fundId: proposal.fundId, version: proposal.baseVersion + 1, mode: proposal.mode, proposalId: proposal.id, approvedBy: actor.id })
        .returning({ fundId: s.fundModes.fundId, mode: s.fundModes.mode, version: s.fundModes.version });
      if (!row) throw new Error("Fund mode was not recorded");
      return { status: "APPROVED" as const, fundId: row.fundId, mode: row.mode, version: row.version };
    });
  } catch (error) {
    if (sqlState(error) === "23514") return refuse("GUARD_REFUSED");
    throw error;
  }
}

export type PendingProposal = { id: string; mode: FundMode; proposedById: string; proposedByName: string; proposedAt: Date };
// mode is the effective mode: a stored AUTOPILOT reads as MANUAL in this release.
export type FundModeView = { fundId: string; mode: FundMode; version: number; pending: PendingProposal[] };
export type ReadFundModeResult = Refused | { status: "OK"; view: FundModeView };
// For the fund's rules page. Pending means no fund_modes row yet and still based on the fund's current mode version (a stale proposal is not shown as pending).
export async function readFundMode(db: AppDatabase, actor: { id: string }, fundId: string, deps: ChangeDeps = {}): Promise<ReadFundModeResult> {
  if (!fundModesEnabled(deps.env)) return refuse("FLAG_OFF");
  if (typeof fundId !== "string" || !ID.test(fundId)) return refuse("INVALID_REQUEST");
  return db.transaction(async tx => {
    const gated = await gate(tx, actor?.id, fundId);
    if (!gated.ok) return gated.refusal;
    const current = await latest(tx, fundId);
    const proposals = await tx.select({ id: s.fundModeProposals.id, mode: s.fundModeProposals.mode, baseVersion: s.fundModeProposals.baseVersion, proposedById: s.fundModeProposals.proposedBy,
      proposedByName: s.users.displayName, proposedAt: s.fundModeProposals.proposedAt })
      .from(s.fundModeProposals).innerJoin(s.users, eq(s.users.id, s.fundModeProposals.proposedBy)).leftJoin(s.fundModes, eq(s.fundModes.proposalId, s.fundModeProposals.id))
      .where(and(eq(s.fundModeProposals.fundId, fundId), isNull(s.fundModes.proposalId))).orderBy(desc(s.fundModeProposals.proposedAt));
    const pending = proposals.filter(row => row.baseVersion === current.version && isOfferedMode(row.mode, deps.env))
      .map(row => ({ id: row.id, mode: row.mode, proposedById: row.proposedById, proposedByName: row.proposedByName, proposedAt: row.proposedAt }));
    return { status: "OK" as const, view: { fundId, mode: effectiveOf(current.mode, deps.env), version: current.version, pending } };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
