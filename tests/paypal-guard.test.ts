import { describe, expect, it, vi } from "vitest";
import { DONATION_MAX_CENTS, createApplicationSandboxPayments, createPayPalAdapter, payPalConfigFromEnvironment, type PayPalConfig } from "../src/paypal/adapter";

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
  const donation: PayPalConfig = { ...valid };
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
  it("refuses invalid donation inputs with zero requests of any kind (the bound is technical, not a donation limit)", async () => {
    const request = vi.fn<typeof fetch>();
    const globalRequest = vi.spyOn(globalThis, "fetch");
    try {
      const adapter = createApplicationSandboxPayments(donation, false, request);
      await expect(adapter.createDonationOrder({ requestId: CREATE_ID, fundId: "fund_b", amountCents: DONATION_MAX_CENTS + 1n })).rejects.toThrow("technical bound");
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

// IAC-391 SEC-01 repeat: the payout guard and its configuration are independent of every donation setting.
describe("DON-H-03 SEC-01 repeat: payout guard unchanged and independent of donation settings", () => {
  const env = { PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "synthetic-test-client", PAYPAL_CLIENT_SECRET: "synthetic-test-secret", PAYEE_ALLOWLIST: "fixture@personal.example.com", MAX_DEMO_PAYOUT_CENTS: "50000" };
  it("builds the same payout guard with or without a malformed donation variable, and still enforces allowlist and ceiling", () => {
    for (const bad of [undefined, "abc", "0", "-5", "99999999999999999"]) {
      const config = payPalConfigFromEnvironment({ ...env, ...(bad === undefined ? {} : { MAX_DEMO_DONATION_CENTS: bad }) });
      expect(Object.keys(config).sort()).toEqual(["baseUrl", "clientId", "clientSecret", "maxDemoPayoutCents", "payeeAllowlist"]);
      const adapter = createPayPalAdapter(config, vi.fn<typeof fetch>());
      expect(() => adapter.validatePayout("other@example.invalid", 50000n)).toThrow();
      expect(() => adapter.validatePayout("fixture@personal.example.com", 50001n)).toThrow();
      expect(() => adapter.validatePayout("fixture@personal.example.com", 50000n)).not.toThrow();
    }
  });
  it("keeps the sandbox URL and credential guard in front of the donation methods", () => {
    for (const unsafe of [{ ...env, PAYPAL_BASE_URL: "https://api-m.paypal.com" }, { ...env, PAYPAL_CLIENT_ID: "" }, { ...env, PAYPAL_CLIENT_SECRET: " " }]) {
      const request = vi.fn<typeof fetch>();
      expect(() => createApplicationSandboxPayments(payPalConfigFromEnvironment(unsafe), false, request)).toThrow();
      expect(request).not.toHaveBeenCalled();
    }
  });
});
