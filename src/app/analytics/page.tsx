import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { findSession, SESSION_COOKIE } from '../../server/auth';
import { getDatabase } from '../../server/db';
import { loadAnalyticsSnapshot, AnalyticsAccessError } from '../../analytics/snapshot';
import { AnalyticsClient } from './client';
import { reviewTime } from '../../server/display';
import { AppHeader } from '../app-header';
import { AI_OFF_MESSAGES, claudeAiStatus } from '../../ai/provider';
export const dynamic = 'force-dynamic';
export default async function AnalyticsPage() {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect('/login');
  if (user.role !== 'APPROVER') return <><AppHeader user={user} /><main className="analytics-page"><h1>Approver access required.</h1><p>This organization-wide accounting view is available to approvers.</p></main></>;
  try {
    const snapshot = await loadAnalyticsSnapshot(getDatabase(), user.id);
    const ai = claudeAiStatus(process.env, 'AI_ANALYTICS_ENABLED');
    return <><AppHeader user={user} /><main className="analytics-page reference-page">
      <div className="reference-screen">
        <p className="kicker">{snapshot.organization}</p>
        <h1 className="screen-heading">Follow funding and book cash.</h1>
        <p className="reference-intro">A read-only snapshot of fund balances and book cash. This page makes no payment, approval or balance request.</p>
        <p className="snapshot-time">Snapshot observed <time dateTime={snapshot.observedAt}>{reviewTime(new Date(snapshot.observedAt))}</time>. <a href="/analytics">Reload snapshot</a></p>
        <div className="reference-links"><a className="button-link secondary" href="/analytics/report" data-testid="report-link">Open the funder report</a></div>
        <AnalyticsClient snapshot={snapshot} aiOff={ai.on ? null : AI_OFF_MESSAGES[ai.reason]}/>
      </div>
      <footer>Accounting-inspired model, pending nonprofit accountant review. This dashboard uses local journal facts and does not verify current PayPal available funds.</footer>
    </main></>;
  } catch (error) {
    if (!(error instanceof AnalyticsAccessError)) throw error;
    return <><AppHeader user={user} /><main className="analytics-page"><h1>Accounting view unavailable.</h1><p>{error.message}. No financial action was requested.</p></main></>;
  }
}
