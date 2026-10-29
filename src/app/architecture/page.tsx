import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { findSession, SESSION_COOKIE } from "../../server/auth";
import { ArchitectureExplorer } from "./explorer";

export default async function ArchitecturePage() {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  return <main className="claim-page architecture-page"><header className="page-header"><Link href="/">AidTrace</Link><span>{user.displayName}</span><form action="/api/auth/logout" method="post"><button className="secondary">Sign out</button></form></header>
    <p className="eyebrow">How AidTrace works / Interactive walkthrough</p><h1>Follow one expense through the system.</h1><p className="intro">AI prepares. Rules constrain. People authorize. Follow the handoffs below, or choose an item that policy will block.</p>
    <ArchitectureExplorer /><footer><Link href="/">Back to your workspace</Link>. The $6 split is illustrative, not a quote from your current funds or a payment result.</footer>
  </main>;
}
