import { describe, expect, it, vi } from "vitest";
import { createApplicationSandboxPayments, type PayPalConfig } from "../src/paypal/adapter";
const config: PayPalConfig = { baseUrl: "https://api-m.sandbox.paypal.com", clientId: "synthetic-client", clientSecret: "synthetic-secret", payeeAllowlist: ["recipient@personal.example.com"], maxDemoPayoutCents: 50000n };
const payout = { senderBatchId: "AT-11111111-1111-4111-8111-111111111111-1", senderItemId: "AT-11111111-1111-4111-8111-111111111111-1-1", payeeEmail: "recipient@personal.example.com", amountCents: 50000n };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const oauth = () => response({ access_token: "synthetic-token", expires_in: 3600 });
describe("IAC-136 product adapter, stubbed provider only", () => {
  it("SEC-01: rejects unsafe endpoint, missing credentials, payee and ceiling before any request", async () => {
    const request = vi.fn<typeof fetch>();
    for (const unsafe of [{ ...config, baseUrl: "https://api-m.paypal.com" }, { ...config, clientSecret: undefined }]) expect(() => createApplicationSandboxPayments(unsafe, false, request)).toThrow();
    const adapter = createApplicationSandboxPayments(config, false, request);
    await expect(adapter.send({ ...payout, payeeEmail: "other@example.invalid" })).rejects.toThrow("allowlisted");
    await expect(adapter.send({ ...payout, amountCents: 50001n })).rejects.toThrow("ceiling");
    await expect(adapter.send({ ...payout, senderItemId: "changed" })).rejects.toThrow("sender IDs");
    expect(request).not.toHaveBeenCalled();
  });
  it("formats exact USD in the adapter and caches the OAuth token", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(oauth()).mockResolvedValueOnce(response({ batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING" }, items: [{ payout_item_id: "ITEM1" }] }, 201)).mockResolvedValueOnce(response({ batch_header: { payout_batch_id: "BATCH1", batch_status: "SUCCESS", sender_batch_header: { sender_batch_id: payout.senderBatchId } }, items: [{ payout_item_id: "ITEM1" }] }));
    const adapter = createApplicationSandboxPayments(config, false, request);
    expect(await adapter.send(payout)).toMatchObject({ batchId: "BATCH1", itemId: "ITEM1" });
    const body = JSON.parse(String(request.mock.calls[1]![1]!.body));
    expect(body.items).toEqual([{ recipient_type: "EMAIL", recipient_wallet: "PAYPAL", receiver: payout.payeeEmail, amount: { value: "500.00", currency: "USD" }, note: "AidTrace sandbox reimbursement", sender_item_id: payout.senderItemId }]);
    expect((await adapter.batch("BATCH1")).itemIds).toEqual(["ITEM1"]); expect(request).toHaveBeenCalledTimes(3);
  });
  it("refreshes on 401 exactly once and preserves the POST body and sender IDs", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(oauth()).mockResolvedValueOnce(response({}, 401)).mockResolvedValueOnce(oauth()).mockResolvedValueOnce(response({}, 401));
    const result = await createApplicationSandboxPayments(config, false, request).send(payout);
    expect(result.httpStatus).toBe(401); expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls[1]![1]!.body).toBe(request.mock.calls[3]![1]!.body);
  });
  it("keeps balance unavailable without a reporting request when the lab flag is false", async () => {
    const request = vi.fn<typeof fetch>();
    expect(await createApplicationSandboxPayments(config, false, request).balance()).toEqual({ readable: false });
    expect(request).not.toHaveBeenCalled();
  });
  it("reads exact provider balance or treats 403 as unreadable, never zero", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(oauth()).mockResolvedValueOnce(response({ balances: [{ currency: "USD", available_balance: { currency_code: "USD", value: "499.99" } }], last_refresh_time: "2026-10-22T18:00:00Z" })).mockResolvedValueOnce(response({ name: "NOT_AUTHORIZED" }, 403));
    const adapter = createApplicationSandboxPayments(config, true, request);
    expect(await adapter.balance()).toEqual({ readable: true, availableCents: 49999n, asOf: "2026-10-22T18:00:00Z" });
    expect(await adapter.balance()).toEqual({ readable: false });
  });
  it("reads item binding, exact reported fee and UTC processing date without leaking raw response", async () => {
    const item = { payout_item_id: "ITEM1", payout_batch_id: "BATCH1", sender_batch_id: payout.senderBatchId, transaction_status: "SUCCESS", payout_item_fee: { value: "0.25", currency: "USD" }, time_processed: "2026-10-21T23:30:00-07:00", payout_item: { recipient_type: "EMAIL", receiver: payout.payeeEmail, sender_item_id: payout.senderItemId, amount: { currency: "USD", value: "500.00" } } };
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(oauth()).mockResolvedValueOnce(response(item)).mockResolvedValueOnce(response({ ...item, payout_item_fee: { value: "0.25", currency: "EUR" } }));
    const adapter = createApplicationSandboxPayments(config, false, request);
    expect(await adapter.item("ITEM1")).toMatchObject({ itemId: "ITEM1", amountCents: 50000n, feeCents: 25n, processedOn: "2026-10-22" });
    expect((await adapter.item("ITEM1")).errorCode).toBe("INVALID_PROVIDER_FEE");
  });
  it("does not repeat a POST after timeout or 5xx", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(oauth()).mockRejectedValueOnce(new Error("synthetic timeout"));
    await expect(createApplicationSandboxPayments(config, false, request).send(payout)).rejects.toThrow("timeout");
    expect(request).toHaveBeenCalledTimes(2);
    const failed = vi.fn<typeof fetch>().mockResolvedValueOnce(oauth()).mockResolvedValueOnce(response({}, 500));
    expect((await createApplicationSandboxPayments(config, false, failed).send(payout)).httpStatus).toBe(500);
    expect(failed).toHaveBeenCalledTimes(2);
  });
});
