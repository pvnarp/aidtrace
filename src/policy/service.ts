// IAC-405 step 1: runs the deterministic rules for one frozen decision and stores the result. Rules only. There is no model call,
// no provider call and no import from the ledger, payout, retry or AI modules. This module writes only policy_check_runs (RULES) and
// policy_check_results. It also reads the stored model check through model-read.ts, which is read-only. The model call itself lives in
// model-run.ts. It never changes a claim, an approval, a reservation or a journal entry, and no flag blocks one.
import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import { fundAutopilotEnabled, fundModesEnabled, type FlagEnv } from "../fund-modes/flag";
import { recordedMode, type ModeReader } from "../fund-modes/modes";
import { loadPolicyFacts, type PolicyReader } from "./facts";
import { readModelChecks, type StoredModelRun } from "./model-read";
import { evaluatePolicy } from "./rules";
import type { PolicyFacts } from "./types";

export type PolicyRefusal = "APPROVER_REQUIRED" | "NO_DECISION" | "STALE" | "NOT_AWAITING" | "INVALID_REQUEST" | "NOT_SWEEPABLE";
// Who starts a run. The web route builds only the first kind: runPolicyChecks hard-codes it. The second is built only by src/policy/sweep.ts for the policy sweep
// and carries no user. The database guard of migration 0019 backs both rules.
export type RunStarter = { trigger: "APPROVER"; id: string } | { trigger: "SWEEP"; env?: FlagEnv };

// The two columns every run insert sets from its starter. An APPROVER run names its approver. A SWEEP run has none, and the database check refuses a user there.
export const startedFields = (starter: RunStarter) => starter.trigger === "APPROVER"
  ? { trigger: "APPROVER" as const, startedBy: starter.id }
  : { trigger: "SWEEP" as const, startedBy: null };
// A SWEEP run is allowed only with the fund modes flag on and for a decision whose recorded effective mode is Assisted or Autopilot. With the flag off nothing is sweepable, so a flag-off process selects nothing and spends no model call. A missing decision_modes row (a decision frozen with the flag off,
// or before migration 0019) is Manual, so it is never swept.
export async function sweepable(tx: ModeReader, decisionHash: string, env?: FlagEnv): Promise<boolean> {
  if (!fundModesEnabled(env)) return false;
  const mode = await recordedMode(tx, decisionHash);
  return mode === "ASSISTED" || (mode === "AUTOPILOT" && fundAutopilotEnabled(env));
}
export type PolicyRunResult =
  | { status: "RAN"; runId: string; flags: number; notChecked: number }
  | { status: "EXISTS"; runId: string }
  | { status: "REFUSED"; reason: PolicyRefusal };

const HASH = /^[a-f0-9]{64}$/;
export function sqlState(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
}
// Canonical JSON: sorted keys, bigint as a decimal string. The digest lets the same claim be explained later.
function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const factsDigest = (facts: PolicyFacts) => createHash("sha256").update(canonical(facts)).digest("hex");

// The web route and the approver paths call this one: an APPROVER run, started by an approver who is not the claimant.
export async function runPolicyChecks(db: AppDatabase, decisionHash: string, actor: { id: string }): Promise<PolicyRunResult> {
  return runRulesCheck(db, decisionHash, { trigger: "APPROVER", id: actor.id });
}

