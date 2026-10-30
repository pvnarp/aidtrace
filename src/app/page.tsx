import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { findSession, SESSION_COOKIE } from "../server/auth";
import { getDatabase } from "../server/db";
import { claims, users } from "../../db/schema";
import { and, eq, like } from "drizzle-orm";
import { OpeningStory } from "./opening-story";
import { judgeSession } from "../server/judge-mode";

export default async function Home() {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  const db = getDatabase();
  const [actor] = await db.select().from(users).where(eq(users.id, user.id));
  const drafts = actor ? await db.select().from(claims).where(and(eq(claims.organizationId, actor.organizationId), like(claims.id, "R-%"), user.role === "CLAIMANT" ? eq(claims.claimantId, user.id) : undefined)).orderBy(claims.id) : [];
  const awaiting = drafts.filter(claim => claim.status === "AWAITING_APPROVAL");
  // An approver sees an awaiting claim once, under its own heading.
  const continuing = user.role === "APPROVER" ? drafts.filter(claim => claim.status !== "AWAITING_APPROVAL") : drafts;
  const judge = judgeSession();
  const current = judge ? drafts[0] : undefined;
  return <main className="claim-page home-page story-page">
    <header className="page-header"><Link href="/">AidTrace<span className="brand-caption">AI + PayPal / Sandbox</span></Link><span>{user.displayName} · {user.role === "CLAIMANT" ? "Claimant" : "Approver"}</span><form action="/api/auth/logout" method="post"><button type="submit" className="secondary">Sign out</button></form></header>
    <OpeningStory actionHref={user.role === "CLAIMANT" ? current ? `/claims/${current.id}` : "/receipts/new" : "#workspace"} actionLabel={user.role === "CLAIMANT" ? judge ? current ? "Continue Maria's receipt" : "Review Maria's $500 receipt" : "Start a $6 practice expense" : "Open your review workspace"} />
    <section className="workspace-links" id="workspace"><h2>Your workspace</h2><p>{judge ? "One receipt carries this session from AI review through funding and two approvals to an unpaid PayPal handoff. Earlier sessions stay preserved; a fresh session starts with fresh funds." : "The $6 practice receipt starts a new unpaid draft. C-104 is the separate, preclassified $500 example shown above."}</p><div className="next-actions"><Link className="button-link secondary" href="/architecture" prefetch={false}>Explore how it works</Link><Link className="button-link secondary" href="/give" prefetch={false}>Give to a restricted fund</Link>{!judge && <Link href="/claims/C-104" prefetch={false}>Inspect the separate claim C-104</Link>}</div></section>
    {user.role === "APPROVER" && <section><h2>Expenses awaiting approvals</h2>{awaiting.length ? <><p>Open an expense to check whether it still needs your approval of the frozen terms.</p><ul className="draft-list">{awaiting.map(claim => <li key={`${claim.id}:${claim.version}`}><Link href={`/claims/${claim.id}`} prefetch={false}>{claim.vendor}</Link><span>Awaiting approval</span></li>)}</ul></> : <p>No practice expense is awaiting approvals. The claimant must confirm categories and freeze its funding terms first.</p>}</section>}
    {user.role === "APPROVER" && <p><Link className="button-link secondary" href="/analytics" prefetch={false}>View funding and cash</Link></p>}
    {continuing.length > 0 && <section><h2>Continue a receipt</h2><ul className="draft-list">{continuing.map(claim => <li key={`${claim.id}:${claim.version}`}><Link href={`/claims/${claim.id}`} prefetch={false}>{claim.vendor}<small className="claim-reference">Claim {claim.id}</small></Link><span>{claim.status === "DRAFT" ? "Draft" : claim.status.toLowerCase().replaceAll("_", " ")}</span></li>)}</ul></section>}
    <footer>Fictional data for Lanternfield Community Alliance. Funds follow organization-approved rules. General Operating is flexible, not exempt from those rules.</footer>
  </main>;
}
