'use client';
import { useEffect, useRef, useState } from 'react';
import { QUESTIONS, questionFacts, usd,type AnalyticsSnapshot, type Question } from '../../analytics/model';
import { snapshotAnswer } from '../../analytics/client-facts';

function Funding({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  const [restriction, setRestriction] = useState('ALL');
  const funds = snapshot.funds.filter(fund => restriction === 'ALL' || fund.restriction === restriction);
  return <article className="analytics-widget" data-testid="funding-widget"><h2>Funding balances</h2><label>Show funds<select value={restriction} onChange={event => setRestriction(event.target.value)}><option value="ALL">All funds</option><option value="RESTRICTED">Restricted</option><option value="UNRESTRICTED">General</option></select></label>
    <ul className="analytics-funds">{funds.map((fund, i) => <li key={i}><h3>{fund.name}</h3><dl><dt>Book balance</dt><dd>{usd(fund.bookCents)}</dd><dt>Reserved</dt><dd>{usd(fund.reservedCents)}</dd><dt>After reservations</dt><dd>{usd(fund.availableCents)}</dd></dl></li>)}</ul>
    <p role="status">Visible book balance: {usd(funds.reduce((sum, fund) => sum + BigInt(fund.bookCents), 0n))}</p><p>Eligibility still depends on fund policies. These balances are not PayPal available cash.</p>
  </article>;
}
function Cash({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  return <article className="analytics-widget" data-testid="cash-widget"><h2>Book cash bridge</h2><dl className="analytics-cash"><dt>Fixture opening cash</dt><dd>{usd(snapshot.cash.openingCents)}</dd><dt>Recorded activity</dt><dd>{usd(snapshot.cash.providerDeltaCents)}</dd><dt>Book cash</dt><dd>{usd(snapshot.cash.bookCents)}</dd><dt>Open payable</dt><dd>{usd(snapshot.cash.payableCents)}</dd></dl>
    <p className={snapshot.fixtureNotStarted || snapshot.matches ? 'notice' : 'notice warning'}>{snapshot.fixtureNotStarted ? 'Opening journals have not been created yet. No ledger tie-out is claimed for this untouched fixture.' : `Ledger tie-out: ${snapshot.matches ? 'Matches' : 'Review required'}.`}</p><p>Source: existing local journals and fund records. Recorded activity is book cash less the fixture opening.</p><p>No current PayPal balance was fetched. This view does not independently verify provider records.</p>
  </article>;
}
export default function AccountingDashboard({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  const [answer, setAnswer] = useState(''); const [selection, setSelection] = useState(''); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, [snapshot.digest]);
  async function ask(question: Question) {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    const timer = setTimeout(() => controller.abort(), 45000);
    setBusy(true); setNotice(''); setAnswer(''); setSelection('');
    try {
      const response = await fetch('/api/analytics/explain', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, snapshotDigest: snapshot.digest }), signal: controller.signal });
      if (!response.ok) {
        if (active.current === controller) setNotice(response.status === 409 ? 'Snapshot changed. Reload the dashboard before asking again.' : 'AI is unavailable or its answer could not be verified. Read the snapshot facts below.');
        return;
      }
      const body = await response.json();
      const text = snapshotAnswer(snapshot, question, body);
      // snapshotAnswer has validated body.facts; the offered count is the fixed set for this question.
      if (active.current === controller && !controller.signal.aborted) { setAnswer(text); setSelection(`AI selected ${body.facts.length} of ${questionFacts(snapshot, question).length} verified facts offered for this question.`); }
    } catch {
      if (active.current === controller) setNotice('AI is unavailable or its answer could not be verified. Read the snapshot facts below.');
    } finally {
      clearTimeout(timer);
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  }
  return <>
    <div className="analytics-dashboard"><Funding snapshot={snapshot}/><Cash snapshot={snapshot}/></div>
    <section aria-labelledby="explanation-title"><h2 id="explanation-title">Explain this snapshot</h2><p>AI selects relevant, exact snapshot facts. AidTrace formats every amount and validates every selected quote. AI has no financial tools.</p>
      <div className="analytics-questions">{(Object.keys(QUESTIONS) as Question[]).map(question => <button key={question} disabled={busy} onClick={() => ask(question)}>{QUESTIONS[question]}</button>)}</div>
      <p role="status" data-testid="analytics-status">{busy ? 'Checking snapshot facts...' : notice || (answer ? 'Verified snapshot facts selected by AI.' : 'Choose a question, or read the facts without AI.')}</p>
      <output className="analytics-answer" data-testid="analytics-answer">{answer}</output>{selection && <p data-testid="analytics-selection">{selection}</p>}
      <details data-testid="snapshot-facts"><summary>Read all snapshot facts without AI</summary><ul>{snapshot.facts.map(fact => <li key={fact.id}><p>{fact.text}</p><small>Source: {fact.source}</small></li>)}</ul></details>
    </section>
  </>;
}
