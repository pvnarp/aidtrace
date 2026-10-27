import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWebhookDonation } from "../src/lab/next-donation-plan";

const complete = { createRequestId: "old-create", captureRequestId: "old-capture", phase: "CAPTURE_RESPONSE", amountCents: "100", fundId: "fund_b", orderId: "ORDER1", observations: [{ action: "status", httpStatus: 200, orderId: "ORDER1", status: "COMPLETED", purchaseUnits: [{ customId: "fund_b", amount: { currency: "USD", value: "1.00" } }], captures: [{ captureId: "CAPTURE1", status: "COMPLETED" }] }] };
it("preserves a completed experiment byte for byte and prepares distinct IDs without a second payment", () => {
  const directory = mkdtempSync(join(tmpdir(), "aidtrace-donation-plan-"));
  try {
    const path = join(directory, "donation.json");
    const original = JSON.stringify(complete, null, 2) + "\n";
    writeFileSync(path, original);
    expect(prepareWebhookDonation(directory).completedTestArchived).toBe(true);
    expect(readFileSync(join(directory, "donation-closed-ORDER1.json"), "utf8")).toBe(original);
    const next = JSON.parse(readFileSync(path, "utf8"));
    expect(next.phase).toBe("PREPARED");
    expect(next.observations).toEqual([]);
    expect(next.createRequestId).not.toBe(next.captureRequestId);
    expect(next.createRequestId).not.toBe(complete.createRequestId);
    const bytes = readFileSync(path);
    expect(() => prepareWebhookDonation(directory)).toThrow("independently fetched");
    expect(readFileSync(path).equals(bytes)).toBe(true);
  } finally { rmSync(directory, { recursive: true }); }
});
it.each(["UNKNOWN", "CREATED", "CAPTURING", "REJECTED"])("refuses a new experiment from %s without modifying or archiving the active test", phase => {
  const directory = mkdtempSync(join(tmpdir(), "aidtrace-donation-plan-"));
  try {
    const path = join(directory, "donation.json");
    const original = JSON.stringify({ ...complete, phase });
    writeFileSync(path, original);
    expect(() => prepareWebhookDonation(directory)).toThrow("independently fetched");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readdirSync(directory)).toEqual(["donation.json"]);
  } finally { rmSync(directory, { recursive: true }); }
});
