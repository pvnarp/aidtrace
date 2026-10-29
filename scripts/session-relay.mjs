import { createServer, request } from "node:http";
// Fixed local upstream only. This service receives no app credentials or source tree.
createServer((incoming, outgoing) => {
  if (!incoming.url?.startsWith("/") || incoming.url.startsWith("//")) { outgoing.writeHead(400).end(); return; }
  const headers = { ...incoming.headers };
  for (const key of ["connection", "upgrade", "x-forwarded-host", "x-forwarded-proto"]) delete headers[key];
  const upstream = request({ hostname: "app", port: 3000, path: incoming.url, method: incoming.method, headers }, response => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
  });
  upstream.setTimeout(90000, () => upstream.destroy());
  upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end("The local session is not ready."); });
  incoming.on("aborted", () => upstream.destroy());
  outgoing.on("close", () => { if (!outgoing.writableFinished) upstream.destroy(); });
  incoming.pipe(upstream);
}).listen(3000, "0.0.0.0");
