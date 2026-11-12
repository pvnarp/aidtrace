import { and, desc, eq, isNull } from "drizzle-orm";
import * as s from "../../../../db/schema";
import { fundAutopilotEnabled } from "../../../fund-modes/flag";
import { getDatabase } from "../../../server/db";
import { ActionForm } from "./action-form";
import { lineOf, money, type Result } from "./automated-trail-copy";
import { paymentLine } from "./payment-line";

// IAC-405 step 3 PR P. Shown only for a claim whose current decision was recognized by an AUTO_RECOGNIZED record, that is, with no human approval.
// It reads that stored record and prints the inputs each guardrail read. It checks nothing itself and never says a claim is cleared, approved or passed by a check. A FIXTURE row of
// payee_email_history reads "demo history". "Disagree" shows for an approver who is not the claimant once the payment was sent, with the second flag on; it turns automation off and reverses nothing.
// Server component. All values are stored decimal strings, closed codes or ids, rendered as escaped text.
export const AUTOPILOT_TRAIL_HEADING = "Approved under Autopilot guardrails";
const NAMES: Record<string, string> = { G1: "Rules and AI agree", G2: "Line caps", G3: "Fund per day", G4: "Claimant per week", G5: "Earlier human-approved claim", G6: "Payout email history", G7: "Random audit", G8: "Automation switch" };

export async function AutomatedTrail({ claimId, viewer }: { claimId: string; viewer: { id: string; role: string } }) {
  const db = getDatabase();
  const [row] = await db.select({ hash: s.allocationDecisions.decisionHash, inputs: s.automatedDecisions.inputs, recordedAt: s.automatedDecisions.recordedAt, claimantId: s.claims.claimantId })
    .from(s.automatedDecisions)
    .innerJoin(s.allocationDecisions, eq(s.allocationDecisions.decisionHash, s.automatedDecisions.decisionHash))
    .innerJoin(s.claims, and(eq(s.claims.id, s.allocationDecisions.claimId), eq(s.claims.version, s.allocationDecisions.claimVersion)))
    .where(and(eq(s.allocationDecisions.claimId, claimId), isNull(s.allocationDecisions.invalidatedAt), eq(s.automatedDecisions.kind, "AUTO_RECOGNIZED")))
    .orderBy(desc(s.automatedDecisions.recordedAt)).limit(1);
  if (!row) return null;
  const [sent] = await db.select({ id: s.automatedDecisions.id }).from(s.automatedDecisions).where(and(eq(s.automatedDecisions.decisionHash, row.hash), eq(s.automatedDecisions.kind, "AUTO_SENT"))).limit(1);
  const [attempt] = await db.select({ state: s.disbursementAttempts.state }).from(s.disbursementAttempts).innerJoin(s.disbursements, eq(s.disbursements.id, s.disbursementAttempts.disbursementId))
    .where(eq(s.disbursements.decisionHash, row.hash)).orderBy(desc(s.disbursementAttempts.attemptNumber)).limit(1);
  const guardrails = (row.inputs as { guardrails?: Record<string, Result> }).guardrails ?? {};
  const canDisagree = Boolean(sent) && viewer.role === "APPROVER" && viewer.id !== row.claimantId && fundAutopilotEnabled();
  // Item 10: people finish a claim whose automatic payment did not go out. Fixed sentences only. A claimant sees the status line above and nothing here.
  const takeovers = attempt ? [] : await db.select({ approverId: s.approvals.approverId }).from(s.approvals).where(eq(s.approvals.decisionHash, row.hash));
  const isApprover = viewer.role === "APPROVER" && viewer.id !== row.claimantId;
  const showTakeover = !attempt && isApprover;
  const approvedByViewer = takeovers.some(approval => approval.approverId === viewer.id);
  return <section className="panel" id="autopilot" aria-labelledby="autopilot-heading" data-testid="autopilot-trail">
    <h2 id="autopilot-heading">{AUTOPILOT_TRAIL_HEADING}</h2>
    <p className="sub">Recognized on <time dateTime={row.recordedAt.toISOString()}>{row.recordedAt.toISOString().slice(0, 16).replace("T", " ")} UTC</time> with no human approval. Claim total {money((row.inputs as { claimCents?: unknown }).claimCents)}. These are the inputs each guardrail read.</p>
    <p data-testid="autopilot-payment"><strong>{paymentLine(attempt?.state ?? null)}</strong></p>
    <ul>{Object.keys(NAMES).filter(id => guardrails[id]).map(id => <li key={id} data-guardrail={id}><strong>{id} {NAMES[id]}.</strong> {lineOf(id, guardrails[id]!)}</li>)}</ul>
    {showTakeover && <div data-testid="autopilot-takeover"><p>Automatic payment did not go out. Two approvers can finish this claim.</p>
      <p data-testid="autopilot-people">People: {takeovers.length} of 2</p>
      {takeovers.length < 2 && !approvedByViewer && <ActionForm claimId={claimId} action="takeover" button="Approve to finish this claim" />}</div>}
    {canDisagree && <form method="post" action={`/api/claims/${claimId}/automation`}><input type="hidden" name="action" value="disagree" />
      <p className="muted">If this payment should not have been automatic, Disagree turns automation off for the whole organization. It does not reverse this payment.</p>
      <button type="submit" className="secondary">Disagree</button></form>}
  </section>;
}
