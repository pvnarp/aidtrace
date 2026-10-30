import { headers } from "next/headers";
import Link from "next/link";
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
  return <main className="claim-page give-page">
    <header className="page-header"><Link href="/" prefetch={false}>AidTrace<span className="brand-caption">AI + PayPal / Sandbox</span></Link></header>
    <p className="eyebrow">Give / Restricted funds</p>
    <h1>Give to a fund.</h1>
    <p className="intro">Choose a restricted fund and an amount. A gift is recorded in that fund&apos;s ledger only after PayPal reports the payment complete.</p>
    <p className="muted">Sandbox demonstration for a fictional organization. Only PayPal sandbox buyer accounts can pay, and no real money moves.</p>
    {mode === "KEYED" && funds.length > 0 && clientId ? <GiveClient funds={funds} clientId={clientId} nonce={nonce} /> : mode === "KEYED" ? <p role="status">No restricted fund can accept a donation right now. Nothing was created.</p> : <KeylessPanel funds={funds} />}
    <footer>AidTrace stores the order ID, fund, amount, status and your optional display name. It never stores your PayPal email, payer ID, address or card details.</footer>
  </main>;
}
