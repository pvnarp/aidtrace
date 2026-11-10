import { cookies, headers } from "next/headers";
import { AppHeader } from "../app-header";
import { findSession, SESSION_COOKIE } from "../../server/auth";
import { getDatabase } from "../../server/db";
import { donationMode } from "../../server/donation-mode";
import { eligibleDonationFunds } from "../../server/donation-funds";
import { GiveClient } from "./give-client";
import { KeylessPanel } from "./keyless-panel";

// The mode and the nonce are read per request, never at build time.
export const dynamic = "force-dynamic";
export const metadata = { title: "Give to a fund | AidTrace" };
export default async function GivePage() {
  const mode = donationMode();
  const funds = await eligibleDonationFunds(getDatabase());
  // Only the sandbox client ID reaches the browser, and only in KEYED. The secret is never read here.
  const clientId = mode === "KEYED" ? process.env.PAYPAL_CLIENT_ID?.trim() ?? "" : "";
  const nonce = (await headers()).get("x-nonce") ?? "";
  // November 10 P7: the page stays public. A visitor with a live session (a judge who came from a workspace) also gets a way back; nobody else sees it. No new data is loaded for anyone.
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const signedIn = token ? Boolean(await findSession(token).catch(() => null)) : false;
  return <><AppHeader /><main className="claim-page give-page">
    <p className="eyebrow">Give / Restricted funds</p>
    <h1>Give to a fund.</h1>
    {signedIn && <p className="give-back"><a className="button-link secondary" href="/" data-testid="give-back">Back to your workspace</a></p>}
    <p className="intro">Choose a restricted fund and an amount. A gift is recorded in that fund&apos;s ledger only after PayPal reports the payment complete.</p>
    <p className="muted">No real money moves.</p>
    {mode === "KEYED" && funds.length > 0 && clientId ? <GiveClient funds={funds} clientId={clientId} nonce={nonce} /> : mode === "KEYED" ? <p role="status">No restricted fund can accept a donation right now. Nothing was created.</p> : <KeylessPanel funds={funds} />}
    <footer>AidTrace stores the order ID, fund, amount, status and your optional display name. It never stores your PayPal email, payer ID, address or card details.</footer>
  </main></>;
}
