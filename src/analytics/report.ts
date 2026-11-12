import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { AppDatabase } from '../server/db';
import { AnalyticsAccessError } from './snapshot';

// IAC-405 step 5. The read-only data of the funder report.
// Same access rules as loadAnalyticsSnapshot: an approver, one organization that is the actor's, a read only transaction at repeatable read.
// Select statements only. No payee email, provider batch or item id, claimant name or approver id leaves this module. Cents are decimal strings.
export type PathKey = 'AUTOPILOT' | 'ONE_PERSON' | 'TWO_PEOPLE';
export const PATH_KEYS: readonly PathKey[] = ['AUTOPILOT', 'ONE_PERSON', 'TWO_PEOPLE'];
export const PATH_LABELS: Record<PathKey, string> = { AUTOPILOT: 'Autopilot', ONE_PERSON: 'One person after AI checks', TWO_PEOPLE: 'Two people' };

// What was recorded decides the column, never the fund's current mode. AUTO_RECOGNIZED is checked first: an Autopilot decision may also carry approvals rows
// (a person finishing a claim whose payment did not go out), and it stays an Autopilot recognition. A decision that fits none of these returns null.
export function classifyPath(autoRecognized: boolean, approvals: number): PathKey | null {
  if (autoRecognized) return 'AUTOPILOT';
  if (approvals === 1) return 'ONE_PERSON';
  if (approvals >= 2) return 'TWO_PEOPLE';
  return null;
}

export type DebitRow = { fundId: string; decisionHash: string; cents: bigint; autoRecognized: boolean; approvals: number };
export type Cell = { claims: number; cents: string };
export type SpendingRow = { fund: string; cells: Record<PathKey, Cell>; total: Cell };
export type Spending = {
  rows: SpendingRow[]; total: { cells: Record<PathKey, Cell>; total: Cell };
  // Recognized decisions that fit no column. Shown as an error and never merged into a column.
  unclassified: Cell;
  tieOut: { matches: boolean; columnCents: string; debitCents: string };
};
type Tally = { hashes: Set<string>; cents: bigint };
const empty = (): Record<PathKey, Tally> => ({ AUTOPILOT: { hashes: new Set(), cents: 0n }, ONE_PERSON: { hashes: new Set(), cents: 0n }, TWO_PEOPLE: { hashes: new Set(), cents: 0n } });
const cell = (tally: Tally): Cell => ({ claims: tally.hashes.size, cents: tally.cents.toString() });
function cells(tallies: Record<PathKey, Tally>): { cells: Record<PathKey, Cell>; total: Cell } {
  const all: Tally = { hashes: new Set(PATH_KEYS.flatMap(key => [...tallies[key].hashes])), cents: PATH_KEYS.reduce((sum, key) => sum + tallies[key].cents, 0n) };
  return { cells: { AUTOPILOT: cell(tallies.AUTOPILOT), ONE_PERSON: cell(tallies.ONE_PERSON), TWO_PEOPLE: cell(tallies.TWO_PEOPLE) }, total: cell(all) };
}

// debitCents is the fund debit total for the same decisions, summed separately by the database, so a decision that fits no column makes the tie-out say so.
export function buildSpending(funds: readonly { id: string; name: string }[], debits: readonly DebitRow[], debitCents: bigint): Spending {
  const perFund = new Map<string, Record<PathKey, Tally>>();
  const overall = empty(); const lost: Tally = { hashes: new Set(), cents: 0n };
  for (const debit of debits) {
    const key = classifyPath(debit.autoRecognized, debit.approvals);
    if (key === null) { lost.hashes.add(debit.decisionHash); lost.cents += debit.cents; continue; }
    const tallies = perFund.get(debit.fundId) ?? empty(); perFund.set(debit.fundId, tallies);
    for (const target of [tallies, overall]) { target[key].hashes.add(debit.decisionHash); target[key].cents += debit.cents; }
  }
  const seenFunds = new Set([...perFund.keys(), ...debits.map(debit => debit.fundId)]);
  const rows = [...seenFunds].map(id => ({ fund: funds.find(fund => fund.id === id)?.name ?? 'Unknown fund', ...cells(perFund.get(id) ?? empty()) })).sort((a, b) => a.fund.localeCompare(b.fund));
  const summed = cells(overall);
  const columnCents = BigInt(summed.total.cents);
  return { rows, total: summed, unclassified: cell(lost), tieOut: { matches: columnCents === debitCents, columnCents: columnCents.toString(), debitCents: debitCents.toString() } };
}

