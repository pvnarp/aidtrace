import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";
import * as s from "../db/schema";

// IAC-415 polish still capture. Explicit run only: playwright.polish-capture.config.ts, never scripts/run-ui-check.mjs.
// Test one walks the real flow with AI off: the claimant freezes the allocation and two separate approver sign-ins approve it, in an isolated database.
// IAC-415 PR 4: the still names are unchanged so the heights compare with section 50. The stubbed claim-model-rows still keeps the all-OK stub (every line OK, one sentence per fund), the same stub as the 3,215 px baseline.
// Test two uses a loopback Claude stub (UI_TEST_CONTAINER sends Claude requests to 127.0.0.1:8080) for the AI states. Those stills carry a -stubbed suffix and
// are NOT a real model result. Each still is a full-page PNG named <label>-<width>.png under local/polish-capture, and the page height is printed as HEIGHT lines.
const OUT = "local/polish-capture";
let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof connectDatabase>;
let server: ChildProcess | undefined, model: Server | undefined, name: string;
let passwords: Record<"maria" | "tara" | "ben", string>;

async function start(stubbed: boolean) {
  if (process.env.UI_TEST_CONTAINER !== "true") throw Error("Use isolated OrbStack browser service");
  const url = new URL(process.env.DATABASE_URL!); url.pathname = "/postgres";
  admin = postgres(url.toString(), { max: 1 }); name = "aidtrace_polishcap_" + randomBytes(6).toString("hex");
  await admin`create database ${admin(name)}`; url.pathname = "/" + name;
  connection = connectDatabase(url.toString()); await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "polish-cap@example.invalid", payeeAllowlist: ["polish-cap@example.invalid"] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  if (stubbed) {
    // Synthetic answers only. A receipt suggestion request has top-level lines, a compliance request has a fund. Every compliance line answers OK.
    model = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); const data = JSON.parse(body.messages[0].content);
      const categories = ["robot_kits_parts", "classroom_supplies", "participant_meals"];
      const text = data.fund
        ? JSON.stringify({ lines: data.receipt.lines.map((line: { id: string }) => ({ lineId: line.id, verdict: "OK", clauseId: null })) })
        : JSON.stringify({ proposals: data.lines.map((line: { id: string; description: string }, i: number) => ({ lineId: line.id, category: categories[i], quote: line.description })) });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_ui_stub", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text }], usage: { input_tokens: 812, output_tokens: 57 } }));
    });
    await new Promise<void>(resolve => model!.listen(8080, "0.0.0.0", resolve));
  }
  const ai = stubbed ? { AI_RECEIPT_ENABLED: "true", AI_COMPLIANCE_ENABLED: "true", AI_EXPENSE_PROPOSALS_ENABLED: "false", ANTHROPIC_API_KEY: "sk-ant-api03-UI-STUB-NOT-A-REAL-KEY" } : { AI_RECEIPT_ENABLED: "false", AI_EXPENSE_PROPOSALS_ENABLED: "true" };
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AIDTRACE_JUDGE_SESSION: "false", ...ai, PAYPAL_SANDBOX_PAYEE_EMAIL: "polish-cap@example.invalid", PAYEE_ALLOWLIST: "polish-cap@example.invalid", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch("http://127.0.0.1:3100/api/health", { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Wait for this container's server. */ }
    if (server.exitCode !== null) throw Error("Isolated server exited");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error("Server readiness timeout");
}
test.afterEach(async () => {
  if (server?.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* Exited. */ } await Promise.race([new Promise(resolve => server!.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 1500))]); try { process.kill(-server.pid, "SIGKILL"); } catch { /* Exited. */ } }
  await connection?.client.end();
  model?.closeAllConnections(); if (model) { await new Promise<void>(resolve => model!.close(() => resolve())); model = undefined; }
  if (admin && /^aidtrace_polishcap_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.pathname === "/");
}
async function logout(page: Page) { await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(url => url.pathname === "/login"); }
const SIZE: Record<number, number> = { 1440: 900, 1280: 800, 390: 844 };
async function shot(page: Page, label: string, widths: number[] = [1440]) {
  mkdirSync(OUT, { recursive: true });
  for (const width of widths) {
    await page.setViewportSize({ width, height: SIZE[width]! }); await page.reload(); await page.waitForLoadState("load");
    const height = await page.evaluate(() => document.documentElement.scrollHeight); console.log(`HEIGHT ${label} ${width} ${height}`);
    await page.screenshot({ path: `${OUT}/${label}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("polish stills through the real freeze and two approvals (AI off)", async ({ page }) => {
  test.setTimeout(600000); await start(false);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "tara"); await shot(page, "approver-home-empty"); await logout(page);
  await login(page, "maria"); await shot(page, "claimant-home-empty");
  await page.getByRole("link", { name: "Start an expense", exact: true }).click();
  await page.getByLabel("This receipt holds no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  await expect(page.getByLabel("Category for L1", { exact: true })).toBeVisible(); await shot(page, "receipt-review");
  for (const [line, category] of [["L1", "robot_kits_parts"], ["L2", "classroom_supplies"], ["L3", "participant_meals"]]) {
    await page.getByLabel(`Category for ${line}`, { exact: true }).selectOption(category!); await page.getByLabel(`Reason for manual choice ${line}`, { exact: true }).fill("Checked this receipt directly");
  }
  await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible(); await shot(page, "receipt-confirmed");
  await page.getByRole("link", { name: "Continue to funding", exact: true }).click();
  await expect(page.getByRole("button", { name: "Freeze allocation for approval", exact: true })).toBeVisible(); const claim = page.url(); await shot(page, "claim-draft");
  await page.goto("/"); await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); await shot(page, "claimant-home");
  await page.goto(claim); await page.getByRole("button", { name: "Freeze allocation for approval", exact: true }).click();
  await expect(page.locator(".trace [aria-current=step] .t")).toHaveText("Approvals"); await shot(page, "claim-awaiting-claimant");
  await logout(page); await login(page, "tara"); await shot(page, "approver-home-awaiting", [1440, 390]);
  await page.goto(claim); await shot(page, "claim-awaiting-approver");
  await page.getByRole("button", { name: "Approve these terms", exact: true }).click();
  await expect(page.locator(".hybrid-review-count")).toContainText("1 of 2"); await shot(page, "claim-one-approval");
  await logout(page); await login(page, "ben"); await page.goto(claim);
  await page.getByRole("button", { name: "Approve these terms", exact: true }).click();
  await expect(page.locator(".trace [aria-current=step] .t")).toHaveText("PayPal payout");
  await shot(page, "claim-approved-unpaid", [1440, 1280, 390]);
  expect(await connection.db.select().from(s.approvals)).toHaveLength(2); expect(await connection.db.select().from(s.disbursementAttempts)).toHaveLength(0);
});

test("polish stills for the AI states, answered by a loopback stub (stubbed)", async ({ page }) => {
  test.setTimeout(600000); await start(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "maria"); await page.getByRole("link", { name: "Start an expense", exact: true }).click();
  await page.getByLabel("This receipt holds no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Unpaid draft created");
  await page.getByRole("button", { name: "Request AI suggestions" }).click(); await expect(page.locator(".notice")).toContainText("AI suggestions are ready");
  await shot(page, "receipt-ai-suggested-stubbed");
  await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible(); await shot(page, "receipt-confirmed-stubbed");
  await page.getByRole("link", { name: "Continue to funding", exact: true }).click();
  await expect(page.getByRole("heading", { name: "$5.00 restricted. $1.00 General.", exact: true })).toBeVisible(); const claim = page.url(); await shot(page, "claim-draft-stubbed");
  await page.getByRole("button", { name: "Freeze allocation for approval" }).click(); await expect(page.getByRole("status")).toContainText("allocation is frozen");
  await logout(page); await login(page, "tara"); await page.goto(claim);
  const section = page.locator("#policy-checks"); await section.getByRole("button", { name: "Run policy checks" }).click();
  await expect(page.getByRole("status")).toContainText("Policy checks ran and are stored");
  await expect(section).toContainText("Model status"); await shot(page, "claim-model-rows-stubbed");
});
