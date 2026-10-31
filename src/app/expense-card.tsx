import Link from "next/link";
import { statusLabel } from "./home-copy";

export type ExpenseCardData = {
  id: string; vendor: string; program: string; status: string;
  /** Formatted from integer cents the page loaded, or null when no amount was loaded. */
  amount: string | null;
  /** One line: the next step, with the frozen split in front when it was loaded. */
  line: string; href: string; action: string; kicker: string;
};

/** One case card of the locked mock's home screens (IAC-403). Presentation only: every field arrives already loaded. */
export function ExpenseCard({ card }: { card: ExpenseCardData }) {
  const titleId = `case-${card.id}`;
  return <article className="reference-case" aria-labelledby={titleId} data-claim={card.id} data-status={card.status}>
    <p className="kicker">{card.kicker}</p>
    <div className="case-head"><h2 id={titleId}>{card.vendor}</h2>{card.amount && <strong className="case-amount">{card.amount}</strong>}</div>
    <p className="case-meta"><span className="case-status" data-state={card.status}>{statusLabel(card.status)}</span><span>{card.program}</span><span>Claim {card.id}</span></p>
    <p>{card.line}</p>
    <Link className="button-link" href={card.href} prefetch={false}>{card.action}</Link>
  </article>;
}
