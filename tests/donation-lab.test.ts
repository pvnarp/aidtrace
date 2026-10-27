import { expect, it, vi } from "vitest";
import { createManualSandboxLab } from "../src/paypal/adapter";

const config = { baseUrl: "https://api-m.sandbox.paypal.com", clientId: "test-client", clientSecret: "test-secret", payeeAllowlist: [], maxDemoPayoutCents: 50000n };
const uuid = "00000000-0000-4000-8000-000000000001";
const unit = { custom_id: "fund_b", amount: { currency_code: "USD", value: "1.00" } };
const approved = { id: "ORDER1", status: "APPROVED", intent: "CAPTURE", purchase_units: [unit] };
it("creates only a one-dollar designated sandbox order with persisted idempotency and human approval", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
    .mockResolvedValueOnce(Response.json({ id: "ORDER1", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1" }], payer: { email_address: "private" } }, { status: 201 }));
  const result = await createManualSandboxLab(config, request).createOneDollarDonation(uuid);
  const init = request.mock.calls[1]![1]!;
  expect(init.headers).toMatchObject({ "PayPal-Request-Id": uuid, Prefer: "return=representation" });
  const payload = JSON.parse(init.body as string);
  expect(payload.intent).toBe("CAPTURE");
  expect(payload.purchase_units).toHaveLength(1);
  expect(payload.purchase_units[0]).toMatchObject(unit);
  expect(payload.payment_source.paypal.experience_context.user_action).toBe("CONTINUE");
  expect(result.approvalUrl).toBe("https://www.sandbox.paypal.com/checkoutnow?token=ORDER1");
  expect(JSON.stringify(result)).not.toMatch(/private|synthetic-token/);
});
it.each(["https://www.paypal.com/checkoutnow?token=ORDER1", "https://www.sandbox.paypal.com.attacker.test/checkoutnow?token=ORDER1", "https://www.sandbox.paypal.com/checkoutnow?token=OTHER"])("withholds an unsafe or mismatched approval link: %s", async href => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
    .mockResolvedValueOnce(Response.json({ id: "ORDER1", links: [{ rel: "approve", href }] }, { status: 201 }));
  expect((await createManualSandboxLab(config, request).createOneDollarDonation(uuid)).approvalUrl).toBeUndefined();
});
it("rejects an unpersisted request ID or an excessive configured lab amount before network access", async () => {
  const request = vi.fn<typeof fetch>();
  await expect(createManualSandboxLab(config, request).createOneDollarDonation("invalid")).rejects.toThrow("UUID");
  await expect(createManualSandboxLab({ ...config, maxDemoPayoutCents: 99n }, request).createOneDollarDonation(uuid)).rejects.toThrow("ceiling");
  expect(request).not.toHaveBeenCalled();
});
it.each([
  { ...approved, status: "CREATED" },
  { ...approved, id: "OTHER" },
  { ...approved, intent: "AUTHORIZE" },
  { ...approved, purchase_units: [{ ...unit, amount: { currency_code: "USD", value: "100.00" } }] },
  { ...approved, purchase_units: [{ ...unit, custom_id: "fund_a" }] },
  { ...approved, purchase_units: [unit, unit] },
  { ...approved, purchase_units: [{ ...unit, payments: { captures: [{ id: "CAPTURE1", status: "COMPLETED" }] } }] },
])("refuses capture when the live order is outside the approved lab terms: %#", async order => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
    .mockResolvedValueOnce(Response.json(order));
  await expect(createManualSandboxLab(config, request).captureOneDollarDonation("ORDER1", uuid)).rejects.toThrow("approved, uncaptured");
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]?.[1]?.method).toBe("GET");
});
it("captures the approved order once and reports independent gross fee net fields without payer data", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
    .mockResolvedValueOnce(Response.json(approved))
    .mockResolvedValueOnce(Response.json({ ...approved, status: "COMPLETED", payer: { email_address: "private" }, purchase_units: [{ ...unit, payments: { captures: [{ id: "CAPTURE1", status: "COMPLETED", amount: unit.amount, seller_receivable_breakdown: { gross_amount: unit.amount, paypal_fee: { currency_code: "USD", value: "0.52" }, net_amount: { currency_code: "USD", value: "0.48" } } }] } }] }, { status: 201 }));
  const result = await createManualSandboxLab(config, request).captureOneDollarDonation("ORDER1", uuid);
  expect(request.mock.calls[2]?.[0]).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER1/capture");
  expect(request.mock.calls[2]?.[1]?.headers).toMatchObject({ "PayPal-Request-Id": uuid });
  expect(result.captures[0]).toMatchObject({ captureId: "CAPTURE1", status: "COMPLETED", gross: { value: "1.00" }, fee: { value: "0.52" }, net: { value: "0.48" } });
  expect(JSON.stringify(result)).not.toMatch(/private|synthetic-token/);
});
it("does not retry a capture POST after a network exception", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
    .mockResolvedValueOnce(Response.json(approved)).mockRejectedValueOnce(new Error("synthetic disconnect"));
  await expect(createManualSandboxLab(config, request).captureOneDollarDonation("ORDER1", uuid)).rejects.toThrow("synthetic disconnect");
  expect(request).toHaveBeenCalledTimes(3);
});
