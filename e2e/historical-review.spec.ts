import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { approveDecision, freezeDecision } from "../src/ledger/service";
import { refreshClaimPayout, sendClaimPayout } from "../src/ledger/payout";
import { authorizePayoutRetry, sendAuthorizedPayoutRetry } from "../src/ledger/retry";
import { handlePayPalWebhook } from "../src/server/webhook-handler";
import * as s from "../db/schema";
import type { PayoutTransport, PersistedPayout, WebhookVerifier } from "../src/paypal/adapter";

// HWR-10 to HWR-13 (November 5 verification gap; the service behavior is HWR-01 to HWR-09 in tests/retry-webhook.integration.test.ts): the historical PayPal event
// review on the claim page, driven in a browser. Each test starts its own isolated database and `next start` on 3100, then builds the state through the REAL ledger
// functions and the REAL webhook handler, with an in-test fake PayoutTransport (a test double, NOT a PayPal result, and its webhook check is a stub that always says SUCCESS):
//   C-104 is frozen by Maria and approved by Tara and Ben; the first send fails (attempt 1); Tara authorizes a retry and Ben sends it (attempt 2); attempt 2 fails too, so the
//   claim is PAYOUT_ISSUE with a retryable latest attempt; then a verified webhook event for attempt 1 arrives, which the handler records as one open historical review.
// No row is inserted by hand. The server runs KEYED with synthetic credentials so an approver's page has payment configured (the case where retry forms render).
// No request leaves loopback; the only POST the browser makes is the one resolve-historical form, which writes one resolution row and nothing else.
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });
const PAYEE = "hist-review@personal.example.com";
const REVIEW_NOTE = /PayPal reported on earlier attempt 1 after a retry\. Check both attempts in PayPal before relying on this payment\. Retries wait until a person records the check\./;
const RESOLVED_NOTICE = "The reconciliation is recorded. Retries can resume if nothing else blocks them.";
const FAILED_NOTICE = /That action could not be completed\./;

let admin: ReturnType<typeof postgres> | undefined, connection: ReturnType<typeof connectDatabase> | undefined;
let server: ChildProcess | undefined, name = "";
let passwords: Record<"maria" | "tara" | "ben", string>;

function fakeTransport(): PayoutTransport & WebhookVerifier {
  const sent = new Map<string, PersistedPayout>(); let serial = 0;
  return {
    validatePayout() {}, async balance() { return { readable: false }; },
    async send(payout) { const id = `HWR_BATCH_${++serial}`; sent.set(id, payout); return { httpStatus: 201, batchId: id, batchStatus: "PENDING" }; },
    async batch(id) { return { httpStatus: 200, batchId: id, senderBatchId: sent.get(id)?.senderBatchId, batchStatus: "SUCCESS", itemIds: [`HWR_ITEM_${id}`] }; },
    async item(id) {
      const batchId = id.replace(/^HWR_ITEM_/, ""); const payout = sent.get(batchId);
      return { httpStatus: 200, itemId: id, batchId, senderBatchId: payout?.senderBatchId, senderItemId: payout?.senderItemId, payeeEmail: payout?.payeeEmail, amountCents: payout?.amountCents, itemStatus: "FAILED", feeCents: 0n };
    },
    async verifyWebhook() { return { httpStatus: 200, verificationStatus: "SUCCESS" }; },
  };
}
const attemptRows = () => connection!.db.select().from(s.disbursementAttempts);
const journalRows = () => connection!.db.select().from(s.journalEntries);
const resolutionRows = () => connection!.db.select().from(s.historicalEventReviewResolutions);
const reviewRows = () => connection!.db.select().from(s.historicalEventReviews);

