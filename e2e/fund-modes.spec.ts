import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";

// IAC-405 step 2 PR F, the browser check of the mode change screen (docs/ASSUMPTIONS.md section 76, FM-30 and FM-31). With the fund modes flag on, one approver proposes Assisted
// on the fund's rules page, cannot approve their own proposal, and a second approver approves it. With the flag off the section and the route do not exist. No model call is
// made: nothing here sets an AI key. Each test starts its own database and next server on 3100, like rules-draft.spec.
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });
const ORIGIN = "http://127.0.0.1:3100";
const RULES = "/funds/fund_a/rules";
let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof connectDatabase>;
let server: ChildProcess | undefined, name: string;
let passwords: Record<"maria" | "tara" | "ben", string>;

async function start(flag: boolean) {
  if (process.env.UI_TEST_CONTAINER !== "true") throw new Error("Use the isolated OrbStack browser service");
  name = `aidtrace_iac405_fm_${randomBytes(6).toString("hex")}`;
  const adminUrl = new URL(process.env.DATABASE_URL!); adminUrl.pathname = "/postgres";
  admin = postgres(adminUrl.toString(), { max: 1 }); await admin`create database ${admin(name)}`;
  const url = new URL(adminUrl); url.pathname = `/${name}`; connection = connectDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "modes-test@personal.example.com", payeeAllowlist: ["modes-test@personal.example.com"] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AIDTRACE_JUDGE_SESSION: "false",
    FUND_MODES_ENABLED: flag ? "true" : "false", AI_RECEIPT_ENABLED: "false", AI_RULE_DRAFTS_ENABLED: "false", AI_COMPLIANCE_ENABLED: "false", AI_EXPENSE_PROPOSALS_ENABLED: "false", ANTHROPIC_API_KEY: "", PAYPAL_SANDBOX_PAYEE_EMAIL: "modes-test@personal.example.com",
    PAYEE_ALLOWLIST: "modes-test@personal.example.com", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
  for (let attempt = 0; attempt < 90; attempt++) {
    try { if ((await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Wait for the isolated server, never the main application. */ }
    if (server.exitCode !== null) throw new Error("Isolated UI server exited before readiness");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Isolated UI server readiness timed out");
}
test.afterEach(async () => {
  if (server?.pid) {
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* Already stopped. */ }
    await Promise.race([new Promise(resolve => server!.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    try { process.kill(-server.pid, "SIGKILL"); } catch { /* Already stopped. */ }
  }
  await connection?.client.end();
  if (admin && /^aidtrace_iac405_fm_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]);
  const response = page.waitForResponse(r => r.url().endsWith("/api/auth/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); expect((await response).status()).toBe(303);
  await page.waitForURL(url => url.pathname === "/");
}
async function signOut(page: Page) { await page.getByRole("button", { name: "Sign out" }).click(); await page.waitForURL(url => url.pathname === "/login"); }
// FM_STILLS names a folder for screenshots (the owner visual review). Unset, nothing is written.
const still = async (page: Page, name: string) => { if (process.env.FM_STILLS) await page.screenshot({ path: `${process.env.FM_STILLS}/${name}.png`, fullPage: true }); };
const post = (page: Page, path: string, form: Record<string, string>, headers: Record<string, string> = { origin: ORIGIN }) => page.request.post(path, { form, headers, maxRedirects: 0 });

test("FM-30: with the flag on, one approver proposes Assisted, cannot approve it, and a second approver approves it", async ({ page }) => {
  test.setTimeout(240_000);
  await start(true);
  await login(page, "tara"); await page.goto(RULES);
  await expect(page.getByRole("heading", { name: "How claims are approved" })).toBeVisible();
  await expect(page.getByTestId("fund-mode-current")).toContainText("Manual");
  await expect(page.getByTestId("fund-mode-current")).toContainText("(the default)");
  // Computed styles, so a page that lost its stylesheet fails here and not only in a screenshot.
  expect(await page.getByTestId("fund-mode").evaluate(el => { const s = getComputedStyle(el); return { top: s.paddingTop, margin: s.marginTop }; })).toEqual({ top: "24px", margin: "32px" });
  await still(page, "fm-1-flag-on-manual");
  await page.getByRole("button", { name: /Propose Assisted/ }).click();
  await expect(page.getByTestId("rules-notice")).toContainText("The change is proposed");
  await expect(page.getByTestId("fund-mode-pending")).toContainText("Assisted proposed by");
  await expect(page.getByTestId("fund-mode-pending")).toContainText("A different approver must approve it.");
  await expect(page.getByRole("button", { name: /Approve the change/ })).toHaveCount(0);
  await still(page, "fm-2-proposed-before-second-approval");
  // The route refuses what the page never offers: Autopilot, an extra field, and a post from a foreign origin.
  expect((await post(page, "/api/funds/fund_a/mode", { action: "propose", mode: "AUTOPILOT" })).headers()["location"]).toContain("notice=mode-failed");
  expect((await post(page, "/api/funds/fund_a/mode", { action: "propose", mode: "ASSISTED", extra: "1" })).status()).toBe(400);
  expect((await post(page, "/api/funds/fund_a/mode", { action: "propose", mode: "ASSISTED" }, { origin: "http://evil.example" })).status()).toBe(403);
  await signOut(page);
  await login(page, "ben"); await page.goto(RULES);
  await page.getByRole("button", { name: "Approve the change to Assisted" }).click();
  await expect(page.getByTestId("rules-notice")).toContainText("The change is approved");
  await expect(page.getByTestId("fund-mode-current")).toContainText("Assisted");
  await expect(page.getByTestId("fund-mode-current")).toContainText("version 1");
  await expect(page.getByTestId("fund-mode-pending")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Propose Manual/ })).toBeVisible();
  await still(page, "fm-3-assisted-after-second-approval");
  const button = await page.getByRole("button", { name: /Propose Manual/ }).evaluate(el => getComputedStyle(el).backgroundColor);
  expect(button).not.toBe("rgba(0, 0, 0, 0)");
  await signOut(page);
  // A claimant has no way in.
  await login(page, "maria");
  expect((await post(page, "/api/funds/fund_a/mode", { action: "propose", mode: "MANUAL" })).status()).toBe(403);
});

test("FM-31: with the flag off, the section and the route do not exist", async ({ page }) => {
  test.setTimeout(240_000);
  await start(false);
  await login(page, "tara"); await page.goto(RULES);
  await expect(page.getByRole("heading", { name: /Rules for/ })).toBeVisible();
  await expect(page.getByTestId("fund-mode")).toHaveCount(0);
  await expect(page.getByText("How claims are approved")).toHaveCount(0);
  await still(page, "fm-4-flag-off");
  expect((await post(page, "/api/funds/fund_a/mode", { action: "propose", mode: "ASSISTED" })).status()).toBe(404);
});
