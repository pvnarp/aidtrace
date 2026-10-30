import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { sendClaimPayout, refreshClaimPayout } from "../src/ledger/payout";
import * as s from "../db/schema";
import type { PersistedPayout, PayoutTransport } from "../src/paypal/adapter";

let connection: ReturnType<typeof connectDatabase>;
let admin: ReturnType<typeof postgres>; let server: ChildProcess | undefined; let name: string;
let passwords: Record<"maria" | "tara" | "ben", string>;
test.beforeEach(async () => {
  if (process.env.UI_TEST_CONTAINER !== "true") throw new Error("Run phone checks only through the isolated OrbStack UI service");
  name = `aidtrace_iac141_test_${randomBytes(6).toString("hex")}`;
  const adminUrl = new URL(process.env.DATABASE_URL!); adminUrl.pathname = "/postgres";
  admin = postgres(adminUrl.toString(), { max: 1 }); await admin`create database ${admin(name)}`;
  const url = new URL(adminUrl); url.pathname = `/${name}`; connection = connectDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "phone-test@personal.example.com", payeeAllowlist: ["phone-test@personal.example.com"] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "synthetic-ui-id", PAYPAL_CLIENT_SECRET: "synthetic-ui-secret", PAYEE_ALLOWLIST: "phone-test@personal.example.com", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
  for (let attempt = 0; attempt < 90; attempt++) {
    try { if ((await fetch("http://127.0.0.1:3100/api/health", { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Wait for the isolated server, never the main application. */ }
    if (server.exitCode !== null) throw new Error("Isolated UI server exited before readiness");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Isolated UI server readiness timed out");
});
test.afterEach(async () => {
  if (server?.pid) {
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* Already stopped. */ }
    await Promise.race([new Promise(resolve => server!.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    try { process.kill(-server.pid, "SIGKILL"); } catch { /* Already stopped. */ }
  }
  await connection?.client.end();
  if (admin && /^aidtrace_iac141_test_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const control of await page.locator("button, input").all()) {
    if (!await control.isVisible()) continue;
    const box = await control.boundingBox(); if (box) { expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(375); }
  }
}
async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]);
  const response = page.waitForResponse(r => r.url().endsWith("/api/auth/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); expect((await response).status()).toBe(303);
  await page.waitForURL(url => url.pathname === "/"); await page.goto("/claims/C-104");
}
async function freeze(page: Page) { await login(page, "maria"); await page.getByRole("button", { name: "Freeze allocation for approval" }).click(); await expect(page.getByRole("status")).toContainText("allocation is frozen"); await noOverflow(page); await page.getByRole("button", { name: "Sign out" }).click(); }
test("UX-01: 375-pixel allocation, both independent approvals and synthetic payout status", async ({ page }) => {
  await freeze(page);
  for (const user of ["tara", "ben"] as const) {
    await login(page, user); await expect(page.getByRole("heading", { level: 1 })).toHaveText(user === "tara" ? "Frozen. Awaiting two approvals." : "1 of 2 approvals saved. One more needed.");
    await expect(page.getByText("$200.00 from General", { exact: true })).toBeVisible(); await page.getByText("Why each fund can pay", { exact: true }).click(); await expect(page.locator(".reasons")).toBeVisible();
    await expect(page.getByText("$70.00 from General", { exact: true })).toBeVisible();
    const cards = page.locator(".comparison-card"); await expect(cards).toHaveCount(2);
    const first = await cards.nth(0).boundingBox(); const second = await cards.nth(1).boundingBox();
    expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height);
    await noOverflow(page); await page.getByRole("button", { name: "Approve these terms" }).click(); await noOverflow(page);
    if (user === "tara") { await expect(page.getByRole("status")).toContainText("different approver"); await page.getByRole("button", { name: "Sign out" }).click(); }
  }
  await expect(page.getByRole("status")).toContainText("Both approvals are complete"); await expect(page.getByRole("button", { name: "Send $500.00 in PayPal sandbox" })).toBeVisible();
  const [decision] = await connection.db.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.claimId, "C-104"));
  let sent: PersistedPayout | undefined;
  // Explicit local provider stubs. The isolated container has no internet route or credentials.
  const provider: PayoutTransport = {
    validatePayout() {}, async balance() { return { readable: false }; },
    async send(payout) { sent = payout; return { httpStatus: 201, batchId: "SYNTHETIC_BATCH_141", batchStatus: "PENDING" }; },
    async batch() { return { httpStatus: 200, batchId: "SYNTHETIC_BATCH_141", senderBatchId: sent!.senderBatchId, batchStatus: "SUCCESS", itemIds: ["SYNTHETIC_ITEM_141"] }; },
    async item() { return { httpStatus: 200, itemId: "SYNTHETIC_ITEM_141", batchId: "SYNTHETIC_BATCH_141", senderBatchId: sent!.senderBatchId, senderItemId: sent!.senderItemId, payeeEmail: sent!.payeeEmail, amountCents: 50000n, itemStatus: "SUCCESS", feeCents: 25n }; },
  };
  await sendClaimPayout(connection.db, "C-104", "ben", decision!.decisionHash, provider); await refreshClaimPayout(connection.db, "C-104", "ben", provider);
  await page.goto("/claims/C-104"); await expect(page.getByText("SYNTHETIC_ITEM_141", { exact: true })).toBeHidden(); await page.getByText("Inspect payment identifiers", { exact: true }).click(); await expect(page.getByText("SYNTHETIC_ITEM_141", { exact: true })).toBeVisible(); await expect(page.getByText("$0.25", { exact: true })).toBeVisible(); await noOverflow(page);
});
test("UI-348: a denied batch stays visible beside retry authority without sending a retry", async ({ page }) => {
  await freeze(page);
  for (const user of ["tara", "ben"] as const) { await login(page, user); await page.getByRole("button", { name: "Approve these terms" }).click(); if (user === "tara") await page.getByRole("button", { name: "Sign out" }).click(); }
  const [decision] = await connection.db.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.claimId, "C-104"));
  let sent: PersistedPayout | undefined;
  const provider: PayoutTransport = {
    validatePayout() {}, async balance() { return { readable: false }; },
    async send(payout) { sent = payout; return { httpStatus: 201, batchId: "SYNTHETIC_DENIED_BATCH", batchStatus: "PENDING" }; },
    async batch() { return { httpStatus: 200, batchId: "SYNTHETIC_DENIED_BATCH", senderBatchId: sent!.senderBatchId, batchStatus: "DENIED", itemIds: [] }; },
    async item() { throw new Error("No item exists for this denied synthetic batch"); },
  };
  await sendClaimPayout(connection.db, "C-104", "ben", decision!.decisionHash, provider); await refreshClaimPayout(connection.db, "C-104", "ben", provider);
  await page.reload();
  await expect(page.getByText("FAILED", { exact: true })).toBeVisible(); await expect(page.getByText("DENIED", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Authorize retry 2", exact: true })).toBeVisible();
  await expect(page.getByText("SYNTHETIC_DENIED_BATCH", { exact: true })).toBeHidden();
  expect(await connection.db.select().from(s.disbursementAttempts)).toHaveLength(1); expect(await connection.db.select().from(s.retryAuthorizations)).toHaveLength(0);
  await noOverflow(page);
});
test("UI-348: standard seed matches; a real mismatch is visible and draft guidance respects the role", async ({ page }) => {
  await login(page, "tara"); await expect(page).toHaveURL(/\/claims\/C-104$/);
  await page.getByText("Claim and decision reference", { exact: true }).click();
  await expect(page.getByText("Claim C-104. No frozen decision.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Waiting for the claimant to freeze/)).toBeVisible();
  await expect(page.getByText("Ledger tie-out: Matches.", { exact: true })).toBeVisible();
  await connection.db.update(s.fundCredits).set({ amountCents: 29999n }).where(eq(s.fundCredits.fundId, "fund_a"));
  await page.reload(); await expect(page.locator(".notice.warning")).toHaveText("Ledger tie-out: Needs investigation.");
  await expect(page.getByText(/Opening journals have not been created yet/)).toHaveCount(0);
  expect(await connection.db.select().from(s.disbursementAttempts)).toHaveLength(0);
});
for (const user of ["tara", "ben"] as const) test(`UX-01: ${user} can reject with required reason at 375 pixels`, async ({ page }) => {
  await freeze(page); await login(page, user); await noOverflow(page);
  await page.getByText("Reject this claim instead", { exact: true }).click();
  await page.getByRole("button", { name: "Reject claim" }).click();
  expect(await page.getByLabel("Reason for rejection").evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
  await page.getByLabel("Reason for rejection").fill("Synthetic phone test rejection"); await page.getByRole("button", { name: "Reject claim" }).click();
  await expect(page.getByRole("status")).toContainText("claim was rejected"); await expect(page.getByText(/Rejected by .*Synthetic phone test rejection/)).toBeVisible(); await noOverflow(page);
});
