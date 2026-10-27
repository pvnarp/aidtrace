import { describe, expect, it, vi } from "vitest";
import { createPayPalAdapter, type PayPalConfig } from "../src/paypal/adapter";

const valid: PayPalConfig = {
  baseUrl: "https://api-m.sandbox.paypal.com",
  clientId: "synthetic-test-client",
  clientSecret: "synthetic-test-secret",
  payeeAllowlist: ["fixture@personal.example.com"],
  maxDemoPayoutCents: 50000n,
};

describe("SEC-01 sandbox guard skeleton", () => {
  it.each([
    { ...valid, baseUrl: "https://api-m.paypal.com" },
    { ...valid, baseUrl: "https://api-m.sandbox.paypal.com/" },
    { ...valid, baseUrl: undefined },
    { ...valid, clientId: undefined },
    { ...valid, clientSecret: " " },
  ])("rejects unsafe configuration before network access", (config) => {
    const request = vi.fn<typeof fetch>();
    const globalRequest = vi.spyOn(globalThis, "fetch");
    try {
      expect(() => createPayPalAdapter(config, request)).toThrow();
      expect(request).not.toHaveBeenCalled();
      expect(globalRequest).not.toHaveBeenCalled();
    } finally { globalRequest.mockRestore(); }
  });
  it("enforces the allowlist and payout ceiling", () => {
    const adapter = createPayPalAdapter(valid);
    expect(() => adapter.validatePayout("other@example.invalid", 50000n)).toThrow();
    expect(() => adapter.validatePayout("fixture@personal.example.com", 50001n)).toThrow();
    expect(() => adapter.validatePayout("fixture@personal.example.com", 0n)).toThrow();
    expect(() => adapter.validatePayout("fixture@personal.example.com", 50000n)).not.toThrow();
  });
});
