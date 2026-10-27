import { expect, it, vi } from "vitest";
import { createManualSandboxLab } from "../src/paypal/adapter";

const config = { baseUrl: "https://api-m.sandbox.paypal.com", clientId: "test-client", clientSecret: "test-secret", payeeAllowlist: ["test@personal.example.com"], maxDemoPayoutCents: 50000n };
it.each([
  { scope: "https://uri.paypal.com/services/reporting/balances/read  https://uri.paypal.com/services/reporting/search/read", balanceRead: true, transactionSearchRead: true },
  { scope: "https://uri.paypal.com/services/reporting/balances/read-extra https://uri.paypal.com/services/reporting/search/read", balanceRead: false, transactionSearchRead: true },
  { scope: undefined, balanceRead: null, transactionSearchRead: null },
])("reports exact granted reporting scopes, treating an omitted scope as unknown: $balanceRead", async ({ scope, balanceRead, transactionSearchRead }) => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ access_token: "synthetic-token", scope }))
    .mockResolvedValueOnce(Response.json({ name: "NOT_AUTHORIZED" }, { status: 403 }));
  const result = await createManualSandboxLab(config, request).getUsdBalance();
  expect(result.tokenPermissions).toEqual({ balanceRead, transactionSearchRead });
  expect(JSON.stringify(result)).not.toMatch(/synthetic-token|uri.paypal.com/);
});
it("reads only USD reporting balances and withholds account identity and tokens", async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
    .mockResolvedValueOnce(Response.json({ account_id: "private-account", last_refresh_time: "2026-10-22T18:00:00Z", balances: [{ currency: "USD", total_balance: { currency_code: "USD", value: "4994.75" }, available_balance: { currency_code: "USD", value: "4994.75" }, withheld_balance: { currency_code: "USD", value: "0.00" } }] }));
  const result = await createManualSandboxLab(config, request).getUsdBalance();
  expect(request.mock.calls[1]?.[0]).toBe("https://api-m.sandbox.paypal.com/v1/reporting/balances?currency_code=USD");
  expect(request.mock.calls[1]?.[1]?.method).toBe("GET");
  expect(result.balances[0]?.available?.value).toBe("4994.75");
  expect(result.lastRefreshTime).toBe("2026-10-22T18:00:00Z");
  expect(JSON.stringify(result)).not.toMatch(/private-account|synthetic-token/);
});
it("reports a balance permission denial without interpreting it as a zero balance", async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
    .mockResolvedValueOnce(Response.json({ name: "NOT_AUTHORIZED", message: "Private message" }, { status: 403 }));
  const result = await createManualSandboxLab(config, request).getUsdBalance();
  expect(result.httpStatus).toBe(403);
  expect(result.errorName).toBe("NOT_AUTHORIZED");
  expect(result.balances).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("Private message");
});
it("constrains the human lab to one allowlisted five-dollar sandbox payout", async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
    .mockResolvedValueOnce(Response.json({ batch_header: { payout_batch_id: "TESTBATCH1", batch_status: "PENDING" } }, { status: 201 }));
  const result = await createManualSandboxLab(config, request).sendFiveDollarPayout("AT-LAB-0123456789abcdef", "AT-LAB-0123456789abcdef-1", "test@personal.example.com");
  expect(result.httpStatus).toBe(201);
  const payload = JSON.parse(request.mock.calls[1]![1]!.body as string);
  expect(payload.items.length).toBe(1);
  expect(payload.items[0].amount).toEqual({ value: "5.00", currency: "USD" });
  expect(request.mock.calls.every(call => String(call[0]).startsWith("https://api-m.sandbox.paypal.com/"))).toBe(true);
  expect(JSON.stringify(result).includes("synthetic-token")).toBe(false);
});
it("rejects non-allowlisted recipients before any lab network request", async () => {
  const request = vi.fn<typeof fetch>();
  await expect(createManualSandboxLab(config, request).sendFiveDollarPayout("AT-LAB-0123456789abcdef", "AT-LAB-0123456789abcdef-1", "other@personal.example.com")).rejects.toThrow("allowlisted");
  expect(request).not.toHaveBeenCalled();
});
it("fetches item status separately and reports only filtered fields", async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
    .mockResolvedValueOnce(Response.json({ batch_header: { payout_batch_id: "TESTBATCH1", batch_status: "SUCCESS" }, items: [{ payout_item_id: "TESTITEM1" }], receiver: "withheld" }))
    .mockResolvedValueOnce(Response.json({ payout_item_id: "TESTITEM1", transaction_status: "SUCCESS", payout_item_fee: { currency: "USD", value: "0.25" }, receiver: "withheld" }));
  const lab = createManualSandboxLab(config, request);
  const batch = await lab.getPayoutBatch("TESTBATCH1");
  const item = await lab.getPayoutItem(batch.itemIds[0]!);
  expect(request.mock.calls[2]?.[0]).toBe("https://api-m.sandbox.paypal.com/v1/payments/payouts-item/TESTITEM1");
  expect(item.itemStatus).toBe("SUCCESS");
  expect(item.fee).toEqual({ value: "0.25", currency: "USD" });
  expect("receiver" in item).toBe(false);
});
it("retains provider failure codes while withholding free-form messages and recipients", async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ access_token: "synthetic-token" }))
    .mockResolvedValueOnce(Response.json({ payout_item_id: "TESTITEM1", transaction_status: "FAILED", errors: { name: "RECEIVER_ACCOUNT_LOCKED", message: "Private details withheld", details: [{ issue: "ACCOUNT_RESTRICTED", value: "withheld" }] } }));
  const result = await createManualSandboxLab(config, request).getPayoutItem("TESTITEM1");
  expect(result.providerErrors[0]?.name).toBe("RECEIVER_ACCOUNT_LOCKED");
  expect(result.providerErrors[0]?.issues).toEqual(["ACCOUNT_RESTRICTED"]);
  expect(JSON.stringify(result).includes("Private details")).toBe(false);
});
