import { ActionForm } from "./action-form";
import { formatUsd, TEMPLATE_LABEL, type GiftNoteEntry, type PayoutNoteStatus } from "../../../donation/note";
import { reviewTime } from "../../../server/display";

// IAC-379 step 3b. Shows the deterministic template draft and the approved, immutable donor impact notes for each gift
// applied to this recognized claim. Text from the database is rendered as React text only, never as markup. Nothing is emailed.
const payoutLabels: Record<PayoutNoteStatus, string> = {
  NO_PAYMENT: "No payment sent in this environment", PROCESSING: "PayPal payout processing", UNKNOWN: "PayPal payout outcome being verified", NEEDS_ATTENTION: "Payout needs attention", PAID: "Paid, verified by PayPal",
};
export function GiftNotes({ claimId, entries, canApprove }: { claimId: string; entries: GiftNoteEntry[]; canApprove: boolean }) {
  return <section id="donor-notes" aria-labelledby="donor-notes-title"><h2 id="donor-notes-title">Donor impact notes</h2>
    <p className="muted">Each note is built from verified records by a fixed template and approved by a person who is not the claimant. Gifts are applied to receipt lines by a stated policy. It is a narrative, not an accounting method. Nothing is emailed.</p>
    {entries.map(entry => <div className="comparison-card" key={entry.captureId} data-testid="gift-note-card">
      <h3>{entry.fundName} gift of {formatUsd(entry.giftCents)}</h3>
      {!entry.approvedCurrent && <>
        <p className="eyebrow">Draft, not yet approved</p>
        <blockquote data-testid="gift-note-draft">{entry.draftText}</blockquote>
        <p className="muted" data-testid="gift-note-label">{TEMPLATE_LABEL}</p>
        {canApprove ? <ActionForm claimId={claimId} action="approve-note" button="Approve this note" fields={{ captureId: entry.captureId, factDigest: entry.draftDigest }} />
          : <p className="muted">An approver who is not the claimant approves this note.</p>}
      </>}
      {entry.notes.map(note => <article key={note.id} data-testid="gift-note-approved">
        <p className="eyebrow">{note.stale ? "Approved earlier" : "Approved"}</p>
        {note.stale && <p className="notice warning" role="note">Out of date: needs a new approval</p>}
        <blockquote>{note.renderedText}</blockquote>
        <p className="muted">{note.mode === "TEMPLATE" ? TEMPLATE_LABEL : "AI selected from verified facts"}. Approved by {note.approverName} at <time dateTime={note.approvedAt.toISOString()}>{reviewTime(note.approvedAt)}</time>. Payout status at approval: {payoutLabels[note.payoutStatus]}.</p>
        <p><a href={`/api/claims/${claimId}/notes/${note.id}`} download>Download as plain text</a></p>
      </article>)}
    </div>)}
  </section>;
}
