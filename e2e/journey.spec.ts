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
// The trace stepper (Trust v2) replaces the old "Step n of 5" kicker: exactly one item carries aria-current=step and it names the current step.
async function traceAt(page: Page, name: string) {
  await expect(page.locator(`nav[aria-label="Expense trace"] [aria-current=step]`)).toHaveCount(1);
  await expect(page.locator(`nav[aria-label="Expense trace"] [aria-current=step] .t`)).toHaveText(name);
}
async function compactJourney(page: Page) {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await page.getByLabel("Expense journey", { exact: true }).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThan(width === 390 ? 300 : 210);
    expect((await page.getByRole("heading", { level: 1 }).boundingBox())!.y).toBeLessThan(700);
    await fits(page);
  }
}
// IAC-415 polish: an approved claim has no Next decision card (the title and the Decision panel state it), so only the top of the page is measured.
async function compactTop(page: Page) {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByLabel("Expense journey", { exact: true })).toHaveCount(0);
    expect((await page.getByRole("heading", { level: 1 }).boundingBox())!.y).toBeLessThan(700);
    await fits(page);
  }
}

test("IAC-350: architecture is authenticated, keyboard-operable and executes no requests", async ({ page }) => {
  await page.goto("/architecture"); await expect(page).toHaveURL(/\/login$/);
  await login(page, "maria"); await page.getByRole("link", { name: "Explore how it works", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("See where each decision happens.");
  // IAC-403: the locked mock's stage picker replaces the six-step explorer, the alcohol scenario and the Previous and Next buttons.
  const stages = page.getByRole("group", { name: "Architecture stages", exact: true });
  await expect(stages.getByRole("button")).toHaveText(["AI suggests", "Rules allocate", "People approve", "PayPal handoff"]);
  await expect(stages.getByRole("button", { name: "AI suggests", exact: true })).toHaveAttribute("aria-pressed", "true");
  const note = page.getByTestId("architecture-note"); await expect(note).toHaveAttribute("aria-live", "polite");
  const requests: string[] = []; page.on("request", request => requests.push(request.url()));
  const explanation = note.getByRole("heading", { level: 2 });
  await expect(explanation).not.toBeFocused();
  await expect(page.getByText(/This page is an illustration, not live telemetry/)).toBeVisible();
  await stages.getByRole("button", { name: "Rules allocate", exact: true }).click();
  await expect(explanation).toHaveText("Rules allocate"); await expect(note).toContainText("$70 refreshments from General Operating");
  await expect(explanation).toBeFocused(); await expect(explanation).toBeInViewport({ ratio: 1 });
  await page.getByRole("button", { name: "Explore AI model", exact: true }).click();
  await expect(explanation).toHaveText("AI suggests"); await expect(note).toContainText("A person chooses every category in this session");
  await expect(explanation).toBeFocused(); await expect(explanation).toBeInViewport({ ratio: 1 });
  // Re-selecting the same component must still return focus to its explanation.
  await page.getByRole("button", { name: "Explore AI model", exact: true }).click();
  await expect(explanation).toBeFocused(); await expect(explanation).toBeInViewport({ ratio: 1 });
  await stages.getByRole("button", { name: "People approve", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(explanation).toHaveText("People approve"); await expect(note).toContainText("Maria cannot approve her own claim");
  await expect(explanation).toBeFocused(); await expect(explanation).toBeInViewport({ ratio: 1 });
  await stages.getByRole("button", { name: "PayPal handoff", exact: true }).click();
  await expect(explanation).toHaveText("PayPal handoff"); await expect(note).toContainText("submits nothing");
  await expect(stages.getByRole("button", { name: "PayPal handoff", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Explore PayPal", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByText("Deployment boundaries", { exact: true }).click();
  await expect(page.getByText("Private Docker containers", { exact: true })).toBeVisible();
  await expect(page.getByText(/one Next.js app container/)).toBeVisible();
  for (const width of [375, 1440]) { await page.setViewportSize({ width, height: 1000 }); await page.getByRole("button", { name: "Explore AidTrace app", exact: true }).click(); await expect(explanation).toBeFocused(); await expect(explanation).toBeInViewport({ ratio: 1 }); await fits(page); }
  expect(requests).toEqual([]);
  expect(await connection.db.select().from(s.disbursementAttempts)).toHaveLength(0);
  expect(await connection.db.select().from(s.approvals)).toHaveLength(0);
});

test("IAC-350: guidance follows one expense, role handoff and two approvals without payment", async ({ page }) => {
  await login(page, "maria"); await page.getByRole("link", { name: "Start a $6 practice expense", exact: true }).click();
  const journey = page.getByLabel("Expense journey", { exact: true });
  await traceAt(page, "Receipt"); await fits(page);
  const checkbox = page.getByLabel("This receipt is sample data with no real personal details.");
  const checkboxBox = await checkbox.boundingBox();
  expect(checkboxBox!.width).toBeGreaterThanOrEqual(20); expect(checkboxBox!.height).toBeGreaterThanOrEqual(20);
  expect((await page.locator("label.confirm").boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByLabel("This receipt is sample data with no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  await traceAt(page, "AI review");
  for (const [line, category] of [["L1", "robot_kits_parts"], ["L2", "classroom_supplies"], ["L3", "participant_meals"]]) {
    await page.getByLabel(`Category for ${line}`, { exact: true }).selectOption(category!); await page.getByLabel(`Reason for manual choice ${line}`, { exact: true }).fill("Checked this fictional receipt directly");
  }
  await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await traceAt(page, "Fund split"); await page.getByRole("link", { name: "Continue to funding", exact: true }).click();
  const claim = page.url(); await expect(journey).toContainText("Check the split, then freeze these terms."); await fits(page);
  await compactJourney(page);
  await journey.getByText("Step details and roles", { exact: true }).click();
  await expect(journey.getByText(/Freezing holds the eligible funds/)).toBeVisible();
  await journey.getByText("Step details and roles", { exact: true }).click();
  await page.getByRole("button", { name: "Freeze allocation for approval", exact: true }).click();
  // IAC-415 PR 4: the claimant on her own awaiting claim reads "Waiting for two approvers." (the approver wording moved to the approvers).
  await traceAt(page, "Approvals"); await expect(journey).toContainText("Waiting for two approvers.");
  await expect(page.getByRole("button", { name: "Approve these terms", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).click(); await login(page, "tara"); await page.goto(claim);
  // IAC-415 PR 4: the count lives in the title and the approvals section only, so the Journey title is the instruction alone.
  await expect(journey).toContainText("Review the frozen terms."); await expect(journey).not.toContainText(/of 2/);
  await page.getByRole("button", { name: "Approve these terms", exact: true }).click();
  await expect(journey).toContainText("Hand this claim to a different approver.");
  await expect(page.getByRole("button", { name: /Send .* with PayPal/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).click(); await login(page, "ben"); await page.goto(claim);
  await expect(journey).toContainText("Review the frozen terms."); await expect(journey).not.toContainText(/of 2/);
  await page.getByRole("button", { name: "Approve these terms", exact: true }).click();
  await traceAt(page, "PayPal payout"); await expect(journey).toHaveCount(0); await expect(page.locator(".paypal-card")).toContainText("Approved does not mean paid."); await fits(page);
  await compactTop(page);
  await page.getByRole("link", { name: "Review receipt and confirmed categories", exact: true }).click();
  await traceAt(page, "PayPal payout"); await expect(journey).not.toContainText("freeze the terms for two human approvers");
  await expect(journey.getByRole("link", { name: "Continue to funding", exact: true })).toHaveCount(0);
  await journey.getByRole("link", { name: "View current claim", exact: true }).click();
  await expect(page).toHaveURL(claim); await expect(journey).toHaveCount(0); await expect(page.locator(".paypal-card")).toContainText("Approved does not mean paid.");
  expect(await connection.db.select().from(s.approvals)).toHaveLength(2);
  expect(await connection.db.select().from(s.disbursementAttempts)).toHaveLength(0);
  expect(await connection.db.select().from(s.disbursements)).toHaveLength(0);
  // Presentation fixtures only: no provider call or fabricated payment attempt.
  for (const status of ["PAYOUT_PROCESSING", "PAYOUT_ISSUE"] as const) {
    await connection.db.update(s.claims).set({ status }).where(eq(s.claims.id, "C-104"));
    await page.goto("/claims/C-104");
    await expect(page.locator(".journey-help")).not.toHaveAttribute("open");
    await expect(page.locator(".journey-critical")).toBeVisible();
    await expect(page.locator(".journey-critical")).toContainText(status === "PAYOUT_ISSUE" ? "Unknown outcomes need manual reconciliation" : "not proof of payment");
  }
  expect(await connection.db.select().from(s.disbursementAttempts)).toHaveLength(0);
});
