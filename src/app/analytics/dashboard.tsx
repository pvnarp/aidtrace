'use client';
import { useEffect, useRef, useState } from 'react';
import { QUESTIONS, questionFacts, usd,type AnalyticsSnapshot, type Question } from '../../analytics/model';
import { snapshotAnswer } from '../../analytics/client-facts';
import { AiWait } from '../ai-wait';
import { fundMeter } from '../fund-meter';

/** The available share of one fund, the same bar and label as the approver home (fund-meter.ts). Presentation only. */
function FundBar({ fund }: { fund: AnalyticsSnapshot["funds"][number] }) {
  const meter = fundMeter(fund);
  return <span className="meter analytics-meter" role="img" aria-label={meter.ariaLabel}><i style={{ width: `${meter.availablePercent}%` }} /></span>;
}
function Funding({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  const [restriction, setRestriction] = useState('ALL');
  const funds = snapshot.funds.filter(fund => restriction === 'ALL' || fund.restriction === restriction);
  return <article className="analytics-widget reference-card" data-testid="funding-widget"><h2>Funding balances</h2><label>Show funds<select value={restriction} onChange={event => setRestriction(event.target.value)}><option value="ALL">All funds</option><option value="RESTRICTED">Restricted</option><option value="UNRESTRICTED">General</option></select></label>
    <ul className="analytics-funds">{funds.map((fund, i) => <li key={i}><div className="fund-head"><h3>{fund.name}</h3><span className="fund-type">{fund.restriction === "RESTRICTED" ? "Restricted" : "General"}</span></div><FundBar fund={fund}/><dl><dt>Book balance</dt><dd>{usd(fund.bookCents)}</dd><dt>Reserved</dt><dd>{usd(fund.reservedCents)}</dd><dt>After reservations</dt><dd>{usd(fund.availableCents)}</dd></dl></li>)}</ul>
    <p role="status">Visible book balance: {usd(funds.reduce((sum, fund) => sum + BigInt(fund.bookCents), 0n))}</p><p>Eligibility still depends on fund policies.</p>
  </article>;
}
function Cash({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  return <article className="analytics-widget reference-note" data-testid="cash-widget"><h2>Book cash bridge</h2><dl className="analytics-cash"><dt>Fixture opening cash</dt><dd>{usd(snapshot.cash.openingCents)}</dd><dt>Recorded activity</dt><dd>{usd(snapshot.cash.providerDeltaCents)}</dd><dt className="bridge-total">Book cash</dt><dd className="bridge-total">{usd(snapshot.cash.bookCents)}</dd><dt>Open payable</dt><dd>{usd(snapshot.cash.payableCents)}</dd></dl>
    <p className={snapshot.fixtureNotStarted || snapshot.matches ? 'notice' : 'notice warning'}>{snapshot.fixtureNotStarted ? 'Opening journals have not been created yet. No ledger tie-out is claimed for this untouched fixture.' : `Ledger tie-out: ${snapshot.matches ? 'Matches' : 'Review required'}.`}</p><p>Source: existing local journals and fund records. Recorded activity is book cash less the fixture opening.</p>
  </article>;
}
export default function AccountingDashboard({ snapshot, aiOff = null }: { snapshot: AnalyticsSnapshot; aiOff?: string | null }) {
  const [answer, setAnswer] = useState(''); const [selection, setSelection] = useState(''); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(''); const [poweredBy, setPoweredBy] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, [snapshot.digest]);
  async function ask(question: Question) {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    const timer = setTimeout(() => controller.abort(), 45000);
    setBusy(true); setNotice(''); setAnswer(''); setSelection(''); setPoweredBy('');
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
      if (active.current === controller && !controller.signal.aborted) { setAnswer(text); setPoweredBy(typeof body.poweredBy === 'string' && body.poweredBy.startsWith('Powered by ') ? body.poweredBy : ''); setSelection(`AI selected ${body.facts.length} of ${questionFacts(snapshot, question).length} verified facts offered for this question.`); }
    } catch {
      if (active.current === controller) setNotice('AI is unavailable or its answer could not be verified. Read the snapshot facts below.');
    } finally {
      clearTimeout(timer);
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  }
  return <>
    <div className="analytics-dashboard"><Funding snapshot={snapshot}/><Cash snapshot={snapshot}/></div>
    <section className="analytics-explain" aria-labelledby="explanation-title"><h2 id="explanation-title">Explain this snapshot</h2><p>AI selects relevant, exact snapshot facts. AidTrace formats every amount and validates every selected quote. AI has no financial tools.</p>
      <div className="analytics-questions">{(Object.keys(QUESTIONS) as Question[]).map(question => <button key={question} className="secondary" disabled={busy || Boolean(aiOff)} onClick={() => ask(question)}>{QUESTIONS[question]}</button>)}</div>
      <p role="status" data-testid="analytics-status">{busy ? 'Checking snapshot facts...' : notice || (answer ? 'Verified snapshot facts selected by AI.' : aiOff ? `${aiOff} Read the snapshot facts below.` : 'Choose a question, or read the facts without AI.')}</p>{busy && <AiWait />}
      <output className="analytics-answer" data-testid="analytics-answer">{answer}</output>{selection && <p data-testid="analytics-selection">{selection}</p>}{poweredBy && <p data-testid="analytics-powered-by">{poweredBy}</p>}
      <details data-testid="snapshot-facts"><summary>Read all snapshot facts without AI</summary><ul>{snapshot.facts.map(fact => <li key={fact.id}><p>{fact.text}</p><small className="fact-source">Source: {fact.source}</small></li>)}</ul></details>
    </section>
  </>;
}
