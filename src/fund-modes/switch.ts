// IAC-405 step 3 PR P (docs/plans/FUND_MODES_SCOPE.md section 5 guardrail G8; docs/ASSUMPTIONS.md section 78). The per-organization automation kill switch. Append-only events
// (migration 0020). No row means OFF. Turning it ON takes a proposal by one approver and a confirmation by a different approver of the same organization, the same two-step shape as a
// fund mode change. Turning it OFF takes one approver. It also trips on its own: an approver's "Disagree" with an automated payment, and any UNKNOWN result of an automated send.
// Automation is blocked while the switch is not ON, and also while any automated attempt of the organization is still UNKNOWN (an unresolved outcome), even if the trip row was lost.
// Every writer except the automatic trip needs the second flag. Nothing here approves a claim, moves money or calls a provider. Refusals carry closed codes, never database text.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { SwitchOffReason } from "../../db/schema";
import type { LedgerTransaction } from "../ledger/journal";
import { serializable } from "../ledger/service";
import { sqlState } from "../policy/service";
import type { AppDatabase } from "../server/db";
import { automationState } from "./automation-state";
import { fundAutopilotEnabled, type FlagEnv } from "./flag";

export type SwitchRefusal = "FLAG_OFF" | "INVALID_REQUEST" | "APPROVER_REQUIRED" | "NOT_FOUND" | "ALREADY_ON" | "ALREADY_OFF" | "SAME_APPROVER" | "STALE_PROPOSAL" | "NOT_AUTOMATED" | "CLAIMANT" | "GUARD_REFUSED";
export type SwitchRefused = { status: "REFUSED"; reason: SwitchRefusal };
export type SwitchDeps = { env?: FlagEnv };
const refuse = (reason: SwitchRefusal): SwitchRefused => ({ status: "REFUSED", reason });
const CLAIM_ID = /^[A-Za-z0-9_-]{1,64}$/;


