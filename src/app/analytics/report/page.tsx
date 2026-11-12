import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { findSession, SESSION_COOKIE } from '../../../server/auth';
import { getDatabase } from '../../../server/db';
import { loadFunderReport, PATH_KEYS, PATH_LABELS, type Cell } from '../../../analytics/report';
import { AnalyticsAccessError } from '../../../analytics/snapshot';
import { usd } from '../../../analytics/model';
import { reviewTime } from '../../../server/display';
import { AppHeader } from '../../app-header';
import { shortClaimRef } from '../../claim-ref';

// IAC-405 step 5. A read-only page for approvers. It has no form, no server action and no mutation route: it reads the
// report data and prints it. A funder gets a printout from the browser's print command (print styles in style.css). No PDF, no email, no export.
export const dynamic = 'force-dynamic';
export const BOUNDARY_LINES = [
  'The AI model can hold a claim but never approves or pays one on its own.',
  'An automatic payment needed every rule to pass and zero compliance flags, under the fund cap.',
  'Sampled and refused claims went to two people.',
  'These are local records, not a PayPal balance.',
] as const;
const count = (cell: Cell) => `${cell.claims} ${cell.claims === 1 ? 'claim' : 'claims'}`;
const amount = (cell: Cell) => usd(cell.cents);
const stored = (value: string | null) => value ?? 'not recorded';

