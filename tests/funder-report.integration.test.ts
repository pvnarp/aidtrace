import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as s from '../db/schema';
import { createPayPalAdapter, type PayoutTransport } from '../src/paypal/adapter';
import { approveDecision, approveAutoRecognized } from '../src/ledger/service';
import { sendClaimPayout } from '../src/ledger/payout';
import { runPolicySweep } from '../src/fund-modes/policy-sweep';
import { loadFunderReport, OUTCOME_WORDS, type FunderReport, type OutcomeKey } from '../src/analytics/report';
import { loadAnalyticsSnapshot } from '../src/analytics/snapshot';
import { questionFacts } from '../src/analytics/model';
import { RECEIPT_PAYEE, FINANCIAL_TABLES, createPolicyDatabase, financialHash, receiptClaim, type PolicyDatabase, type ReceiptLineSpec } from './support/policy-db';
import { ALL_AUTOPILOT, ALL_ASSISTED, SWEEP_ENV, conflictAll, allOk, dbError, setModes, stub, type Handler } from './support/fund-modes';

// IAC-405 step 5, FR-12 onward. Real Postgres in the isolated check project. Every claim below reaches its state through the
// real paths: the policy sweep for Autopilot, Assisted, sampled, refused and held decisions, approveDecision and approveAutoRecognized for people, sendClaimPayout for a person's send.
// The PayPal provider is a stub and every model call goes to a stub. Nothing reaches a network or a key.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const ORG = 'cedar-hollow';
const AUTO_ENV = { ...SWEEP_ENV, FUND_AUTOPILOT_ENABLED: 'true' };
const flags = (modes: boolean, autopilot: boolean) => { vi.stubEnv('FUND_MODES_ENABLED', modes ? 'true' : 'false'); vi.stubEnv('FUND_AUTOPILOT_ENABLED', autopilot ? 'true' : 'false'); };
function provider(behaviour: 'OK' | 'NO_BALANCE' = 'OK') {
  const validatePayout = createPayPalAdapter({ baseUrl: 'https://api-m.sandbox.paypal.com', clientId: 'synthetic', clientSecret: 'synthetic', payeeAllowlist: [RECEIPT_PAYEE], maxDemoPayoutCents: 50_000n }, vi.fn()).validatePayout;
  return { validatePayout: vi.fn(validatePayout), balance: vi.fn<PayoutTransport['balance']>(async () => { if (behaviour === 'NO_BALANCE') throw new Error('the balance is not readable'); return { readable: false }; }),
    send: vi.fn<PayoutTransport['send']>(async () => ({ httpStatus: 201, batchId: 'BATCH_FR', batchStatus: 'PENDING' })),
    batch: vi.fn<PayoutTransport['batch']>(async () => { throw new Error('not used'); }), item: vi.fn<PayoutTransport['item']>(async () => { throw new Error('not used'); }) } satisfies PayoutTransport;
}
type Provider = ReturnType<typeof provider>;
const lines = (n: number): ReceiptLineSpec[] => [{ description: 'Robot servo kit', amount: `${40 + n}.00`, category: 'robot_kits_parts' }, { description: 'Classroom markers', amount: `${25 + n}.00`, category: 'classroom_supplies' }];

let ctx: PolicyDatabase; let report: FunderReport;
const ids: Record<string, { id: string; hash: string }> = {};
const claimN = async (name: string, n: number) => { const claim = await receiptClaim(ctx.db, { vendor: `Shop number ${n}`, lines: lines(n) }); ids[name] = { id: claim.id, hash: claim.hash }; return claim; };
const sweep = async (options: { provider?: Provider | null; audit?: () => number; handler?: Handler } = {}) => {
  const { client } = stub(options.handler ?? allOk);
  return runPolicySweep(ctx.db, { env: AUTO_ENV, model: { client }, log: () => undefined, provider: options.provider === null ? undefined : (options.provider ?? provider()), audit: options.audit ?? (() => 50) });
};
const approve = (claim: { decisionId: string; hash: string }, actor: string) => approveDecision(ctx.db, claim.decisionId, actor, claim.hash);
const kinds = async (hash: string) => (await ctx.db.select().from(s.automatedDecisions).where(eq(s.automatedDecisions.decisionHash, hash))).map(row => row.kind).sort();
let hashBefore = ''; let people = { signedCents: 0n };

