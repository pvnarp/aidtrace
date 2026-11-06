import { expiredSessionCookie, isSameOrigin, revokeSession, sessionToken } from "../../../../server/auth";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return new Response("Request origin rejected", { status: 403 });
  await revokeSession(sessionToken(request));
  return new Response(null, { status: 303, headers: { Location: "/login", "Set-Cookie": expiredSessionCookie(), "Cache-Control": "no-store" } });
}
