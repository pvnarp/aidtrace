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
import { claimTotals } from "../server/home-view";
import { ApproverQueueAccessError, loadApproverQueue } from "../server/approver-queue";
import { ApproverQueueClient } from "./approver-queue/client";
import { loadAssistedChecks } from "../server/assisted-checks";
import { usd } from "../analytics/model";
import { loadAnalyticsSnapshot } from "../analytics/snapshot";
import { fundMeter, type FundMeter } from "./fund-meter";
import { FundRow } from "./fund-row";
import { shortClaimRef } from "./claim-ref";
import { fundModesEnabled } from "../fund-modes/flag";
import { CLAIMANT_LEDE, CLAIMANT_LEDE_FUND_MODES, approverHeading, approverLede, claimActionLabel, claimantHeading, nextStep, statusLabel } from "./home-copy";

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
    // IAC-414 Q1: the claims awaiting this approver are one read-only grid, so each claim shows once. The loader keeps today's rule: a claim this
    // approver already approved waits for the second approver, so it is not listed and not counted. It stays under Other expenses as before.
    const queue = await loadApproverQueue(db, user.id).catch(error => { if (error instanceof ApproverQueueAccessError) return { observedAt: new Date().toISOString(), rows: [] }; throw error; });
    // IAC-405 PR A: with the fund modes flag on, the Checks column and row selection appear only when a waiting claim is Assisted. Flag off or all Manual: no map, the queue as before.
    const assistedChecks = await loadAssistedChecks(db, user.id, queue.rows.map(row => row.id)).catch(() => new Map());
    const assisted = assistedChecks.size > 0 ? Object.fromEntries(assistedChecks) : undefined;
    const queued = new Set(queue.rows.map(row => row.id));
    const continuing = drafts.filter(claim => !queued.has(claim.id));
    // Trust v2: one meter per fund from the same read-only snapshot /analytics shows. A failed read renders no meters and no error text.
    const meters = await loadAnalyticsSnapshot(db, user.id).then(snapshot => snapshot.funds.map(fundMeter), () => [] as FundMeter[]);
    const [firstWord, ...restWords] = approverHeading(queue.rows.length).split(" ");
    return <><AppHeader user={user} /><main className="claim-page home-page reference-page">
      <div className={`reference-screen home-grid${queue.rows.length > 0 ? " aq-home" : ""}`}>
        <div className="home-main">
        <div className="home-head-text">
          <h1 className="screen-heading">{queue.rows.length > 0 ? <><span className="act">{firstWord}</span> {restWords.join(" ")}</> : approverHeading(0)}</h1>
          <p className="reference-intro">{approverLede(queue.rows.length, assisted !== undefined)}</p>
        </div>
        {queue.rows.length > 0 && <ApproverQueueClient rows={queue.rows} observedAt={queue.observedAt} userId={user.id} assisted={assisted} />}
        {continuing.length > 0 && <section aria-labelledby="other-expenses"><h2 id="other-expenses">Other expenses</h2><ul className="draft-list">{continuing.map(claim => <li key={`${claim.id}:${claim.version}`}><Link href={`/claims/${claim.id}`} prefetch={false}>{claim.vendor}<small className="claim-reference">Claim {shortClaimRef(claim.id)}{money(claim) ? ` · ${money(claim)}` : ""}</small></Link><span>{statusLabel(claim.status)}</span></li>)}</ul></section>}
        <div className="reference-links"><Link className="button-link secondary" href="/analytics" prefetch={false}>View funding and cash</Link><Link className="button-link secondary" href="/architecture" prefetch={false}>Explore how it works</Link></div>
        </div>
        {meters.length > 0 && <div className="funds" role="group" aria-label="Fund balances">{meters.map(meter => <FundRow key={meter.name} meter={meter} />)}</div>}
      </div>
    </main></>;
  }

  const cards: ExpenseCardData[] = drafts.map(claim => ({ id: claim.id, vendor: claim.vendor, program: claim.program, status: claim.status, amount: money(claim), line: nextStep("CLAIMANT", claim.status), href: `/claims/${claim.id}`, action: claimActionLabel(judge), kicker: "Continue your expense" }));
  return <><AppHeader user={user} /><main className="claim-page home-page reference-page">
    <div className="reference-screen">
      <h1 className="screen-heading">{claimantHeading(user.displayName)}</h1>
      <p className="reference-intro">{fundModesEnabled() ? CLAIMANT_LEDE_FUND_MODES : CLAIMANT_LEDE}</p>
      {cards.length > 0 ? cards.map((card, index) => <ExpenseCard key={`${card.id}:${index}`} card={card} />)
        : <article className="reference-case" aria-labelledby="start-expense"><p className="kicker">Start your expense</p>
          <div className="case-head"><h2 id="start-expense">{judge ? "No expense is saved in this session yet" : "No expense yet"}</h2></div>
          <p>{judge ? "Start with the receipt, check the AI suggestions, then review funding. Nothing is paid by this walkthrough." : "A receipt starts a new unpaid draft. Nothing is paid by this walkthrough."}</p>
          <Link className="button-link" href="/receipts/new" prefetch={false}>{judge ? "Review Maria's $500 receipt" : "Start an expense"}</Link></article>}
      <div className="reference-links">
        {!judge && cards.length > 0 && <Link className="button-link secondary" href="/receipts/new" prefetch={false}>Start an expense</Link>}
        <Link className="button-link secondary" href="/architecture" prefetch={false}>Explore how it works</Link>
        <Link className="button-link secondary" href="/give" prefetch={false}>Give to a restricted fund</Link>
        {!judge && <Link className="button-link secondary" href="/claims/C-104" prefetch={false}>Inspect the separate claim C-104</Link>}
      </div>
      {!judge && <p className="muted">C-104 is a separate, preclassified example. The receipt you start is your own draft.</p>}
    </div>
  </main></>;
}
