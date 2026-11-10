import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { findSession, SESSION_COOKIE } from '../../server/auth';
import { getDatabase } from '../../server/db';
import { loadLedgerView, LedgerAccessError } from '../../ledger/view';
import { LedgerClient } from './client';
import { reviewTime } from '../../server/display';
import { AppHeader } from '../app-header';
export const dynamic = 'force-dynamic';
export default async function LedgerPage() {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect('/login');
  if (user.role !== 'APPROVER') return <><AppHeader user={user} /><main className="analytics-page"><h1>Approver access required.</h1><p>This organization-wide ledger view is available to approvers.</p></main></>;
  try {
    const view = await loadLedgerView(getDatabase(), user.id);
    return <><AppHeader user={user} /><main className="analytics-page reference-page ledger-page">
      <div className="reference-screen">
        <p className="kicker">{view.organization}</p>
        <h1 className="screen-heading">Read the ledger, one posting at a time.</h1>
        <p className="reference-intro">A read-only view of every journal posting with its entry, fund, claim, approvals and PayPal reference.</p>
        <p className="snapshot-time">View observed <time dateTime={view.observedAt}>{reviewTime(new Date(view.observedAt))}</time>. <a href="/ledger">Reload view</a></p>
        <LedgerClient view={view} userId={user.id} />
      </div>
      <footer>This view shows local journal facts and does not verify current PayPal available funds.</footer>
    </main></>;
  } catch (error) {
    if (!(error instanceof LedgerAccessError)) throw error;
    return <><AppHeader user={user} /><main className="analytics-page"><h1>Ledger view unavailable.</h1><p>{error.message}. No financial action was requested.</p></main></>;
  }
}
