import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { findSession, SESSION_COOKIE } from "../server/auth";
import { getDatabase } from "../server/db";
import { claims, users } from "../../db/schema";
import { and, eq, like } from "drizzle-orm";
import { AppHeader } from "./app-header";
import { ExpenseCard, type ExpenseCardData } from "./expense-card";
import { judgeSession } from "../server/judge-mode";
import { loadClaimView } from "../server/claim-view";
import { claimTotals } from "../server/home-view";
import { usd } from "../analytics/model";
import { CLAIMANT_LEDE, approverHeading, approverLede, approverReviewLine, claimActionLabel, claimantHeading, frozenSplit, nextStep, statusLabel } from "./home-copy";

// IAC-403: the locked mock's Claimant home and Approver home. Every amount, status and count below comes from state this page loads
// (claims, claim lines, and for an approver the same loadClaimView the claim page reads). Nothing is scripted.
export default async function Home() {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  const db = getDatabase();
  const [actor] = await db.select().from(users).where(eq(users.id, user.id));
  const drafts = actor ? await db.select().from(claims).where(and(eq(claims.organizationId, actor.organizationId), like(claims.id, "R-%"), user.role === "CLAIMANT" ? eq(claims.claimantId, user.id) : undefined)).orderBy(claims.id) : [];
  const judge = judgeSession();
  const totals = await claimTotals(db, drafts);
  const money = (claim: { id: string; version: number }) => { const total = totals.get(`${claim.id}:${claim.version}`); return total === undefined ? null : usd(total); };

  if (user.role === "APPROVER") {
    // An approver sees an awaiting claim once. One this approver already approved waits for the second approver, so it is not counted as needing review.
    const cards: ExpenseCardData[] = []; const shown = new Set<string>();
    for (const claim of drafts.filter(row => row.status === "AWAITING_APPROVAL")) {
      const view = await loadClaimView(db, claim.id, user.id).catch(() => null);
      const approvedByMe = view?.approvals.some(approval => approval.approverId === user.id) ?? false;
      if (approvedByMe) continue;
      const total = view ? view.lines.reduce((sum, line) => sum + line.amountCents, 0n) : 0n;
      const split = view ? frozenSplit({ total, generalCents: view.generalCents, frozen: Boolean(view.decision), edges: view.edges }) : null;
      shown.add(`${claim.id}:${claim.version}`);
      cards.push({ id: claim.id, vendor: claim.vendor, program: claim.program, status: claim.status, amount: money(claim), line: approverReviewLine(split, false), href: `/claims/${claim.id}`, action: "Review this expense", kicker: "Expenses awaiting your approval" });
    }
    const continuing = drafts.filter(claim => !shown.has(`${claim.id}:${claim.version}`));
    return <><AppHeader user={user} /><main className="claim-page home-page reference-page">
      <div className="reference-screen">
        <h1 className="screen-heading">{approverHeading(cards.length)}</h1>
        <p className="reference-intro">{approverLede(cards.length)}</p>
        {cards.map((card, index) => <ExpenseCard key={`${card.id}:${index}`} card={card} />)}
        {continuing.length > 0 && <section aria-labelledby="other-expenses"><h2 id="other-expenses">Other expenses</h2><ul className="draft-list">{continuing.map(claim => <li key={`${claim.id}:${claim.version}`}><Link href={`/claims/${claim.id}`} prefetch={false}>{claim.vendor}<small className="claim-reference">Claim {claim.id}{money(claim) ? ` · ${money(claim)}` : ""}</small></Link><span>{statusLabel(claim.status)}</span></li>)}</ul></section>}
        <div className="reference-links"><Link className="button-link secondary" href="/analytics" prefetch={false}>View funding and cash</Link><Link className="button-link secondary" href="/architecture" prefetch={false}>Explore how it works</Link></div>
      </div>
      <footer>Fictional data for Lanternfield Community Alliance. Funds follow organization-approved rules. General Operating is flexible, not exempt from those rules.</footer>
    </main></>;
  }

  const cards: ExpenseCardData[] = drafts.map(claim => ({ id: claim.id, vendor: claim.vendor, program: claim.program, status: claim.status, amount: money(claim), line: nextStep("CLAIMANT", claim.status), href: `/claims/${claim.id}`, action: claimActionLabel(judge), kicker: "Continue your expense" }));
  return <><AppHeader user={user} /><main className="claim-page home-page reference-page">
    <div className="reference-screen">
      <h1 className="screen-heading">{claimantHeading(user.displayName)}</h1>
      <p className="reference-intro">{CLAIMANT_LEDE}</p>
      {cards.length > 0 ? cards.map((card, index) => <ExpenseCard key={`${card.id}:${index}`} card={card} />)
        : <article className="reference-case" aria-labelledby="start-expense"><p className="kicker">Start your expense</p>
          <div className="case-head"><h2 id="start-expense">{judge ? "No expense is saved in this session yet" : "No practice expense yet"}</h2></div>
          <p>{judge ? "Start with the receipt, check the AI suggestions, then review funding. Nothing is paid by this walkthrough." : "A practice receipt starts a new unpaid draft. Nothing is paid by this walkthrough."}</p>
          <Link className="button-link" href="/receipts/new" prefetch={false}>{judge ? "Review Maria's $500 receipt" : "Start a $6 practice expense"}</Link></article>}
      {judge && <p className="muted">One receipt carries this session from AI review through funding and two approvals to an unpaid PayPal handoff. Earlier sessions stay preserved; a fresh session starts with fresh funds.</p>}
      <div className="reference-links">
        {!judge && cards.length > 0 && <Link className="button-link secondary" href="/receipts/new" prefetch={false}>Start a $6 practice expense</Link>}
        <Link className="button-link secondary" href="/architecture" prefetch={false}>Explore how it works</Link>
        <Link className="button-link secondary" href="/give" prefetch={false}>Give to a restricted fund</Link>
        {!judge && <Link className="button-link secondary" href="/claims/C-104" prefetch={false}>Inspect the separate claim C-104</Link>}
      </div>
      {!judge && <p className="muted">C-104 is a separate, preclassified example. The practice receipt is your own draft.</p>}
    </div>
    <footer>Fictional data for Lanternfield Community Alliance. Funds follow organization-approved rules. General Operating is flexible, not exempt from those rules.</footer>
  </main></>;
}
