import Link from "next/link";

/**
 * The action footer of the decision area: "Next decision" above one primary action.
 * Presentation only. The caller supplies authorized saved state, never query-string progress.
 * The footer sits directly under the page title because these pages hold live forms and
 * evidence; the primary action must stay reachable without scrolling past them.
 */
export function Journey({ title, detail, href, action, aside, emphasizeDetail = false }: {
  title: string; detail: string; href?: string; action?: string; aside?: string; emphasizeDetail?: boolean;
}) {
  return <aside className="action-footer" aria-label="Expense journey">
    <div className="footer-main"><div className="footer-copy"><p className="kicker">Next decision</p><h2>{title}</h2></div>
      {href && action && <a className="journey-action" href={href}>{action}<span aria-hidden="true"> →</span></a>}
    </div>
    {emphasizeDetail && <p className="journey-critical">{detail}</p>}
    <details className="journey-help"><summary>Step details and roles</summary>{!emphasizeDetail && <p>{detail}</p>}{aside && <p className="muted">{aside}</p>}
      <Link className="journey-explainer" href="/architecture" prefetch={false}>See how the pieces work together</Link>
    </details>
  </aside>;
}
