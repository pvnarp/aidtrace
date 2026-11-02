import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";
import * as s from "../db/schema";

// IAC-414 Q1 (docs/plans/GRID_SURFACES_SCOPE.md section 3.2 step A), tests AQ-21 to AQ-25. The real flow in an isolated database and server: Maria submits and freezes
// a practice expense, Tara approves it once, and Ben then sees it in the queue as "Approvals: 1 of 2". AI is off and no provider request is made. Every approval below
// is a person's click on the claim page; the grid has no approve control.
let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof connectDatabase>;
let server: ChildProcess | undefined, name: string;
let passwords: Record<"maria" | "tara" | "ben", string>;
test.beforeEach(async () => {
  if (process.env.UI_TEST_CONTAINER !== "true") throw Error("Use isolated OrbStack browser service");
  const url = new URL(process.env.DATABASE_URL!); url.pathname = "/postgres";
  admin = postgres(url.toString(), { max: 1 }); name = "aidtrace_aq_" + randomBytes(6).toString("hex");
  await admin`create database ${admin(name)}`; url.pathname = "/" + name;
  connection = connectDatabase(url.toString()); await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "queue@example.invalid", payeeAllowlist: ["queue@example.invalid"] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AI_RECEIPT_ENABLED: "false", AI_EXPENSE_PROPOSALS_ENABLED: "true", AI_ANALYTICS_ENABLED: "false", PAYPAL_SANDBOX_PAYEE_EMAIL: "queue@example.invalid", PAYEE_ALLOWLIST: "queue@example.invalid", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch("http://127.0.0.1:3100/api/health", { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Wait for this container's server. */ }
    if (server.exitCode !== null) throw Error("Isolated server exited");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error("Server readiness timeout");
});
test.afterEach(async () => {
  if (server?.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* Exited. */ } await Promise.race([new Promise(resolve => server!.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 1500))]); try { process.kill(-server.pid, "SIGKILL"); } catch { /* Gone. */ } }
  await connection?.client.end();
  if (admin && /^aidtrace_aq_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});

async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.pathname === "/");
}
const signOut = async (page: Page) => { await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(/\/login$/); };
const money = (cents: bigint) => `$${(cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${(cents % 100n).toString().padStart(2, "0")}`;
const dataRows = (page: Page) => page.getByTestId("gx-approver-queue").locator(".ag-row[row-id]:not(.ag-row-pinned)");
const headerIds = (page: Page) => page.evaluate(() => [...document.querySelectorAll('[role="columnheader"][col-id]')].map(element => element.getAttribute("col-id")!).filter(id => !/^\d+_\d+$/.test(id)));
const headerNames = (page: Page) => page.evaluate(() => [...document.querySelectorAll('[role="columnheader"][col-id]')].filter(element => !/^\d+_\d+$/.test(element.getAttribute("col-id")!)).map(element => element.querySelector(".ag-header-cell-text")?.textContent ?? ""));
const style = (page: Page, selector: string, property: string) => page.locator(selector).first().evaluate((node, name) => getComputedStyle(node).getPropertyValue(name), property);

