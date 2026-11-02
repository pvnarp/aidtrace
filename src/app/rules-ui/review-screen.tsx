// IAC-440 Package B (docs/plans/AI_DRAFTED_RULES_SCOPE.md section 5, docs/ASSUMPTIONS.md section 72). The review screen of one AI-drafted rule set. Presentation only:
// it takes one stored draft (DraftReview), the viewer's id and an optional notice, and renders them. No hook, no fetch, no model call. Grant text and quotes are
// rendered as plain React text (never as markup). A REFUSED draft renders no drafted value at all, because reviewRows returns none for it.
import { reviewTime } from "../../server/display";
import type { DraftReview } from "../../rules-draft/drafts";
import type { RulesNotice } from "../../server/rules-notices";
import { refusedDraftReason } from "../../server/rules-notices";
import { ruleDraftReviewDisclosure } from "../ai-disclosure";
import { EditForm } from "./edit-form";
import { MAX_APPROVALS, STATE_LABELS, pathLabel } from "./labels";
import { reviewRows, thresholdsBlocked, type ReviewRow } from "./review-rows";

function SourceCell({ row }: { row: ReviewRow }) {
  const source = row.source;
  return <>
    {source.kind === "quote" && <><span className="rules-clause">Clause {source.clauseId}</span><blockquote className="rules-quote">{source.quote}</blockquote></>}
    {source.kind === "edited" && <span>Changed by a person</span>}
    {source.kind === "unsure" && <span>Not settled by the grant</span>}
    {source.kind === "written" && <span>Written by the AI from the clauses</span>}
    {row.unsupported && <p className="rules-unsupported" role="note">The AI proposed a value here, but its quote does not state it, so the value was removed. Fill this field in yourself.</p>}
  </>;
}

function ReviewTable({ review, rows }: { review: DraftReview; rows: ReviewRow[] }) {
  const carried = review.view.analysis?.carried ?? [];
  return <div className="rules-scroll"><table className="rules-table" data-testid="rules-review-table">
    <caption className="vh">Drafted rules compared with the current approved rules</caption>
    <thead><tr><th scope="col">Field</th><th scope="col">Current (version {review.current.version})</th><th scope="col">Draft</th><th scope="col">Source</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.path} data-tone={row.tone} data-path={row.path} data-changed={row.changed ? "true" : "false"}>
      <th scope="row">{row.label}{row.tone === "NEEDED" && <span className="rules-required">Required</span>}</th>
      <td>{row.current}</td>
      <td className="rules-value">{row.draft}{row.changed && <span className="rules-changed">Changed</span>}{row.tone === "CARRIED" && carried.length > 0 && <span className="rules-carried">Carries the current value</span>}</td>
      <td><SourceCell row={row} /></td>
    </tr>)}</tbody>
  </table></div>;
}

function Approvals({ review, viewerId, rows }: { review: DraftReview; viewerId: string; rows: ReviewRow[] }) {
  const { view, approvers } = review;
  const analysis = view.analysis;
  const count = approvers.length;
  const viewerApproved = approvers.some(approval => approval.actorId === viewerId);
  const open = view.state === "OPEN";
  const missing = analysis?.missing ?? [];
  const blocked = thresholdsBlocked(review);
  const canApprove = open && !viewerApproved && missing.length === 0 && !blocked && rows.length > 0;
  const action = `/api/funds/${view.fundId}/rules/drafts/${view.id}`;
  return <section className="rules-section" aria-labelledby="rules-approvals">
    <h2 id="rules-approvals">Approvals: {count} of {MAX_APPROVALS}</h2>
    {count > 0 && <ul className="rules-approvers">{approvers.map(approval => <li key={approval.actorId}>{approval.displayName} approved on <time dateTime={approval.recordedAt.toISOString()}>{reviewTime(approval.recordedAt)}</time>.</li>)}</ul>}
    {count === 0 && open && <p>No one has approved yet. Two different approvers must approve before these rules take effect.</p>}
    {open && analysis?.changesPayOrder === true && <p className="notice warning rules-payorder" role="note" data-testid="rules-payorder-warning">
      <strong>Approving these rules changes the pay order.</strong> Receipts that are frozen but not yet approved twice go back to draft and need both approvals again. Paid claims are untouched.</p>}
    {open && viewerApproved && <p className="notice" role="status" data-testid="rules-second-approver">You approved this draft. A second, different approver must approve it before anything changes.</p>}
    {open && !viewerApproved && missing.length > 0 && <p className="notice warning" role="status" id="rules-missing" data-testid="rules-missing">
      Still needed before approval: {missing.map(pathLabel).join(", ")}. Fill {missing.length === 1 ? "it" : "them"} in with the form below.</p>}
    {open && !viewerApproved && missing.length === 0 && blocked && <p className="notice warning" role="status" id="rules-missing">
      Some review limits are set and some are blank, and this fund has no earlier limits to fill the blanks. Fill in all six review limits, or clear them all, before approving.</p>}
    {open && !viewerApproved && <form className="rules-actions" method="post" action={action}>
      <input type="hidden" name="action" value="approve" />
      <button type="submit" disabled={!canApprove} aria-describedby={canApprove ? undefined : "rules-missing"}>{count === 0 ? "Approve (first of two)" : "Approve (second of two)"}</button>
    </form>}
    {(open || view.state === "STALE") && <form className="rules-actions" method="post" action={action}>
      <input type="hidden" name="action" value="withdraw" />
      <button type="submit" className="secondary">Withdraw this draft</button>
    </form>}
  </section>;
}

