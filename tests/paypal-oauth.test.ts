import { expect, it, vi } from "vitest";
import { createPayPalAdapter, payPalConfigFromEnvironment } from "../src/paypal/adapter";

it("keeps the human OAuth probe sandbox-only and returns no token", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ access_token: "synthetic-test-token", expires_in: 900 }));
  const adapter = createPayPalAdapter({ baseUrl: "https://api-m.sandbox.paypal.com", clientId: "test-client", clientSecret: "test-secret", payeeAllowlist: [], maxDemoPayoutCents: 50000n }, request);
  const result = await adapter.probeAuthentication();
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]?.[0]).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
  expect(request.mock.calls[0]?.[1]?.redirect).toBe("error");
  expect("access_token" in result).toBe(false);
  expect(result.authenticated).toBe(true);
});
it("parses the environment ceiling without floating-point conversion", () => {
  expect(payPalConfigFromEnvironment({}).maxDemoPayoutCents).toBe(50000n);
  expect(() => payPalConfigFromEnvironment({ MAX_DEMO_PAYOUT_CENTS: "500.00" })).toThrow();
});
