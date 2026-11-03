// IAC-405 step 2 PR F (docs/plans/FUND_MODES_SCOPE.md section 3 item 4; docs/ASSUMPTIONS.md section 76). One pass of the policy sweep. For each claim awaiting approval whose decision
// recorded an Assisted or Autopilot effective mode, it runs the rules check, then the model check (one attempt per decision hash, as today), records a HELD audit row when the
// stored runs show a hold, and, only when they show no hold, asks the ledger to recognize a decision that already holds its one human approval. It records no approval, sends no
// payment and never touches a Manual decision. With the flag off it does nothing at all: it selects nothing and spends no model call. Logs carry counts and the first eight
// characters of a hash, never a key, a line or a model answer.
//
// Liveness: every pass calls recognizeWhenReady again for every candidate, so an approval that committed while an earlier call waited for the ledger lock (that call read an older
// snapshot and answered "not ready") is recognized by the next pass. The batch limit caps the model runs a pass may start, not the candidates it looks at, so a pile of older
// claims that are waiting for a second approver cannot starve a newer claim of its check or its recognition.
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import { recognizeAutonomously, recognizeWhenReady, type AutoRecognizeResult } from "../ledger/service";
import { sendAutomatedPayout, type AutomatedSendResult } from "../ledger/payout";
import type { PayoutTransport } from "../paypal/adapter";
import type { AuditDraw } from "./guardrails";
import { sweepModelCheck, sweepRulesCheck } from "../policy/sweep";
import type { ModelRunDeps } from "../policy/model-run";
import type { AppDatabase } from "../server/db";
import { recordHeld } from "./automated";
import { fundAutopilotEnabled, fundModesEnabled, type FlagEnv } from "./flag";
import { recordedMode } from "./modes";
import { noHoldsFor } from "./no-holds";

// The most model runs one pass may start. A candidate beyond it still gets its rules check and its recognition retry.
export const POLICY_SWEEP_BATCH = 25;
// A safety bound on the candidates one pass reads.
export const POLICY_SWEEP_CANDIDATES = 500;
export type PolicySweepLog = (entry: Record<string, string | number | null>) => void;
// provider, now and audit are used only by the Autopilot steps (IAC-405 PR P). With no provider the sweep neither recognizes nor sends for Autopilot: a keyless instance never pays and leaves those claims waiting for people.
export type PolicySweepDeps = { env?: FlagEnv; log?: PolicySweepLog; batch?: number; model?: Pick<ModelRunDeps, "client" | "budget" | "timeoutMs">; provider?: PayoutTransport; now?: Date; audit?: AuditDraw };
export type AutopilotReport = { recognized: number; routedToPeople: number; switchOff: number; sent: number; sendBlocked: number; unknownSends: number };
export type PolicySweepReport =
  | { status: "OFF" }
  | { status: "DONE"; considered: number; rulesRuns: number; modelRuns: number; held: number; recognized: number; failed: number; autopilot?: AutopilotReport };

const mask = (hash: string) => hash.slice(0, 8);

