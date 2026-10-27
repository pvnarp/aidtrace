import { createServer, request as upstreamRequest } from "node:http";

// The public tunnel cannot reach login, claim actions, cookies or application pages.
export function createWebhookGateway(target = "http://app:3000") {
  const upstream = new URL("/api/webhooks/paypal", target);
  return createServer(async (incoming, outgoing) => {
    if (incoming.method !== "POST" || incoming.url !== "/api/webhooks/paypal") { outgoing.writeHead(404); outgoing.end(); incoming.resume(); return; }
    const chunks: Buffer[] = []; let length = 0;
    try {
      for await (const chunk of incoming) {
        length += chunk.length;
        if (length > 65536) { outgoing.writeHead(413); outgoing.end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      const headers: Record<string, string> = { "content-type": String(incoming.headers["content-type"] ?? ""), "content-length": String(body.length) };
      for (const name of ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"]) if (typeof incoming.headers[name] === "string") headers[name] = incoming.headers[name];
      const request = upstreamRequest(upstream, { method: "POST", headers, timeout: 60000 }, response => {
        outgoing.writeHead(response.statusCode ?? 502, { "Cache-Control": "no-store", "Content-Type": "text/plain" }); response.pipe(outgoing);
      });
      request.on("timeout", () => request.destroy());
      request.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      request.end(body);
    } catch { if (!outgoing.headersSent) outgoing.writeHead(400); outgoing.end(); }
  });
}
