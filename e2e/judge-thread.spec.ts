import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
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
  admin = postgres(url.toString(), { max: 1 }); name = "aidtrace_thread_" + randomBytes(6).toString("hex");
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
  if (admin && /^aidtrace_thread_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.pathname === "/");
}
async function fits(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
// The trace stepper (Trust v2) replaces the old "Step n of 5" kicker: exactly one item carries aria-current=step and it names the current step.
async function traceAt(page: Page, name: string) {
  await expect(page.locator(`nav[aria-label="Expense trace"] [aria-current=step]`)).toHaveCount(1);
  await expect(page.locator(`nav[aria-label="Expense trace"] [aria-current=step] .t`)).toHaveText(name);
}
// TH-07 to TH-11 (November 10 judge thread): the real flow with separate sign-ins, in an isolated database, AI off.
const FILLED = "rgb(10, 102, 255)";
/** Names of the visible controls in main that carry the primary fill. A scroll-only action must never be one. */
async function filledPrimaries(page: Page) {
  return page.evaluate(filled => [...document.querySelectorAll<HTMLElement>("main button, main a.journey-action, main a.button-link")]
    .filter(el => el.checkVisibility() && getComputedStyle(el).backgroundColor === filled).map(el => (el.textContent ?? "").replace(/\s*[→↓]$/, "").trim()), FILLED);
}
async function signInFromHandoff(page: Page, user: keyof typeof passwords) {
  await expect(page.getByLabel("Username")).toHaveValue(user); await expect(page.getByLabel("Password")).toBeFocused(); await expect(page.getByLabel("Password")).toHaveValue("");
  await page.getByLabel("Password").fill(passwords[user]); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.pathname === "/");
}

