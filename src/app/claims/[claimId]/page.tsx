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
import { currentPhotoLink } from "../../../receipt/photo-reads";
import { requireReceiptConfirmation } from "../../../receipt/guard";
import { claimFailureNotices } from "../../../server/claim-notices";
import { categoryNames as categories, reviewTime } from "../../../server/display";
import { BUDGET_NAMES } from "../../../ai/categories";
import { Journey } from "../../journey";
import { AiStatusCard, ClaimHeader, DecisionPanel, PayPalStatusCard, Workspace, type ShellState, type SummaryData } from "../../workspace";
import { shortClaimRef } from "../../claim-ref";
import { usd as usdGrouped } from "../../../analytics/model";
import { STATUS_LABELS, aiCard, claimStage, claimantLabel, currentNote, paypalCard } from "../../shell-copy";
import { payoutWords } from "../../payout-copy";
import { receiptAuditLabel } from "../../../ai/audit";
import { AI_OFF_MESSAGES, claudeAiStatus, configuredReceiptAiName } from "../../../ai/provider";
import { FundingSummary, hasFundingSummary } from "../../funding-summary";
import { judgeSession, paymentConfigured } from "../../../server/judge-mode";
import { PayPalHandoff, RecipientNote } from "../../paypal-handoff";
import { describeMatches } from "../../receipts/prohibited-notice";
import { readGiftNotes } from "../../../donation/note";
import { GiftNotes } from "./gift-notes";
import { PolicyChecks } from "./policy-checks";
import { AutomatedTrail } from "./automated-trail";
import { TITLE_AUTO_NOT_SENT, FOOTER_AUTOPILOT, APPROVALS_HEADING_AUTOPILOT, REFERENCE_BINDS_AUTOPILOT, REVIEW_COUNT_AUTOPILOT, APPROVALS_HEADING_ONE, FOOTER_NO_HOLDS_DONE, FOOTER_NO_HOLDS_WAITING, HEADING_AWAITING_ONE, REFERENCE_BINDS_ONE } from "../../../fund-modes/review-copy";
import { ruleChecksSummary } from "../../../policy/copy";

