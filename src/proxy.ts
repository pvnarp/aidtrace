import { NextResponse, type NextRequest } from "next/server";
import { giveContentSecurityPolicy } from "./server/give-csp";

// Next 16 proxy (the renamed middleware), matched to /give only. It sets a fresh nonce per request: Next applies the
// nonce from the request's Content-Security-Policy header to its own scripts, and the page reads x-nonce for the PayPal SDK.
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = giveContentSecurityPolicy(nonce);
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}
export const config = { matcher: ["/give"] };
