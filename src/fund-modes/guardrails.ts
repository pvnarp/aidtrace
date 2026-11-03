// IAC-405 step 3 PR P (docs/plans/FUND_MODES_SCOPE.md section 5 guardrails G1 to G9; docs/ASSUMPTIONS.md section 78). The Autopilot guardrails, evaluated inside the caller's transaction,
// under the organization lock, on stored facts only. Every amount is integer cents (bigint) and is stored as a decimal string. A result is { pass, ...inputs }: the inputs are what the
// rule read, so the claim page can show them. Nothing here writes, approves, posts or calls a provider, and no result is called "cleared", "approved" or "passed" in the app.
//   G1 rules and Claude agree on every line: "no holds" (src/fund-modes/no-holds.ts)
//   G2 per line caps by budget line: supplies at most USD 250.00, equipment at most USD 500.00, every other line goes to people
//   G3 per fund per UTC day: automated sends funded by the fund that day plus this claim's share, at most USD 1,000.00
//   G4 per claimant per 7 days: automated sends to the claimant plus this claim, at most USD 500.00 (human-approved payouts do not count)
//   G5 the claimant has an earlier PAID claim recognized by two human approvals
//   G6 the payout email has been unchanged for 30 days (payee_email_history)
//   G7 a 5 percent audit draw from a cryptographic random source, drawn only when every other guardrail holds; a sampled claim goes to two approvers
//   G8 the kill switch is ON and no automated attempt is unresolved
// G9 (UNKNOWN stays UNKNOWN, only a human retry authorization retries) is a property of the send path, not a check here.
import { randomInt } from "node:crypto";
import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { LedgerTransaction } from "../ledger/journal";
import { automationAllowed, automationState } from "./automation-state";
import { noHoldsFor, type NoHoldsOutcome } from "./no-holds";
import { payingFunds } from "./modes";

export const G2_SUPPLIES_CAP_CENTS = 25_000n;
export const G2_EQUIPMENT_CAP_CENTS = 50_000n;
export const G3_FUND_DAY_CAP_CENTS = 100_000n;
export const G4_CLAIMANT_WEEK_CAP_CENTS = 50_000n;
export const G6_UNCHANGED_DAYS = 30;
export const G7_SAMPLE_PERCENT = 5;
export const GUARDRAIL_IDS = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"] as const;
export type GuardrailId = (typeof GUARDRAIL_IDS)[number];
export type GuardrailResult = { pass: boolean } & Record<string, string | number | boolean | string[] | null>;
export type Guardrails = Partial<Record<GuardrailId, GuardrailResult>>;

// The audit draw. Returns a whole number from 0 to 99. A draw below G7_SAMPLE_PERCENT is sampled. The default is a cryptographic source; a test passes its own.
export type AuditDraw = () => number;
export const cryptoAuditDraw: AuditDraw = () => randomInt(0, 100);

const DAY_MS = 86_400_000;
const utcDayStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
type Claim = typeof s.claims.$inferSelect;
type Edge = { fundId: string; lineId: string; amountCents: bigint };
const sumOf = (rows: readonly { amountCents: bigint }[]) => rows.reduce((sum, row) => sum + row.amountCents, 0n);

export async function g2Lines(tx: LedgerTransaction, claim: Claim): Promise<GuardrailResult> {
  const lines = await tx.select({ id: s.claimLines.id, budgetLine: s.claimLines.budgetLine, amountCents: s.claimLines.amountCents }).from(s.claimLines)
    .where(and(eq(s.claimLines.claimId, claim.id), eq(s.claimLines.claimVersion, claim.version)));
  const refused = lines.filter(line => !(line.budgetLine === "supplies" && line.amountCents <= G2_SUPPLIES_CAP_CENTS) && !(line.budgetLine === "equipment" && line.amountCents <= G2_EQUIPMENT_CAP_CENTS)).map(line => line.id).sort();
  return { pass: lines.length > 0 && refused.length === 0, lines: lines.length, suppliesCapCents: G2_SUPPLIES_CAP_CENTS.toString(), equipmentCapCents: G2_EQUIPMENT_CAP_CENTS.toString(), refusedLines: refused.slice(0, 10) };
}

