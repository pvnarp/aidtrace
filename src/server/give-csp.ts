// IAC-379 step 3a: the Content Security Policy for /give only. No other route has a CSP (confirmed October 30: next.config.ts,
// the root layout and every file under src/ set none). Scripts use a per-request nonce plus PayPal's documented hosts.
// Styles keep 'unsafe-inline' because PayPal's SDK injects style elements and a style nonce would disable it.
const PAYPAL_HOSTS = "https://*.paypal.com https://*.paypalobjects.com";
export function giveContentSecurityPolicy(nonce: string): string {
  if (!/^[A-Za-z0-9+/=]{16,}$/.test(nonce)) throw new Error("A base64 nonce is required");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' ${PAYPAL_HOSTS}`,
    `style-src 'self' 'unsafe-inline' ${PAYPAL_HOSTS}`,
    `frame-src ${PAYPAL_HOSTS}`,
    `connect-src 'self' ${PAYPAL_HOSTS}`,
    `img-src 'self' data: ${PAYPAL_HOSTS}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
