// IAC-405 step 2 PR F (docs/ASSUMPTIONS.md section 76) and step 3 PR P (section 78). "How claims are approved": the fund's stored mode, its pending proposals and the two-step change. Presentation only: the
// page reads the stored view and shows this only when the fund modes flag is on. Autopilot is offered only when the second flag is on (the page passes autopilot). Nothing here approves a claim or pays.
import type { FundMode } from "../../../db/schema";
import type { FundModeView } from "../../fund-modes/change";
import { reviewTime } from "../../server/display";

const LABEL: Record<FundMode, string> = { MANUAL: "Manual", ASSISTED: "Assisted", AUTOPILOT: "Autopilot" };

export function FundModeSection({ fundId, view, userId, autopilot = false }: { fundId: string; view: FundModeView; userId: string; autopilot?: boolean }) {
  const action = `/api/funds/${fundId}/mode`;
  const options = (["MANUAL", "ASSISTED", ...(autopilot ? ["AUTOPILOT"] : [])] as FundMode[]).filter(mode => mode !== view.mode && !view.pending.some(proposal => proposal.mode === mode));
  return <section className="rules-section" aria-labelledby="fund-mode-heading" data-testid="fund-mode">
    <h2 id="fund-mode-heading">How claims are approved</h2>
    <p data-testid="fund-mode-current">This fund is set to <strong>{LABEL[view.mode]}</strong>{view.version > 0 ? `, version ${view.version}` : " (the default)"}.</p>
    <p className="muted">Manual: two different approvers approve every claim. Assisted: when the automatic checks find nothing to hold, one approver is enough, and any hold or doubt still takes two.{autopilot ? " Autopilot: small claims that meet every guardrail are recognized and sent with no approver, a random sample goes to two approvers first, and an approver can switch automation off at any time." : ""} A claim that draws on several funds follows the strictest fund. Changing this takes two different approvers. It never approves or pays on its own.</p>
    {view.pending.length > 0 && <ul className="rules-actions" data-testid="fund-mode-pending">{view.pending.map(proposal => <li key={proposal.id}>
      {LABEL[proposal.mode]} proposed by {proposal.proposedByName} on <time dateTime={proposal.proposedAt.toISOString()}>{reviewTime(proposal.proposedAt)}</time>.{" "}
      {proposal.proposedById === userId
        ? <span className="muted">A different approver must approve it.</span>
        : <form method="post" action={action}><input type="hidden" name="action" value="approve" /><input type="hidden" name="proposalId" value={proposal.id} /><button type="submit">Approve the change to {LABEL[proposal.mode]}</button></form>}
    </li>)}</ul>}
    {options.map(mode => <form key={mode} className="rules-actions" method="post" action={action}>
      <input type="hidden" name="action" value="propose" /><input type="hidden" name="mode" value={mode} />
      <button type="submit" className="secondary">Propose {LABEL[mode]} (a second approver must approve)</button>
    </form>)}
  </section>;
}
