import { NextResponse, type NextRequest } from "next/server";
import { isGiftTokenShape } from "./donation/gift-link";
import { GIFT_STATIC_HEADERS, giftContentSecurityPolicy } from "./server/gift-csp";
import { takeGiftPageSlot } from "./server/gift-rate-limit";
import { getDatabase } from "./server/db";
import { giveContentSecurityPolicy } from "./server/give-csp";

// Next 16 proxy (the renamed middleware), matched to /give and /gift/:path*. It sets a fresh nonce per request: Next applies the
// nonce from the request's Content-Security-Policy header to its own scripts, and the /give page reads x-nonce for the PayPal SDK.
// /gift/[token] also gets the static privacy headers on every response and
// the shared request window, so an over-limit request gets a real 429 with Retry-After and no gift data.
const GIFT_PATH = /^\/gift\/([^/]+)$/;
const THROTTLED_BODY = "Too many requests. Try again in a minute.";

// The token exactly as the page will receive it: Next decodes the segment before it becomes params.token. Testing the decoded
// value means an encoded spelling of a valid token cannot reach the lookup without taking a slot. Malformed tokens take none.
function wellFormedGiftToken(pathname: string): boolean {
  const match = GIFT_PATH.exec(pathname);
  if (!match) return false;
  try { return isGiftTokenShape(decodeURIComponent(match[1]!)); } catch { return false; }
}

export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const gift = request.nextUrl.pathname === "/gift" || request.nextUrl.pathname.startsWith("/gift/");
  const policy = gift ? giftContentSecurityPolicy(nonce) : giveContentSecurityPolicy(nonce);
  if (gift && wellFormedGiftToken(request.nextUrl.pathname)) {
    // If the limiter itself cannot run (the database is unreachable), the request continues: the page then fails closed
    // on its own database read and shows no data, so a limiter fault never opens a gift and never blocks one.
    let allowed = true;
    try { allowed = await takeGiftPageSlot(getDatabase()); } catch { allowed = true; }
    if (!allowed) {
      const throttled = new NextResponse(THROTTLED_BODY, { status: 429, headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "60" } });
      for (const [name, value] of Object.entries(GIFT_STATIC_HEADERS)) throttled.headers.set(name, value);
      throttled.headers.set("Content-Security-Policy", policy);
      return throttled;
    }
  }
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  if (gift) for (const [name, value] of Object.entries(GIFT_STATIC_HEADERS)) response.headers.set(name, value);
  return response;
}
export const config = { matcher: ["/give", "/gift/:path*"] };
