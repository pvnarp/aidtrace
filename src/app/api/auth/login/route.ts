import { authenticate, isSameOrigin, sessionCookie } from "../../../../server/auth";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return new Response("Request origin rejected", { status: 403 });
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return new Response("Form submission required", { status: 415 });
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > 1024) { await reader.cancel(); return new Response("Request too large", { status: 413 }); }
    chunks.push(chunk.value);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  const form = new URLSearchParams(body);
  const username = form.get("username")?.trim().toLowerCase() ?? "";
  const password = form.get("password") ?? "";
  const session = await authenticate(username, password);
  if (!session) return new Response(null, { status: 303, headers: { Location: "/login?error=1", "Cache-Control": "no-store" } });
  return new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": sessionCookie(session.token, session.expires), "Cache-Control": "no-store" } });
}
