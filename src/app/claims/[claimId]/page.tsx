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
import { claimFailureNotices } from "../../../server/claim-notices";
import { categoryNames as categories, reviewTime } from "../../../server/display";
import { BUDGET_NAMES } from "../../../ai/categories";
import { Journey } from "../../journey";
import { FundingSummary } from "../../funding-summary";
import { judgeSession, paymentConfigured } from "../../../server/judge-mode";
import { PayPalHandoff, RecipientNote } from "../../paypal-handoff";
import { describeMatches } from "../../receipts/prohibited-notice";
import { readGiftNotes } from "../../../donation/note";
import { GiftNotes } from "./gift-notes";

const usd = (cents: bigint) => `${cents < 0n ? "-" : ""}$${(cents < 0n ? -cents : cents) / 100n}.${((cents < 0n ? -cents : cents) % 100n).toString().padStart(2, "0")}`;
const labels: Record<string, string> = { DRAFT: "Draft", AWAITING_APPROVAL: "Awaiting approval", APPROVED: "Approved", PAYOUT_PROCESSING: "Payout processing", PAID: "Paid", REJECTED: "Rejected", PAYOUT_ISSUE: "Payout issue" };
const notices: Record<string, string> = {
  ...claimFailureNotices,
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
  "note-approved": "The donor impact note is approved and saved. Nothing was sent to anyone.",
  "note-exists": "This note was already approved for these facts. Nothing changed.",
  "note-stale": "The facts changed after you opened this page. Review the new draft before approving it.",
  "note-refused": "This note cannot be approved by you or in the current state. Nothing was saved.",
};
export default async function ClaimPage({ params, searchParams }: { params: Promise<{ claimId: string }>; searchParams: Promise<{ notice?: string }> }) {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  const { claimId } = await params; if (!/^[A-Za-z0-9-]{1,64}$/.test(claimId)) notFound();
  if (judgeSession() && !CLAIM_ID.test(claimId)) redirect("/");
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
  const canPay = paymentConfigured(claim.payeeEmail);
  const baselineGeneral = comparison?.status === "FUNDED" && comparison.unrestrictedCents !== undefined ? BigInt(comparison.unrestrictedCents) : undefined;
  const approver = user.role === "APPROVER" && user.id !== claim.claimantId;
  // IAC-379 step 3b: read-only. Only a recognized claim (approved or later) can have gifts applied to its lines.
  const recognized = ["APPROVED", "PAYOUT_PROCESSING", "PAID", "PAYOUT_ISSUE"].includes(claim.status);
  const giftNotes = recognized ? await db.transaction(tx => readGiftNotes(tx, claim.organizationId, claimId, claim.version), { isolationLevel: "repeatable read" }) : [];
  const approvedByMe = approvals.some(row => row.approverId === user.id);
  const notice = (await searchParams).notice;
  const lineDescription = (id: string) => view.lines.find(line => line.id === id)?.description ?? id;
  const split = (rows: readonly { fundId: string; lineId: string; amountCents: string | bigint }[]) => <ul className="split-list">{rows.map(row => <li key={`${row.fundId}:${row.lineId}`}><span>{lineDescription(row.lineId)} · {view.funds.find(fund => fund.id === row.fundId)?.name ?? row.fundId}</span><strong>{usd(BigInt(row.amountCents))}</strong></li>)}</ul>;
  const recipient = claim.payeeEmail.split("@");
  const policyBlocked = claim.status === "DRAFT" && view.lines.some(line => view.input.prohibitedCategories.includes(line.category));
  // Keyless judge review: the unpaid PayPal handoff is the outcome, so it moves under the title.
  const handoffReady = claim.status === "APPROVED" && !canPay && !attempt;
  const statusLabel = handoffReady ? "Approved / unpaid" : labels[claim.status];
  const heading = policyBlocked ? "Organization policy stops this expense."
    : claim.status === "DRAFT" ? view.feasible ? `${usd(total - view.generalCents)} restricted. ${usd(view.generalCents)} General.` : "This claim needs more eligible funding."
    : claim.status === "AWAITING_APPROVAL" ? decision ? approvals.length === 0 ? "Frozen. Awaiting two approvals." : `${approvals.length} of 2 approvals saved. One more needed.` : "Awaiting approval."
    : claim.status === "APPROVED" ? handoffReady ? `${usd(total)} approved. PayPal handoff ready. Unpaid.` : `${usd(total)} approved. Payment is a separate decision.`
    : claim.status === "PAID" ? `${usd(total)} paid. Settlement verified.`
    : claim.status === "REJECTED" ? "Claim rejected. Nothing is paid."
    : claim.status === "PAYOUT_PROCESSING" ? "Payment submitted. Not yet verified as paid."
    : "Payment issue. Resolve it before another attempt.";
  const paymentSection = (
    <section id="payment"><p className="paypal-label">PayPal <span>Sandbox</span></p><h2>{canPay || attempt ? "Sandbox payment" : "PayPal handoff"}</h2><p><strong>{labels[claim.status]}</strong>. Organization-wide open payable: {usd(report.openPayableCents)}.</p>
      {(canPay || attempt) && <p>Internal fixture funds are not proof of PayPal cash. {attempt?.providerBalanceCents !== null && attempt?.providerBalanceCents !== undefined ? `Provider available balance at submission: ${usd(attempt.providerBalanceCents)}. Reporting may lag up to three hours.` : "Provider balance is unavailable. PayPal may reject the request for insufficient funds."}</p>}
      {!canPay && !attempt && (claim.status === "APPROVED" ? <PayPalHandoff amount={total} recipient={claim.payeeEmail} /> : <p>Payment access is disabled for this review. After two approvals, inspect the read-only PayPal handoff. No payment will be sent.</p>)}
      {attempt && <><dl className="payment-details"><dt>Attempt</dt><dd>{attempt.state}</dd><dt>Batch status</dt><dd>{attempt.batchStatus ?? "Not known"}</dd><dt>PayPal item status</dt><dd>{attempt.itemStatus ?? "Not known"}</dd><dt>Reported fee</dt><dd>{attempt.feeCents === null ? "Not yet reported" : usd(attempt.feeCents)}</dd><dt>Last error</dt><dd>{attempt.lastErrorCode ?? "None recorded"}</dd><dt>Settlement date</dt><dd>{attempt.settledOn ?? "Not settled"}</dd></dl><details><summary>Inspect payment identifiers</summary><dl className="payment-details"><dt>Sender batch ID</dt><dd>{attempt.senderBatchId}</dd><dt>PayPal batch ID</dt><dd>{attempt.payoutBatchId ?? "Not known"}</dd><dt>PayPal item ID</dt><dd>{attempt.payoutItemId ?? "Not known"}</dd></dl></details></>}
      {canPay && approver && decision && approvedByMe && claim.status === "APPROVED" && !attempt && <ActionForm claimId={claimId} action="send" decisionHash={decision.decisionHash} button={`Send ${usd(total)} in PayPal sandbox`}><label className="confirm"><input type="checkbox" name="confirmSandbox" value="yes" required /> I confirm this is the approved {usd(total)} sandbox reimbursement.</label></ActionForm>}
      {canPay && approver && attempt?.payoutBatchId && <ActionForm claimId={claimId} action="refresh" button="Refresh status" />}
      {canPay && approver && decision && attempt && claim.status === "PAYOUT_ISSUE" && isRetryableAttempt(attempt) && (view.retryAuthorization ? <ActionForm claimId={claimId} action="retry" decisionHash={decision.decisionHash} button={`Send authorized retry ${view.retryAuthorization.attemptNumber} in sandbox`}><input type="hidden" name="authorizationId" value={view.retryAuthorization.id} /><label className="confirm"><input type="checkbox" name="confirmSandbox" value="yes" required /> I confirm this new attempt is for the unchanged {usd(total)} sandbox reimbursement.</label></ActionForm> : <ActionForm claimId={claimId} action="authorize-retry" decisionHash={decision.decisionHash} button={`Authorize retry ${attempt.attemptNumber + 1}`}><input type="hidden" name="failedAttemptId" value={attempt.id} /><label className="confirm"><input type="checkbox" name="confirmSandbox" value="yes" required /> I authorize one retry for the same recipient and open amount.</label></ActionForm>)}
      {attempt && <p>No automatic retry is available. Unknown outcomes require manual reconciliation. Unclaimed and held payments require polling; a confirmed terminal failure requires separate retry authorization.</p>}
    </section>
  );
  return <main className="claim-page">
    <header className="page-header"><Link href="/">AidTrace</Link><span>{user.displayName} · {approver ? "Approver" : "Claimant"}</span><form action="/api/auth/logout" method="post"><button type="submit" className="secondary">Sign out</button></form></header>
    <Journey emphasizeDetail={["PAYOUT_ISSUE", "PAYOUT_PROCESSING"].includes(claim.status)} stage={claim.status === "DRAFT" ? 3 : ["AWAITING_APPROVAL", "REJECTED"].includes(claim.status) ? 4 : 5}
      title={policyBlocked ? "Organization policy stops this expense." : claim.status === "DRAFT" ? approver ? "The claimant must freeze the terms first." : view.feasible ? "Check the split, then freeze these terms." : "More eligible funding is needed." : claim.status === "AWAITING_APPROVAL" ? approver && !approvedByMe ? `Review the frozen terms. ${approvals.length} of 2 approvals saved.` : "Hand this claim to a different approver." : claim.status === "APPROVED" ? "Approved is not paid. Payment is a separate decision." : claim.status === "PAID" ? "Payment verified. The claim is settled." : claim.status === "REJECTED" ? "This claim was rejected." : claim.status === "PAYOUT_PROCESSING" ? "Check the payment result. Do not send again." : "Resolve the payment issue before another attempt."}
      detail={policyBlocked ? "A confirmed item is prohibited by organization policy. General cannot cover it either. Correct the receipt before freezing any terms." : claim.status === "DRAFT" ? approver ? "You can inspect the draft, but only its claimant can freeze an allocation for approval." : view.feasible ? "Review the expense and funding below. Freezing holds the eligible funds and sends the same terms to two independent approvers. It does not pay the claim." : "The current rules and fund balances cannot cover the whole expense. No partial allocation can be frozen." : claim.status === "AWAITING_APPROVAL" ? approver && !approvedByMe ? "Check the expense, categories, recipient and split below before you approve. One person's approval cannot authorize payment." : "Sign out above, then have another authorized approver sign in and open this same claim from the home page. The claimant cannot approve their own expense." : claim.status === "APPROVED" ? approver && approvedByMe ? "Both reviewers approved the same terms. If you intend to send a sandbox payment, inspect the payment section and confirm explicitly. You can stop here without sending." : "Both reviews are complete. An approver who approved these terms must separately confirm any sandbox payment. You do not need to send to review this flow." : claim.status === "PAID" ? "The individual PayPal item reported success. The recorded settlement and fee are below. Refreshing status does not send another payment." : claim.status === "REJECTED" ? "Read the rejection reason below. No payment is authorized. Revisit the underlying expense with the organization." : claim.status === "PAYOUT_PROCESSING" ? "An approver can use Refresh status below. A batch acceptance or pending item is not proof of payment." : "Review the attempt and error below. Unknown outcomes need manual reconciliation; confirmed terminal failures need separate retry authorization."}
      href={policyBlocked ? `/claims/${claimId}/receipt` : claim.status === "DRAFT" ? "#funding-review" : ["AWAITING_APPROVAL", "REJECTED"].includes(claim.status) ? "#approvals" : "#payment"}
      action={policyBlocked ? "Review the receipt" : claim.status === "DRAFT" ? "Inspect funding and terms" : ["AWAITING_APPROVAL", "REJECTED"].includes(claim.status) ? "Inspect the approvals" : "Inspect payment status"}
      aside={claimId === "C-104" ? "C-104 is a separate preclassified $500 example. It did not pass through the new receipt's AI review." : `You are still reviewing the same claim: ${claim.vendor}.`} />
    <p className="eyebrow">Lanternfield Community Alliance / Sandbox fixture</p>
    <div className="title-row"><h1>{heading}</h1><p className="state-badge" data-state={claim.status}>{statusLabel}</p></div>
    {handoffReady && paymentSection}
    <p className="intro">{claim.vendor} · {usd(total)}<br />Program: {claim.program}. Expense date {claim.incurredOn}.</p>
    <p className="muted">{policyBlocked ? "The whole expense remains blocked. Correct prohibited items before approval; no partial allocation is frozen." : claim.status === "DRAFT" ? approver ? "Waiting for the claimant to freeze the allocation. You can review the current draft below." : "Review the funding and expense terms, then freeze them for approval." : claim.status === "AWAITING_APPROVAL" ? `${approvals.length} of 2 approvals recorded. Both must cover the same frozen terms.` : claim.status === "APPROVED" ? "Two approvals are complete. Payment still requires an explicit sandbox send." : claim.status === "PAID" ? "The independently fetched PayPal item reports success. Settlement is recorded below." : claim.status === "REJECTED" ? "This claim was rejected. No payment is authorized. The reason is recorded below." : claim.status === "PAYOUT_PROCESSING" ? "Payment has been submitted. An approver can refresh the result below without sending again." : "Review the current issue below. Unknown outcomes require reconciliation, not another send."}</p>
    {notice && notices[notice] && <p role="status" className="notice">{notices[notice]}</p>}
    <div className="comparison-grid">
      <section className="comparison-card chosen"><p className="eyebrow">Computed by funding rules</p><h2>{view.feasible ? `${usd(view.generalCents)} from General` : "No partial allocation"}</h2>{view.feasible && <FundingSummary total={total} general={view.generalCents} edges={edges} funds={view.funds} />}{baselineGeneral !== undefined && view.feasible && baselineGeneral > view.generalCents && <p><strong>{usd(baselineGeneral - view.generalCents)} less General than this comparison</strong>, under its fixed fund order. More flexible funding remains for expenses restricted funds cannot cover.</p>}{split(edges)}</section>
      <section className="comparison-card"><p className="eyebrow">Pay from the first fund that allows it</p><h2>{baselineGeneral === undefined ? comparison ? "Cannot fully fund" : "Historical comparison unavailable" : `${usd(baselineGeneral)} from General`}</h2><p>This comparison takes each line in order and spends from its first eligible fund. It can leave less room for later items.</p><details><summary>See comparison allocation</summary>{split(comparison?.edges ?? [])}<p>Sorted line IDs, then fund IDs. A different fund order can remove the difference. This is not measured savings over a treasurer.</p></details></section>
    </div>
    <section aria-labelledby="expense-review-title" className="expense-review"><h2 id="expense-review-title">Review the expense terms</h2>
      <p>{decision ? "Approvals bind the frozen version of these terms. Review the current details below; the server checks for changed claim or policy terms before accepting approval." : "Review the items and categories before freezing the allocation."}</p>
      <ul className="expense-lines">{view.lines.map(line => {
        const review = view.receiptReview?.lines.find(item => item.lineId === line.id);
        return <li key={line.id}><h3>{line.id}: {line.description} · {usd(line.amountCents)}</h3>
          <p>Category: <strong>{categories[line.category] ?? line.category}</strong>. Budget: {BUDGET_NAMES[line.budgetLine] ?? line.budgetLine}.</p>
          {review ? <><p className="provenance-tags">{review.provenance === "AI_ACCEPTED" ? <><span className="ai-tag">AI suggested</span><span className="ai-tag confirmed">Person confirmed</span></> : <span className="ai-tag confirmed">Person chose</span>}</p><p>{review.provenance === "AI_ACCEPTED" ? "Claimant accepted an AI category suggestion." : "Claimant made a manual category choice."}</p>
            {review.reason && <p>Claimant's reason: {review.reason}</p>}
            {review.proposal && <details><summary>Original AI suggestion: {categories[review.proposal.category] ?? review.proposal.category}</summary><blockquote>{review.proposal.quote}</blockquote><p>The quote matches receipt text. It does not prove the category or funding eligibility.</p></details>}
          </> : <p>Seeded fixture category. No AI review or receipt confirmation is claimed for this item.</p>}
        </li>;
      })}</ul>
      {view.receiptReview?.prohibitedScreen?.unresolved.length ? <p className="notice prohibited-flag" role="note">Receipt text flag ({view.receiptReview.prohibitedScreen.version}): mentions {describeMatches(view.receiptReview.prohibitedScreen.unresolved)}. The claimant acknowledged it is not claimed under another category. This flag does not change the allocation or any approval.</p> : null}
      {view.receiptReview && <p className="muted">Claimant confirmed categories at <time dateTime={view.receiptReview.confirmedAt.toISOString()}>{reviewTime(view.receiptReview.confirmedAt)}</time>. This is separate from expense approval.</p>}
      {CLAIM_ID.test(claimId) && <p><Link href={`/claims/${claimId}/receipt`}>Review receipt and confirmed categories</Link></p>}
    </section>
    <section className="funding-evidence" id="funding-review"><h2>Check the funding rules</h2><p>Each split uses an approved policy. General still follows organization-wide prohibitions.</p><details><summary>Why each fund can pay</summary><ul className="reasons">{edges.map(edge => <li key={`${edge.fundId}:${edge.lineId}`}><strong>{lineDescription(edge.lineId)} · {usd(edge.amountCents)} · policy v{edge.policyVersion}</strong><p>{edge.reason}</p></li>)}</ul></details>
      <p>Recipient: the claimant's configured sandbox Personal account {recipient[0]?.slice(0, 2)}***@{recipient[1]}. The full configured recipient is bound to the decision hash.<RecipientNote recipient={claim.payeeEmail} /></p>
      {approver && <details className="recipient-review"><summary>Review exact sandbox recipient</summary><p>{claim.payeeEmail}</p><p>Compare this address with the intended recipient before approving. Hash binding prevents changed terms from reusing approval; it does not establish who owns an account. This address is private review data. Keep it out of shared reports and recordings.</p></details>}
      {view.feasible && !policyBlocked && user.id === claim.claimantId && ["DRAFT", "AWAITING_APPROVAL"].includes(claim.status) && <ActionForm claimId={claimId} action="freeze" button={decision ? "Confirm current allocation" : "Freeze allocation for approval"} />}
    </section>
    <section className="approval-section" id="approvals"><h2>Two independent approvals</h2><p>{decision ? `${approvals.length} of 2 approvals recorded.` : "The claimant must freeze this allocation before approval."}</p>{decision && <p className="claim-reference">Decision {decision.decisionHash.slice(0, 16)}. Both approvals bind this reference.</p>}
      <ul>{approvals.map(row => <li key={row.approverId}>{row.displayName} approved at <time dateTime={row.approvedAt.toISOString()}>{reviewTime(row.approvedAt)}</time>.</li>)}</ul>
      {approver && decision && claim.status === "AWAITING_APPROVAL" && !approvedByMe && <ActionForm claimId={claimId} action="approve" decisionId={decision.id} decisionHash={decision.decisionHash} button="Approve these terms" />}
      {approver && ["DRAFT", "AWAITING_APPROVAL"].includes(claim.status) && <details><summary>Reject this claim instead</summary><ActionForm claimId={claimId} action="reject" button="Reject claim"><label htmlFor="reason">Reason for rejection</label><input id="reason" name="reason" required maxLength={500} /></ActionForm></details>}
      {view.rejections.map((rejection, index) => <p key={index}>Rejected by {rejection.rejectedBy}: {rejection.reason}</p>)}
    </section>
    {!handoffReady && paymentSection}
    {giftNotes.length > 0 ? <GiftNotes claimId={claimId} entries={giftNotes} canApprove={approver} /> : recognized && judgeSession() ? <section id="donor-notes"><h2>Donor impact notes</h2><p>No gift has been applied to this receipt.</p></section> : null}
    <section><h2>Fixture accounting</h2><p>Restricted funds: {usd(report.restrictedCents)}. General: {usd(report.generalCents)}.</p>{view.fixtureNotStarted ? <p className="notice">Opening journals have not been created yet. No ledger tie-out is claimed for this untouched fixture.</p> : <p className={report.matches ? "notice" : "notice warning"}>Ledger tie-out: {report.matches ? "Matches" : "Needs investigation"}.</p>}<details><summary>Inspect accounting figures</summary><p>Opening fixture cash: {usd(report.fixtureCashCents)}. Recorded provider activity: {usd(report.providerActivityCashDeltaCents)}. Book cash: {usd(report.bookCashCents)}. These are accounting figures, not PayPal available funds.</p></details></section>
    {view.donations.length > 0 && <section><h2>Designated sandbox donations</h2><p>These are additional provider-backed donations. Fixture opening credits remain labeled separately.</p>{view.donations.map(donation => <div key={donation.orderId}><p>{view.funds.find(fund => fund.id === donation.fundId)?.name}: {donation.status === "COMPLETED" ? `${usd(donation.grossCents!)} gross, ${usd(donation.feeCents!)} fee charged to General, ${usd(donation.netCents!)} net cash.` : "Pending, no accounting posted."}</p><details><summary>Inspect donation identifiers</summary><p>Order {donation.orderId}. Capture {donation.captureId ?? "not yet known"}. Status {donation.providerStatus}.</p></details></div>)}</section>}
    <details><summary>Claim and decision reference</summary><p>Claim {claim.id}. {decision ? `Decision ${decision.decisionHash.slice(0, 16)}.` : "No frozen decision."}</p></details>
    <footer>Accounting-inspired demo model, pending nonprofit accountant review. Paid appears only after an independently fetched payout item reports success. This page does not enable production payments.</footer>
  </main>;
}