const usd = (cents: bigint) => `${cents < 0n ? "-" : ""}$${(cents < 0n ? -cents : cents) / 100n}.${((cents < 0n ? -cents : cents) % 100n).toString().padStart(2, "0")}`;
const notices: Record<string, string> = {
  ...claimFailureNotices,
  frozen: "The allocation is frozen. Tara and Ben can now approve the same terms.",
  unfunded: "Current funds cannot cover this claim. No partial allocation was frozen.",
  "approval-saved": "Your approval is saved. A different approver is still required.",
  approved: "Both approvals are complete. The obligation is recognized; payment has not been sent.",
  "takeover-saved": "Your approval is saved. A second approver is still required.",
  "takeover-done": "Both approvals are complete. A person can now send the payment.",
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
  "policy-ran": "Policy checks ran and are stored for this frozen decision. They add information only.",
  "policy-exists": "Policy checks already ran for this frozen decision. The stored result is shown.",
  "policy-stale": "These terms changed or the claim is no longer awaiting approval. Nothing was stored.",
  "policy-refused": "Policy checks could not run. Nothing was stored.",
  "policy-model-ran": "The model check ran and is stored for this frozen decision. It adds information only.",
  "policy-model-exists": "The model check already ran for this frozen decision. The stored result is shown.",
  "policy-model-off": "The model check is off in this session. Nothing was stored.",
};
export default async function ClaimPage({ params, searchParams }: { params: Promise<{ claimId: string }>; searchParams: Promise<{ notice?: string }> }) {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  const { claimId } = await params; if (!/^[A-Za-z0-9-]{1,64}$/.test(claimId)) notFound();
  if (judgeSession() && !CLAIM_ID.test(claimId)) redirect("/");
  const db = getDatabase();
  let receipt: Awaited<ReturnType<typeof readReceiptView>> | null = null;
  if (CLAIM_ID.test(claimId)) {
    receipt = await readReceiptView(db, claimId, user.id).catch(() => null);
    if (!receipt) notFound();
    if (!receipt.confirmation) redirect(`/claims/${claimId}/receipt`);
    const receiptClaim = receipt.claim;
    const valid = await db.transaction(tx => requireReceiptConfirmation(tx, receiptClaim)).then(() => true, () => false);
    if (!valid) redirect(`/claims/${claimId}/receipt`);
  }
  const view = await loadClaimView(db, claimId, user.id).catch(() => null);
  if (!view) notFound();
  const { claim, decision, edges, comparison, approvals, attempt, report } = view;
  const total = view.lines.reduce((sum, line) => sum + line.amountCents, 0n);
  const canPay = paymentConfigured(claim.payeeEmail);
  const baselineGeneral = comparison?.status === "FUNDED" && comparison.unrestrictedCents !== undefined ? BigInt(comparison.unrestrictedCents) : undefined;
  const approver = user.role === "APPROVER" && user.id !== claim.claimantId;
  // IAC-405 piece G: display only. Reads the flag, a valid configuration, the key's presence and the budget, never the key's value.
  const complianceAi = claudeAiStatus(process.env, "AI_COMPLIANCE_ENABLED");
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
  // IAC-415 PR 8: the one boolean that decides whether the Refresh status form renders. The form and payoutWords both read it, so the words never promise a button that is absent. It stays on a PAID claim on purpose: refreshAttempt maps a later REVERSED or REFUNDED item to MANUAL_REVIEW, and this button is the only browser path that detects it.
  const showRefresh = canPay && approver && Boolean(attempt?.payoutBatchId);
  // title and detail are non-null only for a PAYOUT_PROCESSING claim (PE-01), so each `??` below falls through to the PAYOUT_ISSUE text exactly as the old last branch did.
  const words = payoutWords({ claimStatus: claim.status, attempt: attempt ?? null, canPay, refreshForm: showRefresh, usd });
  const statusLabel = handoffReady ? "Approved / unpaid" : STATUS_LABELS[claim.status];
  // IAC-405 PR A follow-up: true only when the server read this claim's stored decision as needing one approval (no holds found). It comes from view.reviewMode, never from the client.
  const oneApproval = view.reviewMode === "ASSISTED_NO_HOLDS";
  // IAC-405 PR P merge fix: true only for a claim recognized by an automated record and paid with no person involved (stored records, view.reviewMode). A claim not yet sent, or one a person began to take over, keeps the two-person words.
  const autoReview = view.reviewMode === "AUTO_RECOGNIZED_SENT";
  // The same recognized claim before two takeover approvals exist: no one can send yet, so the title must not say the handoff is ready.
  const autoWaiting = view.reviewMode === "AUTO_RECOGNIZED_PEOPLE" && claim.status === "APPROVED" && approvals.length < 2;
  const heading = policyBlocked ? "Organization policy stops this expense."
    : claim.status === "DRAFT" ? view.feasible ? `${usd(total - view.generalCents)} restricted. ${usd(view.generalCents)} General.` : "This claim needs more eligible funding."
    : claim.status === "AWAITING_APPROVAL" ? decision ? approvals.length === 0 ? oneApproval ? HEADING_AWAITING_ONE : "Frozen. Awaiting two approvals." : `${approvals.length} of 2 approvals saved. One more needed.` : "Awaiting approval."
    : claim.status === "APPROVED" ? autoWaiting ? `${usd(total)} ${TITLE_AUTO_NOT_SENT}` : handoffReady ? `${usd(total)} approved. PayPal handoff ready. Unpaid.` : `${usd(total)} approved. Payment is a separate decision.`
    : claim.status === "PAID" ? `${usd(total)} paid. Settlement verified.`
    : claim.status === "REJECTED" ? "Claim rejected. Nothing is paid."
    : words.title ?? "Payment issue. Resolve it before another attempt.";
  const stage = claimStage(claim.status, true);
  const claimantName = claimantLabel(user, claim.claimantId);
  const summary: SummaryData = { claimant: claimantName, program: claim.program.charAt(0).toUpperCase() + claim.program.slice(1), amount: usd(total), status: statusLabel!, statusCode: claim.status, reviews: approvals.length,
    details: [["Program", claim.program], ["Expense date", claim.incurredOn], ["Reimbursement payable", ["APPROVED", "PAYOUT_PROCESSING", "PAYOUT_ISSUE"].includes(claim.status) ? usd(total) : "$0.00"]], note: words.note ?? currentNote(claim.status) };
  // IAC-373 shell cards: only facts this page already loaded. C-104 is a preclassified example with no receipt review.
  const aiAccepted = Boolean(view.receiptReview?.lines.some(line => line.provenance === "AI_ACCEPTED"));
  const savedSuggestion = receipt?.suggestion?.status === "READY" ? receiptAuditLabel(receipt.suggestion) : null;
  // IAC-384: the Receipt rail step says so when the newest revision links a photo read. One read of the review row, only for a receipt claim; no other page changes.
  const photoLinked = CLAIM_ID.test(claimId) ? (await currentPhotoLink(db, claimId)).linked : false;
  const shellState: ShellState = { typedReceipt: CLAIM_ID.test(claimId), ...(photoLinked ? { photoReceipt: true } : {}),
    ai: aiCard({ applicable: CLAIM_ID.test(claimId), suggestion: aiAccepted ? "READY" : "NONE", confirmed: true, aiAccepted, savedModel: savedSuggestion?.model ?? null, configured: configuredReceiptAiName() }),
    paypal: paypalCard({ claimStatus: claim.status, approvals: approvals.length, amount: usd(total), takeoverWaiting: autoWaiting, payout: { attempt: attempt ? { state: attempt.state, itemStatus: attempt.itemStatus, payoutBatchId: attempt.payoutBatchId } : null, keyless: !canPay } }) };
  const receiptLink = CLAIM_ID.test(claimId) ? `/claims/${claimId}/receipt` : undefined;
  // Trust v2 (IAC-415) Rule checks rows. Only checks the server evaluated and this page loaded: the stored categories against the
  // organization's prohibited list, the stored receipt text screen (absent for a seeded fixture), and the funding result. Layout only.
  const prohibitedLines = view.lines.filter(line => view.input.prohibitedCategories.includes(line.category));
  const screen = view.receiptReview?.prohibitedScreen;
  const rules: { key: string; label: string; detail: string; state: "ok" | "note" | "stop" }[] = [
    { key: "categories", label: "Prohibited categories", state: prohibitedLines.length ? "stop" : "ok", detail: prohibitedLines.length ? `${prohibitedLines.length} of ${view.lines.length} lines use a prohibited category.` : "No line uses a prohibited category." },
    ...(screen ? [{ key: "text", label: "Receipt text screen", state: screen.unresolved.length ? "note" as const : "ok" as const, detail: screen.unresolved.length ? "Flagged text was acknowledged by the claimant." : screen.matches.length ? "A flagged term matches a category the claimant confirmed." : "No prohibited terms found in the receipt text." }] : []),
    { key: "funding", label: "Funding eligibility", state: view.feasible ? "ok" : "stop", detail: view.feasible ? "Eligible funds cover the whole claim." : "Eligible funds cannot cover the whole claim." },
  ];
  const clearRules = rules.filter(rule => rule.state === "ok").length;
  const stateWord = { ok: "Clear", note: "Noted", stop: "Stop" } as const;
  const showSplit = view.feasible && hasFundingSummary(total, view.generalCents, edges, view.funds);
  // IAC-415 polish: the payout block of the Decision panel. The status card is its heading and the only place that says the payout state and
  // "Approved does not mean paid." The keyless handoff rows, the attempt facts and the send, refresh and retry forms follow it. Forms are unchanged.
  const paymentSection = (
    <div className="sec payout" id="payment"><PayPalStatusCard card={shellState.paypal} />
      <p>Organization-wide open payable: {usd(report.openPayableCents)}.</p>
      {words.balance && <p>{words.balance}</p>}
      {!canPay && !attempt && (claim.status === "APPROVED" ? <PayPalHandoff amount={total} recipient={claim.payeeEmail} /> : <p>Payment access is disabled for this review. After two approvals, inspect the read-only PayPal handoff. No payment will be sent.</p>)}
      {attempt && <><dl className="payment-details"><dt>Attempt</dt><dd>{attempt.state}</dd><dt>Batch status</dt><dd>{attempt.batchStatus ?? "Not known"}</dd><dt>PayPal item status</dt><dd>{attempt.itemStatus ?? "Not known"}</dd><dt>Reported fee</dt><dd>{attempt.feeCents === null ? "Not yet reported" : usd(attempt.feeCents)}</dd><dt>Last error</dt><dd>{attempt.lastErrorCode ?? "None recorded"}</dd><dt>Settlement date</dt><dd>{attempt.settledOn ?? "Not settled"}</dd></dl><details><summary>Inspect payment identifiers</summary><dl className="payment-details"><dt>Sender batch ID</dt><dd>{attempt.senderBatchId}</dd><dt>PayPal batch ID</dt><dd>{attempt.payoutBatchId ?? "Not known"}</dd><dt>PayPal item ID</dt><dd>{attempt.payoutItemId ?? "Not known"}</dd></dl></details></>}
      {canPay && approver && decision && approvedByMe && claim.status === "APPROVED" && !attempt && <ActionForm claimId={claimId} action="send" decisionHash={decision.decisionHash} button={`Send ${usd(total)} with PayPal`}><label className="confirm"><input type="checkbox" name="confirmSandbox" value="yes" required /> I confirm this is the approved {usd(total)} reimbursement.</label></ActionForm>}
      {showRefresh && <ActionForm claimId={claimId} action="refresh" button="Refresh status" />}
      {canPay && approver && decision && attempt && claim.status === "PAYOUT_ISSUE" && isRetryableAttempt(attempt) && (view.retryAuthorization ? <ActionForm claimId={claimId} action="retry" decisionHash={decision.decisionHash} button={`Send authorized retry ${view.retryAuthorization.attemptNumber} with PayPal`}><input type="hidden" name="authorizationId" value={view.retryAuthorization.id} /><label className="confirm"><input type="checkbox" name="confirmSandbox" value="yes" required /> I confirm this new attempt is for the unchanged {usd(total)} reimbursement.</label></ActionForm> : <ActionForm claimId={claimId} action="authorize-retry" decisionHash={decision.decisionHash} button={`Authorize retry ${attempt.attemptNumber + 1}`}><input type="hidden" name="failedAttemptId" value={attempt.id} /><label className="confirm"><input type="checkbox" name="confirmSandbox" value="yes" required /> I authorize one retry for the same recipient and open amount.</label></ActionForm>)}
      {attempt && <p>No automatic retry is available. Unknown outcomes require manual reconciliation. Unclaimed and held payments require polling; a confirmed terminal failure requires separate retry authorization.</p>}
    </div>
  );
  const claimForms = <>
    {view.feasible && !policyBlocked && user.id === claim.claimantId && claim.status === "DRAFT" && <ActionForm claimId={claimId} action="freeze" button={decision ? "Confirm current allocation" : "Freeze allocation for approval"} />}
    {/* Awaiting claim: the freeze is a re-check, not a step. The copy states what freezeDecision does (tests/ledger.integration.test.ts FRZ-01). */}
    {view.feasible && !policyBlocked && user.id === claim.claimantId && claim.status === "AWAITING_APPROVAL" && <details className="refreeze"><summary>Receipt or fund policy changed? Re-check the frozen terms</summary>
      <p>If nothing changed, the same frozen terms and their approvals stay. If the receipt or fund policy changed, the old terms and their reservations are released, new terms are frozen when funds cover them, and earlier approvals no longer apply.</p>
      <ActionForm claimId={claimId} action="freeze" button="Re-check the frozen terms" /></details>}
    {approver && decision && claim.status === "AWAITING_APPROVAL" && !approvedByMe && <ActionForm claimId={claimId} action="approve" decisionId={decision.id} decisionHash={decision.decisionHash} button="Approve these terms" />}
    {approver && ["DRAFT", "AWAITING_APPROVAL"].includes(claim.status) && <details><summary>Reject this claim instead</summary><ActionForm claimId={claimId} action="reject" button="Reject claim"><label htmlFor="reason">Reason for rejection</label><input id="reason" name="reason" required maxLength={500} /></ActionForm></details>}
  </>;
  // Say it once: the Next decision card only guides a claim that still needs a decision or has a payment in flight. Approved, paid and rejected claims
  // state themselves in the title and the Decision panel.
  const guided = ["DRAFT", "AWAITING_APPROVAL", "PAYOUT_PROCESSING", "PAYOUT_ISSUE"].includes(claim.status);
  return <Workspace user={user} stage={stage} summary={summary} state={shellState} policyBlocked={policyBlocked} {...(oneApproval ? { required: 1 as const } : {})} {...(autoReview ? { required: "auto" as const } : {})} decisionFirst={handoffReady} links={{ ...(receiptLink ? { 1: receiptLink, 2: receiptLink } : {}), 3: "#funding-review", 4: "#approvals" }}
    header={<ClaimHeader claimId={claim.id} heading={heading} data={summary} />}
    decision={<DecisionPanel data={summary}
      split={showSplit ? <section className="sec" aria-labelledby="fund-split-title"><h3 id="fund-split-title">Fund split</h3><FundingSummary total={total} general={view.generalCents} edges={edges} funds={view.funds} /></section> : undefined}
      approvals={<section className="sec approval-section" id="approvals" aria-labelledby="approvals-title"><h3 id="approvals-title">{autoReview ? APPROVALS_HEADING_AUTOPILOT : <>{oneApproval ? APPROVALS_HEADING_ONE : "Two independent approvals"}</>}</h3><p className="hybrid-review-count" data-review-mode={view.reviewMode}>{autoReview ? REVIEW_COUNT_AUTOPILOT : <>Human reviews: {view.reviewMode === "ASSISTED_NO_HOLDS" ? <><strong>{approvals.length} of 1</strong>, Assisted, no holds found</> : <strong>{approvals.length} of 2</strong>}</>}</p>{!decision && <p>The claimant must freeze this allocation before approval.</p>}{decision && <p className="claim-reference">Decision {decision.decisionHash.slice(0, 16)}. {autoReview ? REFERENCE_BINDS_AUTOPILOT : <>{oneApproval ? REFERENCE_BINDS_ONE : "Both approvals bind this reference."}</>}</p>}
        <ul>{approvals.map(row => <li key={row.approverId}>{row.displayName} approved at <time dateTime={row.approvedAt.toISOString()}>{reviewTime(row.approvedAt)}</time>.</li>)}</ul>
        {view.rejections.map((rejection, index) => <p key={index}>Rejected by {rejection.rejectedBy}: {rejection.reason}</p>)}</section>}
      payout={paymentSection}
      actions={claimForms}
      more={<>
        <details className="hybrid-case-details accounting"><summary>Accounting</summary><p>Restricted funds: {usdGrouped(report.restrictedCents)}. General: {usdGrouped(report.generalCents)}.</p>{view.fixtureNotStarted ? <p className="notice">Opening journals have not been created yet. No ledger tie-out is claimed for this untouched fixture.</p> : <p className={report.matches ? "notice" : "notice warning"}>Ledger tie-out: {report.matches ? "Matches" : "Needs investigation"}.</p>}<p>Opening fixture cash: {usdGrouped(report.fixtureCashCents)}. Recorded provider activity: {usdGrouped(report.providerActivityCashDeltaCents)}. Book cash: {usdGrouped(report.bookCashCents)}. These are accounting figures, not PayPal available funds.</p></details>
        <details className="hybrid-case-details reference"><summary>Reference</summary><p>Claim {claim.id}. {decision ? `Decision ${decision.decisionHash.slice(0, 16)}.` : "No frozen decision."}</p><RecipientNote recipient={claim.payeeEmail} /></details>
      </>} />}>
    {notice && notices[notice] && !(handoffReady && notice === "approved") && <p role="status" className="notice">{notices[notice]}</p>}
    {guided && <Journey emphasizeDetail={["PAYOUT_ISSUE", "PAYOUT_PROCESSING"].includes(claim.status)}
      title={policyBlocked ? "Organization policy stops this expense." : claim.status === "DRAFT" ? approver ? "The claimant must freeze the terms first." : view.feasible ? "Check the split, then freeze these terms." : "More eligible funding is needed." : claim.status === "AWAITING_APPROVAL" ? approver && !approvedByMe ? "Review the frozen terms." : user.id === claim.claimantId ? "Waiting for two approvers." : "Hand this claim to a different approver." : claim.status === "PAYOUT_PROCESSING" ? "Check the payment result. Do not send again." : "Resolve the payment issue before another attempt."}
      detail={policyBlocked ? "A confirmed item is prohibited by organization policy. General cannot cover it either. Correct the receipt before freezing any terms." : claim.status === "DRAFT" ? approver ? "You can inspect the draft, but only its claimant can freeze an allocation for approval." : view.feasible ? "Review the expense and funding below. Freezing holds the eligible funds and sends the same terms to two independent approvers. It does not pay the claim." : "The current rules and fund balances cannot cover the whole expense. No partial allocation can be frozen." : claim.status === "AWAITING_APPROVAL" ? approver && !approvedByMe ? "Check the expense, categories, recipient and split below before you approve. One person's approval cannot authorize payment." : user.id === claim.claimantId ? "Two different approvers must approve these frozen terms. You cannot approve your own expense." : "Sign out above, then have another authorized approver sign in and open this same claim from the home page. The claimant cannot approve their own expense." : words.detail ?? "Review the attempt and error below. Unknown outcomes need manual reconciliation; confirmed terminal failures need separate retry authorization."}
      href={policyBlocked ? `/claims/${claimId}/receipt` : claim.status === "DRAFT" ? "#funding-review" : claim.status === "AWAITING_APPROVAL" ? "#approvals" : "#payment"}
      action={policyBlocked ? "Review the receipt" : claim.status === "DRAFT" ? "Inspect funding and terms" : claim.status === "AWAITING_APPROVAL" ? "Inspect the approvals" : "Inspect payment status"}
      aside={claimId === "C-104" ? "C-104 is a separate preclassified $500 example. It did not pass through the new receipt's AI review." : `You are still reviewing the same claim: ${claim.vendor}.`} />}
    <section aria-labelledby="expense-review-title" className="panel receipt-panel expense-review"><h2 id="expense-review-title">Review the expense terms</h2>
      <p className="sub">{claim.vendor} · {usd(total)}. Receipt dated {claim.incurredOn}. Program: {claim.program}.</p>
      <p>{decision ? "Approvals bind the frozen version of these terms. Review the current details below; the server checks for changed claim or policy terms before accepting approval." : "Review the items and categories before freezing the allocation."}</p>
      <ul className="expense-lines">{view.lines.map(line => {
        const review = view.receiptReview?.lines.find(item => item.lineId === line.id);
        // The verdict row states who decided and, for a prohibited category, the stop. It never shows an eligibility pass: the AI suggests, rules and people decide.
        const stopped = view.input.prohibitedCategories.includes(line.category);
        return <li key={line.id} data-line-stop={stopped ? "true" : undefined}><h3>{line.id}: {line.description} · {usd(line.amountCents)}</h3>
          <p>Category: <strong>{categories[line.category] ?? line.category}</strong>. Budget: {BUDGET_NAMES[line.budgetLine] ?? line.budgetLine}.</p>
          {stopped && <p className="verdict-stop"><span className="stop-icon" aria-hidden="true" /><strong>Not allowed by organization policy.</strong></p>}
          {review ? <><div className="provenance-row"><p className="provenance-tags">{review.provenance === "AI_ACCEPTED" ? <><span className="ai-tag">AI suggested</span><span className="ai-tag confirmed">Person confirmed</span></> : <span className="ai-tag confirmed">Person chose</span>}</p></div>
            {review.reason && <p>Claimant's reason: {review.reason}</p>}
            {review.proposal && <details><summary>Original AI suggestion: {categories[review.proposal.category] ?? review.proposal.category}</summary><blockquote>{review.proposal.quote}</blockquote><p>The quote matches receipt text. It does not prove the category or funding eligibility.</p></details>}
          </> : <p>Preclassified example. No AI review or receipt confirmation is claimed for this item.</p>}
        </li>;
      })}</ul>
      {view.receiptReview?.prohibitedScreen?.unresolved.length ? <p className="notice prohibited-flag" role="note">Receipt text flag ({view.receiptReview.prohibitedScreen.version}): mentions {describeMatches(view.receiptReview.prohibitedScreen.unresolved)}. The claimant acknowledged it is not claimed under another category. This flag does not change the allocation or any approval.</p> : null}
      {(view.receiptReview || CLAIM_ID.test(claimId)) && <p className="receipt-meta-line">{view.receiptReview && <span className="muted">Claimant confirmed categories at <time dateTime={view.receiptReview.confirmedAt.toISOString()}>{reviewTime(view.receiptReview.confirmedAt)}</time>. This is separate from expense approval.</span>}{CLAIM_ID.test(claimId) && <Link href={`/claims/${claimId}/receipt`}>Review receipt and confirmed categories</Link>}</p>}
      <AiStatusCard card={shellState.ai} />
    </section>
    <section className="panel rules-panel" id="rule-checks" aria-labelledby="rule-checks-title"><h2 id="rule-checks-title">Checks</h2>
      <p className="sub">{ruleChecksSummary(clearRules, rules.length, view.policyChecks?.run?.flags)} Each row comes from stored data this page loaded.</p>
      <ul className="rules">{rules.map(rule => <li key={rule.key} data-state={rule.state}><span className="rule-state">{stateWord[rule.state]}</span><span className="rule-body"><strong>{rule.label}</strong>{rule.detail}</span></li>)}</ul>
    {view.policyChecks && <PolicyChecks claimId={claimId} decisionHash={view.policyChecks.decisionHash} run={view.policyChecks.run} canRun={claim.status === "AWAITING_APPROVAL"} modelEligible={Boolean(view.receiptReview)} aiOff={complianceAi.on ? null : AI_OFF_MESSAGES[complianceAi.reason]} headingLevel={3} {...(oneApproval ? { footer: claim.status === "AWAITING_APPROVAL" ? FOOTER_NO_HOLDS_WAITING : FOOTER_NO_HOLDS_DONE } : {})} {...(autoReview ? { footer: FOOTER_AUTOPILOT } : {})} />}
    </section>
    <AutomatedTrail claimId={claimId} viewer={user} />
    <section className="panel funding-evidence" id="funding-review"><h2>Check the funding rules</h2><p>Each split uses an approved policy. General still follows organization-wide prohibitions.</p>
      <div className="comparison-grid">
      <section className="comparison-card chosen"><p className="eyebrow">Computed by funding rules</p><h2>{view.feasible ? `${usd(view.generalCents)} from General` : "No partial allocation"}</h2>{baselineGeneral !== undefined && view.feasible && baselineGeneral > view.generalCents && <p><strong>{usd(baselineGeneral - view.generalCents)} less General than this comparison</strong>, under its fixed fund order. More flexible funding remains for expenses restricted funds cannot cover.</p>}{split(edges)}</section>
      <section className="comparison-card"><p className="eyebrow">Pay from the first fund that allows it</p><h2>{baselineGeneral === undefined ? comparison ? "Cannot fully fund" : "Historical comparison unavailable" : `${usd(baselineGeneral)} from General`}</h2><p>This comparison takes each line in order and spends from its first eligible fund. It can leave less room for later items.</p><details><summary>See comparison allocation</summary>{split(comparison?.edges ?? [])}<p>Sorted line IDs, then fund IDs. A different fund order can remove the difference. This is not measured savings over a treasurer.</p></details></section>
      </div>
      <details><summary>Why each fund can pay</summary><ul className="reasons">{edges.map(edge => <li key={`${edge.fundId}:${edge.lineId}`}><strong>{lineDescription(edge.lineId)} · {usd(edge.amountCents)} · policy v{edge.policyVersion}</strong><p>{edge.reason}</p></li>)}</ul></details>
      {!handoffReady && <p>Recipient: the claimant's configured PayPal account {recipient[0]?.slice(0, 2)}***@{recipient[1]}. The full configured recipient is bound to the decision hash.</p>}
      {approver && <details className="recipient-review"><summary>Review exact recipient</summary><p>{claim.payeeEmail}</p><p>Compare this address with the intended recipient before approving. Hash binding prevents changed terms from reusing approval; it does not establish who owns an account. This address is private review data. Keep it out of shared reports and recordings.</p></details>}
    </section>
    {giftNotes.length > 0 ? <GiftNotes claimId={claimId} entries={giftNotes} canApprove={approver} /> : recognized && judgeSession() ? <section id="donor-notes"><h2>Donor impact notes</h2><p>No gift has been applied to this receipt.</p></section> : null}
    {view.donations.length > 0 && <section><h2>Designated donations</h2><p>These are additional provider-backed donations. Opening credits remain labeled separately.</p>{view.donations.map(donation => <div key={donation.orderId}><p>{view.funds.find(fund => fund.id === donation.fundId)?.name}: {donation.status === "COMPLETED" ? `${usd(donation.grossCents!)} gross, ${usd(donation.feeCents!)} fee charged to General, ${usd(donation.netCents!)} net cash.` : "Pending, no accounting posted."}</p><details><summary>Inspect donation identifiers</summary><p>Order {donation.orderId}. Capture {donation.captureId ?? "not yet known"}. Status {donation.providerStatus}.</p></details></div>)}</section>}
    <footer>Accounting-inspired demo model, pending nonprofit accountant review. Paid appears only after an independently fetched payout item reports success. This page does not enable production payments.</footer>
  </Workspace>;
}
