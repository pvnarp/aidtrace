// IAC-405 step 3 PR P (docs/ASSUMPTIONS.md section 78). The read-only view of the automation kill switch for the fund rules page. It lives apart from the writers in switch.ts so the review
// screen's import closure never reaches the ledger module. Approvers only, needs the second flag, writes nothing. Refusals carry closed codes, never database text.
import { and, desc, eq, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import { automationState } from "./automation-state";
import { fundAutopilotEnabled, type FlagEnv } from "./flag";

export type ReadRefused = { status: "REFUSED"; reason: "FLAG_OFF" | "APPROVER_REQUIRED" };
export type SwitchView = { on: boolean; unknownOutstanding: boolean; pending: { seq: number; proposedById: string; proposedByName: string; proposedAt: Date } | null; lastOff: { reason: string; at: Date } | null };
export type ReadSwitchResult = ReadRefused | { status: "OK"; view: SwitchView };
const refuse = (reason: ReadRefused["reason"]): ReadRefused => ({ status: "REFUSED", reason });

// A pending proposal is one newer than the last ON or OFF event and not yet confirmed.
export async function readAutomationSwitch(db: AppDatabase, actor: { id: string }, deps: { env?: FlagEnv } = {}): Promise<ReadSwitchResult> {
  if (!fundAutopilotEnabled(deps.env)) return refuse("FLAG_OFF");
  return db.transaction(async tx => {
    const actorId = actor?.id;
    if (typeof actorId !== "string" || actorId.length < 1 || actorId.length > 100) return refuse("APPROVER_REQUIRED");
    const [user] = await tx.select({ role: s.users.role, organizationId: s.users.organizationId }).from(s.users).where(eq(s.users.id, actorId));
    if (!user || user.role !== "APPROVER") return refuse("APPROVER_REQUIRED");
    const organizationId = user.organizationId;
    const state = await automationState(tx, organizationId);
    const [proposal] = await tx.select({ seq: s.automationSwitchEvents.seq, proposedById: s.automationSwitchEvents.actorId, proposedByName: s.users.displayName, proposedAt: s.automationSwitchEvents.recordedAt })
      .from(s.automationSwitchEvents).innerJoin(s.users, eq(s.users.id, s.automationSwitchEvents.actorId))
      .where(and(eq(s.automationSwitchEvents.organizationId, organizationId), eq(s.automationSwitchEvents.event, "PROPOSE_ON"), sql`${s.automationSwitchEvents.seq} > ${state.lastEvent?.seq ?? 0}`,
        sql`not exists (select 1 from automation_switch_events u where u.proposal_seq = ${s.automationSwitchEvents.seq})`)).orderBy(desc(s.automationSwitchEvents.seq)).limit(1);
    const [off] = await tx.select({ reason: s.automationSwitchEvents.reason, at: s.automationSwitchEvents.recordedAt }).from(s.automationSwitchEvents)
      .where(and(eq(s.automationSwitchEvents.organizationId, organizationId), eq(s.automationSwitchEvents.event, "OFF"))).orderBy(desc(s.automationSwitchEvents.seq)).limit(1);
    return { status: "OK" as const, view: { on: state.on, unknownOutstanding: state.unknownOutstanding,
      pending: proposal && proposal.proposedById ? { seq: proposal.seq, proposedById: proposal.proposedById, proposedByName: proposal.proposedByName, proposedAt: proposal.proposedAt } : null,
      lastOff: off?.reason ? { reason: off.reason, at: off.at } : null } };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
