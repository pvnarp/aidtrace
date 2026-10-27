import { findSession, sessionToken } from "../../../../server/auth";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const user = await findSession(sessionToken(request));
  return Response.json(user ? { user } : { error: "Authentication required" }, { status: user ? 200 : 401, headers: { "Cache-Control": "no-store" } });
}
