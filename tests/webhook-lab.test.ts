import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLabWebhookServer } from "../src/lab/webhook-server";
import { createManualSandboxLab } from "../src/paypal/adapter";

const config = { baseUrl: "https://api-m.sandbox.paypal.com", clientId: "test-client", clientSecret: "test-secret", payeeAllowlist: [], maxDemoPayoutCents: 50000n };
const headers = { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST1", "paypal-transmission-id": "transmission-test1", "paypal-transmission-sig": "c3ludGhldGlj", "paypal-transmission-time": "2026-10-22T18:31:03Z" };
const event = { id: "WH-TEST1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAPTURE1", payer: { email_address: "private" } } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function listener() {
  const directory = mkdtempSync(join(tmpdir(), "aidtrace-webhook-test-"));
  const token = "a".repeat(64);
  const server = createLabWebhookServer(directory, token);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }); rmSync(directory, { recursive: true }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test listener");
  return { directory, base: `http://127.0.0.1:${address.port}`, path: `/paypal/${token}` };
}
it("quarantines exact bytes and only signature headers, acknowledges duplicates without processing", async () => {
  const lab = await listener();
  const raw = JSON.stringify(event, null, 2) + "\n";
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(lab.base + lab.path, { method: "POST", headers: { ...headers, "Content-Type": "application/json", Authorization: "private-unrelated-header" }, body: raw });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, verified: false });
  }
  const files = readdirSync(lab.directory);
  expect(files).toHaveLength(1);
  const stored = JSON.parse(readFileSync(join(lab.directory, files[0]!), "utf8"));
  expect(Buffer.from(stored.rawBodyBase64, "base64").toString("utf8")).toBe(raw);
  expect(stored.headers).toEqual(headers);
  expect(JSON.stringify(stored)).not.toContain("private-unrelated-header");
});
it("exposes health only and refuses readback or unsigned event storage", async () => {
  const lab = await listener();
  expect((await fetch(lab.base + "/healthz")).status).toBe(200);
  expect((await fetch(lab.base + lab.path)).status).toBe(404);
  expect((await fetch(lab.base + "/config.json")).status).toBe(404);
  expect((await fetch(lab.base + lab.path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) })).status).toBe(400);
  expect(readdirSync(lab.directory)).toEqual([]);
});
it("does not accept requests at another path or invalid JSON as receipts", async () => {
  const lab = await listener();
  expect((await fetch(lab.base + "/paypal/wrong", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(event) })).status).toBe(404);
  expect((await fetch(lab.base + lab.path, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{" })).status).toBe(400);
  expect(readdirSync(lab.directory)).toEqual([]);
});
it.each(["https://api.paypal.com/v1/notifications/certs/CERT-TEST1", "https://attacker.test/cert", "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST1?redirect=1"])("rejects unsafe certificate metadata before any verification network request: %s", async cert => {
  const request = vi.fn<typeof fetch>();
  await expect(createManualSandboxLab(config, request).verifyLabWebhook("TESTWEBHOOK1", { ...headers, "paypal-cert-url": cert }, event)).rejects.toThrow("Sandbox PayPal certificate");
  expect(request).not.toHaveBeenCalled();
});
it("posts a real event for human verification while withholding signature, token, and personal data in output", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" })).mockResolvedValueOnce(Response.json({ verification_status: "SUCCESS" }));
  const result = await createManualSandboxLab(config, request).verifyLabWebhook("TESTWEBHOOK1", headers, event);
  expect(request.mock.calls[1]?.[0]).toBe("https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature");
  expect(JSON.parse(request.mock.calls[1]![1]!.body as string)).toMatchObject({ webhook_id: "TESTWEBHOOK1", webhook_event: event });
  expect(result.verificationStatus).toBe("SUCCESS");
  expect(JSON.stringify(result)).not.toMatch(/private|synthetic-token|c3ludGhldGlj/);
});
it("does not turn HTTP success into signature success when PayPal returns FAILURE", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" })).mockResolvedValueOnce(Response.json({ verification_status: "FAILURE" }));
  const result = await createManualSandboxLab(config, request).verifyLabWebhook("TESTWEBHOOK1", headers, event);
  expect(result.httpStatus).toBe(200);
  expect(result.verificationStatus).toBe("FAILURE");
});
