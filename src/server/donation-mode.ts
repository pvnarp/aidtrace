import { judgeSession } from "./judge-mode";

/** Server-only. The donation mode is decided from configuration alone, never from a client field, query string or cookie. */
export type DonationMode = "KEYED" | "KEYLESS";
const SANDBOX_URL = "https://api-m.sandbox.paypal.com";
// KEYED needs: not a judge session, the exact sandbox base URL and both a client ID and a secret. No payee allowlist is
// involved: that gates payouts, not donations.
export function donationMode(env: Readonly<Record<string, string | undefined>> = process.env): DonationMode {
  return !judgeSession(env) && env.PAYPAL_BASE_URL === SANDBOX_URL && Boolean(env.PAYPAL_CLIENT_ID?.trim() && env.PAYPAL_CLIENT_SECRET?.trim()) ? "KEYED" : "KEYLESS";
}
