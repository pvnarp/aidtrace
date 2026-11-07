import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { approveDecision, freezeDecision } from "../src/ledger/service";
import { recordDesignatedDonation } from "../src/ledger/donation";
import type { DonationObservation } from "../src/paypal/adapter";

// IAC-379 step 3b: the donor impact note on the claim page. Own database per test and an own `next start` on 3100, as journey.spec.ts does.
// The gift is a stubbed provider observation recorded through the existing ledger path before the server starts. No network, no email.
let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof connectDatabase>;
let server: ChildProcess | undefined, name: string;
let passwords: Record<"maria" | "tara" | "ben", string>;
test.beforeEach(async () => {
  if (process.env.UI_TEST_CONTAINER !== "true") throw Error("Use isolated OrbStack browser service");
  const url = new URL(process.env.DATABASE_URL!); url.pathname = "/postgres";
  admin = postgres(url.toString(), { max: 1 }); name = "aidtrace_note_" + randomBytes(6).toString("hex");
  await admin`create database ${admin(name)}`; url.pathname = "/" + name;
  connection = connectDatabase(url.toString()); await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "note@example.invalid", payeeAllowlist: ["note@example.invalid"] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  const data: DonationObservation = { httpStatus: 200, orderId: "ORDER_E2E_NOTE", intent: "CAPTURE", status: "COMPLETED", units: [{ fundId: "fund_b", amountCents: 2500n }],
    captures: [{ captureId: "CAPTURE_E2E_NOTE", status: "COMPLETED", amountCents: 2500n, grossCents: 2500n, feeCents: 120n, netCents: 2380n, effectiveOn: "2026-10-22" }] };
  await recordDesignatedDonation(connection.db, "tara", { orderId: "ORDER_E2E_NOTE", captureId: "CAPTURE_E2E_NOTE", fundId: "fund_b", amountCents: 2500n }, { donationOrder: async () => data });
  await new Promise(resolve => setTimeout(resolve, 50));
  const frozen = await freezeDecision(connection.db, "C-104", "maria");
  if (frozen.status !== "AWAITING_APPROVAL") throw Error("Expected a funded decision");
  await approveDecision(connection.db, frozen.decisionId, "tara", frozen.decisionHash); await approveDecision(connection.db, frozen.decisionId, "ben", frozen.decisionHash);
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AI_RECEIPT_ENABLED: "false", AI_EXPENSE_PROPOSALS_ENABLED: "true", PAYPAL_SANDBOX_PAYEE_EMAIL: "note@example.invalid", PAYEE_ALLOWLIST: "note@example.invalid", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
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
  if (admin && /^aidtrace_note_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function login(page: Page, user: keyof typeof passwords) {
  await page.context().clearCookies();
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.pathname === "/");
}
const fits = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

test("IAC-379 step 3b: a non-claimant approves the template donor note, it downloads as plain text, and no external request is made", async ({ page }) => {
  const external: string[] = [];
  page.on("request", request => { if (!/^(http:\/\/127\.0\.0\.1:3100\/|data:|blob:)/.test(request.url())) external.push(request.url()); });
  const draft = "Thank you, A donor. Your $25.00 gift was applied to Robot kit and parts from Brightbench Supply Co. Approved by";
  const meta = "$25.00 of the $280.00 line. Gift recorded October 22, 2026. Template, no AI used.";

  // The claimant sees the draft and the label, and no approve button.
  await login(page, "maria"); await page.goto("/claims/C-104");
  const section = page.locator("#donor-notes");
  await expect(section.getByRole("heading", { name: "Donor impact notes", level: 2 })).toBeVisible();
  await expect(section.getByTestId("gift-note-draft")).toContainText(draft);
  await expect(section.getByTestId("gift-note-draft")).toContainText("No payment has been sent in this environment.");
  await expect(section.getByTestId("gift-note-meta")).toHaveText(meta);
  await expect(section.getByTestId("gift-note-intro")).toHaveText("Built from verified records. Approved by someone other than the claimant. Nothing is emailed.");
  await expect(section.getByTestId("gift-note-policy")).toHaveText("Gifts are applied to approved receipt lines, oldest gift first.");
  await expect(section.getByTestId("gift-note-draft")).not.toContainText("PayPal");
  await expect(section.getByRole("button", { name: "Approve this note" })).toHaveCount(0);
  await expect(section).toContainText("An approver who is not the claimant approves this note.");

  // An approver approves it at phone width and again at desktop width for layout.
  for (const width of [375, 1280]) { await page.setViewportSize({ width, height: 900 }); await fits(page); }
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, "ben"); await page.goto("/claims/C-104");
  await expect(section.getByRole("button", { name: "Approve this note" })).toBeVisible();
  await section.getByRole("button", { name: "Approve this note" }).click();
  await expect(page).toHaveURL(/notice=note-approved$/);
  await expect(page.getByText("The donor impact note is approved and saved. Nothing was sent to anyone.")).toBeVisible();
  const approved = page.locator("#donor-notes").getByTestId("gift-note-approved");
  await expect(approved).toHaveCount(1);
  await expect(approved).toContainText(draft);
  await expect(approved.getByTestId("gift-note-meta")).toHaveText(meta);
  await expect(approved.getByTestId("gift-note-audit")).toContainText("Note approved by Ben at");
  await expect(approved).toContainText("Payout status at approval: No payment sent in this environment");
  await expect(approved).not.toContainText("Out of date");
  await expect(page.locator("#donor-notes").getByRole("button", { name: "Approve this note" })).toHaveCount(0);
  for (const width of [375, 1280]) { await page.setViewportSize({ width, height: 900 }); await fits(page); }

  // Plain text download.
  const [download] = await Promise.all([page.waitForEvent("download"), approved.getByRole("link", { name: "Download as plain text" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^aidtrace-impact-note-[a-f0-9]{8}\.txt$/);
  const body = readFileSync((await download.path())!, "utf8");
  expect(body).toContain(draft); expect(body).toContain("No payment has been sent in this environment."); expect(body.endsWith("\nTemplate, no AI used\n")).toBe(true);
  expect(body).not.toMatch(/Paid\./);

  // The claimant sees the approved note read-only.
  await login(page, "maria"); await page.goto("/claims/C-104");
  await expect(page.locator("#donor-notes").getByTestId("gift-note-approved")).toContainText("Note approved by Ben");
  await expect(page.locator("#donor-notes").getByRole("button", { name: "Approve this note" })).toHaveCount(0);
  expect(external).toEqual([]);
});
