import { describe, expect, it, vi } from "vitest";
import { createApplicationSandboxPayments, createPayPalAdapter, type PayPalConfig } from "../src/paypal/adapter";

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

// IAC-379 SEC-01 repeat: the donation order methods sit behind the same sandbox guard. Stub transport only.
describe("SEC-01 repeat for the donation order workflow", () => {
  const donation: PayPalConfig = { ...valid, maxDemoDonationCents: 5000n };
  const CREATE_ID = "11111111-1111-4111-8111-111111111111";
  it.each([
    { ...donation, baseUrl: "https://api-m.paypal.com" },
    { ...donation, baseUrl: "https://api-m.sandbox.paypal.com/" },
    { ...donation, baseUrl: "http://api-m.sandbox.paypal.com" },
    { ...donation, baseUrl: undefined },
    { ...donation, clientId: undefined },
    { ...donation, clientSecret: " " },
  ])("rejects unsafe configuration before the application adapter can create or capture an order", (config) => {
    const request = vi.fn<typeof fetch>();
    const globalRequest = vi.spyOn(globalThis, "fetch");
    try {
      expect(() => createApplicationSandboxPayments(config, false, request)).toThrow();
      expect(request).not.toHaveBeenCalled();
      expect(globalRequest).not.toHaveBeenCalled();
    } finally { globalRequest.mockRestore(); }
  });
  it("refuses out-of-policy donation inputs with zero requests of any kind", async () => {
    const request = vi.fn<typeof fetch>();
    const globalRequest = vi.spyOn(globalThis, "fetch");
    try {
      const adapter = createApplicationSandboxPayments(donation, false, request);
      await expect(adapter.createDonationOrder({ requestId: CREATE_ID, fundId: "fund_b", amountCents: 5001n })).rejects.toThrow();
      await expect(adapter.createDonationOrder({ requestId: CREATE_ID, fundId: "fund_b", amountCents: 0n })).rejects.toThrow();
      await expect(adapter.createDonationOrder({ requestId: "reused-or-invalid", fundId: "fund_b", amountCents: 100n })).rejects.toThrow();
      await expect(adapter.createDonationOrder({ requestId: CREATE_ID, fundId: "../funds", amountCents: 100n })).rejects.toThrow();
      await expect(adapter.captureDonationOrder("../orders", CREATE_ID)).rejects.toThrow();
      await expect(adapter.captureDonationOrder("ORDER1", "not-a-uuid")).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
      expect(globalRequest).not.toHaveBeenCalled();
    } finally { globalRequest.mockRestore(); }
  });
});