const lock = (tx: LedgerTransaction, organizationId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${organizationId})::bigint)`);
async function approverOrg(tx: LedgerTransaction, actorId: unknown): Promise<string | null> {
  if (typeof actorId !== "string" || actorId.length < 1 || actorId.length > 100) return null;
  const [actor] = await tx.select({ role: s.users.role, organizationId: s.users.organizationId }).from(s.users).where(eq(s.users.id, actorId));
  return actor && actor.role === "APPROVER" ? actor.organizationId : null;
}
async function guarded<T>(work: () => Promise<T | SwitchRefused>): Promise<T | SwitchRefused> {
  try { return await work(); } catch (error) { if (sqlState(error) === "23514") return refuse("GUARD_REFUSED"); throw error; }
}

export type SwitchProposeResult = SwitchRefused | { status: "PROPOSED"; seq: number };
export async function proposeAutomationOn(db: AppDatabase, actor: { id: string }, deps: SwitchDeps = {}): Promise<SwitchProposeResult> {
  if (!fundAutopilotEnabled(deps.env)) return refuse("FLAG_OFF");
  return guarded(() => serializable(db, async tx => {
    const organizationId = await approverOrg(tx, actor?.id); if (!organizationId) return refuse("APPROVER_REQUIRED");
    await lock(tx, organizationId);
    if ((await automationState(tx, organizationId)).on) return refuse("ALREADY_ON");
    const [row] = await tx.insert(s.automationSwitchEvents).values({ organizationId, event: "PROPOSE_ON", actorId: actor.id }).returning({ seq: s.automationSwitchEvents.seq });
    if (!row) throw new Error("Switch proposal was not recorded");
    return { status: "PROPOSED" as const, seq: row.seq };
  }));
}

export type SwitchConfirmResult = SwitchRefused | { status: "ON" };
export async function confirmAutomationOn(db: AppDatabase, actor: { id: string }, proposalSeq: unknown, deps: SwitchDeps = {}): Promise<SwitchConfirmResult> {
  if (!fundAutopilotEnabled(deps.env)) return refuse("FLAG_OFF");
  if (typeof proposalSeq !== "number" || !Number.isSafeInteger(proposalSeq) || proposalSeq < 1) return refuse("INVALID_REQUEST");
  return guarded(() => serializable(db, async tx => {
    const organizationId = await approverOrg(tx, actor?.id); if (!organizationId) return refuse("APPROVER_REQUIRED");
    await lock(tx, organizationId);
    const [proposal] = await tx.select().from(s.automationSwitchEvents).where(and(eq(s.automationSwitchEvents.seq, proposalSeq), eq(s.automationSwitchEvents.organizationId, organizationId), eq(s.automationSwitchEvents.event, "PROPOSE_ON")));
    if (!proposal) return refuse("NOT_FOUND");
    if (proposal.actorId === actor.id) return refuse("SAME_APPROVER");
    const state = await automationState(tx, organizationId);
    if (state.on) return refuse("ALREADY_ON");
    if (state.lastEvent && state.lastEvent.seq > proposal.seq) return refuse("STALE_PROPOSAL");
    const [used] = await tx.select({ seq: s.automationSwitchEvents.seq }).from(s.automationSwitchEvents).where(eq(s.automationSwitchEvents.proposalSeq, proposal.seq));
    if (used) return refuse("STALE_PROPOSAL");
    await tx.insert(s.automationSwitchEvents).values({ organizationId, event: "ON", actorId: actor.id, proposalSeq: proposal.seq });
    return { status: "ON" as const };
  }));
}

export type SwitchOffResult = SwitchRefused | { status: "OFF" };
// One approver turns automation off. Off stops every automated recognition and send at once.
export async function turnAutomationOff(db: AppDatabase, actor: { id: string }, deps: SwitchDeps = {}): Promise<SwitchOffResult> {
  if (!fundAutopilotEnabled(deps.env)) return refuse("FLAG_OFF");
  return guarded(() => serializable(db, async tx => {
    const organizationId = await approverOrg(tx, actor?.id); if (!organizationId) return refuse("APPROVER_REQUIRED");
    await lock(tx, organizationId);
    if (!(await automationState(tx, organizationId)).on) return refuse("ALREADY_OFF");
    await tx.insert(s.automationSwitchEvents).values({ organizationId, event: "OFF", reason: "APPROVER", actorId: actor.id });
    return { status: "OFF" as const };
  }));
}

// An approver who is not the claimant records "Disagree" with an automated payment of their organization. It turns automation off. It reverses nothing and pays nothing.
export async function recordDisagreement(db: AppDatabase, actor: { id: string }, claimId: unknown, deps: SwitchDeps = {}): Promise<SwitchOffResult> {
  if (!fundAutopilotEnabled(deps.env)) return refuse("FLAG_OFF");
  if (typeof claimId !== "string" || !CLAIM_ID.test(claimId)) return refuse("INVALID_REQUEST");
  return guarded(() => serializable(db, async tx => {
    const organizationId = await approverOrg(tx, actor?.id); if (!organizationId) return refuse("APPROVER_REQUIRED");
    await lock(tx, organizationId);
    const [claim] = await tx.select({ id: s.claims.id, version: s.claims.version, claimantId: s.claims.claimantId }).from(s.claims)
      .where(and(eq(s.claims.id, claimId), eq(s.claims.organizationId, organizationId))).orderBy(desc(s.claims.version)).limit(1);
    if (!claim) return refuse("NOT_FOUND");
    if (claim.claimantId === actor.id) return refuse("CLAIMANT");
    const [sent] = await tx.select({ hash: s.automatedDecisions.decisionHash }).from(s.automatedDecisions)
      .innerJoin(s.allocationDecisions, eq(s.allocationDecisions.decisionHash, s.automatedDecisions.decisionHash))
      .where(and(eq(s.automatedDecisions.kind, "AUTO_SENT"), eq(s.allocationDecisions.claimId, claim.id), eq(s.allocationDecisions.claimVersion, claim.version), isNull(s.allocationDecisions.invalidatedAt))).limit(1);
    if (!sent) return refuse("NOT_AUTOMATED");
    await tx.insert(s.automationSwitchEvents).values({ organizationId, event: "OFF", reason: "DISAGREE", actorId: actor.id, decisionHash: sent.hash });
    return { status: "OFF" as const };
  }));
}

// The automatic trip after an UNKNOWN result of an automated send. No user. It needs no flag: it only tightens, and it must run even if a flag was turned off meanwhile.
export async function tripOnUnknownSend(db: AppDatabase, organizationId: string, decisionHash: string): Promise<void> {
  await serializable(db, async tx => {
    await lock(tx, organizationId);
    await tx.insert(s.automationSwitchEvents).values({ organizationId, event: "OFF", reason: "UNKNOWN_SEND" as SwitchOffReason, decisionHash });
  });
}

