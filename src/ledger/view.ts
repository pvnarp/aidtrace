import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { AppDatabase } from '../server/db';
import { payoutNoteStatus } from '../donation/note';

/**
 * The approver ledger view loader (docs/plans/LEDGER_GRID_SCOPE.md sections 1 to 3, as amended by docs/plans/GRID_SURFACES_SCOPE.md 3.1).
 * It reads one transaction that starts `set transaction read only`, and it issues SELECT statements only. It imports neither the PayPal adapter
 * nor any ledger writer, and it changes no row. Every cent value leaves this module as a decimal string.
 */
export class LedgerAccessError extends Error {
  constructor(public readonly status: 403 | 503) { super(status === 403 ? 'Approver access required' : 'Single-organization accounting required'); }
}

/** The grid shows at most this many postings, newest first. The cap is sized for the demo fixture; `total` always counts every posting. */
export const LEDGER_ROW_CAP = 2000;
/** Manual funds need two distinct human approvals (docs/SPEC.md section 6). The Approvals column reads "n of 2". */
export const REQUIRED_APPROVALS = 2;

export const ACCOUNT_NAMES: Readonly<Record<string, string>> = {
  '1010': 'Cash', '2010': 'Reimbursements payable', '3100': 'Net assets with donor restrictions', '3200': 'Net assets without donor restrictions',
  '4100': 'Contributions with donor restrictions', '5100': 'Supplies', '5200': 'Other', '5300': 'Travel', '5400': 'Equipment', '5500': 'Contractual', '5900': 'Payment processing fees',
};

/** One row per journal posting joined to its entry. Debit and credit are string cents and exactly one is non-empty. */
export interface LedgerRow {
  id: string;
  recordedAt: string;
  effectiveOn: string;
  entryType: string;
  entryTypeTip: string;
  account: string;
  accountCode: string;
  fund: string;
  fundTip: string;
  debitCents: string;
  creditCents: string;
  claim: string;
  approvals: string;
  paypalReference: string;
  paypalTip: string;
  /** True when the PayPal payout outcome is UNKNOWN. The grid marks the row with gx-row-verify. */
  verify: boolean;
}
/** The audit events dataset is cut line 1 (LEDGER_GRID_SCOPE section 9). It is not built, so `events` is always empty. */
export interface LedgerEvent { id: string; at: string; kind: string; detail: string }
export interface LedgerView {
  organization: string;
  fixture: boolean;
  observedAt: string;
  /** Every posting in the ledger, not only the rows returned. */
  total: number;
  rows: LedgerRow[];
  events: LedgerEvent[];
  /** Sums over every posting, as decimal strings of cents. */
  totals: { debitCents: string; creditCents: string };
}

export interface RawPosting {
  id: string; accountCode: string; subKey: string | null; debitCents: bigint; creditCents: bigint;
  sourceType: string; sourceId: string; purpose: string; effectiveOn: string; recordedAt: Date;
}
export interface DecisionLookup { claimId: string; decisionHash: string }
export interface AttemptLookup { state: string; itemStatus: string | null; payoutBatchId: string | null; claimId: string; decisionHash: string }
export interface Lookups {
  /** Allocation decision by its id (the claim_recognition source id). */
  decisions: ReadonlyMap<string, DecisionLookup>;
  /** Approval rows per decision hash. */
  approvals: ReadonlyMap<string, number>;
  /** Capture ids that match a donation receipt. */
  captures: ReadonlySet<string>;
  /** Every disbursement attempt per payout item id. A join resolves only when exactly one attempt matches. */
  attempts: ReadonlyMap<string, readonly AttemptLookup[]>;
  /** Fund name by fund id. */
  funds: ReadonlyMap<string, string>;
  /** Decision hashes recognized by an AUTO_RECOGNIZED record (IAC-405 PR P). Optional: a caller with none reads every approval count as before. */
  autopilot?: ReadonlySet<string>;
}

