import Link from "next/link";
import { HandoffButton } from "./handoff-button";
import type { Handoff } from "./thread";

/**
 * The action footer of the decision area: "Next decision" above one primary action.
 * Presentation only. The caller supplies authorized saved state, never query-string progress.
 * The footer sits directly under the page title because these pages hold live forms and
 * evidence; the primary action must stay reachable without scrolling past them.
 * actor (the thread): one muted line saying who acts next, from loaded data. handoff: a secondary sign-out-and-continue button for the
 * two states where the viewer cannot act. An action whose href starts with "#" only scrolls, so it renders as a quiet link (see style.css).
 */
export function Journey({ title, detail, href, action, aside, emphasizeDetail = false, actor, handoff }: {
  title: string; detail: string; href?: string; action?: string; aside?: string; emphasizeDetail?: boolean; actor?: string; handoff?: Handoff;
}) {
  return <aside className="action-footer" aria-label="Expense journey">
    <div className="footer-main"><div className="footer-copy"><p className="kicker">Next decision</p><h2>{title}</h2>{actor && <p className="journey-actor">{actor}</p>}</div>
      {href && action && <a className="journey-action" href={href}>{action}<span aria-hidden="true">{href.startsWith("#") ? " ↓" : " →"}</span></a>}
    </div>
    {(emphasizeDetail || handoff) && <p className={handoff ? "journey-critical calm" : "journey-critical"}>{detail}</p>}
    {handoff && <HandoffButton username={handoff.username} label={handoff.label} />}
    <details className="journey-help"><summary>Step details and roles</summary>{!emphasizeDetail && !handoff && <p>{detail}</p>}{aside && <p className="muted">{aside}</p>}
      <Link className="journey-explainer" href="/architecture" prefetch={false}>See how the pieces work together</Link>
    </details>
  </aside>;
}

/**
 * The closing card of the thread: an approved or paid claim says the trace is done and points an approver to the two places to look next.
 * It is not the Next decision card (no "Expense journey" label), so approved and paid claims still have no Next decision. Links are for approvers only.
 * November 11 eye-flow follow-up: an approved claim that is not paid says "Approved, unpaid", because the PayPal step is still open; only a paid claim says "Trace complete".
 */
export function TraceComplete({ kicker = "Trace complete", title, detail, links }: { kicker?: "Trace complete" | "Approved, unpaid"; title: string; detail?: string; links: readonly { href: string; label: string }[] }) {
  return <aside className="action-footer trace-complete" aria-label={kicker}>
    <div className="footer-copy"><p className="kicker">{kicker}</p><h2>{title}</h2>{detail && <p className="journey-actor">{detail}</p>}</div>
    {links.length > 0 && <p className="trace-complete-links">{links.map(link => <Link key={link.href} className="journey-link" href={link.href} prefetch={false}>{link.label}<span aria-hidden="true"> →</span></Link>)}</p>}
  </aside>;
}
