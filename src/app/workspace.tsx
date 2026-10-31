import { AppHeader } from "./app-header";
import { PayPalText } from "./brand";
import { Amount } from "./amount";
import type { AiCard, PayPalCard, Stage } from "./shell-copy";
import { TraceStepper, currentTraceStep, traceSteps, type TraceLinks } from "./trace";

export type SummaryData = {
  claimant: string; program: string; amount: string; status: string; statusCode: string; reviews: number | null;
  details: readonly (readonly [string, string])[]; note: string;
};
/** Loaded state behind the two status cards and the trace lines. Built by each page from what it already read. */
export type ShellState = { ai: AiCard; paypal: PayPalCard; typedReceipt: boolean };

export type RailLinks = TraceLinks;

/** The AI review card: its own accent, the boundary note always shown. */
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

/** The Decision panel of the review layout: amount, state, the two status cards, human review count and details. */
export function ExpenseSummary({ data, state, stage, policyBlocked }: { data: SummaryData; state: ShellState; stage: Stage; policyBlocked: boolean }) {
  const now = currentTraceStep(traceSteps({ stage, typedReceipt: state.typedReceipt, ai: state.ai, approvals: data.reviews, paypal: state.paypal, policyBlocked }));
  return <aside className="hybrid-summary panel" aria-label="Current expense summary">
    <div className="hybrid-summary-top"><div><p className="kicker">{data.claimant}&apos;s reimbursement</p><h3>{data.program}</h3></div>
      <strong className="big-amount"><Amount value={data.amount} /></strong><p className="state-badge" data-state={data.statusCode}>{data.status}</p></div>
    <div className="status-cards"><AiStatusCard card={state.ai} /><PayPalStatusCard card={state.paypal} /></div>
    <p className="hybrid-review-count">Human reviews: <strong>{data.reviews === null ? "see the claim" : `${data.reviews} of 2`}</strong></p>
    <details className="hybrid-case-details"><summary>Expense details</summary><dl>{data.details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p className="caption">An expense becomes a payable only after both human approvals.</p></details>
    <div className="hybrid-current"><p className="kicker">Current step</p><strong><PayPalText text={now.name} /></strong><span>{data.note}</span></div>
  </aside>;
}

/**
 * The expense workspace under the shared header. Layout only; the page supplies saved state.
 * "review" (claim page): trace, then the receipt side and the Decision panel in two columns (one column at 900 px and below).
 * "single" (receipt pages): trace, the decision area at full width, then the two status cards in a row.
 */
export function Workspace({ user, stage, summary, state, links, layout = "review", policyBlocked = false, children }: {
  user: { displayName: string; role: string }; stage: Stage; summary: SummaryData; state: ShellState; links?: TraceLinks;
  layout?: "review" | "single"; policyBlocked?: boolean; children: React.ReactNode;
}) {
  return <><AppHeader user={user} />
    <main className="workspace-page" data-layout={layout}>
      <TraceStepper stage={stage} state={state} reviews={summary.reviews} links={links} policyBlocked={policyBlocked} />
      <div className={`hybrid-shell ${layout}`}><div className="hybrid-content">{children}</div>
        {layout === "review"
          ? <ExpenseSummary data={summary} state={state} stage={stage} policyBlocked={policyBlocked} />
          : <div className="status-cards status-row"><AiStatusCard card={state.ai} /><PayPalStatusCard card={state.paypal} /></div>}
      </div>
    </main></>;
}
