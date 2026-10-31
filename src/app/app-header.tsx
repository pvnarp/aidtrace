import { connection } from "next/server";
import { receiptAiStatus } from "../ai/provider";
import { Brand, BRAND } from "./brand";
import { shellWording } from "./shell-copy";

/**
 * Presentation only. Signed-in identity comes from the session the page already loaded; signed out shows the brand alone.
 * The header tag follows the receipt AI status the server reads (shellWording), so it never claims AI that is off or has no key. It is read per request.
 */
export async function AppHeader({ user }: { user?: { displayName: string; role: string } }) {
  await connection();
  const status = receiptAiStatus();
  const { tag } = status.on ? shellWording(status) : shellWording(null, status.reason);
  return <header className="product-header"><Brand tag={tag} />
    {user ? <div className="product-context"><span className="product-org">{BRAND.organization}</span>
      <b className="product-person">{user.displayName}<small>{user.role === "CLAIMANT" ? "Claimant" : "Approver"}</small></b>
      <form action="/api/auth/logout" method="post"><button type="submit" className="secondary">Sign out</button></form></div>
      : <div className="product-context"><span className="product-org">{BRAND.organization}</span></div>}
  </header>;
}
