import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import * as s from "../db/schema";
import { CHECK_CLAIM, prepareWebhookCheck, readWebhookCheck, requireUnsentDollarClaim, registeredWebhookMatches } from "../scripts/support/product-webhook-check";
import { sendClaimPayout } from "../src/ledger/payout";
import { handlePayPalWebhook } from "../src/server/webhook-handler";
import type { PersistedPayout, PayoutTransport, WebhookVerifier } from "../src/paypal/adapter";

const name = `aidtrace_product_webhook_${randomBytes(6).toString("hex")}`;
const base = new URL(process.env.DATABASE_URL!); base.pathname = "/postgres";
const admin = postgres(base.toString(), { max: 1 }); const wrong = connectDatabase(base.toString());
const url = new URL(base); url.pathname = `/${name}`; const { db, client } = connectDatabase(url.toString());
let created = false;
it("requires the same registered ID, exact endpoint and payout subscription before sending", () => {
  const url = "https://synthetic.ngrok-free.dev/api/webhooks/paypal";
  const value = { httpStatus: 200, id: "REGISTERED123", url, eventTypes: ["PAYMENT.PAYOUTS-ITEM.SUCCEEDED"] };
  expect(registeredWebhookMatches(value, "REGISTERED123", url)).toBe(true);
  for (const wrong of [{ ...value, httpStatus: 404 }, { ...value, id: "OTHER" }, { ...value, url: url + "/" }, { ...value, eventTypes: ["PAYMENT.CAPTURE.COMPLETED"] }]) expect(registeredWebhookMatches(wrong, "REGISTERED123", url)).toBe(false);
});
beforeAll(async () => { await admin`create database ${admin(name)}`; created = true; await migrate(db, { migrationsFolder: "db/migrations" }); }, 30000);
afterAll(async () => { await client.end(); await wrong.client.end(); if (created) await admin`drop database ${admin(name)}`; await admin.end(); });
it("refuses a non-acceptance database before seeding or preparing an obligation", async () => {
  await expect(prepareWebhookCheck(wrong.db, "synthetic@personal.example.com", ["synthetic@personal.example.com"])).rejects.toThrow("Dedicated webhook acceptance database required");
});
it("prepares only a dollar variant, then settles solely from a verified fetched payout with replay safety", async () => {
  const prepared = await prepareWebhookCheck(db, "synthetic@personal.example.com", ["synthetic@personal.example.com"]);
  expect(prepared.claim).toEqual({ id: CHECK_CLAIM, status: "APPROVED" }); expect(prepared.ledger.openPayableCents).toBe(100n);
  const [original] = await db.select().from(s.claims).where(eq(s.claims.id, "C-104")); expect(original!.status).toBe("DRAFT");
  const lines = await db.select().from(s.claimLines).where(eq(s.claimLines.claimId, "C-104")); expect(lines.reduce((sum, line) => sum + line.amountCents, 0n)).toBe(50000n);
  let sent: PersistedPayout | undefined; let verified = false; let fetches = 0;
  const provider: PayoutTransport & WebhookVerifier = {
    validatePayout(_payee, amount) { expect(amount).toBe(100n); }, async balance() { return { readable: false }; },
    async send(payout) { sent = payout; return { httpStatus: 201, batchId: "SYNTHETIC_CHECK_BATCH", batchStatus: "PENDING" }; },
    async verifyWebhook() { return { httpStatus: 200, verificationStatus: verified ? "SUCCESS" : "FAILURE" }; },
    async batch() { fetches++; return { httpStatus: 200, batchId: "SYNTHETIC_CHECK_BATCH", senderBatchId: sent!.senderBatchId, batchStatus: "SUCCESS", itemIds: ["SYNTHETIC_CHECK_ITEM"] }; },
    async item() { fetches++; return { httpStatus: 200, batchId: "SYNTHETIC_CHECK_BATCH", itemId: "SYNTHETIC_CHECK_ITEM", senderBatchId: sent!.senderBatchId, senderItemId: sent!.senderItemId, payeeEmail: sent!.payeeEmail, amountCents: 100n, itemStatus: "SUCCESS", feeCents: 25n }; },
  };
  await sendClaimPayout(db, CHECK_CLAIM, "ben", await requireUnsentDollarClaim(db), provider);
  await expect(requireUnsentDollarClaim(db)).rejects.toThrow("unsent");
  const event = () => new Request("http://check/api/webhooks/paypal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "WH-SYNTHETIC-CHECK", event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", resource: { payout_batch_id: "SYNTHETIC_CHECK_BATCH", payout_item_id: "SYNTHETIC_CHECK_ITEM", amount: { value: "9999.00", currency: "USD" } } }) });
  expect((await handlePayPalWebhook(event(), { db, provider: () => provider, webhookId: "SYNTHETIC_REGISTRATION" })).status).toBe(400);
  expect(fetches).toBe(0); expect((await readWebhookCheck(db)).ledger.openPayableCents).toBe(100n);
  verified = true;
  expect((await handlePayPalWebhook(event(), { db, provider: () => provider, webhookId: "SYNTHETIC_REGISTRATION" })).status).toBe(204);
  const settled = await readWebhookCheck(db); expect(settled.claim?.status).toBe("PAID"); expect(settled.ledger).toEqual({ matches: true, openPayableCents: 0n, bookCashCents: 149875n });
  expect(settled.attempts[0]).toMatchObject({ state: "SETTLED", itemStatus: "SUCCESS", feeCents: 25n }); expect(settled.events).toHaveLength(1); expect(fetches).toBe(2);
  expect((await handlePayPalWebhook(event(), { db, provider: () => provider, webhookId: "SYNTHETIC_REGISTRATION" })).status).toBe(204);
  expect(await readWebhookCheck(db)).toEqual(settled); expect(fetches).toBe(2);
});
