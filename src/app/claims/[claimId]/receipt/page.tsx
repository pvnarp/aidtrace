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
const names: Record<string, string> = { science_kits: "Science kits", notebooks: "Notebooks", hospitality: "Food and refreshments", alcohol: "Alcohol: prohibited" };
const money = (value: bigint) => `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
export default async function ReceiptPage({ params, searchParams }: { params: Promise<{ claimId: string }>; searchParams: Promise<{ notice?: string }> }) {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value); if (!user) redirect("/login");
  const id = (await params).claimId;
  const preparationEnabled = process.env.AI_EXPENSE_PROPOSALS_ENABLED === "true" && user.role === "CLAIMANT";
  const combined = preparationEnabled ? await readExpenseReview(getDatabase(), id, user.id).catch(() => null) : null;
  const view = preparationEnabled ? combined?.receipt : await readReceiptView(getDatabase(), id, user.id).catch(() => null); if (!view) notFound();
  const { claim, lines, review, suggestion, confirmation } = view;
  const editable = view.canEdit;
  const running = suggestion?.status === "RUNNING" && Date.now() - suggestion.requestedAt.getTime() < 65000;
  const notice = (await searchParams).notice;
  const notices: Record<string, string> = { created: "Unpaid draft created. Review categories before allocating funds.", edited: "Edits saved. Earlier suggestions and confirmation no longer apply.", suggested: "AI suggestions are ready. Verify each quote and category before confirming.", manual: "AI could not provide a usable review. Choose each category yourself and explain your choice.", confirmed: "Categories confirmed. No allocation has been frozen and no payment requested.", running: "An AI review is already in progress. No second request was started. Refresh this page to see its result.", "review-changed": "That form was invalid or the review changed before it was submitted. Your saved draft is below. Review the current information and try again. No allocation or payment was requested." };
  notices["proposal-updated"] = "Preparation result is below. Review every category before confirming.";
  const hidden = <><input type="hidden" name="reviewId" value={review.id} /><input type="hidden" name="draftHash" value={review.draftHash} /></>;
  const editForm = <DraftForm id={id} reviewId={review.id} hash={review.draftHash} vendor={claim.vendor} program={claim.program} incurredOn={claim.incurredOn} source={review.source} total={money(lines.reduce((sum, l) => sum + l.amountCents, 0n))} lines={lines.map(line => ({ description: line.description, amount: money(line.amountCents) }))} />;
  return <main className="claim-page receipt-page"><header className="page-header"><Link href="/">AidTrace</Link><span>{user.displayName}</span><form action="/api/auth/logout" method="post"><button className="secondary">Sign out</button></form></header>
    <h1>Check each receipt category.</h1><p>{claim.vendor} · ${money(lines.reduce((sum, line) => sum + line.amountCents, 0n))} · {claim.incurredOn}</p>
    {notice && notices[notice] && <p role="status" className="notice">{notices[notice]}</p>}
    <details><summary>View original receipt text</summary><pre className="receipt-source">{review.source}</pre></details>
    {confirmation ? <section><h2>Human confirmation recorded</h2><p>Every category was confirmed by the claimant. Changing this draft requires a new review.</p>
      <ul>{confirmation.selections.map(line => <li key={line.lineId}>{line.lineId}: {names[line.category]} · {line.provenance === "AI_ACCEPTED" ? "Human accepted an AI suggestion" : `Human choice: ${line.reason}`}</li>)}</ul><Link href={`/claims/${id}`}>View allocation</Link></section> : <>
      {combined ? <ProposalReview key={`${review.id}:${suggestionHash(suggestion)}`} id={id} reviewId={review.id} draftHash={review.draftHash} suggestionHash={suggestionHash(suggestion)} suggestionId={suggestion?.id ?? null} runHash={combined.preparation.runHash}
        panel={proposalPresentation(combined.preparation.run, combined.fundNames, lines.reduce((sum, line) => sum + line.amountCents, 0n))} editable={editable} receiptRunning={running} editForm={editForm}
        lines={lines.map(line => ({ id: line.id, description: line.description, amount: proposalMoney(line.amountCents), proposal: suggestion?.status === "READY" ? suggestion.proposals?.find(p => p.lineId === line.id) ?? null : null }))} /> : <>
      {editable && (suggestion?.status === "READY" ? <p>AI suggestions are saved for this receipt. Edit the receipt to request a new review.</p> : <SuggestForm id={id} reviewId={review.id} hash={review.draftHash} suggestionHash={suggestionHash(suggestion)} running={running} />)}
      {running && <p><Link href={`/claims/${id}/receipt`}>Refresh review status</Link></p>}
      {suggestion?.status === "RUNNING" && <p>{running ? "AI review is running. Reload to see its result, or review manually below." : "The earlier AI review did not finish. You can request another review or continue manually."}</p>}
      {suggestion?.status === "FAILED" && <p role="status">No usable AI suggestions are available. Manual review is available for every line.</p>}
      <form action={`/api/receipts/${id}`} method="post" className="receipt-form">{hidden}<input type="hidden" name="action" value="confirm" /><input type="hidden" name="suggestionId" value={suggestion?.id ?? ""} /><input type="hidden" name="suggestionHash" value={suggestionHash(suggestion)} />
        {lines.map(line => { const proposal = suggestion?.status === "READY" ? suggestion.proposals?.find(p => p.lineId === line.id) : undefined; return <section key={line.id}>
          <h2>{line.id}: {line.description}</h2><p>${money(line.amountCents)}</p>
          {proposal?.category !== "UNKNOWN" && proposal ? <><p>AI suggests: <strong>{names[proposal.category]}</strong></p><blockquote>{proposal.quote}</blockquote><p>Exact quote found once in the receipt. You still need to verify the category.</p></> : <p>No supported category suggested. Choose a category manually.</p>}
          <CategoryChoice lineId={line.id} proposed={proposal?.category} editable={editable} />
        </section>; })}
        {editable && <><label className="confirm"><input type="checkbox" name="confirm" value="yes" required /> I checked every category and quote. I understand alcohol cannot be reimbursed.</label><button>Confirm categories</button></>}
      </form></>}</>}
    {editable && (!combined || confirmation) && <details className="receipt-edit"><summary>Edit receipt or amounts</summary><p>Saving edits discards the current review and requires fresh confirmation.</p>{editForm}</details>}
    <footer>AI suggests categories only. Your confirmation does not approve, allocate or pay this claim.</footer>
  </main>;
}