// Automated amounts that are committed but not sent: a decision recognized by an AUTO_RECOGNIZED record that has no disbursement yet. Review item 1 (IAC-405 PR P): G3 and G4 count them with
// the sent amounts, so one sweep pass that recognizes several claims before it sends any of them cannot recognize more than the caps allow. The decision under evaluation is excluded
// (at recognition it has no record yet; at send it is the claim being sent). A recognized claim whose send never happens keeps counting: the cap stays conservative until a person resolves it.
export async function g3FundDay(tx: LedgerTransaction, edges: readonly Edge[], now: Date, excludeHash?: string): Promise<GuardrailResult> {
  const funds = payingFunds(edges); const since = utcDayStart(now); const exclude = excludeHash ?? "";
  const shares = Object.fromEntries(funds.map(fundId => [fundId, sumOf(edges.filter(edge => edge.fundId === fundId))]));
  const rows = funds.length === 0 ? [] : await tx.execute<{ fund_id: string; used: string }>(sql`
    select e.fund_id, coalesce(sum(e.amount_cents), 0)::text as used
    from allocation_edges e
    join allocation_decisions ad on ad.id = e.decision_id
    join disbursements d on d.decision_hash = ad.decision_hash
    join disbursement_origins o on o.disbursement_id = d.id
    where o.automated_decision_id is not null and d.recorded_at >= ${since.toISOString()}::timestamptz and e.fund_id in ${funds}
    group by e.fund_id`);
  const pendingRows = funds.length === 0 ? [] : await tx.execute<{ fund_id: string; pending: string }>(sql`
    select e.fund_id, coalesce(sum(e.amount_cents), 0)::text as pending
    from automated_decisions a
    join allocation_decisions ad on ad.decision_hash = a.decision_hash
    join allocation_edges e on e.decision_id = ad.id
    where a.kind = 'AUTO_RECOGNIZED' and a.decision_hash <> ${exclude} and e.fund_id in ${funds}
      and not exists (select 1 from disbursements d where d.decision_hash = a.decision_hash)
    group by e.fund_id`);
  const sent = Object.fromEntries(funds.map(fundId => [fundId, BigInt(rows.find(row => row.fund_id === fundId)?.used ?? "0")]));
  const pending = Object.fromEntries(funds.map(fundId => [fundId, BigInt(pendingRows.find(row => row.fund_id === fundId)?.pending ?? "0")]));
  const used = Object.fromEntries(funds.map(fundId => [fundId, sent[fundId]! + pending[fundId]!]));
  const over = funds.filter(fundId => used[fundId]! + shares[fundId]! > G3_FUND_DAY_CAP_CENTS).sort();
  return { pass: funds.length > 0 && over.length === 0, capCents: G3_FUND_DAY_CAP_CENTS.toString(), dayStartUtc: since.toISOString(), overFunds: over,
    recognizedUnsentCents: funds.reduce((sum, fundId) => sum + pending[fundId]!, 0n).toString(), funds: funds.sort().map(fundId => `${fundId}:${used[fundId]}+${shares[fundId]}`) };
}

export async function g4ClaimantWeek(tx: LedgerTransaction, claim: Claim, claimTotalCents: bigint, now: Date, excludeHash?: string): Promise<GuardrailResult> {
  const since = new Date(now.getTime() - 7 * DAY_MS); const exclude = excludeHash ?? "";
  const [row] = await tx.execute<{ used: string }>(sql`
    select coalesce(sum(d.amount_cents), 0)::text as used
    from disbursements d
    join claims c on c.id = d.claim_id and c.version = d.claim_version
    join disbursement_origins o on o.disbursement_id = d.id
    where o.automated_decision_id is not null and c.claimant_id = ${claim.claimantId} and d.recorded_at >= ${since.toISOString()}::timestamptz`);
  const [pendingRow] = await tx.execute<{ pending: string }>(sql`
    select coalesce(sum(l.amount_cents), 0)::text as pending
    from automated_decisions a
    join allocation_decisions ad on ad.decision_hash = a.decision_hash
    join claims c on c.id = ad.claim_id and c.version = ad.claim_version
    join claim_lines l on l.claim_id = c.id and l.claim_version = c.version
    where a.kind = 'AUTO_RECOGNIZED' and a.decision_hash <> ${exclude} and c.claimant_id = ${claim.claimantId}
      and not exists (select 1 from disbursements d where d.decision_hash = a.decision_hash)`);
  const sent = BigInt(row?.used ?? "0"); const pending = BigInt(pendingRow?.pending ?? "0"); const used = sent + pending;
  return { pass: used + claimTotalCents <= G4_CLAIMANT_WEEK_CAP_CENTS, capCents: G4_CLAIMANT_WEEK_CAP_CENTS.toString(), usedCents: used.toString(), recognizedUnsentCents: pending.toString(), claimCents: claimTotalCents.toString(), sinceUtc: since.toISOString() };
}

export async function g5PriorHumanClaim(tx: LedgerTransaction, claim: Claim, frozenAt: Date): Promise<GuardrailResult> {
  const rows = await tx.execute<{ claim_id: string }>(sql`
    select c2.id as claim_id
    from claims c2
    join allocation_decisions ad on ad.claim_id = c2.id and ad.claim_version = c2.version and ad.recognized_at is not null and ad.invalidated_at is null
    where c2.claimant_id = ${claim.claimantId} and c2.organization_id = ${claim.organizationId} and c2.status = 'PAID'
      and not (c2.id = ${claim.id} and c2.version = ${claim.version}) and ad.recognized_at < ${frozenAt.toISOString()}::timestamptz
      and (select count(distinct a.approver_id) from approvals a join users u on u.id = a.approver_id
           where a.decision_hash = ad.decision_hash and u.role = 'APPROVER' and u.organization_id = ${claim.organizationId} and u.id <> c2.claimant_id) >= 2
    order by c2.id limit 1`);
  return { pass: rows.length > 0, priorClaim: rows[0]?.claim_id ?? null };
}

