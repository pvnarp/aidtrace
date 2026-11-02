import { connection } from "next/server";
import { receiptAiStatus } from "../ai/provider";
import { Brand, BRAND } from "./brand";
import { navLinksFor } from "./nav";
import { PrimaryNav } from "./primary-nav";
import { shellWording } from "./shell-copy";

/**
 * Presentation only. Signed-in identity comes from the session the page already loaded; signed out shows the brand and the organization.
 * The header tag follows the receipt AI status the server reads (shellWording), so it never claims AI that is not running, and says nothing about AI when none is configured. It is read per request.
 * Render it above the page's <main> so the bar spans the window. The links come from nav.ts, by role.
 */
export async function AppHeader({ user }: { user?: { displayName: string; role: string } }) {
  await connection();
  const status = receiptAiStatus();
  const { tag } = shellWording(status.on ? status : null);
  const links = user ? navLinksFor(user.role) : [];
  return <header className="top"><div className="top-in"><Brand tag={tag} />
    {links.length > 0 && <PrimaryNav links={links} />}
    <div className="top-end"><span className="product-org">{BRAND.organization}</span>
      {user && <><p className="who"><b>{user.displayName}</b>, {user.role === "CLAIMANT" ? "Claimant" : "Approver"}</p>
        <form action="/api/auth/logout" method="post"><button type="submit" className="secondary">Sign out</button></form></>}
    </div></div></header>;
}
