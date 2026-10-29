import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";
import * as s from "../db/schema";

let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof connectDatabase>;
let server: ChildProcess | undefined, name: string;
let passwords: Record<"maria" | "tara" | "ben", string>;
test.beforeEach(async () => {
  if (process.env.UI_TEST_CONTAINER !== "true") throw Error("Use isolated OrbStack browser service");
  const url = new URL(process.env.DATABASE_URL!); url.pathname = "/postgres";
  admin = postgres(url.toString(), { max: 1 }); name = "aidtrace_journey_" + randomBytes(6).toString("hex");
  await admin`create database ${admin(name)}`; url.pathname = "/" + name;
  connection = connectDatabase(url.toString()); await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "journey@example.invalid", payeeAllowlist: ["journey@example.invalid"] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AI_RECEIPT_ENABLED: "false", AI_EXPENSE_PROPOSALS_ENABLED: "true", PAYPAL_SANDBOX_PAYEE_EMAIL: "journey@example.invalid", PAYEE_ALLOWLIST: "journey@example.invalid", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch("http://127.0.0.1:3100/api/health", { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Wait for this container's server. */ }
    if (server.exitCode !== null) throw Error("Isolated server exited");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error("Server readiness timeout");
});
test.afterEach(async () => {
  if (server?.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* Exited. */ } await Promise.race([new Promise(resolve => server!.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 1500))]); try { process.kill(-server.pid, "SIGKILL"); } catch { /* Exited. */ } }
  await connection?.client.end();
  if (admin && /^aidtrace_journey_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.pathname === "/");
}
async function fits(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }

test("IAC-350: architecture is authenticated, keyboard-operable and executes no requests", async ({ page }) => {
  await page.goto("/architecture"); await expect(page).toHaveURL(/\/login$/);
  await login(page, "maria"); await page.getByRole("link", { name: "Explore how it works", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Follow one expense through the system.");
  await expect(page.getByText(/This is not live telemetry/)).toBeVisible();
  const requests: string[] = []; page.on("request", request => requests.push(request.url()));
  await page.getByRole("button", { name: "Explore Local AI model", exact: true }).click();
  await expect(page.getByRole("heading", { name: "AI suggests categories. It cannot spend." })).toBeVisible();
  await page.getByRole("button", { name: "1. Receipt", exact: true }).click();
  for (let i = 0; i < 5; i++) await page.getByRole("button", { name: "Next step", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Verified success closes the payable once." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next step", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "What if the receipt includes alcohol?", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "The expense stops at the rules." })).toBeVisible();
  await page.getByRole("button", { name: "5. PayPal", exact: true }).click();
  await page.getByRole("button", { name: "Explore PayPal Sandbox", exact: true }).click();
  await expect(page.getByRole("heading", { name: "The expense stops at the rules." })).toBeVisible();
  await expect(page.getByLabel("Illustrated request path")).not.toContainText("PayPal");
  await page.getByText("Where the components actually run", { exact: true }).click();
  await expect(page.getByText(/same Next.js app container/)).toBeVisible();
  for (const width of [375, 1440]) { await page.setViewportSize({ width, height: 1000 }); await fits(page); }
  expect(requests).toEqual([]);
  expect(await connection.db.select().from(s.disbursementAttempts)).toHaveLength(0);
  expect(await connection.db.select().from(s.approvals)).toHaveLength(0);
});

test("IAC-350: guidance follows one expense, role handoff and two approvals without payment", async ({ page }) => {
  await login(page, "maria"); await page.getByRole("link", { name: "Start a $6 practice expense", exact: true }).click();
  const journey = page.getByLabel("Expense journey", { exact: true });
  await expect(journey).toContainText("Step 1 of 5"); await fits(page);
  await page.getByLabel("This receipt is fictional sandbox data.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  await expect(journey).toContainText("Step 2 of 5");
  for (const [line, category] of [["L1", "science_kits"], ["L2", "notebooks"], ["L3", "hospitality"]]) {
    await page.getByLabel(`Category for ${line}`, { exact: true }).selectOption(category!); await page.getByLabel(`Reason for manual choice ${line}`, { exact: true }).fill("Checked this fictional receipt directly");
  }
  await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await expect(journey).toContainText("Step 3 of 5"); await page.getByRole("link", { name: "Continue to funding", exact: true }).click();
  const claim = page.url(); await expect(journey).toContainText("Check the split, then freeze these terms."); await fits(page);
  await page.getByRole("button", { name: "Freeze allocation for approval", exact: true }).click();
  await expect(journey).toContainText("Step 4 of 5"); await expect(journey).toContainText("Hand this claim to a different approver.");
  await expect(page.getByRole("button", { name: "Approve these terms", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).click(); await login(page, "tara"); await page.goto(claim);
  await expect(journey).toContainText("0 of 2 approvals saved");
  await page.getByRole("button", { name: "Approve these terms", exact: true }).click();
  await expect(journey).toContainText("Hand this claim to a different approver.");
  await expect(page.getByRole("button", { name: /Send .*PayPal sandbox/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).click(); await login(page, "ben"); await page.goto(claim);
  await expect(journey).toContainText("1 of 2 approvals saved");
  await page.getByRole("button", { name: "Approve these terms", exact: true }).click();
  await expect(journey).toContainText("Step 5 of 5"); await expect(journey).toContainText("Approved is not paid"); await fits(page);
  await page.getByRole("link", { name: "Review receipt and confirmed categories", exact: true }).click();
  await expect(journey).toContainText("Step 5 of 5"); await expect(journey).not.toContainText("freeze the terms for two human approvers");
  expect(await connection.db.select().from(s.approvals)).toHaveLength(2);
  expect(await connection.db.select().from(s.disbursementAttempts)).toHaveLength(0);
  expect(await connection.db.select().from(s.disbursements)).toHaveLength(0);
});