beforeAll(async () => {
  ctx = await createPolicyDatabase('aidtrace_fr', { payeeEmail: RECEIPT_PAYEE });
  // 1. Manual: two people, paid earlier (also the earlier human-approved claim that guardrail G5 needs).
  flags(true, true);
  const prior = await receiptClaim(ctx.db, { vendor: 'Earlier shop', lines: [{ description: 'Earlier markers', amount: '30.00', category: 'classroom_supplies' }] }); ids.prior = { id: prior.id, hash: prior.hash };
  await approve(prior, 'tara'); await approve(prior, 'ben'); await ctx.client`update claims set status = 'PAID' where id = ${prior.id}`;
  // 2. Assisted: the sweep records the AI checks, one person recognizes it.
  await setModes(ctx.db, ALL_ASSISTED);
  const assisted = await claimN('assisted', 2); await sweep({ provider: null }); await approve(assisted, 'tara');
  // 3. Autopilot, sent: the switch is turned on by two different approvers the way production does it.
  await setModes(ctx.db, ALL_AUTOPILOT);
  const [proposal] = await ctx.db.insert(s.automationSwitchEvents).values({ organizationId: ORG, event: 'PROPOSE_ON', actorId: 'tara' }).returning({ seq: s.automationSwitchEvents.seq });
  await ctx.db.insert(s.automationSwitchEvents).values({ organizationId: ORG, event: 'ON', actorId: 'ben', proposalSeq: proposal!.seq });
  await claimN('sent', 1); await sweep();
  // 4. Autopilot, send blocked (unreadable balance), then two people take over and one of them sends.
  const blocked = await claimN('takeover', 6); await sweep({ provider: provider('NO_BALANCE') });
  await approveAutoRecognized(ctx.db, blocked.id, 'tara'); await approveAutoRecognized(ctx.db, blocked.id, 'ben');
  await sendClaimPayout(ctx.db, blocked.id, 'tara', blocked.hash, provider());
  // 5. Drawn for the random audit, then two people approve.
  const sampled = await claimN('sampled', 3); await sweep({ audit: () => 4 }); await approve(sampled, 'tara'); await approve(sampled, 'ben');
  // 6. Refused by a guardrail (the payout email changed 10 days ago), then two people approve.
  await ctx.db.insert(s.payeeEmailHistory).values({ userId: 'maria', email: 'changed-address@example.invalid', source: 'CLAIM', seenAt: new Date(Date.now() - 10 * 86_400_000) });
  const refused = await claimN('refused', 4); await sweep(); await approve(refused, 'tara'); await approve(refused, 'ben');
  // 7. Held by the AI checks and left for people.
  await claimN('held', 5); await sweep({ handler: conflictAll });
  // 8. An approver turns the switch off.
  await ctx.db.insert(s.automationSwitchEvents).values({ organizationId: ORG, event: 'OFF', reason: 'APPROVER', actorId: 'ben' });
  const [signed] = await ctx.client`select coalesce(sum(d.amount_cents), 0)::text as cents from disbursements d join disbursement_origins o on o.disbursement_id = d.id where o.signed_by is not null`;
  people = { signedCents: BigInt(signed!.cents as string) };
  hashBefore = await financialHash(ctx.client, FINANCIAL_TABLES);
  report = await loadFunderReport(ctx.db, 'tara');
});
afterAll(async () => { vi.unstubAllEnvs(); await ctx?.close(); });