const ENTRY_TYPES: Readonly<Record<string, { label: string; tip: string }>> = {
  'fixture_opening_balance:opening': { label: 'Opening balance', tip: 'Fixture opening balances: cash and net assets.' },
  'claim_recognition:recognition': { label: 'Claim recognition', tip: 'An approved expense recognized as expense and reimbursement payable.' },
  'claim_recognition:restriction_release': { label: 'Restriction release', tip: 'Restricted net assets released to unrestricted when the approved expense was recognized.' },
  'paypal_capture:donation': { label: 'Donation', tip: 'A completed donation capture: cash and restricted contribution revenue.' },
  'paypal_capture:donation_fee': { label: 'Donation fee', tip: 'The processing fee PayPal reported for a donation capture.' },
  'paypal_payout_item:settlement': { label: 'Payout settlement', tip: 'A verified PayPal payout settled the reimbursement payable.' },
  'paypal_payout_item:payout_fee': { label: 'Payout fee', tip: 'The processing fee PayPal reported for a payout item.' },
};
export function entryTypeOf(sourceType: string, purpose: string) {
  const known = ENTRY_TYPES[`${sourceType}:${purpose}`];
  const raw = `Source type ${sourceType}, purpose ${purpose}.`;
  return known ? { label: known.label, tip: `${known.tip} ${raw}` } : { label: `${sourceType} / ${purpose}`, tip: `Unrecognized entry type. ${raw}` };
}

/** "n of 2" up to the requirement. A larger count reads as the count with the requirement beside it. */
/** The same phrase the claim page shows for a decision recognized and sent under the Autopilot guardrails. */
// Review item 7: the approvals column says what happened to the approval, never that anything was paid. Paid is said only on the claim page, from the provider outcome.
export const AUTOPILOT_PHRASE = 'Approved under Autopilot guardrails';
export function approvalsText(count: number): string {
  return count <= REQUIRED_APPROVALS ? `${count} of ${REQUIRED_APPROVALS}` : `${count} (${REQUIRED_APPROVALS} required)`;
}

const NO_REFERENCE = 'No PayPal reference';
const NO_CLAIM = 'No claim';
const NOT_APPLICABLE = 'Not applicable';

/**
 * Maps one posting to a display row with no database access. Money stays a decimal string: a bigint is converted with toString and never
 * passes through a JavaScript number. A join the data does not resolve with certainty shows the raw source type and id and says so.
 */
