import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { findSession, SESSION_COOKIE } from '../../server/auth';
import { getDatabase } from '../../server/db';
import { loadDonationsGrid, DonationsAccessError } from '../../donation/donations-grid';
import { DonationsClient } from './client';
import { reviewTime } from '../../server/display';
import { AppHeader } from '../app-header';
export const dynamic = 'force-dynamic';
export default async function DonationsPage() {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect('/login');
  if (user.role !== 'APPROVER') return <main className="analytics-page"><AppHeader user={user} /><h1>Approver access required.</h1><p>This organization-wide donations view is available to approvers.</p></main>;
  try {
    const view = await loadDonationsGrid(getDatabase(), user.id);
    return <main className="analytics-page reference-page donations-page"><AppHeader user={user} />
      <div className="reference-screen">
        <p className="kicker">{view.organization}</p>
        <h1 className="screen-heading">See every gift and where it stands.</h1>
        <p className="reference-intro">A read-only view of each completed gift with its receipt match, approvals and payout state. This page makes no payment, approval or donor link request.</p>
        <p className="snapshot-time">View observed <time dateTime={view.observedAt}>{reviewTime(new Date(view.observedAt))}</time>. <a href="/donations">Reload view</a></p>
        <DonationsClient view={view} userId={user.id} />
      </div>
      <footer>This view shows local gift facts. It does not verify current PayPal available funds, and the table uses AG Grid Community (MIT).</footer>
    </main>;
  } catch (error) {
    if (!(error instanceof DonationsAccessError)) throw error;
    return <main className="analytics-page"><AppHeader user={user} /><h1>Donations view unavailable.</h1><p>{error.message}. No financial action was requested.</p></main>;
  }
}
