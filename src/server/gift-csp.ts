// IAC-413 PR A (docs/plans/DONOR_TRAIL_SCOPE.md section 3.3): the Content Security Policy for /gift/[token].
// The page loads nothing from another origin: no PayPal host, no font host, no frame, no form target. Scripts are the Next runtime
// from this origin plus its nonce-tagged inline payload. Styles are this origin only, with no 'unsafe-inline' (a test proves the
// Next markup needs none, and if it ever does the scope names the fallback). The nonce rule is the one give-csp.ts applies.
export function giftContentSecurityPolicy(nonce: string): string {
  if (!/^[A-Za-z0-9+/=]{16,}$/.test(nonce)) throw new Error("A base64 nonce is required");
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
// The static headers on every /gift response (200, 404 and 429). The CSP is added beside them because it carries a nonce.
export const GIFT_STATIC_HEADERS: Readonly<Record<string, string>> = {
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
