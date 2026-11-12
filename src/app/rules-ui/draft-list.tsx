// IAC-440 Package B. The fund's drafts, newest first, with state and approvals. Presentation only.
import type { DraftListItem } from "../../rules-draft/drafts";
import { reviewTime } from "../../server/display";
import { refusedDraftReason } from "../../server/rules-notices";
import { MAX_APPROVALS, STATE_LABELS, pathLabel } from "./labels";

export function DraftList({ fundId, drafts }: { fundId: string; drafts: DraftListItem[] }) {
  if (drafts.length === 0) return <p className="muted" data-testid="rules-no-drafts">No drafts yet for this fund.</p>;
  return <div className="rules-scroll"><table className="rules-table" data-testid="rules-draft-list">
    <caption className="vh">Drafts of this fund, newest first</caption>
    <thead><tr><th scope="col">Draft</th><th scope="col">State</th><th scope="col">Approvals</th><th scope="col">Made by</th><th scope="col">Detail</th></tr></thead>
    <tbody>{drafts.map(draft => <tr key={draft.id} data-state={draft.state}>
      <th scope="row"><a href={`/funds/${fundId}/rules/drafts/${draft.id}`}>{draft.parentDraftId ? "Edited draft" : "Draft"} of <time dateTime={draft.createdAt.toISOString()}>{reviewTime(draft.createdAt)}</time></a></th>
      <td><span className="state-badge" data-state={draft.state}>{STATE_LABELS[draft.state]}</span></td>
      <td>{draft.state === "REFUSED" ? "None" : `${draft.approvals} of ${MAX_APPROVALS}`}</td>
      <td>{draft.createdByName}</td>
      <td>{draft.state === "REFUSED" ? refusedDraftReason(draft.refusalReason)
        : draft.state === "BOUND" ? `In use as version ${draft.boundPolicyVersion ?? "?"}.`
        : draft.state === "STALE" ? `Made from version ${draft.basePolicyVersion}, which is no longer current.`
        : draft.state === "WITHDRAWN" ? "Withdrawn."
        : draft.changedFields && draft.changedFields.length > 0 ? `A person changed: ${draft.changedFields.map(pathLabel).join(", ")}.` : `Made from version ${draft.basePolicyVersion}.`}</td>
    </tr>)}</tbody>
  </table></div>;
}
