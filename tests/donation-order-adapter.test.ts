import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationSandboxPayments, payPalConfigFromEnvironment, type PayPalConfig } from "../src/paypal/adapter";

// IAC-379 step 1. Every response here is a stub written by this file. Nothing contacts PayPal. These tests prove
// our request shape, allowlist parsing and guards, not PayPal behavior.
const config: PayPalConfig = { baseUrl: "https://api-m.sandbox.paypal.com", clientId: "synthetic-client", clientSecret: "synthetic-secret", payeeAllowlist: [], maxDemoPayoutCents: 50000n, maxDemoDonationCents: 5000n };
const CREATE_ID = "11111111-1111-4111-8111-111111111111";
const CAPTURE_ID = "22222222-2222-4222-8222-222222222222";
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const oauth = () => response({ access_token: "synthetic-token", expires_in: 3600 });
const BASE = "https://api-m.sandbox.paypal.com";
const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map(name => vi.spyOn(console, name).mockImplementation(() => undefined));
afterEach(() => consoleSpies.forEach(spy => spy.mockClear()));

describe("DON-01 order creation request, stubbed provider only", () => {
  it.each([[1n, "0.01"], [5n, "0.05"], [99n, "0.99"], [100n, "1.00"], [2500n, "25.00"], [5000n, "50.00"]])("sends one CAPTURE unit with custom_id and exact decimal for %s cents", async (cents, value) => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(oauth()).mockResolvedValueOnce(response({ id: "ORDER1", status: "CREATED" }, 201));
    const result = await createApplicationSandboxPayments(config, false, request).createDonationOrder({ requestId: CREATE_ID, fundId: "fund_b", amountCents: cents });
    expect(result).toMatchObject({ httpStatus: 201, orderId: "ORDER1", status: "CREATED", errorIssues: [] });
    expect(request).toHaveBeenCalledTimes(2);
    const [url, init] = request.mock.calls[1]!;
    expect(url).toBe(`${BASE}/v2/checkout/orders`);
    expect(init!.method).toBe("POST"); expect(init!.redirect).toBe("error");
    const headers = init!.headers as Record<string, string>;
    expect(headers["PayPal-Request-Id"]).toBe(CREATE_ID); expect(headers.Authorization).toBe("Bearer synthetic-token");
    expect(JSON.parse(String(init!.body))).toEqual({ intent: "CAPTURE", purchase_units: [{ custom_id: "fund_b", amount: { currency_code: "USD", value } }] });
    expect(String(init!.body)).toContain(`"value":"${value}"`); // a string, never a JSON number
  });
  it("parses an allowlist only and drops payer, address, card and link data", async () => {
    const body = { id: "ORDER1", status: "CREATED", intent: "CAPTURE", payer: { email_address: "payer@example.com", payer_id: "PAYERID123", name: { given_name: "Pat" }, address: { address_line_1: "1 Private Way" } },
      payment_source: { card: { last_digits: "4242", brand: "VISA" } }, links: [{ href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1", rel: "approve" }],
      purchase_units: [{ shipping: { address: { address_line_1: "1 Private Way" } } }] };
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(oauth()).mockResolvedValueOnce(response(body, 201));
    const result = await createApplicationSandboxPayments(config, false, request).createDonationOrder({ requestId: CREATE_ID, fundId: "fund_b", amountCents: 2500n });
    expect(Object.keys(result).sort()).toEqual(["errorCode", "errorIssues", "httpStatus", "orderId", "status"]);
    const text = JSON.stringify(result, (_k, v) => typeof v === "bigint" ? v.toString() : v);
    for (const forbidden of ["payer@example.com", "PAYERID123", "Pat", "Private Way", "4242", "VISA", "checkoutnow"]) expect(text).not.toContain(forbidden);
  });
  it("does not repeat a create POST after a timeout or HTTP 500", async () => {
    const timedOut = vi.fn<typeof fetch>().mockResolvedValueOnce(oauth()).mockRejectedValueOnce(new Error("synthetic timeout"));
    await expect(createApplicationSandboxPayments(config, false, timedOut).createDonationOrder({ requestId: CREATE_ID, fundId: "fund_b", amountCents: 100n })).rejects.toThrow("timeout");
    expect(timedOut).toHaveBeenCalledTimes(2);
    const failed = vi.fn<typeof fetch>().mockResolvedValueOnce(oauth()).mockResolvedValueOnce(response({ name: "INTERNAL_SERVER_ERROR" }, 500));
    expect(await createApplicationSandboxPayments(config, false, failed).createDonationOrder({ requestId: CREATE_ID, fundId: "fund_b", amountCents: 100n })).toMatchObject({ httpStatus: 500, errorCode: "INTERNAL_SERVER_ERROR" });
    expect(failed).toHaveBeenCalledTimes(2);
  });
});

describe("DON-04 capture request, stubbed provider only", () => {
  const capturedOrder = { id: "ORDER1", intent: "CAPTURE", status: "COMPLETED",
    payer: { email_address: "payer@example.com", payer_id: "PAYERID123", address: { country_code: "US" } }, payment_source: { card: { last_digits: "4242" } },
    purchase_units: [{ custom_id: "fund_b", amount: { currency_code: "USD", value: "25.00" }, shipping: { address: { address_line_1: "1 Private Way" } },
      payments: { captures: [{ id: "CAPTURE1", status: "COMPLETED", amount: { currency_code: "USD", value: "25.00" }, update_time: "2026-10-30T20:00:00Z",
        seller_receivable_breakdown: { gross_amount: { currency_code: "USD", value: "25.00" }, paypal_fee: { currency_code: "USD", value: "1.20" }, net_amount: { currency_code: "USD", value: "23.80" } } }] } }] };
  it("posts the capture endpoint with the persisted capture request ID and drops payer data", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(oauth()).mockResolvedValueOnce(response(capturedOrder, 201));
    const result = await createApplicationSandboxPayments(config, false, request).captureDonationOrder("ORDER1", CAPTURE_ID);
    expect(result).toMatchObject({ httpStatus: 201, orderId: "ORDER1", status: "COMPLETED", errorIssues: [], units: [{ fundId: "fund_b", amountCents: 2500n }],
      captures: [{ captureId: "CAPTURE1", status: "COMPLETED", amountCents: 2500n, grossCents: 2500n, feeCents: 120n, netCents: 2380n, effectiveOn: "2026-10-30" }] });
    const [url, init] = request.mock.calls[1]!;
    expect(url).toBe(`${BASE}/v2/checkout/orders/ORDER1/capture`); expect(init!.method).toBe("POST"); expect(init!.body).toBe("{}");
    expect((init!.headers as Record<string, string>)["PayPal-Request-Id"]).toBe(CAPTURE_ID);
    const text = JSON.stringify(result, (_k, v) => typeof v === "bigint" ? v.toString() : v);
    for (const forbidden of ["payer@example.com", "PAYERID123", "Private Way", "4242", "US"]) expect(text).not.toContain(forbidden);
    expect(Object.keys(result).sort()).toEqual(["captures", "errorCode", "errorIssues", "httpStatus", "intent", "orderId", "status", "units"]);
  });
  it("reports a documented instrument decline as an allowlisted issue code", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(oauth()).mockResolvedValueOnce(response({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED", description: "free text with payer@example.com" }, { issue: "not a code" }] }, 422));
    const result = await createApplicationSandboxPayments(config, false, request).captureDonationOrder("ORDER1", CAPTURE_ID);
    expect(result).toMatchObject({ httpStatus: 422, errorCode: "UNPROCESSABLE_ENTITY", errorIssues: ["INSTRUMENT_DECLINED"], captures: [] });
    expect(JSON.stringify(result)).not.toContain("payer@example.com");
  });
  it("sends one capture POST on timeout and one same-ID re-send only after a 401", async () => {
    const timedOut = vi.fn<typeof fetch>().mockResolvedValueOnce(oauth()).mockRejectedValueOnce(new Error("synthetic timeout"));
    await expect(createApplicationSandboxPayments(config, false, timedOut).captureDonationOrder("ORDER1", CAPTURE_ID)).rejects.toThrow("timeout");
    expect(timedOut).toHaveBeenCalledTimes(2);
    const expired = vi.fn<typeof fetch>().mockResolvedValueOnce(oauth()).mockResolvedValueOnce(response({}, 401)).mockResolvedValueOnce(oauth()).mockResolvedValueOnce(response(capturedOrder, 201));
    expect((await createApplicationSandboxPayments(config, false, expired).captureDonationOrder("ORDER1", CAPTURE_ID)).httpStatus).toBe(201);
    expect(expired).toHaveBeenCalledTimes(4);
    const first = expired.mock.calls[1]![1]!; const second = expired.mock.calls[3]![1]!;
    expect(second.body).toBe(first.body);
    expect((second.headers as Record<string, string>)["PayPal-Request-Id"]).toBe(CAPTURE_ID);
  });
});

describe("DON-08 adapter guards, stubbed provider only", () => {
  it("refuses an unsafe URL or missing credentials before any request", () => {
    const request = vi.fn<typeof fetch>();
    for (const unsafe of [{ ...config, baseUrl: "https://api-m.paypal.com" }, { ...config, baseUrl: undefined }, { ...config, clientId: undefined }, { ...config, clientSecret: " " }]) expect(() => createApplicationSandboxPayments(unsafe, false, request)).toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("enforces the donation ceiling: 5000 sends, 5001, 0, negative and non-bigint values do not", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(oauth());
    const adapter = createApplicationSandboxPayments(config, false, request);
    for (const amount of [5001n, 0n, -1n, -5000n, 5000.5 as unknown as bigint, 100 as unknown as bigint, "100" as unknown as bigint, undefined as unknown as bigint]) {
      await expect(adapter.createDonationOrder({ requestId: CREATE_ID, fundId: "fund_b", amountCents: amount })).rejects.toThrow("ceiling");
    }
    expect(request).not.toHaveBeenCalled();
    request.mockReset().mockResolvedValueOnce(oauth()).mockResolvedValueOnce(response({ id: "ORDER1", status: "CREATED" }, 201));
    await adapter.createDonationOrder({ requestId: CREATE_ID, fundId: "fund_b", amountCents: 5000n });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("defaults the ceiling to 5000 and honors a lower configured ceiling", async () => {
    const request = vi.fn<typeof fetch>();
    const { maxDemoDonationCents: _omitted, ...withoutCeiling } = config;
    await expect(createApplicationSandboxPayments(withoutCeiling, false, request).createDonationOrder({ requestId: CREATE_ID, fundId: "fund_b", amountCents: 5001n })).rejects.toThrow("ceiling");
    await expect(createApplicationSandboxPayments({ ...config, maxDemoDonationCents: 100n }, false, request).createDonationOrder({ requestId: CREATE_ID, fundId: "fund_b", amountCents: 101n })).rejects.toThrow("ceiling");
    expect(() => createApplicationSandboxPayments({ ...config, maxDemoDonationCents: 0n }, false, request)).toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("reads MAX_DEMO_DONATION_CENTS as a positive integer and defaults to 5000", () => {
    expect(payPalConfigFromEnvironment({}).maxDemoDonationCents).toBe(5000n);
    expect(payPalConfigFromEnvironment({ MAX_DEMO_DONATION_CENTS: "2500" }).maxDemoDonationCents).toBe(2500n);
    for (const bad of ["0", "-5", "50.5", "1e3", " 5", "05", "abc", "99999999999999999"]) expect(() => payPalConfigFromEnvironment({ MAX_DEMO_DONATION_CENTS: bad })).toThrow("MAX_DEMO_DONATION_CENTS");
  });
  it("refuses malformed request IDs, fund IDs and order IDs before any request", async () => {
    const request = vi.fn<typeof fetch>();
    const adapter = createApplicationSandboxPayments(config, false, request);
    for (const requestId of ["", "not-a-uuid", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "11111111-1111-1111-8111-111111111111", `${CREATE_ID} `]) await expect(adapter.createDonationOrder({ requestId, fundId: "fund_b", amountCents: 100n })).rejects.toThrow("request UUID");
    for (const fundId of ["", "FUND_B", "fund b", "../fund", "a".repeat(65)]) await expect(adapter.createDonationOrder({ requestId: CREATE_ID, fundId, amountCents: 100n })).rejects.toThrow("fund ID");
    for (const orderId of ["", "../x", "ORDER/capture", "A".repeat(65)]) await expect(adapter.captureDonationOrder(orderId, CAPTURE_ID)).rejects.toThrow("provider ID");
    await expect(adapter.captureDonationOrder("ORDER1", "nope")).rejects.toThrow("request UUID");
    expect(request).not.toHaveBeenCalled();
  });
  it("never logs tokens, credentials, headers or payer data, including when the transport fails", async () => {
    const leaky = new Error("transport failed with Authorization: Bearer synthetic-token for payer@example.com");
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(oauth()).mockResolvedValueOnce(response({ id: "ORDER1", status: "CREATED", payer: { email_address: "payer@example.com" } }, 201)).mockRejectedValueOnce(leaky);
    const adapter = createApplicationSandboxPayments(config, false, request);
    await adapter.createDonationOrder({ requestId: CREATE_ID, fundId: "fund_b", amountCents: 100n });
    await expect(adapter.captureDonationOrder("ORDER1", CAPTURE_ID)).rejects.toThrow("transport failed");
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
