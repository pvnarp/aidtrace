import Link from "next/link";
import { AppHeader } from "./app-header";
import { PayPalText } from "./brand";
import { Amount } from "./amount";
import type { AiCard, PayPalCard, Stage } from "./shell-copy";
import { TraceStepper, type TraceLinks } from "./trace";
import { shortClaimRef } from "./claim-ref";

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

/**
 * The claim header band (Trust v2, IAC-415): crumb, an optional page kicker, the h1 the page supplies, the state and who it is for, and the
 * claim total at the right. Every fact comes from the SummaryData the page already built. The state badge is the page's only one.
 * Say it once (IAC-415 polish): the state lives in the title and the badge. The payout note is not repeated here; the Decision panel owns it.
 */
export function ClaimHeader({ claimId, kicker, heading, data }: { claimId: string; kicker?: React.ReactNode; heading: string; data: SummaryData }) {
  return <header className="rh">
    <div className="rh-main">
      <p className="crumb"><Link href="/" prefetch={false}>Expenses</Link> / {shortClaimRef(claimId)}</p>
      {kicker}
      <h1>{heading}</h1>
      <p className="meta"><span className="state-badge" data-state={data.statusCode}>{data.status}</span><span>{data.claimant}&apos;s reimbursement, {data.program}.</span></p>
    </div>
    <div className="tot"><p className="lbl">Claim total</p><p className="big-amount"><Amount value={data.amount} /></p></div>
  </header>;
}

/**
 * The Decision panel of the review layout. The page supplies its sections as slots: Fund split, Approvals, Payout, then the action
 * forms. The details disclosure keeps the earlier summary facts. Layout only: nothing here approves, freezes or pays.
 */
export function DecisionPanel({ data, split, approvals, payout, actions, more }: {
  data: SummaryData; split?: React.ReactNode; approvals?: React.ReactNode; payout?: React.ReactNode; actions?: React.ReactNode; more?: React.ReactNode;
}) {
  return <aside className="hybrid-summary panel dec" aria-labelledby="decision-title">
    <h2 id="decision-title">Decision</h2>
    {split}
    {approvals}
    {payout}
    {actions && <div className="actions">{actions}</div>}
    <details className="hybrid-case-details"><summary>Expense details</summary><dl>{data.details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p className="caption">An expense becomes a payable only after both human approvals.</p></details>
    {more}
  </aside>;
}

/**
 * The expense workspace under the shared header. Layout only; the page supplies saved state.
 * "review" (claim page): header band, trace, then the receipt side and the Decision panel in two columns (one column at 900 px and below).
 * "single" (receipt pages): trace, the decision area at full width, then the two status cards in a row.
 * decisionFirst (keyless approved claim only): on one column (900 px and below) the Decision panel, which holds the unpaid handoff, moves above the receipt side.
 * statusCards (single layout only, default true): the receipt page passes false because its trace and its own sections already state the AI and PayPal facts (IAC-415 PR 4).
 */
export function Workspace({ user, stage, summary, state, links, layout = "review", policyBlocked = false, decisionFirst = false, statusCards = true, header, decision, children }: {
  user: { displayName: string; role: string }; stage: Stage; summary: SummaryData; state: ShellState; links?: TraceLinks;
  layout?: "review" | "single"; policyBlocked?: boolean; decisionFirst?: boolean; statusCards?: boolean; header?: React.ReactNode; decision?: React.ReactNode; children: React.ReactNode;
}) {
  return <><AppHeader user={user} />
    <main className="workspace-page" data-layout={layout}>
      {header}
      <TraceStepper stage={stage} state={state} reviews={summary.reviews} links={links} policyBlocked={policyBlocked} />
      <div className={`hybrid-shell ${layout}`} data-decision-first={decisionFirst ? "true" : undefined}><div className="hybrid-content">{children}</div>
        {layout === "review"
          ? decision ?? <DecisionPanel data={summary} />
          : statusCards ? <div className="status-cards status-row"><AiStatusCard card={state.ai} /><PayPalStatusCard card={state.paypal} /></div> : null}
      </div>
    </main></>;
}
