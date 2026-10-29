import Link from "next/link";

export type JourneyStage = 1 | 2 | 3 | 4 | 5;
const stages = ["Enter receipt", "Check categories", "Check funding", "Two approvals", "Payment"];

/** Presentation only. The caller supplies authorized saved state, never query-string progress. */
export function Journey({ stage, title, detail, href, action, aside }: {
  stage: JourneyStage; title: string; detail: string; href?: string; action?: string; aside?: string;
}) {
  return <aside className="journey" aria-label="Expense journey">
    <ol aria-label="Expense stages">{stages.map((label, index) => <li key={label} aria-current={index + 1 === stage ? "step" : undefined} className={index + 1 === stage ? "current" : ""}><span>{index + 1}</span>{label}</li>)}</ol>
    <div className="journey-next"><div><p className="eyebrow">Step {stage} of 5 / Your next step</p><h2>{title}</h2><p>{detail}</p>{aside && <p className="muted">{aside}</p>}</div>
      {href && action && <a className="button-link" href={href}>{action}</a>}
    </div>
    <Link className="journey-explainer" href="/architecture" prefetch={false}>See how the pieces work together</Link>
  </aside>;
}
