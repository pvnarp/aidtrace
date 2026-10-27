import { expect, it, vi } from "vitest";
import { createApplicationSandboxPayments } from "../src/paypal/adapter";
const config = { baseUrl: "https://api-m.sandbox.paypal.com", clientId: "synthetic", clientSecret: "synthetic", payeeAllowlist: ["test@personal.example.com"], maxDemoPayoutCents: 50000n };
const headers = { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test", "paypal-transmission-id": "test-transmission", "paypal-transmission-sig": "c3ludGhldGlj", "paypal-transmission-time": "2026-10-22T20:00:00Z" };
const event = { id: "WH-TEST-REALFORMAT", event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", resource: { payout_item_id: "SYNTHETIC_ITEM" } };
it("requests only notification redelivery to one registered listener and rejects unsafe event IDs", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: "synthetic-token", expires_in: 3600 })).mockResolvedValueOnce(new Response(null, { status: 202 }));
  const adapter = createApplicationSandboxPayments(config, false, request);
  expect(await adapter.resendWebhookEvent("WH-SYNTHETIC-EXISTING", "REGISTERED123")).toEqual({ httpStatus: 202, errorCode: undefined });
  expect(request.mock.calls[1]![0]).toBe("https://api-m.sandbox.paypal.com/v1/notifications/webhooks-events/WH-SYNTHETIC-EXISTING/resend");
  expect(request.mock.calls[1]![1]!.method).toBe("POST"); expect(JSON.parse(String(request.mock.calls[1]![1]!.body))).toEqual({ webhook_ids: ["REGISTERED123"] });
  for (const id of ["../unsafe", "WH-SIMULATOR-123"]) await expect(adapter.resendWebhookEvent(id, "REGISTERED123")).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(2);
});
it("reads the configured registration with GET and filters its event list without submitting a payout", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: "synthetic-token", expires_in: 3600 })).mockResolvedValueOnce(Response.json({ id: "REGISTERED123", url: "https://synthetic.ngrok-free.dev/api/webhooks/paypal", event_types: [{ name: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED" }, { name: "*" }, { name: "not a valid event" }] }));
  const result = await createApplicationSandboxPayments(config, false, request).webhookRegistration("REGISTERED123");
  expect(result).toEqual({ httpStatus: 200, id: "REGISTERED123", url: "https://synthetic.ngrok-free.dev/api/webhooks/paypal", eventTypes: ["PAYMENT.PAYOUTS-ITEM.SUCCEEDED", "*"], errorCode: undefined });
  expect(request.mock.calls[1]).toMatchObject(["https://api-m.sandbox.paypal.com/v1/notifications/webhooks/REGISTERED123", { method: "GET" }]);
  await expect(createApplicationSandboxPayments(config, false, request).webhookRegistration("../unsafe")).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(2);
});
it("postback verifies with the configured ID and original parsed event, never fetching certificate URLs", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: "synthetic-token", expires_in: 3600 })).mockResolvedValueOnce(Response.json({ verification_status: "SUCCESS" }));
  const result = await createApplicationSandboxPayments(config, false, request).verifyWebhook("REGISTERED123", headers, event);
  expect(result).toEqual({ httpStatus: 200, verificationStatus: "SUCCESS" });
  expect(request.mock.calls.map(([url]) => url)).toEqual(["https://api-m.sandbox.paypal.com/v1/oauth2/token", "https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature"]);
  expect(JSON.parse(String(request.mock.calls[1]![1]!.body))).toMatchObject({ webhook_id: "REGISTERED123", webhook_event: event, transmission_id: "test-transmission" });
});
it("refuses simulator IDs, missing metadata and unsafe certificate URLs before any request", async () => {
  const request = vi.fn<typeof fetch>(); const adapter = createApplicationSandboxPayments(config, false, request);
  await expect(adapter.verifyWebhook("WEBHOOK_ID", headers, event)).rejects.toThrow();
  await expect(adapter.verifyWebhook("REGISTERED123", {}, event)).rejects.toThrow();
  for (const url of ["http://api.sandbox.paypal.com/v1/notifications/certs/CERT-a", "https://evil.example/cert", "https://api.sandbox.paypal.com.evil.example/v1/notifications/certs/CERT-a", "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-a?q=1"]) await expect(adapter.verifyWebhook("REGISTERED123", { ...headers, "paypal-cert-url": url }, event)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