// Shared body, exported for src/policy/sweep.ts only. An APPROVER run follows today's rules exactly. A SWEEP run has no user to authorize, so it is refused unless the
// decision's recorded mode is Assisted or Autopilot (the database guard refuses it too), and it is never a Manual claim's check.
export async function runRulesCheck(db: AppDatabase, decisionHash: string, starter: RunStarter): Promise<PolicyRunResult> {
  if (!HASH.test(decisionHash)) return { status: "REFUSED", reason: "INVALID_REQUEST" };
  // Read phase: authorization, decision state and facts, all from one snapshot. It writes nothing.
  const read = await db.transaction(async tx => {
    const [user] = starter.trigger === "APPROVER"
      ? await tx.select({ id: s.users.id, role: s.users.role, organizationId: s.users.organizationId }).from(s.users).where(eq(s.users.id, starter.id))
      : [];
    if (starter.trigger === "APPROVER" && (!user || user.role !== "APPROVER")) return { kind: "refused" as const, reason: "APPROVER_REQUIRED" as const };
    const [decision] = await tx.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.decisionHash, decisionHash));
    // A decision in another organization looks the same as no decision.
    if (!decision || (user && decision.organizationId !== user.organizationId)) return { kind: "refused" as const, reason: "NO_DECISION" as const };
    const [claim] = await tx.select().from(s.claims).where(and(eq(s.claims.id, decision.claimId), eq(s.claims.version, decision.claimVersion)));
    if (!claim || (user && claim.claimantId === user.id)) return { kind: "refused" as const, reason: "APPROVER_REQUIRED" as const };
    if (starter.trigger === "SWEEP" && !(await sweepable(tx, decisionHash, starter.env))) return { kind: "refused" as const, reason: "NOT_SWEEPABLE" as const };
    if (decision.invalidatedAt || decision.recognizedAt) return { kind: "refused" as const, reason: "STALE" as const };
    if (claim.status !== "AWAITING_APPROVAL") return { kind: "refused" as const, reason: "NOT_AWAITING" as const };
    const [existing] = await tx.select({ id: s.policyCheckRuns.id }).from(s.policyCheckRuns).where(and(eq(s.policyCheckRuns.decisionHash, decisionHash), eq(s.policyCheckRuns.kind, "RULES")));
    if (existing) return { kind: "exists" as const, id: existing.id };
    const facts = await loadPolicyFacts(tx, decisionHash);
    if (!facts) return { kind: "refused" as const, reason: "NO_DECISION" as const };
    return { kind: "ready" as const, facts, outcome: evaluatePolicy(facts), claimId: claim.id, claimVersion: claim.version, organizationId: claim.organizationId };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
  if (read.kind === "refused") return { status: "REFUSED", reason: read.reason };
  if (read.kind === "exists") return { status: "EXISTS", runId: read.id };
  const { facts, outcome } = read;

  // Write phase: one transaction. The advisory lock makes two simultaneous presses write one run, and the unique
  // (decision_hash, kind) constraint is the backstop. The database guards refuse a stale decision or a non-approver.
  try {
    return await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`policy-checks:${decisionHash}`}, 405))`);
      const [existing] = await tx.select({ id: s.policyCheckRuns.id }).from(s.policyCheckRuns).where(and(eq(s.policyCheckRuns.decisionHash, decisionHash), eq(s.policyCheckRuns.kind, "RULES")));
      if (existing) return { status: "EXISTS" as const, runId: existing.id };
      const [run] = await tx.insert(s.policyCheckRuns).values({
        decisionHash, claimId: read.claimId, claimVersion: read.claimVersion, organizationId: read.organizationId, kind: "RULES", ...startedFields(starter),
        settingsVersions: outcome.settingsVersions, ruleSetVersion: outcome.ruleSetVersion, factsDigest: factsDigest(facts),
      }).returning({ id: s.policyCheckRuns.id });
      if (!run) throw new Error("Policy check run was not created");
      let sequence = 0;
      for (const entry of outcome.entries) {
        sequence += 1;
        await tx.insert(s.policyCheckResults).values(entry.entry === "FLAG"
          ? { runId: run.id, sequence, entry: "FLAG", ruleId: entry.ruleId, severity: entry.severity, lineId: entry.lineId, fundId: entry.fundId, settingsVersion: entry.settingsVersion, reasonCode: null, flagText: entry.flagText, inputs: entry.inputs }
          : { runId: run.id, sequence, entry: "NOT_CHECKED", ruleId: entry.ruleId, severity: null, lineId: null, fundId: null, settingsVersion: null, reasonCode: entry.reasonCode, flagText: entry.flagText, inputs: entry.inputs });
      }
      await tx.insert(s.policyCheckResults).values({ runId: run.id, sequence: sequence + 1, entry: "RUN_END", ruleId: null, severity: null, lineId: null, fundId: null, settingsVersion: null, reasonCode: null, flagText: null, inputs: {} });
      return { status: "RAN" as const, runId: run.id, flags: outcome.entries.filter(entry => entry.entry === "FLAG").length, notChecked: outcome.entries.filter(entry => entry.entry === "NOT_CHECKED").length };
    });
  } catch (error) {
    const state = sqlState(error);
    // 23514: a database guard refused (the decision was invalidated after the read, or the actor lost the role). 23505: a run exists.
    if (state === "23514") return { status: "REFUSED", reason: "STALE" };
    if (state === "23505") {
      const [existing] = await db.select({ id: s.policyCheckRuns.id }).from(s.policyCheckRuns).where(and(eq(s.policyCheckRuns.decisionHash, decisionHash), eq(s.policyCheckRuns.kind, "RULES")));
      if (existing) return { status: "EXISTS", runId: existing.id };
    }
    throw error;
  }
}

export type StoredPolicyFlag = { sequence: number; ruleId: string; severity: "HOLD" | "NOTE"; lineId: string | null; fundId: string | null; settingsVersion: number | null; flagText: string };
export type StoredPolicyRun = {
  id: string; startedAt: Date; startedByName: string; ruleSetVersion: string; settingsVersions: Record<string, number>;
  // True once the run-end row exists. A run written by runPolicyChecks always has one.
  complete: boolean; flags: StoredPolicyFlag[]; notChecked: { ruleId: string; flagText: string }[];
  // The stored arm C model check of the same frozen decision, or null when none ran. Separate rows: it never changes a rule flag above.
  // Optional so a caller that builds a rules-only run (a test or a preview) needs no model field.
  model?: StoredModelRun | null;
};
// Read-only. Returns the stored rows exactly as written, in sequence order.
export async function readPolicyChecks(tx: PolicyReader, decisionHash: string, now?: Date): Promise<StoredPolicyRun | null> {
  const [run] = await tx.select({ id: s.policyCheckRuns.id, startedAt: s.policyCheckRuns.startedAt, startedByName: sql<string>`coalesce(${s.users.displayName}, 'Policy sweep')`, ruleSetVersion: s.policyCheckRuns.ruleSetVersion, settingsVersions: s.policyCheckRuns.settingsVersions })
    .from(s.policyCheckRuns).leftJoin(s.users, eq(s.users.id, s.policyCheckRuns.startedBy))
    .where(and(eq(s.policyCheckRuns.decisionHash, decisionHash), eq(s.policyCheckRuns.kind, "RULES")));
  if (!run) return null;
  const rows = await tx.select().from(s.policyCheckResults).where(eq(s.policyCheckResults.runId, run.id)).orderBy(asc(s.policyCheckResults.sequence));
  return { ...run, complete: rows.some(row => row.entry === "RUN_END"),
    flags: rows.filter(row => row.entry === "FLAG").map(row => ({ sequence: row.sequence, ruleId: row.ruleId!, severity: row.severity!, lineId: row.lineId, fundId: row.fundId, settingsVersion: row.settingsVersion, flagText: row.flagText! })),
    notChecked: rows.filter(row => row.entry === "NOT_CHECKED").map(row => ({ ruleId: row.ruleId!, flagText: row.flagText! })),
    model: await readModelChecks(tx, decisionHash, now) };
}
