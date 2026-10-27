import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { findSession, SESSION_COOKIE } from "../../../server/auth";
import { getDatabase } from "../../../server/db";
import { loadClaimView } from "../../../server/claim-view";
import { ActionForm } from "./action-form";
import { isRetryableAttempt } from "../../../ledger/retry";
import { CLAIM_ID } from "../../../receipt/terms";
import { readReceiptView } from "../../../receipt/service";
import { requireReceiptConfirmation } from "../../../receipt/guard";

const usd = (cents: bigint) => `${cents < 0n ? "-" : ""}$${(cents < 0n ? -cents : cents) / 100n}.${((cents < 0n ? -cents : cents) % 100n).toString().padStart(2, "0")}`;
const labels: Record<string, string> = { DRAFT: "Draft", AWAITING_APPROVAL: "Awaiting approval", APPROVED: "Approved", PAYOUT_PROCESSING: "Payout processing", PAID: "Paid", REJECTED: "Rejected", PAYOUT_ISSUE: "Payout issue" };
const notices: Record<string, string> = {
  frozen: "The allocation is frozen. Tara and Ben can now approve the same terms.",
  unfunded: "Current funds cannot cover this claim. No partial allocation was frozen.",
  "approval-saved": "Your approval is saved. A different approver is still required.",
  approved: "Both approvals are complete. The obligation is recognized; payment has not been sent.",
  invalidated: "Claim or policy terms changed. The old decision was invalidated and its reservations released. Maria must submit again.",
  rejected: "The claim was rejected and its active reservations released.",
  submitted: "PayPal accepted the batch. Refresh status to check the individual payment before calling it paid.",
  unknown: "The send outcome is unknown. Do not send again. Saved sender IDs require manual reconciliation.",
  funding: "PayPal rejected the request for insufficient funds. The obligation remains open. A future retry requires separate authorization.",
  "retry-authorized": "This retry is authorized for the same recipient and open amount. Review and explicitly send the new attempt when ready.",
  refreshed: "The latest independently fetched provider status has been recorded.",
  "action-failed": "That action could not be completed. Review the current state before acting again. Payment failures do not authorize another send.",
};
export default async function ClaimPage({ params, searchParams }: { params: Promise<{ claimId: string }>; searchParams: Promise<{ notice?: string }> }) {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  const { claimId } = await params; if (!/^[A-Za-z0-9-]{1,64}$/.test(claimId)) notFound();
  const db = getDatabase();
  if (CLAIM_ID.test(claimId)) {
    const receipt = await readReceiptView(db, claimId, user.id).catch(() => null);
    if (!receipt) notFound();
    if (!receipt.confirmation) redirect(`/claims/${claimId}/receipt`);
    const valid = await db.transaction(tx => requireReceiptConfirmation(tx, receipt.claim)).then(() => true, () => false);
    if (!valid) redirect(`/claims/${claimId}/receipt`);
  }
  const view = await loadClaimView(db, claimId, user.id).catch(() => null);
  if (!view) notFound();
  const { claim, decision, edges, comparison, approvals, attempt, report } = view;
  const total = view.lines.reduce((sum, line) => sum + line.amountCents, 0n);
  const baselineGeneral = comparison?.status === "FUNDED" && comparison.unrestrictedCents !== undefined ? BigInt(comparison.unrestrictedCents) : undefined;
  const approver = user.role === "APPROVER" && user.id !== claim.claimantId;
  const approvedByMe = approvals.some(row => row.approverId === user.id);
  const notice = (await searchParams).notice;
  const split = (rows: readonly { fundId: string; lineId: string; amountCents: string | bigint }[]) => <ul className="split-list">{rows.map(row => <li key={`${row.fundId}:${row.lineId}`}><span>{row.lineId} · {view.funds.find(fund => fund.id === row.fundId)?.name ?? row.fundId}</span><strong>{usd(BigInt(row.amountCents))}</strong></li>)}</ul>;
  const recipient = claim.payeeEmail.split("@");
  return <main className="claim-page">
    <header className="page-header"><Link href="/">AidTrace</Link><span>{user.displayName} · {approver ? "Approver" : "Claimant"}</span><form action="/api/auth/logout" method="post"><button type="submit" className="secondary">Sign out</button></form></header>
    <p className="eyebrow">Cedar Hollow Youth Robotics / Sandbox fixture</p>
    <h1>{view.feasible ? `${usd(total - view.generalCents)} from restricted funds, ${usd(view.generalCents)} from General.` : "This claim needs more eligible funding."}</h1>
    <p className="intro">Claim {claim.id} · {claim.vendor} · {usd(total)}<br />Expense date {claim.incurredOn}. Status: <strong>{labels[claim.status]}</strong>.</p>
    {notice && notices[notice] && <p role="status" className="notice">{notices[notice]}</p>}
    <div className="comparison-grid">
      <section className="comparison-card"><p className="eyebrow">First eligible fund</p><h2>{baselineGeneral === undefined ? comparison ? "Cannot fully fund" : "Historical comparison unavailable" : `${usd(baselineGeneral)} from General`}</h2><p>Comparison only. Uses line order, then fund order.</p>{split(comparison?.edges ?? [])}</section>
      <section className="comparison-card chosen"><p className="eyebrow">AidTrace allocation</p><h2>{view.feasible ? `${usd(view.generalCents)} from General` : "No partial allocation"}</h2>{baselineGeneral !== undefined && view.feasible && <p><strong>{usd(baselineGeneral - view.generalCents)} preserved</strong> for expenses restricted grants cannot cover.</p>}{split(edges)}</section>
    </div>
    <section><h2>Why each fund can pay</h2><ul className="reasons">{edges.map(edge => <li key={`${edge.fundId}:${edge.lineId}`}><strong>{edge.lineId} · {usd(edge.amountCents)} · policy v{edge.policyVersion}</strong><p>{edge.reason}</p></li>)}</ul>
      <p>Recipient: the claimant's configured sandbox Personal account {recipient[0]?.slice(0, 2)}***@{recipient[1]}. The full configured recipient is bound to the decision hash.</p>
      {CLAIM_ID.test(claimId) && <p><Link href={`/claims/${claimId}/receipt`}>Review receipt and confirmed categories</Link></p>}
      {user.id === claim.claimantId && ["DRAFT", "AWAITING_APPROVAL"].includes(claim.status) && <ActionForm claimId={claimId} action="freeze" button={decision ? "Confirm current allocation" : "Freeze allocation for approval"} />}
    </section>
    <section><h2>Two independent approvals</h2><p>{decision ? `Decision ${decision.decisionHash.slice(0, 16)}. ${approvals.length} of 2 approvals recorded.` : "The claimant must freeze this allocation before approval."}</p>
      <ul>{approvals.map(row => <li key={row.approverId}>{row.displayName} approved at {row.approvedAt.toISOString()}.</li>)}</ul>
      {approver && decision && claim.status === "AWAITING_APPROVAL" && !approvedByMe && <ActionForm claimId={claimId} action="approve" decisionId={decision.id} decisionHash={decision.decisionHash} button="Approve these terms" />}
      {approver && ["DRAFT", "AWAITING_APPROVAL"].includes(claim.status) && <ActionForm claimId={claimId} action="reject" button="Reject claim"><label htmlFor="reason">Reason for rejection</label><input id="reason" name="reason" required maxLength={500} /></ActionForm>}
      {view.rejections.map((rejection, index) => <p key={index}>Rejected by {rejection.rejectedBy}: {rejection.reason}</p>)}
    </section>
    <section><h2>Sandbox payment</h2><p><strong>{labels[claim.status]}</strong>. Organization reimbursement payable: {usd(report.openPayableCents)}.</p>
      <p>Internal fixture funds are not proof of PayPal cash. {attempt?.providerBalanceCents !== null && attempt?.providerBalanceCents !== undefined ? `Provider available balance at submission: ${usd(attempt.providerBalanceCents)}. Reporting may lag up to three hours.` : "Provider balance is unavailable. PayPal may reject the request for insufficient funds."}</p>
      {attempt && <dl className="payment-details"><dt>Attempt</dt><dd>{attempt.state}</dd><dt>Sender batch ID</dt><dd>{attempt.senderBatchId}</dd><dt>PayPal batch ID</dt><dd>{attempt.payoutBatchId ?? "Not known"}</dd><dt>PayPal item ID</dt><dd>{attempt.payoutItemId ?? "Not known"}</dd><dt>Batch / item status</dt><dd>{attempt.batchStatus ?? "Not known"} / {attempt.itemStatus ?? "Not known"}</dd><dt>Reported fee</dt><dd>{attempt.feeCents === null ? "Not yet reported" : usd(attempt.feeCents)}</dd><dt>Last error</dt><dd>{attempt.lastErrorCode ?? "None recorded"}</dd><dt>Settlement date</dt><dd>{attempt.settledOn ?? "Not settled"}</dd></dl>}
      {approver && decision && approvedByMe && claim.status === "APPROVED" && !attempt && <ActionForm claimId={claimId} action="send" decisionHash={decision.decisionHash} button={`Send ${usd(total)} in PayPal sandbox`}><label className="confirm"><input type="checkbox" name="confirmSandbox" value="yes" required /> I confirm this is the approved {usd(total)} sandbox reimbursement.</label></ActionForm>}
      {approver && attempt?.payoutBatchId && <ActionForm claimId={claimId} action="refresh" button="Refresh status" />}
      {approver && decision && attempt && claim.status === "PAYOUT_ISSUE" && isRetryableAttempt(attempt) && (view.retryAuthorization ? <ActionForm claimId={claimId} action="retry" decisionHash={decision.decisionHash} button={`Send authorized retry ${view.retryAuthorization.attemptNumber} in sandbox`}><input type="hidden" name="authorizationId" value={view.retryAuthorization.id} /><label className="confirm"><input type="checkbox" name="confirmSandbox" value="yes" required /> I confirm this new attempt is for the unchanged {usd(total)} sandbox reimbursement.</label></ActionForm> : <ActionForm claimId={claimId} action="authorize-retry" decisionHash={decision.decisionHash} button={`Authorize retry ${attempt.attemptNumber + 1}`}><input type="hidden" name="failedAttemptId" value={attempt.id} /><label className="confirm"><input type="checkbox" name="confirmSandbox" value="yes" required /> I authorize one retry for the same recipient and open amount.</label></ActionForm>)}
      {attempt && <p>No automatic retry is available. Unknown outcomes require manual reconciliation. Unclaimed and held payments require polling; a confirmed terminal failure requires separate retry authorization.</p>}
    </section>
    <section><h2>Fixture accounting</h2><p>Restricted funds: {usd(report.restrictedCents)}. General: {usd(report.generalCents)}. Ledger tie-out: {report.matches ? "Matches" : "Needs investigation"}.</p><p>Opening fixture cash: {usd(report.fixtureCashCents)}. Recorded provider activity: {usd(report.providerActivityCashDeltaCents)}. Book cash: {usd(report.bookCashCents)}. These are accounting figures, not PayPal available funds.</p></section>
    {view.donations.length > 0 && <section><h2>Designated sandbox donations</h2><p>These are additional provider-backed donations. Fixture opening credits remain labeled separately.</p>{view.donations.map(donation => <div key={donation.orderId}><p>{view.funds.find(fund => fund.id === donation.fundId)?.name}: {donation.status === "COMPLETED" ? `${usd(donation.grossCents!)} gross, ${usd(donation.feeCents!)} fee charged to General, ${usd(donation.netCents!)} net cash.` : "Pending, no accounting posted."}</p><p>Order {donation.orderId}. Capture {donation.captureId ?? "not yet known"}. Status {donation.providerStatus}.</p></div>)}</section>}
    <footer>Accounting-inspired demo model, pending nonprofit accountant review. Paid appears only after an independently fetched payout item reports success. This page does not enable production payments.</footer>
  </main>;
}