export default async function FunderReportPage() {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect('/login');
  if (user.role !== 'APPROVER') return <><AppHeader user={user} /><main className="analytics-page"><h1>Approver access required.</h1><p>This organization-wide accounting view is available to approvers.</p></main></>;
  try {
    const report = await loadFunderReport(getDatabase(), user.id);
    const { spending } = report;
    return <><AppHeader user={user} /><main className="analytics-page reference-page report-page">
      <div className="reference-screen">
        <p className="kicker">{report.organization}</p>
        <h1 className="screen-heading">Funder report.</h1>
        <p className="reference-intro">How claims were decided, and what automation did. A read-only record of this organization. This page makes no payment, approval or balance request.</p>
        <p className="snapshot-time">Observed <time dateTime={report.observedAt}>{reviewTime(new Date(report.observedAt))}</time>. <span className="report-copy-hint">To keep a copy, use your browser's print command.</span></p>
        <p className="report-back"><a href="/analytics">Back to funding and book cash</a></p>

        <section className="panel report-section" aria-labelledby="report-spending" data-testid="report-spending">
          <h2 id="report-spending">Spending by decision path</h2>
          <p className="muted">Recognized spending by fund. Each claim sits in the column for what was recorded when it was decided, not the fund's mode today.</p>
          {spending.rows.length === 0 ? <p data-testid="report-spending-empty">No claim has been recognized yet.</p> : <div className="rules-scroll"><table className="rules-table report-table" data-testid="report-spending-table">
            <caption className="vh">Recognized spending by fund and decision path</caption>
            <thead><tr><th scope="col">Fund</th>{PATH_KEYS.map(key => <th scope="col" key={key}>{PATH_LABELS[key]}</th>)}<th scope="col">Total</th></tr></thead>
            <tbody>{spending.rows.map(row => <tr key={row.fund}><th scope="row">{row.fund}</th>
              {PATH_KEYS.map(key => <td key={key}><span className="report-amount">{amount(row.cells[key])}</span> <span className="muted">{count(row.cells[key])}</span></td>)}
              <td><span className="report-amount">{amount(row.total)}</span> <span className="muted">{count(row.total)}</span></td></tr>)}</tbody>
            <tfoot><tr data-testid="report-total-row"><th scope="row">All funds</th>
              {PATH_KEYS.map(key => <td key={key}><span className="report-amount">{amount(spending.total.cells[key])}</span> <span className="muted">{count(spending.total.cells[key])}</span></td>)}
              <td><span className="report-amount">{amount(spending.total.total)}</span> <span className="muted">{count(spending.total.total)}</span></td></tr></tfoot>
          </table></div>}
          <p className="muted">A claim paid from two funds counts once in each fund row and once in the total row.</p>
          {spending.unclassified.claims > 0 && <p className="notice warning" role="alert" data-testid="report-unclassified">Error: {count(spending.unclassified)} totaling {amount(spending.unclassified)} were recognized with neither an automatic record nor a human approval. They are not placed in any column. Review is required.</p>}
          <p className={spending.tieOut.matches ? 'notice' : 'notice warning'} data-testid="report-tie-out">{spending.tieOut.matches
            ? `Tie-out: the columns total ${usd(spending.tieOut.columnCents)}, which matches the fund debits of the same claims, ${usd(spending.tieOut.debitCents)}.`
            : `Tie-out: the columns total ${usd(spending.tieOut.columnCents)} but the fund debits of the same claims total ${usd(spending.tieOut.debitCents)}. They do not match. Review is required.`}</p>
        </section>

        <section className="panel report-section" aria-labelledby="report-accountability" data-testid="report-accountability">
          <h2 id="report-accountability">Automation accountability</h2>
          <p className="muted">Every claim that an automated check recorded on, newest first. Versions are shown as stored.</p>
          {report.accountability.length === 0 ? <p data-testid="report-accountability-empty">No automated record yet.</p> : <div className="rules-scroll"><table className="rules-table report-table" data-testid="report-accountability-table">
            <caption className="vh">Claims with an automated record, newest first</caption>
            <thead><tr><th scope="col">Claim</th><th scope="col">Outcome</th><th scope="col">Amount</th><th scope="col">Check rules</th><th scope="col">Model</th><th scope="col">Prompt</th><th scope="col">Recorded</th></tr></thead>
            <tbody>{report.accountability.map(row => <tr key={row.claimId + row.recordedAt} data-outcome={row.outcomeKey}>
              <th scope="row"><a href={`/claims/${encodeURIComponent(row.claimId)}${row.hasTrail ? '#autopilot' : ''}`} title={row.claimId} aria-label={`Claim ${row.claimId}`}>{shortClaimRef(row.claimId)}</a></th>
              <td>{row.outcome}</td><td><span className="report-amount">{usd(row.amountCents)}</span></td>
              <td>{stored(row.ruleSetVersion)}</td><td>{stored(row.model)}</td><td>{stored(row.promptVersion)}</td>
              <td><time dateTime={row.recordedAt}>{reviewTime(new Date(row.recordedAt))}</time></td></tr>)}</tbody>
          </table></div>}
        </section>

        <section className="panel report-section" aria-labelledby="report-switch" data-testid="report-switch">
          <h2 id="report-switch">Kill switch log</h2>
          <p className="muted">Each change of the automation switch. Automation is off until two different approvers turn it on.</p>
          {report.switchLog.length === 0 ? <p data-testid="report-switch-empty">The switch has never been turned on. Automation is off.</p> : <div className="rules-scroll"><table className="rules-table report-table" data-testid="report-switch-table">
            <caption className="vh">Automation switch events, newest first</caption>
            <thead><tr><th scope="col">When</th><th scope="col">Event</th><th scope="col">Reason</th><th scope="col">Approver</th></tr></thead>
            <tbody>{report.switchLog.map((row, index) => <tr key={index}><th scope="row"><time dateTime={row.recordedAt}>{reviewTime(new Date(row.recordedAt))}</time></th>
              <td>{row.event}</td><td>{row.reason}</td><td>{row.approver ?? 'No approver acted'}</td></tr>)}</tbody>
          </table></div>}
        </section>

        <section className="reference-note report-boundary" aria-labelledby="report-boundary" data-testid="report-boundary">
          <h2 id="report-boundary">What automation can and cannot do</h2>
          <ul>{BOUNDARY_LINES.map(line => <li key={line}>{line}</li>)}</ul>
        </section>
      </div>
      <footer>This report uses local records and does not verify current PayPal available funds.</footer>
    </main></>;
  } catch (error) {
    if (!(error instanceof AnalyticsAccessError)) throw error;
    return <><AppHeader user={user} /><main className="analytics-page"><h1>Accounting view unavailable.</h1><p>{error.message}. No financial action was requested.</p></main></>;
  }
}