test("TH-07 to TH-11: the handoff ends the session, lands on a prefilled sign-in, and the closing card ends the trace", async ({ page, playwright, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Receipt screens: one filled primary, and a scroll-only action is a quiet link.
  await login(page, "maria"); await page.goto("/receipts/new");
  await expect(page.locator(".journey-actor")).toHaveText("Your move, Maria.");
  expect(await filledPrimaries(page), "new receipt").toEqual(["Create receipt draft"]);
  expect(await page.locator('.journey-action[href^="#"]').evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  await expect(page.locator(".status-cards")).toHaveCount(0);
  await page.getByLabel("This receipt holds no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  await traceAt(page, "AI review");
  expect(await filledPrimaries(page), "receipt review").toEqual(["Confirm categories"]);
  for (const [line, category] of [["L1", "robot_kits_parts"], ["L2", "classroom_supplies"], ["L3", "participant_meals"]]) {
    await page.getByLabel(`Category for ${line}`, { exact: true }).selectOption(category!); await page.getByLabel(`Reason for manual choice ${line}`, { exact: true }).fill("Checked this fictional receipt directly");
  }
  await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await traceAt(page, "Fund split");
  expect(await filledPrimaries(page), "categories confirmed").toEqual(["Continue to funding"]);
  await page.getByRole("link", { name: "Continue to funding", exact: true }).click();
  const claim = page.url();
  await expect(page.locator(".action-footer .journey-actor")).toHaveText("Your move, Maria. Rules computed this split.");
  expect(await filledPrimaries(page), "claim draft").toEqual(["Freeze allocation for approval"]);
  await expect(page.getByLabel("Expense journey").getByRole("button")).toHaveCount(0);
  await page.getByRole("button", { name: "Freeze allocation for approval", exact: true }).click();

  // TH-08: Maria cannot act. The detail is in the open and the handoff names the next approver from loaded data.
  const journey = page.getByLabel("Expense journey", { exact: true });
  await expect(journey).toContainText("Waiting for two approvers."); await expect(journey.locator(".journey-actor")).toHaveText("Tara and Ben act next.");
  await expect(journey.locator(".journey-critical")).toBeVisible(); await expect(journey.locator(".journey-critical")).toContainText("Two different approvers must approve these frozen terms.");
  await expect(journey.locator(".journey-help")).not.toHaveAttribute("open");
  const handoff = journey.getByRole("button", { name: "Sign out and continue as Tara", exact: true }); await expect(handoff).toBeVisible();
  expect((await handoff.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await filledPrimaries(page), "claim waiting, maria").toEqual([]);
  // TH-09: the session really ends. The old cookie opened the claim before the click and is refused after it.
  const sessionCookie = (await page.context().cookies()).find(cookie => cookie.name.includes("session")); expect(sessionCookie, "session cookie").toBeDefined();
  const old = await playwright.request.newContext({ baseURL: baseURL!, extraHTTPHeaders: { cookie: `${sessionCookie!.name}=${sessionCookie!.value}` } });
  expect((await old.get(claim, { maxRedirects: 0 })).status(), "old cookie before the click").toBe(200);
  await handoff.click(); await page.waitForURL(url => url.pathname === "/login" && url.searchParams.get("as") === "tara");
  const after = await old.get(claim, { maxRedirects: 0 }); expect([302, 303, 307], "old cookie after the click").toContain(after.status()); expect(after.headers()["location"]).toMatch(/\/login$/);
  await expect(page.getByTestId("login-continue")).toHaveText("Continue as Tara. Type the password for tara to continue.");
  expect(await page.getByLabel("Password").inputValue()).toBe("");
  await expect(page.getByRole("navigation", { name: "How a claim moves" })).toBeVisible(); await expect(page.getByTestId("login-order")).toContainText("Start as maria.");
  await fits(page);
  await signInFromHandoff(page, "tara");

  // TH-10: approver home with the queue first, then the claim with the checks status above Approve.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("One expense needs your review.");
  const queue = (await page.getByTestId("aq-queue").boundingBox())!, funds = (await page.locator(".funds").boundingBox())!; expect(queue.y + queue.height - 1, "queue above the fund cards").toBeLessThanOrEqual(funds.y);
  await page.goto(claim);
  await expect(page.locator(".action-footer .journey-actor")).toHaveText("Your move, Tara. Run the checks, then approve.");
  expect(await filledPrimaries(page), "claim, first approver").toEqual(["Approve these terms"]);
  const status = page.getByTestId("checks-status"); await expect(status).toContainText("Checks not run yet."); await expect(status.getByRole("link", { name: "Run the checks" })).toHaveAttribute("href", "#policy-checks");
  const approve = page.getByRole("button", { name: "Approve these terms", exact: true }); await expect(approve).toBeEnabled();
  expect((await status.boundingBox())!.y).toBeLessThan((await approve.boundingBox())!.y);
  await page.locator("#policy-checks").getByRole("button", { name: "Run policy checks" }).click();
  await expect(page.getByTestId("checks-status")).toContainText(/Checks run: (no flags|\d+ flags?)\./);
  await expect(page.getByTestId("checks-status").getByRole("link", { name: "See the checks" })).toHaveAttribute("href", "#policy-checks");
  await expect(approve).toBeEnabled(); await approve.click();
  await expect(journey).toContainText("Hand this claim to a different approver."); await expect(journey.locator(".journey-actor")).toHaveText("Ben acts next.");
  await expect(journey.locator(".journey-critical")).toContainText("another authorized approver");
  await journey.getByRole("button", { name: "Sign out and continue as Ben", exact: true }).click(); await page.waitForURL(url => url.pathname === "/login" && url.searchParams.get("as") === "ben");
  await signInFromHandoff(page, "ben"); await page.goto(claim);
  await expect(journey.locator(".journey-actor")).toHaveText("Your move, Ben. Run the checks, then approve.");
  await page.getByRole("button", { name: "Approve these terms", exact: true }).click();

  // TH-11: the closing card. No Next decision card, the PayPal card says not paid, approvers get the two quiet links, the claimant gets the card alone.
  const closing = page.getByLabel("Approved, unpaid", { exact: true });
  await expect(closing.locator(".kicker")).toHaveText("Approved, unpaid"); await expect(closing.getByRole("heading", { level: 2 })).toHaveText("Approval is complete. Payout is a separate step.");
  await expect(page.getByLabel("Expense journey", { exact: true })).toHaveCount(0);
  await expect(closing.getByRole("link", { name: "See it in the ledger" })).toHaveAttribute("href", "/ledger"); await expect(closing.getByRole("link", { name: "Open the funder report" })).toHaveAttribute("href", "/analytics/report");
  await expect(page.locator(".paypal-card")).toContainText("Approved does not mean paid.");
  await expect(page.locator("footer", { hasText: "Paid appears only after an independently fetched payout item reports success." })).toHaveCount(1);
  await fits(page);
  await closing.getByRole("link", { name: "See it in the ledger" }).click(); await expect(page).toHaveURL(/\/ledger$/);
  await page.goto("/"); await page.getByRole("button", { name: "Sign out", exact: true }).click(); await login(page, "maria"); await page.goto(claim);
  await expect(page.getByLabel("Approved, unpaid", { exact: true })).toBeVisible(); await expect(page.getByLabel("Approved, unpaid", { exact: true }).getByRole("link")).toHaveCount(0);
  expect(await connection.db.select().from(s.approvals)).toHaveLength(2);
  expect(await connection.db.select().from(s.disbursementAttempts)).toHaveLength(0);
});

test("TH-12 before approval the claim page has one payment caution, and the footer promise waits for APPROVED", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "tara"); await page.goto("/claims/C-104");
  await expect(page.getByText("Payment access is disabled for this review.", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Organization-wide open payable", { exact: false })).toBeHidden();
  await expect(page.locator("footer", { hasText: "Paid appears only after" })).toHaveCount(0);
  await expect(page.locator(".paypal-card")).toContainText("Not ready: needs two approvals");
});

test("TH-13 ?as= fills the username only for a plain username", async ({ page }) => {
  await page.goto("/login?as=tara"); await expect(page.getByLabel("Username")).toHaveValue("tara"); await expect(page.getByLabel("Password")).toBeFocused();
  for (const value of ["Tara", "ta%20ra", "%3Cscript%3E", "1tara", "x".repeat(40)]) {
    await page.goto(`/login?as=${value}`); await expect(page.getByLabel("Username")).toHaveValue(""); await expect(page.getByTestId("login-continue")).toHaveCount(0); await expect(page.getByLabel("Password")).not.toBeFocused();
  }
  await page.goto("/login?as=tara&as=ben"); await expect(page.getByLabel("Username")).toHaveValue("");
  await page.goto("/login"); await expect(page.getByLabel("Username")).toHaveValue(""); await expect(page.getByTestId("login-continue")).toHaveCount(0);
});
