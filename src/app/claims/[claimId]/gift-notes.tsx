import { ActionForm } from "./action-form";
import { formatShares, formatUsd, longDate, TEMPLATE_LABEL, type GiftNoteEntry, type PayoutNoteStatus } from "../../../donation/note";
import { reviewTime } from "../../../server/display";

// IAC-379 step 3b and Option A (docs/ASSUMPTIONS.md section 47). Shows the deterministic template draft and the approved, immutable donor
// impact notes for each gift applied to this recognized claim. Text from the database is rendered as React text only, never as markup.
// Nothing is emailed. The meta line comes from the current facts, so a stale note shows the audit line and no meta line.
const payoutLabels: Record<PayoutNoteStatus, string> = {
  NO_PAYMENT: "No payment sent in this environment", PROCESSING: "PayPal payout processing", UNKNOWN: "PayPal payout outcome being verified", NEEDS_ATTENTION: "Payout needs attention", PAID: "Paid, verified by PayPal",
};
const noteLabel = (mode: "TEMPLATE" | "AI") => mode === "TEMPLATE" ? TEMPLATE_LABEL : "AI selected from verified facts";
const metaLine = (entry: GiftNoteEntry, label: string) => `${formatShares(entry.shares)}. Gift recorded ${longDate(entry.capturedOn)}. ${label}.`;
export function GiftNotes({ claimId, entries, canApprove }: { claimId: string; entries: GiftNoteEntry[]; canApprove: boolean }) {
  return <section id="donor-notes" aria-labelledby="donor-notes-title"><h2 id="donor-notes-title">Donor impact notes</h2>
    <p className="muted" data-testid="gift-note-intro">Built from verified records. Approved by someone other than the claimant. Nothing is emailed.</p>
    <p className="muted" data-testid="gift-note-policy">Gifts are applied to approved receipt lines, oldest gift first.</p>
    {entries.map(entry => <div className="comparison-card" key={entry.captureId} data-testid="gift-note-card">
      <h3>{entry.fundName} gift of {formatUsd(entry.giftCents)}</h3>
      {!entry.approvedCurrent && <>
        <p className="eyebrow">Draft, not yet approved</p>
        <blockquote data-testid="gift-note-draft">{entry.draftText}</blockquote>
        <p className="muted" data-testid="gift-note-meta">{metaLine(entry, TEMPLATE_LABEL)}</p>
        {canApprove ? <ActionForm claimId={claimId} action="approve-note" button="Approve this note" fields={{ captureId: entry.captureId, factDigest: entry.draftDigest }} />
          : <p className="muted">An approver who is not the claimant approves this note.</p>}
      </>}
      {entry.notes.map(note => <article key={note.id} data-testid="gift-note-approved">
        <p className="eyebrow">{note.stale ? "Approved earlier" : "Approved"}</p>
        {note.stale && <p className="notice warning" role="note">Out of date: needs a new approval</p>}
        <blockquote>{note.renderedText}</blockquote>
        {!note.stale && <p className="muted" data-testid="gift-note-meta">{metaLine(entry, noteLabel(note.mode))}</p>}
        <p className="muted" data-testid="gift-note-audit">Note approved by {note.approverName} at <time dateTime={note.approvedAt.toISOString()}>{reviewTime(note.approvedAt)}</time>. Payout status at approval: {payoutLabels[note.payoutStatus]}.</p>
        <p><a href={`/api/claims/${claimId}/notes/${note.id}`} download>Download as plain text</a></p>
      </article>)}
    </div>)}
  </section>;
}
