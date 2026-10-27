import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const headerNames = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"] as const;
export function createLabWebhookServer(directory: string, pathToken: string) {
  if (!/^[a-f0-9]{64}$/.test(pathToken)) throw new Error("Invalid private webhook path token");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const server = createServer(async (request, response) => {
    const reply = (status: number, body: object) => { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(body)); };
    try {
      if (request.method === "GET" && request.url === "/healthz") return reply(200, { healthy: true });
      if (request.method !== "POST" || request.url !== `/paypal/${pathToken}`) return reply(404, { error: "Not found" });
      if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")) return reply(415, { error: "JSON required" });
      const headers: Record<string, string> = {};
      for (const name of headerNames) {
        const value = request.headers[name];
        if (typeof value !== "string" || !value || value.length > 1024) return reply(400, { error: "Signature metadata required" });
        headers[name] = value;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk); bytes += buffer.length;
        if (bytes > 131072) return reply(413, { error: "Body too large" });
        chunks.push(buffer);
      }
      const raw = Buffer.concat(chunks);
      let event: unknown;
      try { event = JSON.parse(raw.toString("utf8")); } catch { return reply(400, { error: "Invalid JSON" }); }
      if (!event || typeof event !== "object" || !("id" in event) || typeof event.id !== "string" || !/^WH-[A-Za-z0-9-]{1,125}$/.test(event.id) || !("event_type" in event) || typeof event.event_type !== "string" || !/^[A-Z0-9_.]{1,100}$/.test(event.event_type)) return reply(400, { error: "Event metadata required" });
      const receipt = createHash("sha256").update(headers["paypal-transmission-id"]!).update("\0").update(headers["paypal-transmission-sig"]!).update("\0").update(raw).digest("hex");
      const files = readdirSync(directory).filter(file => /^[a-f0-9]{64}\.json$/.test(file));
      if (!files.includes(`${receipt}.json`) && files.length >= 100) return reply(507, { error: "Lab storage limit reached" });
      try { writeFileSync(join(directory, `${receipt}.json`), JSON.stringify({ receivedAt: new Date().toISOString(), rawBodyBase64: raw.toString("base64"), headers }) + "\n", { flag: "wx", mode: 0o600 }); }
      catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
      // Receipt acknowledgement is not signature verification. Never process an event here.
      reply(200, { received: true, verified: false });
    } catch { if (!response.headersSent) reply(500, { error: "Receipt storage failed" }); else response.end(); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 30;
  return server;
}
