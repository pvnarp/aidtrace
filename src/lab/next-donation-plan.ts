import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
// Caller holds the donation lock. This prepares a distinct experiment and makes no request.
export function prepareWebhookDonation(directory: string) {
  const path = join(directory, "donation.json");
  const original = readFileSync(path);
  const state = object(JSON.parse(original.toString("utf8")));
  const status = object((Array.isArray(state.observations) ? state.observations : []).filter(row => object(row).action === "status").at(-1));
  const captures = Array.isArray(status.captures) ? status.captures.map(object) : [];
  const units = Array.isArray(status.purchaseUnits) ? status.purchaseUnits.map(object) : [];
  if (state.phase !== "CAPTURE_RESPONSE" || state.amountCents !== "100" || state.fundId !== "fund_b" || typeof state.orderId !== "string" || !/^[A-Z0-9]{1,36}$/.test(state.orderId) || status.httpStatus !== 200 || status.orderId !== state.orderId || status.status !== "COMPLETED" || captures.length !== 1 || captures[0]?.status !== "COMPLETED" || units.length !== 1 || units[0]?.customId !== "fund_b" || object(units[0]?.amount).currency !== "USD" || object(units[0]?.amount).value !== "1.00") throw new Error("A new webhook test requires an independently fetched completed one-dollar donation");
  const archive = join(directory, `donation-closed-${state.orderId}.json`);
  writeFileSync(archive, original, { flag: "wx", mode: 0o600 });
  if (!readFileSync(archive).equals(original)) throw new Error("Completed donation archive verification failed");
  const next = { createRequestId: randomUUID(), captureRequestId: randomUUID(), amountCents: "100", fundId: "fund_b", phase: "PREPARED", preparedAt: new Date().toISOString(), observations: [] };
  const temporary = `${path}.new`;
  writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
  return { prepared: true, completedTestArchived: true, amount: "1.00", currency: "USD", fundId: "fund_b", note: "Separate webhook experiment prepared; no PayPal request sent." };
}
