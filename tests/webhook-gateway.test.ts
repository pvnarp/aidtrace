import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createWebhookGateway } from "../src/server/webhook-gateway";
const received: { path: string; cookie?: string; authorization?: string; transmission?: string; body: string }[] = [];
const upstream = createServer(async (request, response) => {
  let body = ""; for await (const chunk of request) body += chunk.toString();
  received.push({ path: request.url!, cookie: request.headers.cookie, authorization: request.headers.authorization, transmission: request.headers["paypal-transmission-id"] as string, body });
  response.writeHead(204); response.end();
});
let gateway: ReturnType<typeof createWebhookGateway>; let origin: string;
beforeAll(async () => {
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  gateway = createWebhookGateway(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
  await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => gateway.close(error => error ? reject(error) : resolve())); await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve())); });
it("forwards only exact webhook POST bytes and signature metadata, stripping sessions and authorization", async () => {
  const body = '{ "id": "WH-test" }';
  expect((await fetch(`${origin}/api/webhooks/paypal`, { method: "POST", headers: { "content-type": "application/json", cookie: "private-session", authorization: "Bearer private", "paypal-transmission-id": "test-id" }, body })).status).toBe(204);
  expect(received).toEqual([{ path: "/api/webhooks/paypal", cookie: undefined, authorization: undefined, transmission: "test-id", body }]);
});
it("cannot expose application pages, claim actions or oversized requests", async () => {
  for (const path of ["/", "/login", "/claims/C-104", "/api/claims/C-104/actions", "/api/webhooks/paypal?x=1"]) expect((await fetch(`${origin}${path}`, { method: "POST", body: "test" })).status).toBe(404);
  expect((await fetch(`${origin}/api/webhooks/paypal`)).status).toBe(404);
  expect((await fetch(`${origin}/api/webhooks/paypal`, { method: "POST", body: "a".repeat(65537) })).status).toBe(413);
  expect(received).toHaveLength(1);
});
