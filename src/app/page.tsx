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
  return <main>
    <p className="eyebrow">AidTrace / Sandbox development</p>
    <h1>Welcome, {user.displayName}.</h1>
    <p>You are signed in as {user.username}, a {user.role === "CLAIMANT" ? "claimant" : "separate approver"}.</p>
    <p>Review the fixture allocation, collect independent approvals, and track a sandbox reimbursement.</p>
    <p><Link href="/claims/C-104">Open claim C-104</Link></p>
    {user.role === "APPROVER" && <p><Link href="/analytics" prefetch={false}>Open funding and cash dashboard</Link></p>}
    {user.role === "CLAIMANT" && <p><Link href="/receipts/new">Create a synthetic receipt draft</Link></p>}
    {drafts.length > 0 && <section><h2>Receipt drafts</h2><ul className="draft-list">{drafts.map(claim => <li key={`${claim.id}:${claim.version}`}><Link href={`/claims/${claim.id}/receipt`}>{claim.vendor} · {claim.status} · {claim.id}</Link></li>)}</ul></section>}
    <form action="/api/auth/logout" method="post"><button type="submit">Sign out</button></form>
    <footer>Fixture data for Cedar Hollow Youth Robotics. Sandbox payments require both approvals and an explicit send confirmation.</footer>
  </main>;
}
