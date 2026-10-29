import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { findSession, SESSION_COOKIE } from "../server/auth";
import { getDatabase } from "../server/db";
import { claims, users } from "../../db/schema";
import { and, eq, like } from "drizzle-orm";

export default async function Home() {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  const db = getDatabase();
  const [actor] = await db.select().from(users).where(eq(users.id, user.id));
  const drafts = actor ? await db.select().from(claims).where(and(eq(claims.organizationId, actor.organizationId), like(claims.id, "R-%"), user.role === "CLAIMANT" ? eq(claims.claimantId, user.id) : undefined)).orderBy(claims.id) : [];
  return <main className="claim-page home-page">
    <header className="page-header"><Link href="/">AidTrace</Link><span>{user.displayName} · {user.role === "CLAIMANT" ? "Claimant" : "Approver"}</span><form action="/api/auth/logout" method="post"><button type="submit" className="secondary">Sign out</button></form></header>
    <p className="eyebrow">Nonprofit spending / Sandbox demonstration</p>
    <h1>The money is there. Which fund can pay?</h1>
    <p className="intro">One receipt. Several restricted funds. AidTrace checks which funds can pay, protects General funding, and keeps people in control.</p>
    <div className="start-here"><p className="eyebrow">Start here</p><h2>{user.role === "CLAIMANT" ? "Try one expense, from receipt to review." : "Review an expense prepared by a claimant."}</h2><p>{user.role === "CLAIMANT" ? "Use the prefilled $6 fictional receipt. AidTrace will guide you through categories, funding and the handoff to two approvers. Creating it sends no payment." : "Open a claim below. Check its expense, recipient and funding before approving. A second person must approve the same frozen terms."}</p>
    <div className="next-actions">{user.role === "CLAIMANT" ? <Link className="button-link" href="/receipts/new">Start a $6 practice expense</Link> : <Link className="button-link" href="/claims/C-104">Open claim C-104</Link>}
      <Link className="button-link secondary" href="/architecture" prefetch={false}>Explore how it works</Link>
    </div>
    <p className="muted">Prefer to inspect a ready-made funding example? <Link href="/claims/C-104">Open the separate $500 claim C-104</Link>. It has preclassified items and its own status, not the new $6 receipt.</p></div>
    <section className="workflow" aria-labelledby="workflow-title"><h2 id="workflow-title">AI prepares. Rules check. People decide.</h2>
      <ol className="workflow-list"><li><strong>Receipt</strong><span>You enter amounts.</span></li><li><strong>Category review</strong><span>AI suggests. You confirm.</span></li><li><strong>Funding rules</strong><span>You freeze the allocation.</span></li><li><strong>Two approvals</strong><span>Different people, same terms.</span></li><li><strong>PayPal Sandbox</strong><span>Explicit send. Verified result.</span></li></ol>
    <p className="muted">Workflow overview, not a live request trace. AI cannot approve or pay. <Link href="/architecture" prefetch={false}>Click through the architecture and a blocked expense</Link>.</p>
    </section>
    {user.role === "APPROVER" && <p><Link className="button-link secondary" href="/analytics" prefetch={false}>View funding and cash</Link></p>}
    {drafts.length > 0 && <section><h2>Continue a receipt</h2><ul className="draft-list">{drafts.map(claim => <li key={`${claim.id}:${claim.version}`}><Link href={`/claims/${claim.id}`}>{claim.vendor}<small className="claim-reference">Claim {claim.id}</small></Link><span>{claim.status === "DRAFT" ? "Draft" : claim.status.toLowerCase().replaceAll("_", " ")}</span></li>)}</ul></section>}
    <footer>Fictional data for Cedar Hollow Youth Robotics. Funds follow organization-approved rules. General is flexible, not exempt from those rules.</footer>
  </main>;
}
