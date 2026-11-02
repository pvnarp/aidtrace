import Link from "next/link";
import { Amount } from "./amount";
import { statusLabel } from "./home-copy";
import { shortClaimRef } from "./claim-ref";

export type ExpenseCardData = {
  id: string; vendor: string; program: string; status: string;
  /** Formatted from integer cents the page loaded, or null when no amount was loaded. */
  amount: string | null;
  /** One line: the next step, with the frozen split in front when it was loaded. */
  line: string; href: string; action: string; kicker: string;
};

/**
 * One expense row of the home screens (IAC-403, restyled for Trust v2 in IAC-415): a panel with the facts on the left and the
 * amount and the one action on the right. Presentation only: every field arrives already loaded. The status reads as a dot and its words.
 */
export function ExpenseCard({ card }: { card: ExpenseCardData }) {
  const titleId = `case-${card.id}`;
  return <article className="reference-case panel" aria-labelledby={titleId} data-claim={card.id} data-status={card.status}>
    <div className="case-main">
      <p className="kicker">{card.kicker}</p>
      <h2 id={titleId}>{card.vendor}</h2>
      <p className="case-meta"><span className="case-status" data-state={card.status}>{statusLabel(card.status)}</span><span>{card.program}</span><span>Claim {shortClaimRef(card.id)}</span></p>
      <p className="case-line">{card.line}</p>
    </div>
    <div className="case-side">
      {card.amount && <strong className="case-amount"><Amount value={card.amount} /></strong>}
      <Link className="button-link" href={card.href} prefetch={false}>{card.action}</Link>
    </div>
  </article>;
}
