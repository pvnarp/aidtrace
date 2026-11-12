import { BRAND, TraceMark } from "../../brand";
import { GIFT_METHOD_SENTENCE, type GiftPageData } from "../../../donation/trail";

// IAC-413 PR A: the donor trail as a server component, so the grid page can reuse it.
// It renders only the fields of GiftPageData: formatted gift text, step text, line cards and the optional note. It receives no
// name, email, claim ID, decision hash, order ID or capture ID, so it cannot render one. Every string is escaped by React, and
// nothing here uses dangerouslySetInnerHTML, a client component, a link out or a form.
export function GiftBrand() {
  return <div className="gift-brand"><TraceMark /><strong>{BRAND.name}</strong></div>;
}

export function TrailView({ data }: { data: GiftPageData }) {
  const { trail, note } = data;
  return <main className="gift-page" data-testid="gift-page">
    <GiftBrand />
    <h1>Your gift, step by step.</h1>
    <p className="gift-state" data-testid="gift-state" data-state={trail.state}>{trail.stateSentence}</p>
    <div className="gift-panel" data-testid="gift-panel">
      <p className="gift-amount" data-testid="gift-amount">{trail.gift.amount} to {trail.gift.fundName}</p>
      <p className="gift-received">Received {trail.gift.received}</p>
    </div>
    <ol className="gift-trace" aria-label="Where your gift went" data-testid="gift-trace">
      {trail.steps.map(step => <li key={step.id} className={step.state} data-testid={`gift-step-${step.id}`} aria-current={step.state === "cur" ? "step" : undefined}>
        <span className="t">{step.title}</span><span className="d">{step.detail}</span>
      </li>)}
    </ol>
    {trail.lines.length > 0 ? <ul className="gift-lines" aria-label="Receipt lines your gift was applied to">
      {trail.lines.map((line, index) => <li key={index} className="gift-card" data-testid="gift-line">
        <h2 className="gift-line-title">{line.description}</h2>
        <p className="gift-line-vendor">{line.vendor}</p>
        <p className="gift-line-share">{line.share}</p>
        <p className="gift-line-payout" data-payout={line.payout}>{line.payoutSentence}</p>
      </li>)}
    </ul> : null}
    {trail.waiting ? <div className="gift-waiting" data-testid="gift-waiting">
      <p className="gift-waiting-title">{trail.waiting}</p>
      <p>{GIFT_METHOD_SENTENCE}</p>
    </div> : null}
    {note ? <div className="gift-note" data-testid="gift-note">
      <h2>Your thank-you note</h2>
      <p>{note.sentence}</p>
      <p className="gift-note-caption">A person at {note.organizationName} approved this note.</p>
    </div> : null}
    <footer className="gift-footer" data-testid="gift-footer">
      <p>This page shows no names or contact details. Anyone who has this link can see it.</p>
      {trail.waiting ? null : <p>{GIFT_METHOD_SENTENCE}</p>}
    </footer>
  </main>;
}