// One HELD row per distinct (reason, rules run, model run) for a decision, so a sweep that repeats every few minutes does not grow the audit table. The advisory lock makes two
// sweeps at once write one row. Returns true when it wrote a row. A decision whose runs now show no holds writes nothing here.
async function recordHeldOnce(db: AppDatabase, decisionHash: string, modelDeferred: boolean): Promise<boolean> {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`policy-sweep:${decisionHash}`}, 405))`);
    const outcome = await noHoldsFor(tx, decisionHash);
    // A decision that was recognized or invalidated while this pass ran is no longer awaiting anything: it is not a hold to record.
    if (outcome.noHolds || outcome.reason === "NOT_CURRENT") return false;
    // Not holds yet: a model run the batch cap deferred to a later pass, and a model run still going, are waiting, not held.
    if (outcome.reason === "MODEL_RUNNING" || (outcome.reason === "NO_MODEL_RUN" && modelDeferred)) return false;
    const existing = await tx.select().from(s.automatedDecisions).where(and(eq(s.automatedDecisions.decisionHash, decisionHash), eq(s.automatedDecisions.kind, "HELD")));
    if (existing.some(row => row.rulesRunId === outcome.rulesRunId && row.modelRunId === outcome.modelRunId && row.inputs.reason === outcome.reason)) return false;
    await recordHeld(tx, decisionHash, outcome);
    return true;
  });
}

// A cheap pre-check only: recognize() reads the approvals again inside its own transaction and decides. True when an approver of the decision organization other than the claimant approved.
async function hasValidApproval(db: AppDatabase, decisionHash: string): Promise<boolean> {
  const rows = await db.select({ id: s.approvals.approverId }).from(s.approvals)
    .innerJoin(s.allocationDecisions, eq(s.allocationDecisions.decisionHash, s.approvals.decisionHash))
    .innerJoin(s.claims, and(eq(s.claims.id, s.allocationDecisions.claimId), eq(s.claims.version, s.allocationDecisions.claimVersion)))
    .innerJoin(s.users, eq(s.users.id, s.approvals.approverId))
    .where(and(eq(s.approvals.decisionHash, decisionHash), eq(s.users.role, "APPROVER"), eq(s.users.organizationId, s.allocationDecisions.organizationId), ne(s.users.id, s.claims.claimantId))).limit(1);
  return rows.length > 0;
}

// True when the stored rules run shows a hold (or an unchecked or unfinished rule): the model check adds nothing then, and no model call is spent.
async function rulesHolds(db: AppDatabase, decisionHash: string): Promise<boolean> {
  const outcome = await db.transaction(tx => noHoldsFor(tx, decisionHash));
  return !outcome.noHolds && (outcome.reason === "RULES_HOLD" || outcome.reason === "RULES_NOT_CHECKED" || outcome.reason === "RULES_UNFINISHED");
}

export async function runPolicySweep(db: AppDatabase, deps: PolicySweepDeps = {}): Promise<PolicySweepReport> {
  const env = deps.env ?? process.env; const log = deps.log ?? (() => undefined);
  if (!fundModesEnabled(env)) return { status: "OFF" };
  const batch = deps.batch ?? POLICY_SWEEP_BATCH; const autopilotOn = fundAutopilotEnabled(env);
  const candidates = await db.select({ hash: s.allocationDecisions.decisionHash }).from(s.allocationDecisions)
    .innerJoin(s.decisionModes, eq(s.decisionModes.decisionHash, s.allocationDecisions.decisionHash))
    .innerJoin(s.claims, and(eq(s.claims.id, s.allocationDecisions.claimId), eq(s.claims.version, s.allocationDecisions.claimVersion)))
    .where(and(inArray(s.decisionModes.effectiveMode, autopilotOn ? ["ASSISTED", "AUTOPILOT"] : ["ASSISTED"]), eq(s.claims.status, "AWAITING_APPROVAL"), isNull(s.allocationDecisions.invalidatedAt), isNull(s.allocationDecisions.recognizedAt)))
    .orderBy(asc(s.allocationDecisions.frozenAt)).limit(POLICY_SWEEP_CANDIDATES);
  const autopilot: AutopilotReport = { recognized: 0, routedToPeople: 0, switchOff: 0, sent: 0, sendBlocked: 0, unknownSends: 0 };
  const report: Extract<PolicySweepReport, { status: "DONE" }> = { status: "DONE", considered: candidates.length, rulesRuns: 0, modelRuns: 0, held: 0, recognized: 0, failed: 0 };
  for (const { hash } of candidates) {
    try {
      const rules = await sweepRulesCheck(db, hash, env);
      if (rules.status === "RAN") report.rulesRuns++;
      let modelDeferred = false;
      const rulesHold = rules.status !== "REFUSED" && (await rulesHolds(db, hash));
      if (rules.status === "REFUSED") log({ event: "rules-refused", decision: mask(hash), reason: rules.reason });
      else if (rulesHold) log({ event: "rules-hold", decision: mask(hash) });
      else if (report.modelRuns >= batch) modelDeferred = true;
      else {
        const model = await sweepModelCheck(db, hash, { env, ...deps.model });
        if (model.status === "RAN") report.modelRuns++;
        if (model.status === "REFUSED") log({ event: "model-refused", decision: mask(hash), reason: model.reason });
        if (model.status === "OFF") log({ event: "model-off", decision: mask(hash), reason: model.reason });
      }
      if (await recordHeldOnce(db, hash, modelDeferred)) { report.held++; log({ event: "held", decision: mask(hash) }); continue; }
      // Autopilot (IAC-405 PR P): only for a decision whose effective mode is Autopilot with the second flag on. recognizeAutonomously evaluates G1 to G8 itself, inside its transaction. Anything
      // but RECOGNIZED leaves the decision to the human path below, which for an Autopilot decision needs two approvals.
      // With no send provider (a keyless instance) nothing is recognized automatically either (review item 2): a recognized claim that can never be sent would wait with no human approval.
      if (autopilotOn && !deps.provider && (await recordedMode(db, hash)) === "AUTOPILOT") log({ event: "autopilot-skipped-no-provider", decision: mask(hash) });
      else if (autopilotOn && (await recordedMode(db, hash)) === "AUTOPILOT") {
        const outcome: AutoRecognizeResult = await recognizeAutonomously(db, hash, { env, now: deps.now, audit: deps.audit });
        if (outcome.status === "RECOGNIZED") { report.recognized++; autopilot.recognized++; log({ event: "auto-recognized", decision: mask(hash) }); continue; }
        if (outcome.status === "REFUSED" || outcome.status === "SAMPLED") { autopilot.routedToPeople++; log({ event: "routed-to-people", decision: mask(hash), reason: outcome.status === "REFUSED" ? outcome.failed.join(",") : "AUDIT_SAMPLED" }); }
        else if (outcome.status === "SWITCH_OFF") { autopilot.switchOff++; log({ event: "automation-off", decision: mask(hash), reason: outcome.reason }); }
      }
      // Not newly held: recognize if the decision already holds what it needs. This is a no-op for a decision that is not ready, and the retry that closes the snapshot gap.
      if (!(await hasValidApproval(db, hash))) continue;
      const recognition = await recognizeWhenReady(db, hash, { env });
      if (recognition.status === "APPROVED") { report.recognized++; log({ event: "recognized", decision: mask(hash) }); }
    } catch (error) {
      report.failed++; log({ event: "decision-failed", decision: mask(hash), error: error instanceof Error ? error.name : "Error" });
    }
  }
  // The automated send pass: every claim recognized by an AUTO_RECOGNIZED record that has no disbursement yet. A blocked send changes nothing and is retried by the next pass while the claim
  // stays APPROVED. With no provider (a keyless instance) nothing is sent. An UNKNOWN result trips the switch inside sendAutomatedPayout and is never retried here.
  if (autopilotOn) {
    const pending = await db.select({ claimId: s.allocationDecisions.claimId, hash: s.allocationDecisions.decisionHash }).from(s.allocationDecisions)
      .innerJoin(s.claims, and(eq(s.claims.id, s.allocationDecisions.claimId), eq(s.claims.version, s.allocationDecisions.claimVersion)))
      .innerJoin(s.automatedDecisions, and(eq(s.automatedDecisions.decisionHash, s.allocationDecisions.decisionHash), eq(s.automatedDecisions.kind, "AUTO_RECOGNIZED")))
      .leftJoin(s.disbursements, and(eq(s.disbursements.claimId, s.claims.id), eq(s.disbursements.claimVersion, s.claims.version)))
      .where(and(isNull(s.disbursements.id), eq(s.claims.status, "APPROVED"), isNull(s.allocationDecisions.invalidatedAt), isNotNull(s.allocationDecisions.recognizedAt)))
      .orderBy(asc(s.allocationDecisions.recognizedAt)).limit(POLICY_SWEEP_CANDIDATES);
    for (const { claimId, hash } of pending) {
      if (!deps.provider) { log({ event: "send-skipped-no-provider", decision: mask(hash) }); continue; }
      try {
        const sent: AutomatedSendResult = await sendAutomatedPayout(db, claimId, hash, deps.provider, { env, now: deps.now });
        if (sent.status === "SENT") { autopilot.sent++; if (sent.state === "UNKNOWN") autopilot.unknownSends++; log({ event: "auto-sent", decision: mask(hash), state: sent.state, switchTripped: sent.switchTripped ? 1 : 0 }); }
        else if (sent.status === "BLOCKED") { autopilot.sendBlocked++; log({ event: "send-blocked", decision: mask(hash), reason: sent.reason }); }
      } catch (error) { report.failed++; log({ event: "send-failed", decision: mask(hash), error: error instanceof Error ? error.name : "Error" }); }
    }
  }
  log({ event: "pass", considered: report.considered, rulesRuns: report.rulesRuns, modelRuns: report.modelRuns, held: report.held, recognized: report.recognized, failed: report.failed, ...(autopilotOn ? { autoRecognized: autopilot.recognized, autoSent: autopilot.sent, unknownSends: autopilot.unknownSends } : {}) });
  return autopilotOn ? { ...report, autopilot } : report;
}