describe('FR-12 the report columns and the tie-out, over claims driven through the real paths', () => {
  it('FR-12: the setup reached the recorded states it claims', async () => {
    expect(await kinds(ids.sent!.hash)).toEqual(['AUTO_RECOGNIZED', 'AUTO_SEND_CONFIRMED', 'AUTO_SENT']);
    expect(await kinds(ids.takeover!.hash)).toEqual(['AUTO_RECOGNIZED']);
    expect(await kinds(ids.sampled!.hash)).toEqual(['AUDIT_SAMPLED']); expect(await kinds(ids.refused!.hash)).toEqual(['GUARDRAIL_REFUSED']); expect(await kinds(ids.held!.hash)).toEqual(['HELD']);
    expect(await kinds(ids.assisted!.hash)).toEqual(['NO_HOLDS']);
    const count = async (key: string) => (await ctx.db.select().from(s.approvals).where(eq(s.approvals.decisionHash, ids[key]!.hash))).length;
    expect([await count('prior'), await count('assisted'), await count('sent'), await count('takeover'), await count('sampled'), await count('refused'), await count('held')]).toEqual([2, 1, 0, 2, 2, 2, 0]);
    const recognized = async (key: string) => (await ctx.db.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.decisionHash, ids[key]!.hash)))[0]!.recognizedAt !== null;
    expect([await recognized('held'), await recognized('refused'), await recognized('sampled'), await recognized('takeover')]).toEqual([false, true, true, true]);
  });

  it('FR-13: each column holds the claims recorded for it, in integer cents, and the held claim is in none', () => {
    // Claim n totals (65 + 2n) dollars: sent 67.00, takeover 77.00, assisted 69.00, sampled 71.00, refused 73.00, prior 30.00.
    expect(report.spending.total.cells).toEqual({ AUTOPILOT: { claims: 2, cents: '14400' }, ONE_PERSON: { claims: 1, cents: '6900' }, TWO_PEOPLE: { claims: 3, cents: '17400' } });
    expect(report.spending.total.total).toEqual({ claims: 6, cents: '38700' });
    expect(report.spending.unclassified).toEqual({ claims: 0, cents: '0' });
    for (const row of report.spending.rows) expect(BigInt(row.total.cents)).toBe(BigInt(row.cells.AUTOPILOT.cents) + BigInt(row.cells.ONE_PERSON.cents) + BigInt(row.cells.TWO_PEOPLE.cents));
    const sum = (key: 'AUTOPILOT' | 'ONE_PERSON' | 'TWO_PEOPLE') => report.spending.rows.reduce((total, row) => total + BigInt(row.cells[key].cents), 0n);
    expect([sum('AUTOPILOT'), sum('ONE_PERSON'), sum('TWO_PEOPLE')]).toEqual([14_400n, 6_900n, 17_400n]);
    expect(report.spending.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('FR-14: the tie-out equals the fund debits read separately, and says matched only because they match', async () => {
    const [debits] = await ctx.client`select coalesce(sum(amount_cents), 0)::text as cents from fund_debits where purpose like 'recognition:%'`;
    expect(report.spending.tieOut).toEqual({ matches: true, columnCents: '38700', debitCents: debits!.cents });
    expect(debits!.cents).toBe('38700');
  });

  it('FR-15: a claim that Autopilot recognized and two people then finished stays in the Autopilot column, and a sampled or refused claim approved by two people is in Two people', () => {
    // takeover: AUTO_RECOGNIZED plus two approvals (77.00). sampled 71.00 and refused 73.00 plus prior 30.00 are the Two people column.
    expect(report.spending.total.cells.AUTOPILOT.cents).toBe('14400'); expect(report.spending.total.cells.TWO_PEOPLE).toEqual({ claims: 3, cents: '17400' });
  });
});

describe('FR-16 automation accountability and the kill switch log', () => {
  const outcomes = () => new Map(report.accountability.map(row => [row.claimId, row]));
  it('FR-16: one row per claim with an automated record, in the scope words, newest first, with stored versions', () => {
    const rows = outcomes();
    expect(report.accountability).toHaveLength(6);
    const expected: Record<string, OutcomeKey> = { assisted: 'CHECKED', takeover: 'APPROVED_PEOPLE_SENT', sampled: 'SAMPLED', refused: 'REFUSED', held: 'HELD' };
    for (const [name, key] of Object.entries(expected)) expect(rows.get(ids[name]!.id), name).toMatchObject({ outcomeKey: key, outcome: OUTCOME_WORDS[key] });
    expect(rows.has(ids.prior!.id)).toBe(false);
    const times = report.accountability.map(row => row.recordedAt); expect([...times].sort().reverse()).toEqual(times);
    expect(rows.get(ids.sent!.id)).toMatchObject({ outcomeKey: 'SENT_NOT_PAID', amountCents: '6700', ruleSetVersion: 'policy-rules-v1', promptVersion: 'compliance-v1.1', hasTrail: true });
    expect(rows.get(ids.sent!.id)!.model).toBe('claude-haiku-5-5>claude-sonnet-5-5');
    expect(rows.get(ids.held!.id)).toMatchObject({ amountCents: '7500', hasTrail: false });
    expect(rows.get(ids.takeover!.id)).toMatchObject({ amountCents: '7700', hasTrail: true });
  });
  it('FR-17: the kill switch log lists every event, newest first, naming the approver where one acted', () => {
    expect(report.switchLog.map(row => [row.event, row.approver, row.reason])).toEqual([
      ['OFF', 'Ben', 'An approver turned it off'], ['ON', 'Ben', 'Confirmed by a second approver'], ['ON proposed', 'Tara', 'Proposed by an approver, not on until a different approver confirms'],
    ]);
  });
  it('FR-18: no payee email, provider id, claimant, approver id or decision hash is in the report', () => {
    const text = JSON.stringify(report);
    for (const secret of [RECEIPT_PAYEE, 'personal.example.com', 'BATCH_FR', 'AT-', 'senderBatchId', 'payeeEmail', 'maria', 'Maria', 'tara', 'claimantId', ids.sent!.hash, ids.held!.hash, 'changed-address']) expect(text, secret).not.toContain(secret);
    expect(text).toContain('Ben');
  });
});

describe('FR-19 the why facts in the snapshot', () => {
  it('FR-19: the snapshot carries the eight facts built from the same rows, and each question offers its four', async () => {
    const snapshot = await loadAnalyticsSnapshot(ctx.db, 'tara');
    const auto = questionFacts(snapshot, 'whyAuto'); const why = questionFacts(snapshot, 'whyPeople');
    expect(auto.map(fact => fact.id)).toEqual(['auto-count', 'auto-rule', 'auto-versions', 'auto-sampled']);
    expect(why.map(fact => fact.id)).toEqual(['people-signed', 'people-held', 'people-refused', 'people-off']);
    expect(auto[0]!.text).toBe('Autopilot approved 2 claims automatically, totaling $144.00. Each payment is recorded separately and is not assumed to be paid.');
    expect(auto[2]!.text).toBe('The most recent automatic approval recorded these versions. Check rules: policy-rules-v1. Model: claude-haiku-5-5 then claude-sonnet-5-5. Prompt: compliance-v1.1.');
    expect(auto[3]!.text).toBe('1 claim was drawn for the random audit and went to two people.');
    expect(why[0]!.text).toBe(`People signed 1 payout, totaling $${(people.signedCents / 100n).toString()}.${(people.signedCents % 100n).toString().padStart(2, '0')}.`);
    expect(people.signedCents).toBe(7_700n);
    expect(why[1]!.text).toBe('1 claim was held for people after AI checks.'); expect(why[2]!.text).toBe('1 claim was refused by a guardrail and went to two people.');
    expect(why[3]!.text).toBe('The automation switch was turned off 1 time: 0 after an approver disagreed with an automatic payment, 0 after an automatic payment had an unknown outcome, 1 by an approver.');
    const text = JSON.stringify([...auto, ...why]);
    for (const secret of ['maria', 'Maria', 'Tara', 'Ben', RECEIPT_PAYEE, ids.sent!.id, ids.held!.id, 'BATCH_FR', 'AT-']) expect(text, secret).not.toContain(secret);
  });
});

describe('FR-20 access and read-only', () => {
  it('FR-20: a claimant is refused with 403, an unknown actor too, and an approver is served', async () => {
    await expect(loadFunderReport(ctx.db, 'maria')).rejects.toMatchObject({ status: 403 });
    await expect(loadFunderReport(ctx.db, 'nobody')).rejects.toMatchObject({ status: 403 });
    expect((await loadFunderReport(ctx.db, 'ben')).spending.total.total.cents).toBe('38700');
  });
  it('FR-21: a write attempted inside the report transaction is refused by the database, and nothing changed', async () => {
    const error = await dbError(loadFunderReport(ctx.db, 'tara', { probe: tx => tx.update(s.users).set({ displayName: 'Changed inside the report' }).where(eq(s.users.id, 'ben')).then(() => undefined) }));
    expect(error.code, error.message).toBe('25006'); expect(error.message).toMatch(/read-only transaction/);
    expect((await ctx.db.select().from(s.users).where(eq(s.users.id, 'ben')))[0]!.displayName).toBe('Ben');
  });
  it('FR-22: building the report changes no financial or automated record', async () => {
    await loadFunderReport(ctx.db, 'tara'); await loadAnalyticsSnapshot(ctx.db, 'tara');
    expect(await financialHash(ctx.client, FINANCIAL_TABLES)).toBe(hashBefore);
  });
  it('FR-23: with a second organization the report refuses all consolidated data with 503 and names nothing of it', async () => {
    await ctx.db.insert(s.organizations).values({ id: 'other', name: 'Private other organization', prohibitedCategories: [], openingSourceType: 'fixture_opening_balance' });
    const error = await loadFunderReport(ctx.db, 'tara').then(() => null, (reason: unknown) => reason as { status: number; message: string });
    expect(error).toMatchObject({ status: 503 }); expect(error!.message).not.toContain('Private other');
  });
});