export function mapLedgerRow(posting: RawPosting, lookups: Lookups): LedgerRow {
  const entry = entryTypeOf(posting.sourceType, posting.purpose);
  const debit = posting.debitCents > 0n; const credit = posting.creditCents > 0n;
  if (debit === credit) throw new Error('A posting needs exactly one positive side');
  const raw = `${posting.sourceType} ${posting.sourceId}`;
  const unresolved = (what: string) => `Unresolved: ${raw} (${what})`;

  let fund = ''; let fundTip = 'This account is not kept by fund.';
  if (posting.accountCode === '3100' || posting.accountCode === '4100') {
    const key = posting.subKey ?? '';
    const name = key ? lookups.funds.get(key) : undefined;
    fund = name ?? key; fundTip = name ? `Fund id ${key}.` : key ? `Fund id ${key}. No fund record matches this id.` : 'This posting carries no fund key.';
  } else if (posting.accountCode === '3200') {
    fund = 'General'; fundTip = 'Net assets without donor restrictions are general funds.';
  }

  let claim = NO_CLAIM; let approvals = NOT_APPLICABLE; let paypalReference = NO_REFERENCE; let paypalTip = 'This entry did not come from a PayPal event.'; let verify = false;
  if (posting.sourceType === 'claim_recognition') {
    const decision = lookups.decisions.get(posting.sourceId);
    if (decision) { claim = decision.claimId; approvals = lookups.autopilot?.has(decision.decisionHash) ? AUTOPILOT_PHRASE : approvalsText(lookups.approvals.get(decision.decisionHash) ?? 0); }
    else { claim = unresolved('no allocation decision matches this source id'); approvals = claim; }
  } else if (posting.sourceType === 'paypal_capture') {
    if (lookups.captures.has(posting.sourceId)) { paypalReference = posting.sourceId; paypalTip = 'PayPal capture id from the stored donation receipt.'; }
    else { paypalReference = unresolved('no donation receipt matches this capture id'); paypalTip = 'The capture id did not match a stored donation receipt, so the raw source is shown.'; }
  } else if (posting.sourceType === 'paypal_payout_item') {
    const matches = lookups.attempts.get(posting.sourceId) ?? [];
    if (matches.length === 1) {
      const attempt = matches[0]!;
      claim = attempt.claimId; approvals = lookups.autopilot?.has(attempt.decisionHash) ? AUTOPILOT_PHRASE : approvalsText(lookups.approvals.get(attempt.decisionHash) ?? 0);
      const status = payoutNoteStatus({ state: attempt.state, itemStatus: attempt.itemStatus, payoutBatchId: attempt.payoutBatchId }).status;
      if (status === 'UNKNOWN') { paypalReference = 'UNKNOWN'; paypalTip = 'The payout outcome is not verified. It is neither paid nor failed.'; verify = true; }
      else { paypalReference = posting.sourceId; paypalTip = 'PayPal payout item id from the matching disbursement attempt.'; }
    } else {
      const why = matches.length === 0 ? 'no disbursement attempt matches this payout item id' : 'more than one disbursement attempt matches this payout item id';
      claim = unresolved(why); approvals = claim; paypalReference = unresolved(why); paypalTip = 'The payout item id did not match exactly one disbursement attempt, so the raw source is shown.';
    }
  }

  return {
    id: posting.id, recordedAt: posting.recordedAt.toISOString(), effectiveOn: posting.effectiveOn, entryType: entry.label, entryTypeTip: entry.tip,
    account: `${posting.accountCode} ${ACCOUNT_NAMES[posting.accountCode] ?? 'Unrecognized account'}`, accountCode: posting.accountCode,
    fund, fundTip, debitCents: debit ? posting.debitCents.toString() : '', creditCents: credit ? posting.creditCents.toString() : '',
    claim, approvals, paypalReference, paypalTip, verify,
  };
}

