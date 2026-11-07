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
import { centerOverflow, measureEdge, measureFilters, MIN_FILTER_INPUT } from "./grid-edge";

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
  await login(page, "maria"); await page.getByRole("link", { name: "Start an expense", exact: true }).click();
  await page.getByLabel("This receipt holds no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
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
    await test.step("HP-02 the empty-queue approver home has no empty band under the lede and keeps its fund rail", async () => {
      const lede = await page.locator(".home-head-text .reference-intro").first().boundingBox(), next = await page.locator(".home-main > :not(.home-head-text)").first().boundingBox();
      expect(next!.y - (lede!.y + lede!.height), "lede to the next block").toBeGreaterThanOrEqual(0); expect(next!.y - (lede!.y + lede!.height), "lede to the next block").toBeLessThanOrEqual(48);
      // Unchanged by the polish: the meters stay in one white panel in the right rail, beside the head text, and the main column is not stretched across it.
      const head = await page.locator(".home-head-text").boundingBox(), rail = await page.locator('[aria-label="Fund balances"]').boundingBox();
      expect(rail!.x).toBeGreaterThan(head!.x + head!.width - 1);
      expect(await style(page, '[aria-label="Fund balances"]', "background-color")).toBe("rgb(255, 255, 255)");
      expect(await style(page, '[data-testid="fund-meter"]', "background-color")).toBe("rgba(0, 0, 0, 0)");
      await expect(page.getByTestId("fund-meter").first()).toBeVisible();
      if (process.env.AQ_STILLS) { mkdirSync(process.env.AQ_STILLS, { recursive: true }); await page.screenshot({ path: `${process.env.AQ_STILLS}/hp-empty-1440.png`, fullPage: true }); }
    });
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
      const frame = await page.locator(".aq-queue .gx-frame").boundingBox(); expect(frame!.height).toBeLessThan(360); expect(frame!.height).toBeGreaterThan(140);
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
      // Wide layout (desktop polish, HP-01): the head text, the fund meters and the queue are three full-width rows, in that order, so nothing sits in a rail beside the head text.
      const queue = await page.getByTestId("aq-queue").boundingBox(); const funds = await page.locator(".funds").boundingBox(); const head = await page.locator(".home-head-text").boundingBox();
      expect(queue!.width).toBeGreaterThan(900); expect(funds!.y).toBeGreaterThanOrEqual(head!.y + head!.height - 1); expect(queue!.y).toBeGreaterThanOrEqual(funds!.y + funds!.height - 1);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      if (process.env.AQ_STILLS) { mkdirSync(process.env.AQ_STILLS, { recursive: true }); await page.screenshot({ path: `${process.env.AQ_STILLS}/approver-queue-1440.png`, fullPage: true }); }
    });

    await row.getByRole("link", { name: /^Review / }).click();
    await expect(page).toHaveURL(new RegExp(`${claimPath}$`));
    await expect(page.getByRole("button", { name: "Approve these terms", exact: true })).toBeVisible();
  });

  // Desktop polish (docs/ASSUMPTIONS.md section 74, GATE_REPORT section 62): geometry of the approver home in the real flow, as the second approver with one queued claim.
  const boxOf = async (page: Page, selector: string) => { const found = await page.locator(selector).first().boundingBox(); expect(found, selector).not.toBeNull(); return found!; };
  const hpStill = async (page: Page, name: string) => { if (process.env.AQ_STILLS) { mkdirSync(process.env.AQ_STILLS, { recursive: true }); await page.screenshot({ path: `${process.env.AQ_STILLS}/${name}.png`, fullPage: true }); } };
  await test.step("HP-01 the approver home with a queued claim has no empty band at 1440 and 1280, and the queue keeps the whole column with all seven columns", async () => {
    for (const [width, height] of [[1440, 900], [1280, 800]] as const) {
      await page.setViewportSize({ width, height }); await page.goto("/");
      await expect(dataRows(page)).toHaveCount(1); await expect(page.getByTestId("fund-meter").first()).toBeVisible();
      const lede = await boxOf(page, ".home-head-text .reference-intro"), funds = await boxOf(page, '[aria-label="Fund balances"]'), queue = await boxOf(page, '[data-testid="aq-queue"]'), column = await boxOf(page, ".reference-screen.home-grid");
      // No empty band: the next block starts within 48 px of the bottom of the lede, and the queue within 48 px of the meters.
      const bandUnderLede = funds.y - (lede.y + lede.height), bandUnderMeters = queue.y - (funds.y + funds.height);
      expect(bandUnderLede, `${width}: lede to fund meters`).toBeGreaterThanOrEqual(0); expect(bandUnderLede, `${width}: lede to fund meters`).toBeLessThanOrEqual(48);
      expect(bandUnderMeters, `${width}: fund meters to queue`).toBeGreaterThanOrEqual(0); expect(bandUnderMeters, `${width}: fund meters to queue`).toBeLessThanOrEqual(48);
      // The meters and the queue are as wide as the content column.
      expect(Math.abs(funds.width - column.width), `${width}: meters width`).toBeLessThanOrEqual(1); expect(Math.abs(queue.width - column.width), `${width}: queue width`).toBeLessThanOrEqual(1);
      // One horizontal row of white 14 px panels. An unstyled page keeps the rail's block layout, with a transparent meter and a square corner, and fails here.
      const meters = await page.getByTestId("fund-meter").evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); const computed = getComputedStyle(node); return { top: Math.round(rect.top), bottom: rect.bottom, background: computed.backgroundColor, radius: computed.borderTopLeftRadius }; }));
      expect(meters.length).toBeGreaterThanOrEqual(2);
      expect(new Set(meters.map(meter => meter.top)).size, `${width}: one row`).toBe(1);
      for (const meter of meters) { expect(meter.background).toBe("rgb(255, 255, 255)"); expect(meter.radius).toBe("14px"); expect(meter.bottom, `${width}: meter above the fold`).toBeLessThanOrEqual(height); }
      expect(await style(page, '[aria-label="Fund balances"]', "background-color")).toBe("rgba(0, 0, 0, 0)");
      expect(await style(page, '[aria-label="Fund balances"]', "display")).toBe("grid");
      // auto-fit keeps an empty track at 0px in the computed value (four tracks fit at 1440, three meters fill three), so count the tracks with width.
      expect((await style(page, '[aria-label="Fund balances"]', "grid-template-columns")).split(" ").filter(track => track !== "0px").length).toBe(meters.length);
      // The rules link of each restricted fund is visible above the fold too.
      const links = page.getByTestId("fund-rules-link"); expect(await links.count()).toBeGreaterThanOrEqual(1);
      for (const link of await links.all()) { await expect(link).toBeVisible(); const found = await link.boundingBox(); expect(found!.y + found!.height, `${width}: rules link above the fold`).toBeLessThanOrEqual(height); }
      // All seven columns, no sideways scroll inside the grid or on the page.
      expect(await headerIds(page)).toEqual(["claimant", "vendor", "approvals", "amountCents", "approvalCount", "waitingSince", "href"]);
      await expect(page.locator(".aq-queue .ag-body-horizontal-scroll-viewport")).toHaveCount(1);
      expect(await page.evaluate(() => { const viewport = document.querySelector(".aq-queue .ag-body-horizontal-scroll-viewport")!; return viewport.scrollWidth - viewport.clientWidth; }), `${width}: grid scrolls sideways`).toBeLessThanOrEqual(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: page scrolls sideways`).toBe(true);
      const frameBox = await boxOf(page, ".aq-queue .gx-frame"), reviewHeader = await boxOf(page, '[role="columnheader"][col-id="href"]');
      expect(reviewHeader.x + reviewHeader.width, `${width}: Review header inside the frame`).toBeLessThanOrEqual(frameBox.x + frameBox.width + 1);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await hpStill(page, `hp-queued-${width}`);
    }
  });

  await test.step("HP-10 the queue frame fits one row: no empty row under it, and a filter that hides the row still shows the empty message inside the frame", async () => {
    await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/");
    await expect(dataRows(page)).toHaveCount(1);
    const frame = await boxOf(page, ".aq-queue .gx-frame"), data = await boxOf(page, '.aq-queue .ag-row[row-id]:not(.ag-row-pinned)');
    // Header, filter row, one row and 18 px: 44 * 3 + 18. The old frame kept room for two rows and left an empty one (194 px).
    expect(Math.abs(frame.height - 150), "frame height").toBeLessThanOrEqual(1);
    expect(frame.y + frame.height - (data.y + data.height), "room under the only row").toBeLessThanOrEqual(24);
    expect(data.y + data.height, "row inside the frame").toBeLessThanOrEqual(frame.y + frame.height);
    await page.getByLabel("Search this table").fill("no vendor has this name");
    await expect(page.getByTestId("gx-status")).toHaveText("Showing 0 of 1"); await expect(dataRows(page)).toHaveCount(0);
    const overlay = page.locator(".aq-queue .ag-overlay-no-matching-rows-center").first(); await expect(overlay).toBeVisible();
    const message = await overlay.boundingBox();
    expect(message!.y, "empty message top").toBeGreaterThanOrEqual(frame.y); expect(message!.y + message!.height, "empty message bottom").toBeLessThanOrEqual(frame.y + frame.height);
    await hpStill(page, "hp-queued-filtered-1440");
  });

  await test.step("GE-15 at 1440 the queue's floating filter inputs are wide enough, no column crosses the frame edge, no sideways cue shows, and the filtered copy is the house text", async () => {
    await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/");
    await expect(dataRows(page)).toHaveCount(1);
    await expect(page.locator(".aq-queue .ag-floating-filter button[aria-label='Open Filter Menu']:visible")).toHaveCount(0);
    const filters = (await measureFilters(page)).inputs;
    expect(filters.length, "the queue's filterable columns").toBeGreaterThanOrEqual(3);
    for (const item of filters) {
      if (item.kind === "date") expect(item.width, `${item.id} date input`).toBeGreaterThanOrEqual(item.needs);
      else expect(item.width, `${item.id} input`).toBeGreaterThanOrEqual(MIN_FILTER_INPUT);
    }
    const report = await measureEdge(page, []);
    expect(report.crossing).toEqual([]); expect(report.checked.headers).toBeGreaterThanOrEqual(5);
    // The queue's flex columns fit the frame, so nothing scrolls sideways and the status line carries no cue.
    expect((await centerOverflow(page)).overflows).toBe(false);
    await expect(page.getByTestId("gx-more-columns")).toHaveCount(0);
    await page.getByLabel("Search this table").fill("no vendor has this name");
    await expect(page.locator(".aq-queue .ag-overlay-no-matching-rows-center").first()).toHaveText("No queued claims match this search or filter.");
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
    await test.step("HP-03 on a phone the order is still the head text, the fund meters in one panel, then the queue", async () => {
      const head = await page.locator(".home-head-text").boundingBox(), funds = await page.locator('[aria-label="Fund balances"]').boundingBox(), queue = await page.getByTestId("aq-queue").boundingBox();
      expect(funds!.y).toBeGreaterThanOrEqual(head!.y + head!.height - 1); expect(queue!.y).toBeGreaterThanOrEqual(funds!.y + funds!.height - 1);
      expect(await style(page, '[aria-label="Fund balances"]', "background-color")).toBe("rgb(255, 255, 255)");
      expect(await style(page, '[data-testid="fund-meter"]', "background-color")).toBe("rgba(0, 0, 0, 0)");
      expect(Math.abs(funds!.width - queue!.width)).toBeLessThanOrEqual(1);
    });
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
