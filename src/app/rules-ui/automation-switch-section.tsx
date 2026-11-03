// IAC-405 step 3 PR P (docs/ASSUMPTIONS.md section 78). The organization's Autopilot kill switch on the fund rules page: its state, a pending proposal and the two-step turn on, and one-click off.
// Shown only to an approver and only when the second flag (FUND_AUTOPILOT_ENABLED) is on. Presentation only: it reads the stored view. It never approves a claim or pays.
import type { SwitchView } from "../../fund-modes/automation-read";
import { reviewTime } from "../../server/display";

const OFF_REASON: Record<string, string> = { DISAGREE: "an approver disagreed with an automated payment", UNKNOWN_SEND: "an automated payment came back UNKNOWN", APPROVER: "an approver turned it off" };

export function AutomationSwitchSection({ fundId, view, userId }: { fundId: string; view: SwitchView; userId: string }) {
  const action = `/api/funds/${fundId}/automation`;
  return <section className="rules-section" aria-labelledby="automation-heading" data-testid="automation-switch">
    <h2 id="automation-heading">Autopilot switch</h2>
    <p data-testid="automation-state">Automation is <strong>{view.on ? "on" : "off"}</strong> for the organization.{view.on && view.unknownOutstanding ? " It is paused while an automated payment is still UNKNOWN." : ""}{!view.on && view.lastOff ? ` Last turned off because ${OFF_REASON[view.lastOff.reason] ?? "of a recorded event"}, ${reviewTime(view.lastOff.at)}.` : ""}</p>
    <p className="muted">Automation sends nothing unless a fund is set to Autopilot and a claim meets every guardrail. Turning it on takes two different approvers. Turning it off takes one, and it also turns off by itself on a Disagree or an UNKNOWN automated payment.</p>
    {view.on
      ? <form className="rules-actions" method="post" action={action}><input type="hidden" name="action" value="off" /><button type="submit">Turn automation off</button></form>
      : view.pending
        ? <div className="rules-actions" data-testid="automation-pending">
          <p>Proposed by {view.pending.proposedByName} on <time dateTime={view.pending.proposedAt.toISOString()}>{reviewTime(view.pending.proposedAt)}</time>.</p>
          {view.pending.proposedById === userId
            ? <p className="muted">A different approver must confirm it.</p>
            : <form method="post" action={action}><input type="hidden" name="action" value="confirm" /><input type="hidden" name="proposal" value={String(view.pending.seq)} /><button type="submit">Confirm turning automation on</button></form>}
        </div>
        : <form className="rules-actions" method="post" action={action}><input type="hidden" name="action" value="propose" /><button type="submit" className="secondary">Propose turning automation on (a second approver must confirm)</button></form>}
  </section>;
}