/** Exact sums over postings, as decimal strings. */
export function sumSides(postings: readonly { debitCents: bigint; creditCents: bigint }[]): { debitCents: string; creditCents: string } {
  let debit = 0n; let credit = 0n;
  for (const posting of postings) { debit += posting.debitCents; credit += posting.creditCents; }
  return { debitCents: debit.toString(), creditCents: credit.toString() };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadLedgerView(db: AppDatabase, actorId: string): Promise<LedgerView> {
  return db.transaction(async tx => {
    await tx.execute(sql`set transaction read only`);
    const [actor] = await tx.select({ organizationId: s.users.organizationId, role: s.users.role }).from(s.users).where(eq(s.users.id, actorId));
    if (!actor || actor.role !== 'APPROVER') throw new LedgerAccessError(403);
    // v0.2.1 journals have no organization key. Refuse the view if that invariant changes.
    const organizations = await tx.select({ id: s.organizations.id, name: s.organizations.name, isFixture: s.organizations.isFixture }).from(s.organizations);
    if (organizations.length !== 1 || organizations[0]!.id !== actor.organizationId) throw new LedgerAccessError(503);
    const organization = organizations[0]!;

    const [counts] = await tx.select({ total: count(), debit: sql<string>`coalesce(sum(${s.journalPostings.debitCents}), 0)::text`, credit: sql<string>`coalesce(sum(${s.journalPostings.creditCents}), 0)::text` }).from(s.journalPostings);
    const postings: RawPosting[] = await tx.select({
      id: s.journalPostings.id, accountCode: s.journalPostings.accountCode, subKey: s.journalPostings.subKey, debitCents: s.journalPostings.debitCents, creditCents: s.journalPostings.creditCents,
      sourceType: s.journalEntries.sourceType, sourceId: s.journalEntries.sourceId, purpose: s.journalEntries.purpose, effectiveOn: s.journalEntries.effectiveOn, recordedAt: s.journalEntries.recordedAt,
    }).from(s.journalPostings).innerJoin(s.journalEntries, eq(s.journalPostings.entryId, s.journalEntries.id))
      .orderBy(desc(s.journalEntries.recordedAt), desc(s.journalEntries.id), desc(s.journalPostings.debitCents), asc(s.journalPostings.id)).limit(LEDGER_ROW_CAP);

    const idsOf = (type: string) => [...new Set(postings.filter(row => row.sourceType === type).map(row => row.sourceId))];
    const decisionIds = idsOf('claim_recognition').filter(id => UUID.test(id));
    const captureIds = idsOf('paypal_capture');
    const itemIds = idsOf('paypal_payout_item');

    const decisionRows = decisionIds.length ? await tx.select({ id: s.allocationDecisions.id, claimId: s.allocationDecisions.claimId, decisionHash: s.allocationDecisions.decisionHash }).from(s.allocationDecisions).where(inArray(s.allocationDecisions.id, decisionIds)) : [];
    const receiptRows = captureIds.length ? await tx.select({ captureId: s.donationReceipts.captureId }).from(s.donationReceipts).where(inArray(s.donationReceipts.captureId, captureIds)) : [];
    const attemptRows = itemIds.length ? await tx.select({
      itemId: s.disbursementAttempts.payoutItemId, state: s.disbursementAttempts.state, itemStatus: s.disbursementAttempts.itemStatus, payoutBatchId: s.disbursementAttempts.payoutBatchId,
      claimId: s.disbursements.claimId, decisionHash: s.disbursements.decisionHash,
    }).from(s.disbursementAttempts).innerJoin(s.disbursements, eq(s.disbursementAttempts.disbursementId, s.disbursements.id)).where(inArray(s.disbursementAttempts.payoutItemId, itemIds)) : [];
    const hashes = [...new Set([...decisionRows.map(row => row.decisionHash), ...attemptRows.map(row => row.decisionHash)])];
    const approvalRows = hashes.length ? await tx.select({ decisionHash: s.approvals.decisionHash, n: count() }).from(s.approvals).where(inArray(s.approvals.decisionHash, hashes)).groupBy(s.approvals.decisionHash) : [];
    const autoRows = hashes.length ? await tx.select({ decisionHash: s.automatedDecisions.decisionHash }).from(s.automatedDecisions).where(and(inArray(s.automatedDecisions.decisionHash, hashes), eq(s.automatedDecisions.kind, 'AUTO_RECOGNIZED'))) : [];
    const fundRows = await tx.select({ id: s.funds.id, name: s.funds.name }).from(s.funds).where(eq(s.funds.organizationId, actor.organizationId));

    const attempts = new Map<string, AttemptLookup[]>();
    for (const row of attemptRows) {
      if (!row.itemId) continue;
      const list = attempts.get(row.itemId) ?? [];
      list.push({ state: row.state, itemStatus: row.itemStatus, payoutBatchId: row.payoutBatchId, claimId: row.claimId, decisionHash: row.decisionHash });
      attempts.set(row.itemId, list);
    }
    const lookups: Lookups = {
      decisions: new Map(decisionRows.map(row => [row.id, { claimId: row.claimId, decisionHash: row.decisionHash }])),
      approvals: new Map(approvalRows.map(row => [row.decisionHash, row.n])),
      captures: new Set(receiptRows.flatMap(row => (row.captureId ? [row.captureId] : []))),
      attempts,
      funds: new Map(fundRows.map(row => [row.id, row.name])),
      autopilot: new Set(autoRows.map(row => row.decisionHash)),
    };

    return {
      organization: organization.name, fixture: organization.isFixture, observedAt: new Date().toISOString(),
      total: counts!.total, rows: postings.map(posting => mapLedgerRow(posting, lookups)), events: [],
      totals: { debitCents: BigInt(counts!.debit).toString(), creditCents: BigInt(counts!.credit).toString() },
    };
  }, { isolationLevel: 'repeatable read' });
}