// The outcome in words, from the kinds recorded for one decision and how its payment stands. An unknown or unfinished send is never shown as paid.
export type OutcomeKey = 'PAID_AUTOMATICALLY' | 'SENT_VERIFYING' | 'SENT_NOT_PAID' | 'APPROVED_NOT_SENT' | 'APPROVED_PEOPLE_SENT' | 'REFUSED' | 'SAMPLED' | 'HELD' | 'CHECKED' | 'CHECKED_WAITING' | 'PAYMENT_ISSUE' | 'FUNDING_REFUSED';
export const OUTCOME_WORDS: Record<OutcomeKey, string> = {
  PAID_AUTOMATICALLY: 'Paid automatically', SENT_VERIFYING: 'Approved automatically, payment is being verified', SENT_NOT_PAID: 'Approved automatically, sent to PayPal and not paid yet',
  APPROVED_NOT_SENT: 'Approved automatically, payment not sent', APPROVED_PEOPLE_SENT: 'Approved automatically, payment finished by people',
  PAYMENT_ISSUE: 'Approved automatically, the payment has an issue', FUNDING_REFUSED: 'Approved automatically, PayPal refused the payment for insufficient funds, not paid',
  REFUSED: 'Refused by a guardrail', SAMPLED: 'Sampled for people', HELD: 'Held for people', CHECKED: 'AI checks found no holds, then a person approved', CHECKED_WAITING: 'AI checks found no holds, waiting for a person',
};
// Precedence when a decision has several records: an automatic recognition stands, then the routes to people (final), then a hold, then a plain check.
const PRECEDENCE = ['AUTO_RECOGNIZED', 'GUARDRAIL_REFUSED', 'AUDIT_SAMPLED', 'HELD', 'NO_HOLDS'] as const;
export function outcomeFor(kinds: readonly string[], payment: { attemptState: string | null; signedByPerson: boolean }, approvals = 0): { key: OutcomeKey; kind: (typeof PRECEDENCE)[number] } | null {
  const kind = PRECEDENCE.find(candidate => kinds.includes(candidate));
  if (!kind) return null;
  if (kind === 'GUARDRAIL_REFUSED') return { key: 'REFUSED', kind };
  if (kind === 'AUDIT_SAMPLED') return { key: 'SAMPLED', kind };
  if (kind === 'HELD') return { key: 'HELD', kind };
  if (kind === 'NO_HOLDS') return { key: approvals >= 1 ? 'CHECKED' : 'CHECKED_WAITING', kind };
  if (payment.signedByPerson) return { key: 'APPROVED_PEOPLE_SENT', kind };
  const state = payment.attemptState;
  if (state === null) return { key: 'APPROVED_NOT_SENT', kind };
  if (state === 'SETTLED') return { key: 'PAID_AUTOMATICALLY', kind };
  if (state === 'UNKNOWN' || state === 'UNKNOWN_STATUS' || state === 'MANUAL_REVIEW') return { key: 'SENT_VERIFYING', kind };
  if (state === 'SUBMITTED' || state === 'PREPARED' || state === 'PENDING') return { key: 'SENT_NOT_PAID', kind };
  if (state === 'FAILED' || state === 'HELD') return { key: 'PAYMENT_ISSUE', kind };
  if (state === 'FUNDING_REJECTED') return { key: 'FUNDING_REFUSED', kind };
  return { key: 'SENT_VERIFYING', kind };
}

