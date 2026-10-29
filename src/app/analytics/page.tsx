import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { findSession, SESSION_COOKIE } from '../../server/auth';
import { getDatabase } from '../../server/db';
import { loadAnalyticsSnapshot, AnalyticsAccessError } from '../../analytics/snapshot';
import { AnalyticsClient } from './client';
import { reviewTime } from '../../server/display';
export const dynamic = 'force-dynamic';
export default async function AnalyticsPage() {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect('/login');
  if (user.role !== 'APPROVER') return <main><Link href="/">AidTrace</Link><h1>Approver access required.</h1><p>This organization-wide accounting view is available to approvers.</p></main>;
  try {
    const snapshot = await loadAnalyticsSnapshot(getDatabase(), user.id);
    return <main className="analytics-page"><header className="page-header"><Link href="/">AidTrace</Link><span>{user.displayName} · Approver</span><form action="/api/auth/logout" method="post"><button className="secondary">Sign out</button></form></header>
      <p className="eyebrow">{snapshot.organization} / {snapshot.fixture ? 'Sandbox fixture' : 'Sandbox accounting'}</p>
      <h1>Follow the funding and the cash.</h1>
      <p>Read-only local accounting. No payment, approval or balance request is made by this dashboard.</p>
      <p className="snapshot-time">Snapshot observed <time dateTime={snapshot.observedAt}>{reviewTime(new Date(snapshot.observedAt))}</time>. <a href="/analytics">Reload snapshot</a></p>
      <AnalyticsClient snapshot={snapshot}/>
      <footer>Accounting-inspired sandbox model, pending nonprofit accountant review. This dashboard uses local journal facts and does not verify current PayPal available funds.</footer>
    </main>;
  } catch (error) {
    if (!(error instanceof AnalyticsAccessError)) throw error;
    return <main><Link href="/">AidTrace</Link><h1>Accounting view unavailable.</h1><p>{error.message}. No financial action was requested.</p></main>;
  }
}