/** Maria submits a $6 practice expense, confirms every category by hand and freezes the terms. Returns the claim path. */
async function submitAndFreeze(page: Page) {
  await login(page, "maria"); await page.getByRole("link", { name: "Start a $6 practice expense", exact: true }).click();
  await page.getByLabel("This receipt is sample data with no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  // The form can hydrate while the first choices are typed and reset them, so the choices are set again until all three hold.
  const picks = [["L1", "robot_kits_parts"], ["L2", "classroom_supplies"], ["L3", "participant_meals"]] as const;
  await expect(page.getByText(/Unpaid draft created/)).toBeVisible();
  await expect(async () => {
    for (const [line, category] of picks) { await page.getByLabel(`Category for ${line}`, { exact: true }).selectOption(category); await page.getByLabel(`Reason for manual choice ${line}`, { exact: true }).fill("Checked this receipt directly"); }
    for (const [line, category] of picks) { await expect(page.getByLabel(`Category for ${line}`, { exact: true })).toHaveValue(category); await expect(page.getByLabel(`Reason for manual choice ${line}`, { exact: true })).toHaveValue("Checked this receipt directly"); }
  }).toPass({ timeout: 20000 });
  await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await page.getByRole("link", { name: "Continue to funding", exact: true }).click(); await expect(page.locator(".rh h1")).toBeVisible();
  const path = new URL(page.url()).pathname;
  await page.getByRole("button", { name: "Freeze allocation for approval", exact: true }).click();
  await expect(page.locator("nav[aria-label='Expense trace'] [aria-current=step] .t")).toHaveText("Approvals");
  return path;
}

test("AQ-21 to AQ-25: the approver queue grid in the real flow, wide and on a phone, read only", async ({ page }) => {
  test.setTimeout(240000);
  const seen = { external: 0, errors: [] as string[], writes: [] as string[] };
  page.on("console", message => { if (message.type() === "error" || message.type() === "warning") seen.errors.push(`${message.type()} ${message.text()}`); });
  page.on("request", request => { const path = new URL(request.url()).pathname; if (request.method() !== "GET" && path === "/") seen.writes.push(`${request.method()} ${path}`); });
  await page.route("**/*", route => { const host = new URL(route.request().url()).hostname; if (["127.0.0.1", "localhost"].includes(host)) return route.continue(); seen.external++; return route.abort(); });
  await page.setViewportSize({ width: 1440, height: 900 });

  const claimPath = await submitAndFreeze(page);
  const [claim] = await connection.db.select().from(s.claims).where(eq(s.claims.claimantId, "maria")).then(rows => rows.filter(row => row.id.startsWith("R-")));
  const total = (await connection.db.select().from(s.claimLines).where(eq(s.claimLines.claimId, claim!.id))).filter(line => line.claimVersion === claim!.version).reduce((sum, line) => sum + line.amountCents, 0n);
  expect(claimPath).toBe(`/claims/${claim!.id}`);
  const [maria] = await connection.db.select().from(s.users).where(eq(s.users.id, "maria"));

  await test.step("AQ-22 a claimant sees no queue grid, only their own card", async () => {
    await page.goto("/");
    await expect(page.locator(`article[data-claim="${claim!.id}"]`)).toHaveCount(1);
    await expect(page.getByTestId("gx-approver-queue")).toHaveCount(0); await expect(page.getByTestId("aq-queue")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Awaiting your approval" })).toHaveCount(0); await expect(page.getByRole("grid")).toHaveCount(0);
    await signOut(page);
  });

  await test.step("AQ-23 an approver who approved the claim sees an empty queue, and the claim stays under Other expenses", async () => {
    await login(page, "tara"); await page.goto("/");
    // Before Tara approves, the claim is hers to review: one row.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("One expense needs your review."); await expect(dataRows(page)).toHaveCount(1);
    await expect(dataRows(page).locator('[col-id="approvals"]')).toHaveText("Approvals: 0 of 2");
    await page.goto(claimPath); await page.getByRole("button", { name: "Approve these terms", exact: true }).click();
    await expect(page.locator(".hybrid-review-count")).toContainText("1 of 2");
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("No expense needs your review.");
    await expect(page.getByText("Nothing is waiting for your decision.", { exact: false })).toBeVisible();
    await expect(page.getByTestId("aq-queue")).toHaveCount(0); await expect(page.getByRole("grid")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Other expenses", level: 2 })).toBeVisible();
    await expect(page.locator(".draft-list").getByRole("link").first()).toHaveAttribute("href", claimPath);
    await signOut(page);
  });

  await test.step("AQ-21 the other approver sees the grid with Approvals: 1 of 2, and the Review link opens the claim", async () => {
    await login(page, "ben"); await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("One expense needs your review.");
    await expect(page.getByRole("heading", { name: "Awaiting your approval", level: 2 })).toBeVisible();
    await expect(page.locator("article[data-claim]")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Other expenses", level: 2 })).toHaveCount(0);
    await expect(page.getByRole("grid")).toHaveCount(1); await expect(dataRows(page)).toHaveCount(1);
    expect(await headerIds(page)).toEqual(["claimant", "vendor", "approvals", "amountCents", "approvalCount", "waitingSince", "href"]);
    expect(await headerNames(page)).toEqual(["Claimant", "Vendor", "Status", "Amount", "Progress", "Age", "Review"]);
    const row = dataRows(page);
    await expect(row.locator('[col-id="approvals"]')).toHaveText("Approvals: 1 of 2");
    await expect(row.locator('[col-id="claimant"]')).toHaveText(maria!.displayName);
    await expect(row.locator('[col-id="amountCents"]')).toHaveText(money(total));
    await expect(row.locator('[col-id="vendor"] .aq-vendor-name')).toHaveText(claim!.vendor);
    const funds = (await connection.db.select({ name: s.funds.name }).from(s.funds)).map(fund => fund.name);
    const fundText = (await row.locator('[col-id="vendor"] small').innerText()).trim(); expect(fundText.length).toBeGreaterThan(0);
    for (const part of fundText.split(", ")) expect(funds, `fund ${part}`).toContain(part);
    await expect(row.locator('[col-id="waitingSince"]')).toHaveText(/^(Just now|\d+m)$/);
    // The mini trace: four done, Approvals current, PayPal payout not reached, said in words for a screen reader.
    const dots = row.locator('[col-id="approvalCount"] .aq-mini i'); await expect(dots).toHaveCount(6);
    expect(await dots.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-state")))).toEqual(["done", "done", "done", "done", "current", "future"]);
    await expect(row.getByRole("img")).toHaveAttribute("aria-label", "Step 5 of 6, Approvals. Receipt done, AI review done, Rule checks done, Fund split done, Approvals current, PayPal payout not reached.");
    // Read only: no checkbox, no selection column, no button inside the grid, nothing editable.
    const grid = page.getByTestId("gx-approver-queue");
    await expect(grid.locator('input[type="checkbox"]')).toHaveCount(0); await expect(grid.locator(".ag-selection-checkbox, .ag-checkbox")).toHaveCount(0);
    await expect(row.locator("input, textarea, select, button")).toHaveCount(0);
    await expect(grid.getByRole("button", { name: /approve|reject|pay|send/i })).toHaveCount(0);
    await row.locator('[col-id="claimant"]').dblclick(); await expect(grid.locator(".ag-cell-inline-editing, .ag-cell-edit-wrapper")).toHaveCount(0);
    await expect(page.getByTestId("gx-status")).toHaveText("Showing 1 of 1");

    await test.step("AQ-24 the grid is styled: computed styles of the frame, the dots, the vendor and the link", async () => {
      // An unstyled grid would keep the foundation's 360 px minimum frame, plain dots and no weight on the link.
      expect(await style(page, ".aq-queue .gx-frame", "min-height")).toBe("0px");
      const frame = await page.locator(".aq-queue .gx-frame").boundingBox(); expect(frame!.height).toBeLessThan(360); expect(frame!.height).toBeGreaterThan(150);
      expect(await style(page, '.aq-mini i[data-state="done"]', "background-color")).toBe("rgb(11, 31, 58)");
      expect(await style(page, '.aq-mini i[data-state="future"]', "background-color")).toBe("rgb(255, 255, 255)");
      expect(await style(page, '.aq-mini i[data-state="current"]', "border-top-width")).toBe("3px");
      expect(await style(page, '.aq-mini i[data-state="current"]', "border-top-color")).toBe("rgb(10, 102, 255)");
      // The connector starts at each dot's outer edge, so it never paints over the ring of the current dot (it did once, and the ring read as a C).
      const connector = (state: string) => page.locator(`.aq-mini i[data-state="${state}"]`).first().evaluate(node => getComputedStyle(node, "::after").left);
      expect(await connector("done")).toBe("8px"); expect(await connector("current")).toBe("7px");
      expect(await style(page, ".aq-vendor small", "font-size")).toBe("13px"); expect(await style(page, ".aq-vendor small", "color")).toBe("rgb(91, 107, 128)");
      expect(await style(page, ".aq-review", "font-weight")).toBe("600"); expect(await style(page, ".aq-review", "color")).toBe("rgb(8, 80, 204)");
      const link = await page.locator(".aq-review").first().boundingBox(); expect(link!.width).toBeGreaterThanOrEqual(44); expect(link!.height).toBeGreaterThanOrEqual(40);
      // Wide layout: the queue spans the full width under the head text, with the fund rail kept in the top row to the right.
      const queue = await page.getByTestId("aq-queue").boundingBox(); const funds = await page.locator(".funds").boundingBox(); const head = await page.locator(".home-head-text").boundingBox();
      expect(queue!.width).toBeGreaterThan(900); expect(queue!.y).toBeGreaterThanOrEqual(head!.y + head!.height - 1); expect(funds!.x).toBeGreaterThan(head!.x + head!.width - 1);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      if (process.env.AQ_STILLS) { mkdirSync(process.env.AQ_STILLS, { recursive: true }); await page.screenshot({ path: `${process.env.AQ_STILLS}/approver-queue-1440.png`, fullPage: true }); }
    });

    await row.getByRole("link", { name: /^Review / }).click();
    await expect(page).toHaveURL(new RegExp(`${claimPath}$`));
    await expect(page.getByRole("button", { name: "Approve these terms", exact: true })).toBeVisible();
  });

  await test.step("AQ-25 on a phone the grid keeps vendor, amount and the Review link, and the rest moves under it", async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/");
    await expect(dataRows(page)).toHaveCount(1);
    expect(await headerIds(page)).toEqual(["vendor", "amountCents", "href"]);
    expect(await headerNames(page)).toEqual(["Vendor", "Amount", "Review"]);
    const extras = page.getByTestId("gx-phone-extras"); await expect(extras).toBeVisible();
    await extras.locator("summary").first().click();
    await expect(extras).toContainText(`${claim!.vendor}, Amount ${money(total)}`);
    for (const [label, value] of [["Claimant", maria!.displayName], ["Status", "Approvals: 1 of 2"], ["Progress", "Step 5 of 6, Approvals"]]) await expect(extras.locator("dl > div", { hasText: label! }).first()).toContainText(value!);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.AQ_STILLS) { mkdirSync(process.env.AQ_STILLS, { recursive: true }); await page.screenshot({ path: `${process.env.AQ_STILLS}/approver-queue-390.png`, fullPage: true }); }
    const link = dataRows(page).getByRole("link", { name: /^Review / }); await expect(link).toBeVisible();
    const box = await link.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await link.click(); await expect(page).toHaveURL(new RegExp(`${claimPath}$`));
  });

  // The queue read nothing but the page and changed nothing: Tara's one approval is the only approval, and no payout exists.
  expect(await connection.db.select().from(s.approvals)).toHaveLength(1);
  expect(await connection.db.select().from(s.disbursements)).toHaveLength(0); expect(await connection.db.select().from(s.disbursementAttempts)).toHaveLength(0);
  expect(seen.external).toBe(0); expect(seen.writes).toEqual([]); expect(seen.errors).toEqual([]);
});
