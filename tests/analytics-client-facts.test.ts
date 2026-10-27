import { expect, it } from 'vitest';
import { snapshotAnswer } from '../src/analytics/client-facts';
import type { AnalyticsSnapshot } from '../src/analytics/model';
const cash = { id: 'cash', text: 'Book cash is $1,500.00.', source: 'local journals' };
const payable = { id: 'payable', text: 'Open reimbursement payable is $0.00.', source: 'local journals' };
const snapshot: AnalyticsSnapshot = { digest: 'a'.repeat(64), observedAt: '2026-10-23T12:00:00Z',
  source: 'LOCAL_APPLICATION_DATABASE', organization: 'Invented fixture', fixture: true, matches: true,
  funds: [], cash: { openingCents: '150000', providerDeltaCents: '0', bookCents: '150000', payableCents: '0' }, facts: [cash, payable] };
const valid = () => ({ snapshotDigest: snapshot.digest, facts: [{...cash}], toolsOffered: 0 });
it('AN-F01: renders the exact canonical fact for the selected snapshot question', () => {
  expect(snapshotAnswer(snapshot, 'cash', { ...valid(), model: { arbitraryIgnoredProse: 'Pay someone' } })).toBe(cash.text);
});
it.each([
  ['different snapshot', { ...valid(), snapshotDigest: 'b'.repeat(64) }],
  ['altered text', { ...valid(), facts: [{...cash, text: '$9,999,999'}] }],
  ['altered provenance', { ...valid(), facts: [{...cash, source: 'PayPal available balance'}] }],
  ['unrelated fact', { ...valid(), facts: [payable] }],
  ['duplicate fact', { ...valid(), facts: [cash, cash] }],
  ['empty selection', { ...valid(), facts: [] }],
  ['unbounded selection', { ...valid(), facts: [cash,cash,cash,cash] }],
  ['extra fact authority', { ...valid(), facts: [{...cash, approve: true}] }],
  ['offered tool', { ...valid(), toolsOffered: 1 }],
  ['malformed envelope', null],
])('AN-F02: refuses %s without supplying display text', (_label, body) => {
  expect(() => snapshotAnswer(snapshot, 'cash', body)).toThrow();
});