export function ReviewScreen({ review, viewerId, notice }: { review: DraftReview; viewerId: string; notice: RulesNotice | null }) {
  const { view, current } = review;
  const rows = reviewRows(review);
  const rulesPath = `/funds/${view.fundId}/rules`;
  return <div className="reference-screen rules-screen">
    <p className="kicker"><a href={rulesPath}>{view.fundName} rules</a></p>
    <h1 className="screen-heading">Review drafted rules</h1>
    <p className="rules-status"><span className="state-badge" data-state={view.state} data-testid="rules-state">{STATE_LABELS[view.state]}</span>{" "}
      <span className="muted">Made by {review.draftedByName} on <time dateTime={view.createdAt.toISOString()}>{reviewTime(view.createdAt)}</time>, from version {view.basePolicyVersion} of the rules.</span></p>
    <p className="rules-disclosure" data-testid="rules-disclosure">{ruleDraftReviewDisclosure(view.model?.model ?? null)}</p>
    {notice && <p className={notice.tone === "warning" ? "notice warning" : "notice"} role="status" data-testid="rules-notice">{notice.text}</p>}

    {view.state === "REFUSED" && <section className="rules-section" aria-labelledby="rules-refused" data-testid="rules-refused">
      <h2 id="rules-refused">The AI answer was refused</h2>
      <p>{refusedDraftReason(view.refusal?.reason)}</p>
      <p>Nothing was approved or changed. Go back to the fund rules page to draft again, or paste a shorter part of the grant.</p>
    </section>}
    {view.state === "STALE" && <p className="notice warning" role="status" data-testid="rules-stale">The fund moved to version {current.version} after this draft was made from version {view.basePolicyVersion}. This draft can no longer be approved or edited. <a href={rulesPath}>Draft again from the current rules.</a></p>}
    {view.state === "WITHDRAWN" && <p className="notice" role="status">This draft was withdrawn. It takes no more approvals. It stays here as a record.</p>}
    {view.state === "BOUND" && <p className="notice" role="status" data-testid="rules-bound">This draft was approved by two different approvers and is in use as version {view.boundPolicyVersion ?? current.version} of the fund&apos;s rules.</p>}

    {rows.length > 0 && <section className="rules-section" aria-labelledby="rules-table-heading">
      <h2 id="rules-table-heading">Drafted values and where they come from</h2>
      {view.changedFields && view.changedFields.length > 0 && <p className="muted">A person changed: {view.changedFields.map(pathLabel).join(", ")}.</p>}
      <p className="muted">The AI cannot tell what a clause means for programs and categories. Check those two rows against the grant text.</p>
      <ReviewTable review={review} rows={rows} />
    </section>}

    {rows.length > 0 && <Approvals review={review} viewerId={viewerId} rows={rows} />}
    {view.state === "OPEN" && <details className="rules-edit-details" open={(view.analysis?.missing.length ?? 0) > 0}>
      <summary>Fill in or change values</summary>
      <EditForm review={review} />
    </details>}

    <details className="rules-source-details">
      <summary>Grant text this draft came from</summary>
      <pre className="rules-source" data-testid="rules-source">{view.inputText}</pre>
    </details>
  </div>;
}
