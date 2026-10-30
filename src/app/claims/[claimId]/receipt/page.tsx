import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { findSession, SESSION_COOKIE } from "../../../../server/auth";
import { getDatabase } from "../../../../server/db";
import { readReceiptView, suggestionHash } from "../../../../receipt/service";
import { DraftForm } from "../../../receipts/draft-form";
import { CategoryChoice } from "../../../receipts/category-choice";
import { SuggestForm } from "../../../receipts/suggest-form";
import { readExpenseReview } from "../../../../proposal/service";
import { proposalPresentation, proposalMoney } from "../../../../proposal/presentation";
import { ProposalReview } from "../../../receipts/proposal-review";
import { Journey } from "../../../journey";
import { quoteEvidence } from "../../../receipts/quote-evidence";
import { ReceiptEvidence } from "../../../receipts/receipt-evidence";
import { receiptAuditLabel } from "../../../../ai/audit";
import { CATEGORY_NAMES } from "../../../../ai/categories";
const names = CATEGORY_NAMES;
const money = (value: bigint) => `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
export default async function ReceiptPage({ params, searchParams }: { params: Promise<{ claimId: string }>; searchParams: Promise<{ notice?: string }> }) {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value); if (!user) redirect("/login");
  const id = (await params).claimId;
  const preparationEnabled = process.env.AI_EXPENSE_PROPOSALS_ENABLED === "true" && user.role === "CLAIMANT";
  const combined = preparationEnabled ? await readExpenseReview(getDatabase(), id, user.id).catch(() => null) : null;
  const view = preparationEnabled ? combined?.receipt : await readReceiptView(getDatabase(), id, user.id).catch(() => null); if (!view) notFound();
  const { claim, lines, review, suggestion, confirmation } = view;
  const evidence = quoteEvidence(review, claim.version, lines.map(line => line.id), suggestion);
  // Provider and model come from the stored audit of the READY suggestion, never from the environment.
  const aiLabel = suggestion?.status === "READY" ? receiptAuditLabel(suggestion) : null;
  const aiName = aiLabel?.short ?? "AI";
  const editable = view.canEdit;
  const running = suggestion?.status === "RUNNING" && Date.now() - suggestion.requestedAt.getTime() < 65000;
  const notice = (await searchParams).notice;
  const notices: Record<string, string> = { created: "Unpaid draft created. Review categories before allocating funds.", edited: "Edits saved. Earlier suggestions and confirmation no longer apply.", suggested: "AI suggestions are ready. Verify each quote and category before confirming.", manual: "AI could not provide a usable review. Choose each category yourself and explain your choice.", confirmed: "Categories confirmed. No allocation has been frozen and no payment requested.", running: "An AI review is already in progress. No second request was started. Refresh this page to see its result.", "review-changed": "That form was invalid or the review changed before it was submitted. Your saved draft is below. Review the current information and try again. No allocation or payment was requested." };
  notices["proposal-updated"] = "Preparation result is below. Review every category before confirming.";
  const hidden = <><input type="hidden" name="reviewId" value={review.id} /><input type="hidden" name="draftHash" value={review.draftHash} /></>;
  const editForm = <DraftForm id={id} reviewId={review.id} hash={review.draftHash} vendor={claim.vendor} program={claim.program} incurredOn={claim.incurredOn} source={review.source} total={money(lines.reduce((sum, l) => sum + l.amountCents, 0n))} lines={lines.map(line => ({ description: line.description, amount: money(line.amountCents) }))} />;
  return <main className="claim-page receipt-page"><header className="page-header"><Link href="/">AidTrace</Link><span>{user.displayName}</span><form action="/api/auth/logout" method="post"><button className="secondary">Sign out</button></form></header>
    <Journey stage={confirmation ? claim.status === "DRAFT" ? 3 : ["AWAITING_APPROVAL", "REJECTED"].includes(claim.status) ? 4 : 5 : 2} title={confirmation ? claim.status === "DRAFT" ? "Categories saved. Review the funding next." : "Categories saved. Check the claim's current status." : running ? "The AI review is in progress." : suggestion?.status === "READY" ? "Check the suggestions, then confirm every category." : "Prepare suggestions, or review the categories yourself."}
      detail={confirmation ? claim.status === "DRAFT" ? user.role === "CLAIMANT" ? "Open the allocation, check which fund pays each item, then freeze the terms for two human approvers. Confirmation alone did not reserve funds or approve payment." : "The categories are confirmed. Review the allocation; only the claimant can freeze it for approval." : "This is the saved category review. Open the claim to see its current approval and payment state; do not treat this receipt page as a new request." : running ? "Wait for the result, then refresh preparation status below. Do not submit a second request." : suggestion?.status === "READY" ? "Compare each category and quote with the receipt. Correct anything wrong, check the confirmation box and confirm below. Funding comes next." : "Use Prepare expense proposal below for AI help. You can also choose all categories manually with a reason. You must confirm them before funding can be frozen."}
      href={confirmation ? `/claims/${id}` : "#category-review"} action={confirmation ? claim.status === "DRAFT" ? "Continue to funding" : "View current claim" : "Go to category review"} />
    <p className="eyebrow">AI suggestion / Human decision</p><div className="title-row"><h1>{confirmation ? "Categories checked." : "Check each receipt category."}</h1><span className="state-badge">{confirmation ? "Confirmed by claimant" : running ? "AI preparing" : "Your review"}</span></div><p>{claim.vendor} · ${money(lines.reduce((sum, line) => sum + line.amountCents, 0n))} · {claim.incurredOn}</p><p className="claim-reference">Claim {claim.id}</p>
    {notice && notices[notice] && <p role="status" className="notice">{notices[notice]}</p>}
    <div className="receipt-review-layout"><ReceiptEvidence evidence={evidence} modelLabel={suggestion?.status === "READY" ? aiLabel?.model ?? "Unrecognized AI record" : null} /><div className="receipt-review-work">
    {confirmation ? <section><h2>Human confirmation recorded</h2><p>Every category was confirmed by the claimant. Changing this draft requires a new review.</p>
      <ul>{confirmation.selections.map(line => <li key={line.lineId}>{line.lineId}: {names[line.category]} · {line.provenance === "AI_ACCEPTED" ? "Human accepted an AI suggestion" : `Human choice: ${line.reason}`}</li>)}</ul><Link className="button-link" href={`/claims/${id}`}>View allocation</Link><p className="muted">{claim.status === "DRAFT" ? user.role === "CLAIMANT" ? "Next: review funding and freeze the terms for two separate approvers." : "Review funding. The claimant must freeze the terms before approval." : "View the claim for its current approval and payment status."}</p></section> : <>
      {combined ? <ProposalReview key={`${review.id}:${suggestionHash(suggestion)}`} id={id} reviewId={review.id} draftHash={review.draftHash} suggestionHash={suggestionHash(suggestion)} suggestionId={suggestion?.id ?? null} runHash={combined.preparation.runHash} aiName={aiName}
        panel={proposalPresentation(combined.preparation.run, combined.fundNames, lines.reduce((sum, line) => sum + line.amountCents, 0n), Object.fromEntries((suggestion?.proposals ?? []).map(p => [p.lineId, p.category])))} editable={editable} receiptRunning={running} editForm={editForm}
        lines={lines.map(line => ({ id: line.id, description: line.description, amount: proposalMoney(line.amountCents), proposal: evidence.grounded ? suggestion?.proposals?.find(p => p.lineId === line.id) ?? null : null }))} /> : <>
      {editable && (suggestion?.status === "READY" ? <p>AI suggestions are saved for this receipt. Edit the receipt to request a new review.</p> : <SuggestForm id={id} reviewId={review.id} hash={review.draftHash} suggestionHash={suggestionHash(suggestion)} running={running} />)}
      {running && <p><Link href={`/claims/${id}/receipt`}>Refresh review status</Link></p>}
      {suggestion?.status === "RUNNING" && <p>{running ? "AI review is running. Reload to see its result, or review manually below." : "The earlier AI review did not finish. You can request another review or continue manually."}</p>}
      {suggestion?.status === "FAILED" && <p role="status">No usable AI suggestions are available. Manual review is available for every line.</p>}
      <form id="category-review" action={`/api/receipts/${id}`} method="post" className="receipt-form" tabIndex={-1}>{hidden}<input type="hidden" name="action" value="confirm" /><input type="hidden" name="suggestionId" value={suggestion?.id ?? ""} /><input type="hidden" name="suggestionHash" value={suggestionHash(suggestion)} />
        {lines.map(line => { const proposal = evidence.grounded ? suggestion?.proposals?.find(p => p.lineId === line.id) : undefined; return <section key={line.id}>
          <h2>{line.id}: {line.description}</h2><p>${money(line.amountCents)}</p>
          {proposal?.category !== "UNKNOWN" && proposal ? <><p className="ai-label">{aiName} suggests: <strong>{names[proposal.category]}</strong></p><blockquote>{proposal.quote}</blockquote><a href={`#receipt-source-${line.id}`}>See quote in receipt</a>{proposal.category === "alcohol" && <p className="notice warning">Alcohol is prohibited across all funds. Correct the expense before it can proceed.</p>}{proposal.category === "gift_cards" && <p className="notice warning">Gift cards need pre-approval outside AidTrace and are never allocated here. Correct or remove this line.</p>}</> : <p>No supported category suggested. Choose a category manually.</p>}
          <CategoryChoice lineId={line.id} proposed={proposal?.category} editable={editable} />
        </section>; })}
        {editable && <><label className="confirm"><input type="checkbox" name="confirm" value="yes" required /> I checked every category and quote. I understand alcohol cannot be reimbursed and gift cards need pre-approval outside AidTrace.</label><button>Confirm categories</button></>}
      </form></>}</>}
    {editable && (!combined || confirmation) && <details className="receipt-edit"><summary>Edit receipt or amounts</summary><p>Saving edits discards the current review and requires fresh confirmation.</p>{editForm}</details>}
    </div></div>
    <footer>AI suggests categories only. Your confirmation does not approve, allocate or pay this claim.</footer>
  </main>;
}
