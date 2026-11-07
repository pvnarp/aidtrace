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

// HOME-08 (IAC-403): the locked mock's Sign-in, Claimant home, Approver home, Analytics and Architecture screens in the real app,
// at 1440 and 390 px. Isolated database and server, AI off, no provider or model request. The one claim status change
// (AWAITING_APPROVAL) is written directly to the isolated database as a presentation fixture; no approval or payment is made.
let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof connectDatabase>;
let server: ChildProcess | undefined, name: string;
let passwords: Record<"maria" | "tara" | "ben", string>;
test.beforeEach(async () => {
  if (process.env.UI_TEST_CONTAINER !== "true") throw Error("Use isolated OrbStack browser service");
  const url = new URL(process.env.DATABASE_URL!); url.pathname = "/postgres";
  admin = postgres(url.toString(), { max: 1 }); name = "aidtrace_home_" + randomBytes(6).toString("hex");
  await admin`create database ${admin(name)}`; url.pathname = "/" + name;
  connection = connectDatabase(url.toString()); await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "home@example.invalid", payeeAllowlist: ["home@example.invalid"] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AI_RECEIPT_ENABLED: "false", AI_EXPENSE_PROPOSALS_ENABLED: "true", AI_ANALYTICS_ENABLED: "false", PAYPAL_SANDBOX_PAYEE_EMAIL: "home@example.invalid", PAYEE_ALLOWLIST: "home@example.invalid", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
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
  if (admin && /^aidtrace_home_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function signIn(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.pathname === "/");
}
async function fits(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
const sizes = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
async function atEachSize(page: Page, path: string, check: () => Promise<void>) {
  for (const size of sizes) { await page.setViewportSize(size); await page.goto(path); await check(); await fits(page); }
}
const money = (cents: bigint) => `$${(cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${(cents % 100n).toString().padStart(2, "0")}`;

test("HOME-08: the five locked mock screens render in the real app at 1440 and 390 and change no state", async ({ page }) => {
  // Sign-in: the same form signs in, the two columns stack at 1100 and below, no horizontal overflow.
  await atEachSize(page, "/login", async () => {
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Review an expense. Honor each fund.");
    await expect(page.getByRole("heading", { name: "Sign in to your own account", level: 2 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Three people, distinct responsibilities", level: 2 })).toBeVisible();
    await expect(page.getByText(/Product screen reference|Design navigation only/)).toHaveCount(0);
  });
  const columns = () => page.locator(".reference-two").evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length);
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/login"); expect(await columns()).toBe(2);
  await page.setViewportSize({ width: 1100, height: 900 }); expect(await columns()).toBe(1);
  await signIn(page, "maria");

  // Claimant home: heading from the session, a start card before any expense, one card per loaded claim after.
  await atEachSize(page, "/", async () => {
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Which fund can pay Maria back?");
    await expect(page.getByRole("heading", { name: "No expense yet", level: 2 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Start an expense", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "View funding and cash" })).toHaveCount(0);
  });
  await page.getByRole("link", { name: "Start an expense", exact: true }).click();
  await page.getByLabel("This receipt holds no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  await expect(page.getByText(/Unpaid draft created/)).toBeVisible();
  const [claim] = await connection.db.select().from(s.claims).where(eq(s.claims.claimantId, "maria")).then(rows => rows.filter(row => row.id.startsWith("R-")));
  expect(claim).toBeDefined();
  const total = (await connection.db.select().from(s.claimLines).where(eq(s.claimLines.claimId, claim!.id))).filter(line => line.claimVersion === claim!.version).reduce((sum, line) => sum + line.amountCents, 0n);
  await atEachSize(page, "/", async () => {
    const card = page.locator(`article[data-claim="${claim!.id}"]`);
    await expect(card).toHaveCount(1); await expect(card).toHaveAttribute("data-status", "DRAFT");
    await expect(card.locator(".case-amount")).toHaveText(money(total)); await expect(card.locator(".case-status")).toHaveText("Draft");
    await expect(card).toContainText("Unpaid draft. Confirm each category, then review funding.");
    await expect(card.getByRole("link", { name: "Open this expense", exact: true })).toHaveAttribute("href", `/claims/${claim!.id}`);
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(/\/login$/);

  // Approver home: a calm empty state, then the heading and card follow the loaded awaiting count.
  await signIn(page, "tara");
  await atEachSize(page, "/", async () => {
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("No expense needs your review.");
    await expect(page.getByRole("link", { name: "View funding and cash", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Explore how it works", exact: true })).toBeVisible();
  });
  await connection.db.update(s.claims).set({ status: "AWAITING_APPROVAL" }).where(eq(s.claims.id, claim!.id));
  await atEachSize(page, "/", async () => {
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("One expense needs your review.");
    // IAC-414 Q1: the awaiting claim is one row of the queue grid and no longer a card. It is listed once, with its amount and a Review link to the claim.
    await expect(page.locator("article[data-claim]")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Awaiting your approval", level: 2 })).toBeVisible();
    const queued = page.getByTestId("gx-approver-queue").locator(".ag-row:not(.ag-row-pinned)");
    await expect(queued).toHaveCount(1);
    await expect(queued.locator('[col-id="amountCents"]')).toHaveText(money(total));
    await expect(queued.getByRole("link", { name: /^Review / })).toHaveAttribute("href", `/claims/${claim!.id}`);
    await expect(page.getByText("Check the items, the recipient and the funding.", { exact: false })).toBeVisible();
    // Wide shows the approval count in the Status column; a phone moves it to the details list under the grid.
    if ((page.viewportSize()?.width ?? 0) > 639) { await expect(queued.locator('[col-id="approvals"]')).toHaveText("Approvals: 0 of 2"); await expect(page.getByTestId("gx-phone-extras")).toHaveCount(0); }
    else await expect(page.getByTestId("gx-phone-extras")).toContainText("Approvals: 0 of 2");
    await expect(page.getByText("$430")).toHaveCount(0);
  });

  // Analytics (approver only): the same read-only widgets inside the mock's layout.
  await atEachSize(page, "/analytics", async () => {
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Follow funding and book cash.");
    await expect(page.getByTestId("funding-widget")).toBeVisible(); await expect(page.getByTestId("cash-widget")).toBeVisible();
    await expect(page.getByText(/Illustrated snapshot|Scripted design example/)).toHaveCount(0);
  });
  await page.setViewportSize({ width: 1100, height: 900 });
  expect(await page.locator(".analytics-dashboard").evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length)).toBe(1);

  // Architecture: the stage picker changes the live note, with no request and no state change.
  const requests: string[] = []; page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request.url()); });
  await atEachSize(page, "/architecture", async () => {
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("See where each decision happens.");
    const stages = page.getByRole("group", { name: "Architecture stages", exact: true });
    const note = page.getByTestId("architecture-note");
    await stages.getByRole("button", { name: "AI suggests", exact: true }).click();
    await expect(note).toContainText("A person chooses every category in this session");
    await stages.getByRole("button", { name: "Rules allocate", exact: true }).click();
    await expect(note.getByRole("heading", { level: 2 })).toHaveText("Rules allocate"); await expect(note).toContainText("A rule failure stops the allocation");
    await expect(stages.getByRole("button", { name: "Rules allocate", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(/Local|Qwen|1\.7B/)).toHaveCount(0);
  });
  expect(requests).toEqual([]);
  expect(await connection.db.select().from(s.approvals)).toHaveLength(0);
  expect(await connection.db.select().from(s.disbursements)).toHaveLength(0);
  expect(await connection.db.select().from(s.disbursementAttempts)).toHaveLength(0);
});