export type AccountabilityRow = { claimId: string; outcome: string; outcomeKey: OutcomeKey; amountCents: string; ruleSetVersion: string | null; model: string | null; promptVersion: string | null; recordedAt: string; hasTrail: boolean };
export type SwitchLogRow = { recordedAt: string; event: 'ON' | 'OFF' | 'ON proposed'; reason: string; approver: string | null };
export type FunderReport = { organization: string; observedAt: string; spending: Spending; accountability: AccountabilityRow[]; switchLog: SwitchLogRow[] };

const SWITCH_REASONS: Record<string, string> = {
  DISAGREE: 'An approver disagreed with an automatic payment', UNKNOWN_SEND: 'An automatic payment had an unknown outcome', APPROVER: 'An approver turned it off',
};
export function switchRow(event: { event: string; reason: string | null; recordedAt: Date; approver: string | null }): SwitchLogRow {
  const label = event.event === 'ON' ? 'ON' : event.event === 'OFF' ? 'OFF' : 'ON proposed';
  const reason = event.event === 'OFF' ? (event.reason !== null && Object.hasOwn(SWITCH_REASONS, event.reason) ? SWITCH_REASONS[event.reason]! : 'Reason not recorded')
    : event.event === 'ON' ? 'Confirmed by a second approver' : 'Proposed by an approver, not on until a different approver confirms';
  return { recordedAt: event.recordedAt.toISOString(), event: label, reason, approver: event.approver };
}