test.beforeEach(async () => {
  if (process.env.UI_TEST_CONTAINER !== "true") throw Error("Use isolated OrbStack browser service");
  const url = new URL(process.env.DATABASE_URL!); url.pathname = "/postgres";
  admin = postgres(url.toString(), { max: 1 }); name = "aidtrace_hwr_" + randomBytes(6).toString("hex");
  await admin`create database ${admin(name)}`; url.pathname = "/" + name;
  connection = connectDatabase(url.toString()); await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: PAYEE, payeeAllowlist: [PAYEE] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  const db = connection.db, provider = fakeTransport();
  const frozen = await freezeDecision(db, "C-104", "maria");
  if (frozen.status !== "AWAITING_APPROVAL") throw Error("Expected a funded decision");
  await approveDecision(db, frozen.decisionId, "tara", frozen.decisionHash); await approveDecision(db, frozen.decisionId, "ben", frozen.decisionHash);
  await sendClaimPayout(db, "C-104", "ben", frozen.decisionHash, provider); await refreshClaimPayout(db, "C-104", "ben", provider);
  const [first] = await attemptRows(); if (first?.state !== "FAILED") throw Error("Attempt 1 must have failed");
  const authorization = await authorizePayoutRetry(db, "C-104", "tara", frozen.decisionHash, first.id);
  await sendAuthorizedPayoutRetry(db, "C-104", "ben", frozen.decisionHash, authorization.authorizationId, provider); await refreshClaimPayout(db, "C-104", "ben", provider);
  const second = (await attemptRows()).find(row => row.attemptNumber === 2); if (second?.state !== "FAILED") throw Error("Attempt 2 must have failed");
  const event = { id: "WH-HWR-EVENT-1", event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", resource: { payout_batch_id: first.payoutBatchId, payout_item_id: first.payoutItemId ?? `HWR_ITEM_${first.payoutBatchId}`, transaction_status: "SUCCESS", amount: { value: "500.00", currency: "USD" } } };
  const delivered = await handlePayPalWebhook(new Request("http://127.0.0.1:3100/api/webhooks/paypal", { method: "POST", headers: { "content-type": "application/json", "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test", "paypal-transmission-id": "hwr-transmission", "paypal-transmission-sig": "c3ludGhldGlj", "paypal-transmission-time": "2026-11-05T20:00:00Z" }, body: JSON.stringify(event) }), { db, provider: () => provider, webhookId: "HWRREGISTERED123" });
  if (delivered.status !== 204) throw Error(`Webhook was not accepted: ${delivered.status}`);
  if ((await reviewRows()).length !== 1) throw Error("Expected exactly one open historical review");
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AIDTRACE_JUDGE_SESSION: "false",
    AI_RECEIPT_ENABLED: "false", AI_EXPENSE_PROPOSALS_ENABLED: "false", AI_ANALYTICS_ENABLED: "false", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false",
    PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "hwr-synthetic-client-id", PAYPAL_CLIENT_SECRET: "hwr-synthetic-secret", PAYEE_ALLOWLIST: PAYEE } });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch("http://127.0.0.1:3100/api/health", { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Wait for this container's server. */ }
    if (server.exitCode !== null) throw Error("Isolated server exited");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error("Server readiness timeout");
});
test.afterEach(async () => {
  if (server?.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* Exited. */ } await Promise.race([new Promise(resolve => server!.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 1500))]); try { process.kill(-server.pid, "SIGKILL"); } catch { /* Exited. */ } }
  server = undefined;
  await connection?.client.end(); connection = undefined;
  if (admin && /^aidtrace_hwr_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
  admin = undefined; name = "";
});
async function login(page: Page, user: keyof typeof passwords) {
  await page.context().clearCookies();
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]);
  const response = page.waitForResponse(r => r.url().endsWith("/api/auth/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); expect((await response).status()).toBe(303);
  await page.waitForURL(url => url.pathname === "/"); await page.goto("/claims/C-104");
}
const retryButtons = (page: Page) => page.getByRole("button", { name: /retry/i });
const snapshot = async () => ({ attempts: (await attemptRows()).length, journal: (await journalRows()).length, resolutions: (await resolutionRows()).length });

test("HWR-10: the claimant sees the review notice and neither the reconciliation form nor any retry form", async ({ page }) => {
  const before = await snapshot(); expect(before).toEqual({ attempts: 2, journal: before.journal, resolutions: 0 });
  await login(page, "maria");
  await expect(page.locator("#payment").getByRole("note").filter({ hasText: REVIEW_NOTE })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Record the reconciliation" })).toHaveCount(0);
  await expect(page.getByLabel("What you checked in PayPal")).toHaveCount(0);
  await expect(retryButtons(page)).toHaveCount(0);
  expect(await snapshot()).toEqual(before);
});

test("HWR-11: an approver who is not the claimant sees the notice and the reconciliation form, and no retry form while the review is open", async ({ page }) => {
  const before = await snapshot();
  for (const user of ["tara", "ben"] as const) {
    await login(page, user);
    await expect(page.locator("#payment").getByRole("note").filter({ hasText: REVIEW_NOTE }), `${user} notice`).toHaveCount(1);
    await expect(page.getByLabel("What you checked in PayPal"), `${user} note field`).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Record the reconciliation", exact: true }), `${user} button`).toHaveCount(1);
    await expect(retryButtons(page), `${user} retry forms`).toHaveCount(0);
  }
  expect(await snapshot()).toEqual(before);
});

test("HWR-12: a note under 10 characters is refused with the page's failure notice and records nothing", async ({ page }) => {
  const before = await snapshot();
  await login(page, "tara");
  // The textarea carries minlength=10, so the browser would stop a short note first. Drop that attribute to prove the server refuses it too.
  await page.getByLabel("What you checked in PayPal").evaluate((el: HTMLTextAreaElement) => { el.removeAttribute("minlength"); el.value = "too short"; });
  await page.getByRole("button", { name: "Record the reconciliation", exact: true }).click();
  await page.waitForURL(url => url.searchParams.get("notice") === "action-failed");
  await expect(page.getByRole("status").filter({ hasText: FAILED_NOTICE })).toHaveCount(1);
  // The review is still open: the notice, the form and the absence of retry forms are all unchanged.
  await expect(page.locator("#payment").getByRole("note").filter({ hasText: REVIEW_NOTE })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Record the reconciliation", exact: true })).toHaveCount(1);
  await expect(retryButtons(page)).toHaveCount(0);
  expect(await snapshot()).toEqual(before);
});

test("HWR-13: a valid note records the reconciliation, clears the notice and brings the retry form back, with no new attempt or journal row", async ({ page }) => {
  const before = await snapshot();
  await login(page, "tara");
  await page.getByLabel("What you checked in PayPal").fill("Checked both attempts in the PayPal sandbox activity page.");
  await page.getByRole("button", { name: "Record the reconciliation", exact: true }).click();
  await page.waitForURL(url => url.searchParams.get("notice") === "historical-resolved");
  await expect(page.getByRole("status").filter({ hasText: RESOLVED_NOTICE })).toHaveCount(1);
  await expect(page.locator("#payment").getByRole("note").filter({ hasText: REVIEW_NOTE })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Record the reconciliation" })).toHaveCount(0);
  // Attempt 2 failed and is retryable, so with the review closed the page offers the retry authorization form again (attempt 3 is only authorized, never sent here).
  await expect(page.getByRole("button", { name: "Authorize retry 3", exact: true })).toHaveCount(1);
  const after = await snapshot();
  expect(after).toEqual({ attempts: before.attempts, journal: before.journal, resolutions: 1 });
  const [resolution] = await resolutionRows(); expect(resolution).toMatchObject({ resolvedBy: "tara", note: "Checked both attempts in the PayPal sandbox activity page." });
  expect((await reviewRows()).filter(row => row.id === resolution!.reviewId)).toHaveLength(1);
  expect((await connection!.db.select().from(s.claims).where(eq(s.claims.id, "C-104")))[0]!.status).toBe("PAYOUT_ISSUE");
});
