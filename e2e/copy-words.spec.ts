import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";

// CW-03 (IAC-416): the visible words at 1440 px. Screen copy avoids "sandbox" and the "AI off" wording in headings;
// the sandbox status is stated once on /give and in the README. Each test starts its own isolated database and next server on 3100, like shell.spec. No model request is
// made: the stub key only makes the app read as configured, and no AI button is pressed. Payments stay sandbox-only in code.
// The visible text is document.body.innerText with every <details> opened, so hidden review text is covered as well.
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });
let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof connectDatabase>;
let server: ChildProcess | undefined, name: string;
let passwords: Record<"maria" | "tara" | "ben", string>;

async function start(ai: Record<string, string>) {
  if (process.env.UI_TEST_CONTAINER !== "true") throw Error("Use isolated OrbStack browser service");
  const url = new URL(process.env.DATABASE_URL!); url.pathname = "/postgres";
  admin = postgres(url.toString(), { max: 1 }); name = "aidtrace_cw_" + randomBytes(6).toString("hex");
  await admin`create database ${admin(name)}`; url.pathname = "/" + name;
  connection = connectDatabase(url.toString()); await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "cw@example.invalid", payeeAllowlist: ["cw@example.invalid"] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AI_EXPENSE_PROPOSALS_ENABLED: "true", PAYPAL_SANDBOX_PAYEE_EMAIL: "cw@example.invalid", PAYEE_ALLOWLIST: "cw@example.invalid", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false", ...ai } });
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
  if (admin && /^aidtrace_cw_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.pathname === "/");
}
async function logout(page: Page) { await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(url => url.pathname === "/login"); }
async function bodyText(page: Page) {
  await page.evaluate(() => document.querySelectorAll("details").forEach(details => { details.open = true; }));
  return page.evaluate(() => document.body.innerText);
}
/** The words check for one page. aiWording false skips only the "AI off" test, for the receipt page where the true reason may show. */
async function words(page: Page, label: string, aiWording = true) {
  const text = await bodyText(page);
  expect(text.length, `${label} has text`).toBeGreaterThan(200);
  expect(text, `${label}: sandbox`).not.toMatch(/sandbox/i);
  if (aiWording) expect(text, `${label}: AI off`).not.toMatch(/AI off/i);
  return text;
}
const AI_ON = { AI_RECEIPT_ENABLED: "true", ANTHROPIC_API_KEY: "sk-ant-api03-UI-STUB-NOT-A-REAL-KEY" };
const AI_NONE = { AI_RECEIPT_ENABLED: "true", ANTHROPIC_API_KEY: "" };

test("CW-03a: with AI configured, no screen says sandbox or AI off, and How it works says no sandbox", async ({ page }) => {
  await start(AI_ON);
  // Sign-in and Give need no session. The header tag and the footer say AI and PayPal only.
  await page.goto("/login"); await words(page, "sign-in");
  await expect(page.locator(".header-tag")).toHaveText("AI + PayPal"); await expect(page.locator(".footer-built")).toHaveText("Built with PayPal Payouts and AI");
  await page.goto("/give"); await words(page, "Give");
  expect(await bodyText(page)).toContain("No real money moves.");
  // Maria: home, the new receipt form and its draft (the receipt page), then the seeded claim and the freeze.
  await login(page, "maria"); await words(page, "claimant home");
  await page.getByRole("link", { name: "Start an expense", exact: true }).click(); await words(page, "new receipt");
  await page.getByLabel("This receipt holds no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  await expect(page.getByText(/Unpaid draft created/).first()).toBeVisible(); await words(page, "receipt page");
  await page.goto("/claims/C-104"); await words(page, "claim page, draft");
  await page.getByRole("button", { name: "Freeze allocation for approval", exact: true }).click(); await words(page, "claim page, awaiting approval");
  // Tara and Ben approve the same frozen terms. Tara's home is the approver home. The approved claim shows the unpaid PayPal handoff.
  await logout(page); await login(page, "tara"); const home = await words(page, "approver home");
  expect(home).toMatch(/Lanternfield Community Alliance/);
  await page.goto("/claims/C-104"); await page.getByRole("button", { name: "Approve these terms", exact: true }).click(); await words(page, "claim page, one approval");
  await logout(page); await login(page, "ben"); await page.goto("/claims/C-104"); await page.getByRole("button", { name: "Approve these terms", exact: true }).click();
  const approved = await words(page, "claim page, approved");
  expect(approved).toContain("PayPal handoff"); expect(approved).toContain("Review exact recipient");
  await expect(page.locator(".paypal-label")).toHaveText("PayPal"); await expect(page.locator(".paypal-label span")).toHaveCount(0);
  // The trace names the last step PayPal payout, with no test-money detail.
  const trace = page.getByRole("navigation", { name: "Expense trace" }); await expect(trace.locator("li").nth(5).locator(".t")).toHaveText("PayPal payout");
  await expect(trace.locator("li").nth(5).locator(".d")).not.toContainText(/test money/i);
  // Ledger and analytics kickers name the organization alone.
  await page.goto("/ledger"); await words(page, "ledger"); await expect(page.locator(".kicker").first()).toHaveText("Lanternfield Community Alliance");
  await page.goto("/analytics"); await words(page, "analytics");
  // How it works: no sandbox sentence (IAC-416 PR 2 moved the only test-money line to Give), with every <details> opened.
  await page.goto("/architecture"); const how = await bodyText(page);
  expect(how.match(/sandbox/gi) ?? [], "How it works").toHaveLength(0);
  expect(how).not.toMatch(/AI off/i);
  await page.getByRole("button", { name: "PayPal handoff", exact: true }).click(); expect((await bodyText(page)).match(/sandbox/gi) ?? [], "How it works, handoff stage").toHaveLength(0);
});

test("CW-03b: with no AI key, the shell shows no tag and no AI off wording, and the receipt page still says why", async ({ page }) => {
  await start(AI_NONE);
  await page.goto("/login"); await words(page, "sign-in");
  await expect(page.locator(".header-tag")).toHaveCount(0); await expect(page.locator(".footer-built")).toHaveText("Built with PayPal Payouts.");
  await page.goto("/give"); await words(page, "Give");
  await login(page, "maria"); await words(page, "claimant home"); await expect(page.locator(".header-tag")).toHaveCount(0);
  await page.goto("/claims/C-104"); await words(page, "claim page"); await expect(page.locator(".header-tag")).toHaveCount(0);
  // The receipt page is where AI would act, so its fixed true-reason notice stays. Only the sandbox wording is asserted here.
  await page.goto("/receipts/new"); await page.getByLabel("This receipt holds no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  await expect(page.getByText(/Unpaid draft created/).first()).toBeVisible();
  const receipt = await words(page, "receipt page", false); expect(receipt).toContain("AI suggestions are off in this session: no AI key is configured.");
  // IAC-415 PR 4: the receipt page drops the bottom AI status row, so the AI strip carries the same fact.
  const ai = page.locator(".ai-strip"); await expect(ai).toContainText("A person confirms each category"); await expect(page.locator(".trace-nav")).not.toContainText(/AI off/i);
  await logout(page); await login(page, "tara"); await words(page, "approver home"); await page.goto("/ledger"); await words(page, "ledger");
  await page.goto("/architecture"); const how = await bodyText(page);
  expect(how.match(/sandbox/gi) ?? [], "How it works").toHaveLength(0); expect(how).not.toMatch(/AI is off|AI off/i);
});
