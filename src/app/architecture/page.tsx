import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { findSession, SESSION_COOKIE } from "../../server/auth";
import { ArchitectureExplorer } from "./explorer";

export default async function ArchitecturePage() {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  return <main className="claim-page architecture-page story-page"><header className="page-header"><Link href="/">AidTrace<span className="brand-caption">AI + PayPal / Sandbox</span></Link><span>{user.displayName}</span><form action="/api/auth/logout" method="post"><button className="secondary">Sign out</button></form></header>
    <p className="eyebrow">AI + PayPal / How the decisions connect</p><h1>One $500 expense. Every decision explained.</h1>
    <p className="intro">AI suggests categories. Rules calculate funding. Two people approve. The keyless review ends at an unpaid PayPal handoff.</p>
    <details open className="technical-explorer"><summary>Inside the architecture: inspect the components and handoffs</summary><p>The walkthrough uses the same fictional $280 kits, $150 notebooks and $70 refreshments. It reads no current claim or account data.</p><ArchitectureExplorer /></details>
    <footer><Link href="/">Back to your workspace</Link>. AI suggestions require human confirmation. PayPal Sandbox uses test funds. This page is an illustration, not live telemetry.</footer>
  </main>;
}
