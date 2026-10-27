import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
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
let model: Server; let unavailable = false; let modelCalls = 0;
let modelGate: Promise<void> | undefined;
test.beforeEach(async () => {
  if (process.env.UI_TEST_CONTAINER !== "true") throw new Error("Run phone checks only through the isolated OrbStack UI service");
  name = `aidtrace_iac211_test_${randomBytes(6).toString("hex")}`;
  const adminUrl = new URL(process.env.DATABASE_URL!); adminUrl.pathname = "/postgres";
  admin = postgres(adminUrl.toString(), { max: 1 }); await admin`create database ${admin(name)}`;
  const url = new URL(adminUrl); url.pathname = `/${name}`; connection = connectDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "phone-test@personal.example.com", payeeAllowlist: ["phone-test@personal.example.com"] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  unavailable = false; modelCalls = 0; modelGate = undefined;
  // Synthetic model responses only. This test network has no internet route.
  model = createServer(async (request, response) => {
    modelCalls++;
    await modelGate;
    if (unavailable) { response.writeHead(503).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const data = JSON.parse(body.messages[1].content);
    const categories = ["science_kits", "notebooks", "hospitality"];
    const content = JSON.stringify({ proposals: data.lines.map((line: { id: string; description: string }, i: number) => ({ lineId: line.id, category: categories[i], quote: line.description })) });
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "aidtrace-category-qwen3", choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] }));
  });
  await new Promise<void>(resolve => model.listen(8080, "0.0.0.0", resolve));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AI_RECEIPT_ENABLED: "true", PAYPAL_SANDBOX_PAYEE_EMAIL: "phone-test@personal.example.com", PAYEE_ALLOWLIST: "phone-test@personal.example.com", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
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
  await new Promise<void>(resolve => model?.close(() => resolve()));
  if (admin && /^aidtrace_iac211_test_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const control of await page.locator("button, input, textarea, select").all()) {
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
async function create(page: Page) {
  await login(page, "maria"); await page.goto("/"); await page.getByRole("link", { name: "Create a synthetic receipt draft" }).click();
  await noOverflow(page); await page.getByLabel("This receipt is fictional sandbox data.").check();
  await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Unpaid draft created"); await noOverflow(page);
}
test("GB-02: 375-pixel receipt quotes, explicit confirmation, allocation and edits requiring new review", async ({ page }) => {
  await create(page); const receiptUrl = page.url().split("?")[0]!;
  await page.getByRole("button", { name: "Request AI suggestions" }).click();
  await expect(page.locator(".notice")).toContainText("AI suggestions are ready"); expect(modelCalls).toBe(1);
  await expect(page.locator("blockquote")).toHaveCount(3); await noOverflow(page);
  await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  expect(await page.getByLabel(/I checked every category/).evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
  await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible(); await page.getByRole("link", { name: "View allocation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "$5.00 from restricted funds, $1.00 from General.", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Freeze allocation for approval" })).toBeVisible(); await noOverflow(page);
  await page.goto(receiptUrl); await page.getByText("Edit receipt or amounts", { exact: true }).click();
  await page.getByLabel("Invented receipt text").fill("Edited fictional source"); await page.getByLabel("This receipt is fictional sandbox data.").check();
  await page.getByRole("button", { name: "Save edits and require a new review" }).click();
  await expect(page.getByRole("status")).toContainText("Earlier suggestions and confirmation no longer apply"); await expect(page.locator("blockquote")).toHaveCount(0);
  await expect(page.getByLabel("Category for L1", { exact: true })).toHaveValue("");
  await page.goto(receiptUrl.replace(/\/receipt$/, "")); await expect(page).toHaveURL(/\/receipt$/);
  const confirmations = await connection.db.select().from(s.receiptConfirmations); expect(confirmations).toHaveLength(1);
  expect(await connection.db.select().from(s.disbursements)).toHaveLength(0);
  expect((await connection.db.select().from(s.journalEntries)).every(entry => entry.sourceType === "fixture_opening_balance")).toBe(true);
});
test("GB-02: unavailable model leaves human review usable and approvers read-only at 375 pixels", async ({ page }) => {
  await create(page); unavailable = true;
  await page.getByRole("button", { name: "Request AI suggestions" }).click();
  await expect(page.getByText("No usable AI suggestions are available.", { exact: false })).toBeVisible(); expect(modelCalls).toBe(1);
  for (const [line, category] of [["L1", "science_kits"], ["L2", "notebooks"], ["L3", "hospitality"]]) {
    await page.getByLabel(`Category for ${line}`, { exact: true }).selectOption(category!);
    await page.getByLabel(`Reason for manual choice ${line}`, { exact: true }).fill("Checked fictional receipt");
  }
  await noOverflow(page); await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await expect(page.getByText(/Human choice: Checked fictional receipt/)).toHaveCount(3); const url = page.url();
  await page.getByRole("button", { name: "Sign out" }).click(); await login(page, "tara"); await page.goto(url);
  await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible(); await expect(page.getByText("Edit receipt or amounts", { exact: true })).toHaveCount(0); await noOverflow(page);
  expect(modelCalls).toBe(1); expect(await connection.db.select().from(s.disbursements)).toHaveLength(0);
});
test("GB-02: double submit shows progress and duplicate/stale posts return to the receipt", async ({ page }) => {
  await create(page); const receiptUrl = page.url().split("?")[0]!;
  const fields = await page.locator(".action-form").evaluate((form: HTMLFormElement) => Object.fromEntries(new FormData(form).entries()) as Record<string, string>);
  const endpoint = receiptUrl.replace("/claims/", "/api/receipts/").replace(/\/receipt$/, "");
  let release!: () => void; modelGate = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.locator(".action-form").evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
    await expect(page.getByRole("button", { name: "AI review in progress...", exact: true })).toBeDisabled();
    await expect.poll(() => modelCalls).toBe(1);
    const overlapping = await page.request.post(endpoint, { form: fields, headers: { origin: "http://127.0.0.1:3100" }, maxRedirects: 0 });
    expect(overlapping.status()).toBe(303); expect(overlapping.headers().location).toContain("notice=running");
  } finally { release(); }
  await expect(page.locator(".notice")).toContainText("AI suggestions are ready");
  await expect(page.locator("blockquote")).toHaveCount(3); expect(modelCalls).toBe(1);
  const duplicate = await page.request.post(endpoint, { form: fields, headers: { origin: "http://127.0.0.1:3100" }, maxRedirects: 0 });
  expect(duplicate.status()).toBe(303); expect(duplicate.headers().location).toContain("notice=suggested"); expect(modelCalls).toBe(1);
  const stale = await page.request.post(endpoint, { form: { ...fields, draftHash: "0".repeat(64) }, headers: { origin: "http://127.0.0.1:3100" }, maxRedirects: 0 });
  expect(stale.status()).toBe(303); expect(stale.headers().location).toContain("notice=review-changed");
  await page.goto(stale.headers().location); await expect(page.locator(".notice")).toContainText("Your saved draft is below");
  await expect(page.locator("blockquote")).toHaveCount(3); await noOverflow(page);
  expect(await connection.db.select().from(s.receiptSuggestions)).toHaveLength(1);
  expect(await connection.db.select().from(s.receiptConfirmations)).toHaveLength(0);
  expect(await connection.db.select().from(s.disbursements)).toHaveLength(0);
});
