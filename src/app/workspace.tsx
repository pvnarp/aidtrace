import { AppHeader } from "./app-header";
import { PayPalText } from "./brand";
import { STAGES, railLines, type AiCard, type PayPalCard, type Stage } from "./shell-copy";

export type SummaryData = {
  claimant: string; program: string; amount: string; status: string; statusCode: string; reviews: number | null;
  details: readonly (readonly [string, string])[]; note: string;
};
/** Loaded state behind the two status cards and the rail lines. Built by each page from what it already read. */
export type ShellState = { ai: AiCard; paypal: PayPalCard; typedReceipt: boolean };

export type RailLinks = Partial<Record<Stage, string>>;

function Check() { return <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M4.5 10.5l3.4 3.4 7.6-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>; }

export function StageRail({ stage, state, reviews, links = {} }: { stage: Stage; state: ShellState; reviews: number | null; links?: RailLinks }) {
  const lines = railLines({ stage, typedReceipt: state.typedReceipt, ai: state.ai, approvals: reviews, paypal: state.paypal });
  return <aside className="hybrid-rail"><p className="kicker">Expense workspace</p>
    <nav aria-label="Expense stages"><ol className="stage-rail">{STAGES.map((name, index) => {
      const number = (index + 1) as Stage; const done = number < stage; const future = number > stage; const href = done ? links[number] : undefined;
      const line = lines[index]!;
      const body = <><span className="hybrid-step-number">{done ? <Check /> : number}</span>{name}{line.tag && <span className={`rail-tag ${line.tag === "AI" ? "ai" : "paypal"}`}>{line.tag}</span>}<small className="rail-state">{line.state}</small></>;
      return <li key={name}>{href
        ? <a className="stage-item" href={href} aria-label={`${name}: inspect completed step. ${line.state}`}>{body}</a>
        : <span className="stage-item" aria-current={number === stage ? "step" : undefined} aria-disabled={future || undefined} aria-label={`${name}${done ? ": completed" : future ? ": locked" : ": current step"}. ${line.state}`}>{body}</span>}</li>;
    })}</ol></nav>
    <p className="hybrid-rail-note">Review one decision at a time.<br />People keep control.</p></aside>;
}

/** The AI review card: teal, the boundary note always shown. */
export function AiStatusCard({ card }: { card: AiCard }) {
  return <section className="status-card ai-card" aria-label="AI review status" data-ai-state={card.key}>
    <p className="card-kicker">AI review</p>
    <p className="card-state">{card.state}</p>
    {card.model && <p className="card-model">{card.model}</p>}
    <p className="card-note">{card.note}</p></section>;
}

/** The PayPal payout card: PayPal blue. It says paid only for a verified paid state (see paypalCard). */
export function PayPalStatusCard({ card }: { card: PayPalCard }) {
  return <section className="status-card paypal-card" aria-label="PayPal payout status" data-paypal-state={card.key}>
    <p className="card-kicker"><PayPalText text="PayPal payout" /></p>
    <p className="card-state">{card.state}</p>
    <p className="card-note">{card.note}</p></section>;
}

export function ExpenseSummary({ data, state, stage }: { data: SummaryData; state: ShellState; stage: Stage }) {
  return <aside className="hybrid-summary" aria-label="Current expense summary">
    <div className="hybrid-summary-top"><div><p className="kicker">{data.claimant}&apos;s reimbursement</p><h3>{data.program}</h3></div>
      <strong className="big-amount">{data.amount}</strong><p className="state-badge" data-state={data.statusCode}>{data.status}</p></div>
    <div className="status-cards"><AiStatusCard card={state.ai} /><PayPalStatusCard card={state.paypal} /></div>
    <p className="hybrid-review-count">Human reviews: <strong>{data.reviews === null ? "see the claim" : `${data.reviews} of 2`}</strong></p>
    <details className="hybrid-case-details"><summary>Expense details</summary><dl>{data.details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p className="caption">An expense becomes a payable only after both human approvals.</p></details>
    <div className="hybrid-current"><p className="kicker">Current step</p><strong>{STAGES[stage - 1]}</strong><span>{data.note}</span></div>
  </aside>;
}

/** Three columns: stage rail, one decision, expense summary. Layout only; the page supplies saved state. */
export function Workspace({ user, stage, summary, state, links, children }: {
  user: { displayName: string; role: string }; stage: Stage; summary: SummaryData; state: ShellState; links?: RailLinks; children: React.ReactNode;
}) {
  return <main className="workspace-page"><div className="product-frame"><AppHeader user={user} />
    <div className="hybrid-shell"><StageRail stage={stage} state={state} reviews={summary.reviews} links={links} /><div className="hybrid-content">{children}</div><ExpenseSummary data={summary} state={state} stage={stage} /></div>
  </div></main>;
}