export async function g6EmailUnchanged(tx: LedgerTransaction, claim: Claim, now: Date): Promise<GuardrailResult> {
  const cutoff = new Date(now.getTime() - G6_UNCHANGED_DAYS * DAY_MS);
  const [anchor] = await tx.select({ email: s.payeeEmailHistory.email, source: s.payeeEmailHistory.source, seenAt: s.payeeEmailHistory.seenAt }).from(s.payeeEmailHistory)
    .where(and(eq(s.payeeEmailHistory.userId, claim.claimantId), lte(s.payeeEmailHistory.seenAt, cutoff))).orderBy(desc(s.payeeEmailHistory.seenAt), desc(s.payeeEmailHistory.id)).limit(1);
  const later = await tx.select({ email: s.payeeEmailHistory.email }).from(s.payeeEmailHistory).where(and(eq(s.payeeEmailHistory.userId, claim.claimantId), gt(s.payeeEmailHistory.seenAt, cutoff)));
  const changedSince = later.filter(row => row.email !== claim.payeeEmail).length;
  const pass = Boolean(anchor) && anchor!.email === claim.payeeEmail && changedSince === 0;
  return { pass, days: G6_UNCHANGED_DAYS, anchorSeenAt: anchor?.seenAt.toISOString() ?? null, anchorSource: anchor?.source ?? null, anchorMatches: anchor ? anchor.email === claim.payeeEmail : false, changedSince,
    demoHistory: anchor?.source === "FIXTURE" };
}

export type GuardrailInput = { tx: LedgerTransaction; claim: Claim; decision: typeof s.allocationDecisions.$inferSelect; edges: readonly Edge[]; now: Date; audit?: AuditDraw };
export type Evaluation =
  | { status: "SWITCH_OFF"; reason: "OFF" | "UNKNOWN_OUTSTANDING" }
  | { status: "HELD"; reason: string }
  | { status: "REFUSED"; guardrails: Guardrails; failed: GuardrailId[]; claimCents: bigint; noHolds: Extract<NoHoldsOutcome, { noHolds: true }> }
  | { status: "SAMPLED"; guardrails: Guardrails; claimCents: bigint; noHolds: Extract<NoHoldsOutcome, { noHolds: true }> }
  | { status: "PASS"; guardrails: Guardrails; claimCents: bigint; noHolds: Extract<NoHoldsOutcome, { noHolds: true }> };

// The G8 state first (an off switch records nothing: it is not a refusal of the claim), then G1 (a hold is recorded by the sweep as HELD), then G2 to G6, then the G7 draw only if all of those hold.
export async function evaluateGuardrails(input: GuardrailInput): Promise<Evaluation> {
  const { tx, claim, decision, edges, now } = input;
  const state = await automationState(tx, claim.organizationId);
  if (!automationAllowed(state)) return { status: "SWITCH_OFF", reason: state.on ? "UNKNOWN_OUTSTANDING" : "OFF" };
  const noHolds = await noHoldsFor(tx, decision.decisionHash, now, { strict: true });
  if (!noHolds.noHolds) return { status: "HELD", reason: noHolds.reason };
  const lines = await tx.select({ amountCents: s.claimLines.amountCents }).from(s.claimLines).where(and(eq(s.claimLines.claimId, claim.id), eq(s.claimLines.claimVersion, claim.version)));
  const claimCents = sumOf(lines);
  const guardrails: Guardrails = {
    G1: { pass: true, okLines: noHolds.okLines, checkedPairs: noHolds.checkedPairs, rulesNotes: noHolds.rulesNotes },
    G2: await g2Lines(tx, claim), G3: await g3FundDay(tx, edges, now, decision.decisionHash), G4: await g4ClaimantWeek(tx, claim, claimCents, now, decision.decisionHash),
    G5: await g5PriorHumanClaim(tx, claim, decision.frozenAt), G6: await g6EmailUnchanged(tx, claim, now),
    G8: { pass: true, switchOn: true, unresolvedAutomatedAttempts: false },
  };
  const failed = (["G2", "G3", "G4", "G5", "G6"] as const).filter(id => !guardrails[id]!.pass);
  if (failed.length > 0) return { status: "REFUSED", guardrails: { ...guardrails, G7: { pass: false, drawn: false } }, failed, claimCents, noHolds };
  const draw = (input.audit ?? cryptoAuditDraw)();
  if (!Number.isInteger(draw) || draw < 0 || draw > 99) throw new Error("The audit draw must be a whole number from 0 to 99");
  const sampled = draw < G7_SAMPLE_PERCENT;
  guardrails.G7 = { pass: !sampled, drawn: true, draw, samplePercent: G7_SAMPLE_PERCENT, sampled };
  return sampled ? { status: "SAMPLED", guardrails, claimCents, noHolds } : { status: "PASS", guardrails, claimCents, noHolds };
}

// The inputs object stored with an automated record: closed codes and decimal strings only, never request text, model text or a key.
export const guardrailInputs = (guardrails: Guardrails, claimCents: bigint, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ guardrails, claimCents: claimCents.toString(), ...extra });
