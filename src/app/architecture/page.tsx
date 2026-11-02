import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { findSession, SESSION_COOKIE } from "../../server/auth";
import { ArchitectureExplorer } from "./explorer";
import { architectureStages } from "./stages";
import { receiptAiStatus } from "../../ai/provider";
import { AppHeader } from "../app-header";

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
    </div>
    <footer><Link href="/">Back to your workspace</Link>. AI suggestions require human confirmation. This page is an illustration, not live telemetry.</footer>
  </main></>;
}
