"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProposalPanel } from "../../proposal/presentation";
import { CategoryChoice } from "./category-choice";
const names: Record<string, string> = { science_kits: "Science kits", notebooks: "Notebooks", hospitality: "Food and refreshments", alcohol: "Alcohol: prohibited" };
export function ProposalReview({ id, reviewId, draftHash, suggestionHash, suggestionId, runHash, panel, lines, editable, receiptRunning, editForm }: {
  id: string; reviewId: string; draftHash: string; suggestionHash: string; suggestionId: string | null; runHash: string; panel: ProposalPanel;
  lines: { id: string; description: string; amount: string; proposal: { category: string; quote: string } | null }[];
  editable: boolean; receiptRunning: boolean; editForm: ReactNode;
}) {
  const submitted = useRef(false); const [pending, setPending] = useState(false); const [dirty, setDirty] = useState(false); const [message, setMessage] = useState("");
  const [editDirty, setEditDirty] = useState(false); const [interactive, setInteractive] = useState(false);
  const [reviewChanged, setReviewChanged] = useState(false);
  useEffect(() => { setInteractive(true); }, []);
  const running = pending || panel.state === "RUNNING" || receiptRunning;
  const receiptUrl = `/claims/${id}/receipt`;
  async function prepare(form: HTMLFormElement) {
    if (submitted.current || running || dirty || editDirty) return;
    submitted.current = true; setPending(true); setMessage("");
    try {
      const body = new URLSearchParams();
      for (const [key, value] of new FormData(form)) { if (typeof value !== "string") throw new Error("Text form required"); body.append(key, value); }
      const response = await fetch(`/api/receipts/${id}/proposal`, { method: "POST", body, credentials: "same-origin", redirect: "error" });
      if (response.status === 200 || response.status === 202) {
        const result = await response.json();
        if (!result || typeof result.runHash !== "string" || !result.run || !["RUNNING", "READY_FOR_REVIEW", "NEEDS_REVIEW", "POLICY_BLOCKED", "UNAVAILABLE", "STALE"].includes(result.run.state)) throw new Error("Unknown preparation result");
        window.location.assign(receiptUrl + "?notice=proposal-updated"); return;
      }
      setMessage(response.status === 401 ? "Your session expired. Sign in again before preparing." : response.status === 409 ? "This review changed before preparation finished. Reload the saved receipt and review it again." : "Preparation could not be confirmed. Reload the saved receipt before trying again.");
    } catch { setMessage("Preparation could not be confirmed. Reload the saved receipt before trying again. Your saved draft is still available."); }
    submitted.current = false; setPending(false);
  }
  return <>
    <section className="proposal-panel" aria-labelledby="proposal-heading" data-state={panel.state ?? "NOT_STARTED"} aria-busy={running}>
      <p className="eyebrow">Expense preparation</p><h2 id="proposal-heading">{pending ? "Preparation in progress" : message ? "Reload the saved review" : reviewChanged || editDirty ? "Review changes before continuing" : panel.heading}</h2>
      <p role="status">{pending ? "Preparing category suggestions, then checking funding rules. This can take about a minute. Submit once; manual review stays available after this request finishes." : message || reviewChanged || editDirty ? "The earlier preview is hidden until your current saved review is checked again." : panel.message}</p>
      {!pending && !message && !reviewChanged && !editDirty && panel.steps.length > 0 && <ol className="proposal-steps" aria-label="Preparation steps">{panel.steps.map(step => <li key={step}>{step}</li>)}</ol>}
      {!pending && !message && !reviewChanged && !editDirty && panel.split && <p className="proposal-split"><strong>{panel.split}</strong></p>}
      {!pending && !message && !reviewChanged && !editDirty && panel.edges.length > 0 && <ul className="proposal-edges">{panel.edges.map((edge, index) => <li key={`${edge.lineId}-${index}`}><strong>{edge.lineId}: {edge.amount} from {edge.fund}</strong><p>{edge.reason}</p></li>)}</ul>}
      {!pending && !message && !reviewChanged && !editDirty && panel.issues.length > 0 && <ul className="proposal-issues">{panel.issues.map(issue => <li key={issue.lineId}>{issue.lineId}: {issue.message}</li>)}</ul>}
      {reviewChanged && <p>The earlier funding preview is hidden because your review choices changed. Confirm categories to view a recalculated allocation.</p>}
      <p>Preparation stops here. You must confirm categories below, then freeze the allocation separately for two human approvals.</p>
      {editable && <form action={`/api/receipts/${id}/proposal`} method="post" className="proposal-form" onSubmit={event => { event.preventDefault(); void prepare(event.currentTarget); }}>
        <input type="hidden" name="action" value="prepare" /><input type="hidden" name="reviewId" value={reviewId} /><input type="hidden" name="draftHash" value={draftHash} /><input type="hidden" name="suggestionHash" value={suggestionHash} /><input type="hidden" name="runHash" value={runHash} />
        <button disabled={!interactive || running || dirty || editDirty || Boolean(message)} type="submit">{running ? "Preparation in progress..." : panel.state === "READY_FOR_REVIEW" || panel.state === "POLICY_BLOCKED" || panel.state === "STALE" ? "Refresh funding preview" : "Prepare expense proposal"}</button>
      </form>}
      <noscript><p>JavaScript is needed for preparation. Manual category review below remains available.</p></noscript>
      {dirty && <p role="status">You have unsaved review choices. Confirm them below or reload the saved receipt before preparing again.</p>}
      {editDirty && <p role="status">You have unsaved receipt edits. Save them below or reload the saved receipt before preparing or confirming.</p>}
      {running && <p><a href={receiptUrl}>Refresh preparation status</a></p>}
      {message && <p role="alert">{message} <a href={receiptUrl}>Reload saved receipt</a> or <a href="/login">sign in</a>.</p>}
      <p><a href="#category-review">Review categories manually</a></p>
    </section>
    <section id="category-review" aria-labelledby="category-review-heading"><h2 id="category-review-heading">Review and confirm each category</h2>
      <p>Check the source quote and category for every line. Correct a suggestion if needed. A quote match does not prove the category is right.</p>
      {running && <p>Wait for this request to finish or refresh its status before confirming, so you review the current suggestions.</p>}
      <form action={`/api/receipts/${id}`} method="post" className="receipt-form" onChange={event => { setDirty(true); const input = event.target; if (!(input instanceof HTMLInputElement) || input.name !== "confirm") setReviewChanged(true); }}>
        <input type="hidden" name="action" value="confirm" /><input type="hidden" name="reviewId" value={reviewId} /><input type="hidden" name="draftHash" value={draftHash} /><input type="hidden" name="suggestionId" value={suggestionId ?? ""} /><input type="hidden" name="suggestionHash" value={suggestionHash} />
        {lines.map(line => <section key={line.id}><h3>{line.id}: {line.description}</h3><p>{line.amount}</p>
          {line.proposal && line.proposal.category !== "UNKNOWN" ? <><p>AI suggests: <strong>{names[line.proposal.category]}</strong></p><blockquote>{line.proposal.quote}</blockquote><p>Exact quote found once in the receipt. You still need to verify the category.</p></> : <p>No supported category suggested. Choose a category manually.</p>}
          <CategoryChoice lineId={line.id} proposed={line.proposal?.category} editable={editable && !running && !editDirty} />
        </section>)}
        {editable && <><label className="confirm"><input type="checkbox" name="confirm" value="yes" required disabled={running || editDirty} /> I checked every category and quote. I understand alcohol cannot be reimbursed.</label><button disabled={running || editDirty}>Confirm categories</button></>}
      </form>
    </section>
    {editable && <details className="receipt-edit" onChange={() => setEditDirty(true)}><summary>Edit receipt or amounts</summary><p>Saving edits discards the current review and requires fresh confirmation.</p><fieldset disabled={running}>{editForm}</fieldset></details>}
  </>;
}
