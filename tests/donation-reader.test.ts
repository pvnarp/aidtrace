import { expect, it, vi } from "vitest";
import { createApplicationSandboxPayments } from "../src/paypal/adapter";
const config = { baseUrl: "https://api-m.sandbox.paypal.com", clientId: "synthetic", clientSecret: "synthetic", payeeAllowlist: [], maxDemoPayoutCents: 50000n };
it("reads an existing Orders v2 capture and parses exact USD breakdown without creating or capturing", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: "synthetic-token", expires_in: 3600 })).mockResolvedValueOnce(Response.json({ id: "ORDER_TEST", intent: "CAPTURE", status: "COMPLETED", purchase_units: [{ custom_id: "fund_b", amount: { currency_code: "USD", value: "1.00" }, payments: { captures: [{ id: "CAPTURE_TEST", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" }, update_time: "2026-10-22T20:00:00Z", seller_receivable_breakdown: { gross_amount: { currency_code: "USD", value: "1.00" }, paypal_fee: { currency_code: "USD", value: "0.52" }, net_amount: { currency_code: "USD", value: "0.48" } } }] } }] }));
  const result = await createApplicationSandboxPayments(config, false, request).donationOrder("ORDER_TEST");
  expect(result).toMatchObject({ orderId: "ORDER_TEST", units: [{ fundId: "fund_b", amountCents: 100n }], captures: [{ captureId: "CAPTURE_TEST", grossCents: 100n, feeCents: 52n, netCents: 48n, effectiveOn: "2026-10-22" }] });
  expect(request.mock.calls[1]![0]).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER_TEST"); expect(request.mock.calls[1]![1]!.method).toBe("GET"); expect(request).toHaveBeenCalledTimes(2);
});