// probe is a test seam: it runs inside the report transaction after the access checks, so a test can show that a write there is refused. Production passes nothing.
type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];
export async function loadFunderReport(db: AppDatabase, actorId: string, options: { probe?: (tx: Tx) => Promise<void> } = {}): Promise<FunderReport> {
  return db.transaction(async tx => {
    await tx.execute(sql`set transaction read only`);
    const [actor] = await tx.select({ organizationId: s.users.organizationId, role: s.users.role }).from(s.users).where(eq(s.users.id, actorId));
    if (!actor || actor.role !== 'APPROVER') throw new AnalyticsAccessError(403);
    // v0.2.1 journals have no organization key. Refuse an aggregate if that invariant changes.
    const organizations = await tx.select({ id: s.organizations.id, name: s.organizations.name }).from(s.organizations);
    if (organizations.length !== 1 || organizations[0]!.id !== actor.organizationId) throw new AnalyticsAccessError(503);
    const organization = organizations[0]!; const org = actor.organizationId;
    if (options.probe) await options.probe(tx);

    const funds = await tx.select({ id: s.funds.id, name: s.funds.name }).from(s.funds).where(eq(s.funds.organizationId, org));
    const recognized = and(eq(s.allocationDecisions.organizationId, org), isNotNull(s.allocationDecisions.recognizedAt));
    const debitRows = await tx.select({ fundId: s.fundDebits.fundId, hash: s.allocationDecisions.decisionHash, cents: s.fundDebits.amountCents }).from(s.fundDebits)
      .innerJoin(s.allocationDecisions, eq(s.allocationDecisions.id, s.fundDebits.decisionId)).where(recognized);
    const [total] = await tx.select({ cents: sql<string>`coalesce(sum(${s.fundDebits.amountCents}), 0)::text` }).from(s.fundDebits)
      .innerJoin(s.allocationDecisions, eq(s.allocationDecisions.id, s.fundDebits.decisionId)).where(recognized);
    const automated = await tx.select({ hash: s.automatedDecisions.decisionHash, kind: s.automatedDecisions.kind, ruleSetVersion: s.automatedDecisions.ruleSetVersion, model: s.automatedDecisions.model, promptVersion: s.automatedDecisions.promptVersion,
      recordedAt: s.automatedDecisions.recordedAt, claimId: s.allocationDecisions.claimId, claimVersion: s.allocationDecisions.claimVersion }).from(s.automatedDecisions)
      .innerJoin(s.allocationDecisions, eq(s.allocationDecisions.decisionHash, s.automatedDecisions.decisionHash)).where(eq(s.allocationDecisions.organizationId, org));
    const approvalRows = await tx.select({ hash: s.approvals.decisionHash, n: sql<number>`count(*)::int` }).from(s.approvals)
      .innerJoin(s.allocationDecisions, eq(s.allocationDecisions.decisionHash, s.approvals.decisionHash)).where(eq(s.allocationDecisions.organizationId, org)).groupBy(s.approvals.decisionHash);
    const approvalsOf = new Map(approvalRows.map(row => [row.hash, row.n]));
    const autoHashes = new Set(automated.filter(row => row.kind === 'AUTO_RECOGNIZED').map(row => row.hash));
    const spending = buildSpending(funds, debitRows.map(row => ({ fundId: row.fundId, decisionHash: row.hash, cents: row.cents, autoRecognized: autoHashes.has(row.hash), approvals: approvalsOf.get(row.hash) ?? 0 })), BigInt(total?.cents ?? '0'));

    const lineRows = await tx.select({ claimId: s.claimLines.claimId, claimVersion: s.claimLines.claimVersion, cents: s.claimLines.amountCents }).from(s.claimLines);
    const claimCents = new Map<string, bigint>();
    for (const line of lineRows) claimCents.set(`${line.claimId}:${line.claimVersion}`, (claimCents.get(`${line.claimId}:${line.claimVersion}`) ?? 0n) + line.cents);
    const payments = await tx.select({ hash: s.disbursements.decisionHash, attempt: s.disbursementAttempts.attemptNumber, state: s.disbursementAttempts.state, signedBy: s.disbursementOrigins.signedBy }).from(s.disbursements)
      .innerJoin(s.disbursementAttempts, eq(s.disbursementAttempts.disbursementId, s.disbursements.id))
      .leftJoin(s.disbursementOrigins, eq(s.disbursementOrigins.disbursementId, s.disbursements.id)).orderBy(desc(s.disbursementAttempts.attemptNumber));
    const paymentOf = new Map<string, { attemptState: string | null; signedByPerson: boolean }>();
    for (const row of payments) if (!paymentOf.has(row.hash)) paymentOf.set(row.hash, { attemptState: row.state, signedByPerson: row.signedBy !== null });

    const groups = new Map<string, typeof automated>();
    for (const row of automated) groups.set(row.hash, [...(groups.get(row.hash) ?? []), row]);
    const accountability: AccountabilityRow[] = [];
    for (const [hash, rows] of groups) {
      const outcome = outcomeFor(rows.map(row => row.kind), paymentOf.get(hash) ?? { attemptState: null, signedByPerson: false }, approvalsOf.get(hash) ?? 0);
      if (!outcome) continue;
      const row = rows.filter(candidate => candidate.kind === outcome.kind).sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())[0]!;
      accountability.push({ claimId: row.claimId, outcome: OUTCOME_WORDS[outcome.key], outcomeKey: outcome.key, amountCents: (claimCents.get(`${row.claimId}:${row.claimVersion}`) ?? 0n).toString(),
        ruleSetVersion: row.ruleSetVersion, model: row.model, promptVersion: row.promptVersion, recordedAt: row.recordedAt.toISOString(), hasTrail: outcome.kind === 'AUTO_RECOGNIZED' });
    }
    accountability.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.claimId.localeCompare(b.claimId));

    const events = await tx.select({ seq: s.automationSwitchEvents.seq, event: s.automationSwitchEvents.event, reason: s.automationSwitchEvents.reason, recordedAt: s.automationSwitchEvents.recordedAt, approver: s.users.displayName })
      .from(s.automationSwitchEvents).leftJoin(s.users, eq(s.users.id, s.automationSwitchEvents.actorId)).where(eq(s.automationSwitchEvents.organizationId, org)).orderBy(desc(s.automationSwitchEvents.seq));
    return { organization: organization.name, observedAt: new Date().toISOString(), spending, accountability, switchLog: events.map(switchRow) };
  }, { isolationLevel: 'repeatable read' });
}
