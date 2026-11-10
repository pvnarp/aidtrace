import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { findSession, SESSION_COOKIE } from "../../server/auth";
import { ArchitectureExplorer } from "./explorer";
import { architectureStages } from "./stages";
import { receiptAiStatus } from "../../ai/provider";
import { AppHeader } from "../app-header";
import { GRID_SURFACES } from "./grid-surfaces";

export default async function ArchitecturePage() {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  const status = receiptAiStatus();
  const stages = architectureStages({ on: status.on });
  return <><AppHeader user={user} /><main className="claim-page architecture-page story-page reference-page">
    <div className="reference-screen">
      <p className="kicker">AI + PayPal / How the decisions connect</p>
      <h1 className="screen-heading">See where each decision happens.</h1>
      <p className="reference-intro">One $500 expense. Components highlight the selected explanation, not live traffic. AI suggests, rules allocate, two people approve and the keyless review ends at an unpaid PayPal handoff.</p>
      <ArchitectureExplorer stages={stages} />
      <section className="reference-note" aria-labelledby="grid-where" data-testid="architecture-grid-surfaces">
        <h2 id="grid-where">Where AG Grid works</h2>
        <p className="reference-intro">Four tables use AG Grid Community (MIT), a sponsor library for fast tables. Each shows a one-line caption naming it. They are read only: no editing, no write path, and they never approve or pay. Approvals and payments stay on the claim page.</p>
        <ul>{GRID_SURFACES.map(surface => <li key={surface.name}><b>{user.role === "APPROVER" ? <Link href={surface.href}>{surface.name}</Link> : surface.name}</b>: {surface.does} {surface.value}</li>)}</ul>
        {user.role !== "APPROVER" && <p>These pages open for approvers.</p>}
      </section>
    </div>
    <footer><Link href="/">Back to your workspace</Link>. The accounting model has not been reviewed by a nonprofit accountant. AI suggestions require human confirmation. This page is an illustration, not live telemetry.</footer>
  </main></>;
}
