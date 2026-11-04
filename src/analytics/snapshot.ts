import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { AppDatabase } from '../server/db';
import { reconcile } from '../ledger/reconcile';
import { fixtureNotStarted } from '../server/fixture-state';
import { usd, type AnalyticsSnapshot, type Fact } from './model';
import { whyFacts } from './why-facts';
import { loadWhyRows } from './why-rows';
export class AnalyticsAccessError extends Error {
  constructor(public readonly status: 403 | 503) { super(status === 403 ? 'Approver access required' : 'Single-organization accounting required'); }
}
export async function loadAnalyticsSnapshot(db: AppDatabase, actorId: string): Promise<AnalyticsSnapshot> {
  return db.transaction(async tx => {
    await tx.execute(sql`set transaction read only`);
    const [actor] = await tx.select({ organizationId: s.users.organizationId, role: s.users.role }).from(s.users).where(eq(s.users.id, actorId));
    if (!actor || actor.role !== 'APPROVER') throw new AnalyticsAccessError(403);
    // v0.2.1 journals have no organization key. Refuse an aggregate if that invariant changes.
    const organizations = await tx.select({ id: s.organizations.id, name: s.organizations.name, isFixture: s.organizations.isFixture }).from(s.organizations);
    if (organizations.length !== 1 || organizations[0]!.id !== actor.organizationId) throw new AnalyticsAccessError(503);
    const organization = organizations[0]!;
    const names = await tx.select({ id: s.funds.id, name: s.funds.name }).from(s.funds).where(eq(s.funds.organizationId, actor.organizationId));
    const report = await reconcile(tx, actor.organizationId);
    const notStarted = await fixtureNotStarted(tx, actor.organizationId);
    const why = whyFacts(await loadWhyRows(tx, actor.organizationId));
    const reserved = report.fundBalances.reduce((sum, fund) => sum + fund.reservedCents, 0n);
    const available = report.fundBalances.reduce((sum, fund) => sum + fund.availableCents, 0n);
    const facts: Fact[] = [
      { id: 'restricted', text: `Restricted fund book balance is ${usd(report.restrictedCents)}.`, source: 'Fund credits less debits, restricted funds' },
      { id: 'general', text: `General fund book balance is ${usd(report.generalCents)}.`, source: 'Fund credits less debits, unrestricted funds' },
      { id: 'reserved', text: `Active fund reservations total ${usd(reserved)}.`, source: 'Active fund reservations' },
      { id: 'availability', text: `Book balances less active reservations total ${usd(available)}. Fund policies still determine eligibility.`, source: 'Fund balances and active reservations' },
      { id: 'cash', text: `Book cash is ${usd(report.bookCashCents)}.`, source: 'Journal account 1010 debit balance' },
      { id: 'opening', text: `Fixture opening cash is ${usd(report.fixtureCashCents)}.`, source: 'Fixture opening journal entries in account 1010' },
      { id: 'activity', text: `Recorded cash activity beyond the fixture opening is ${usd(report.providerActivityCashDeltaCents)}.`, source: 'Account 1010 less fixture opening cash; local records only' },
      { id: 'payable', text: `Open reimbursement payable is ${usd(report.openPayableCents)}.`, source: 'Journal account 2010 credit balance' },
      { id: 'tie-out', text: notStarted ? 'Opening journals have not been created yet. No ledger tie-out is claimed for this untouched fixture.' : report.matches ? 'Fund balances match the corresponding ledger balances.' : 'Fund balances do not match the corresponding ledger balances. Review is required.', source: 'Existing ledger reconciliation and explicit fixture initialization check' },
      { id: 'cash-limit', text: 'These are local accounting records, not a current PayPal available balance. No provider request was made.', source: 'Snapshot boundary' },
      ...why,
    ];
    const content = {
      source: 'LOCAL_APPLICATION_DATABASE' as const, organization: organization.name, fixture: organization.isFixture, matches: report.matches, fixtureNotStarted: notStarted,
      funds: report.fundBalances.map(fund => ({ name: names.find(row => row.id === fund.fundId)!.name, restriction: fund.fundClass, bookCents: fund.bookCents.toString(), reservedCents: fund.reservedCents.toString(), availableCents: fund.availableCents.toString() })).sort((a, b) => a.name.localeCompare(b.name)),
      cash: { openingCents: report.fixtureCashCents.toString(), providerDeltaCents: report.providerActivityCashDeltaCents.toString(), bookCents: report.bookCashCents.toString(), payableCents: report.openPayableCents.toString() }, facts,
    };
    return { ...content, digest: createHash('sha256').update(JSON.stringify(content)).digest('hex'), observedAt: new Date().toISOString() };
  }, { isolationLevel: 'repeatable read' });
}
