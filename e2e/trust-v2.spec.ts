import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";
import * as s from "../db/schema";

// TV-14 and TV-15 (IAC-415 Trust v2 port PR 2).
// Each test starts its own isolated database and next server on 3100, like journey.spec. AI is off so categories are chosen by a person.
let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof connectDatabase>;
let server: ChildProcess | undefined, name: string;
let passwords: Record<"maria" | "tara" | "ben", string>;
test.beforeEach(async () => {
  if (process.env.UI_TEST_CONTAINER !== "true") throw Error("Use isolated OrbStack browser service");
  const url = new URL(process.env.DATABASE_URL!); url.pathname = "/postgres";
  admin = postgres(url.toString(), { max: 1 }); name = "aidtrace_tv2_" + randomBytes(6).toString("hex");
  await admin`create database ${admin(name)}`; url.pathname = "/" + name;
  connection = connectDatabase(url.toString()); await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "tv2@example.invalid", payeeAllowlist: ["tv2@example.invalid"] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AI_RECEIPT_ENABLED: "false", AI_EXPENSE_PROPOSALS_ENABLED: "true", PAYPAL_SANDBOX_PAYEE_EMAIL: "tv2@example.invalid", PAYEE_ALLOWLIST: "tv2@example.invalid", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
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
  if (admin && /^aidtrace_tv2_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.pathname === "/");
}
async function fits(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
const NAMES = ["Receipt", "AI review", "Rule checks", "Fund split", "Approvals", "PayPal payout"];

test("TV-14: the trace names the saved step for each fixture state, compact at 390 and complete in the accessibility tree", async ({ page }) => {
  const trace = page.getByRole("navigation", { name: "Expense trace" });
  // One check per state: six items, one current step with the expected name, the compact line at 390 and all six names in the accessibility tree.
  const step = async (current: string, position: number) => {
    await expect(trace.locator("li")).toHaveCount(6);
    await expect(trace.locator("[aria-current=step]")).toHaveCount(1);
    await expect(trace.locator("[aria-current=step] .t")).toHaveText(current);
    const tree = await trace.ariaSnapshot(); for (const each of NAMES) expect(tree, `${each} in the accessibility tree`).toContain(each);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".trace-now")).toBeVisible(); await expect(page.locator(".trace-now")).toContainText(`Step ${position} of 6, ${current}`); await fits(page);
    await page.setViewportSize({ width: 1440, height: 900 }); await expect(page.locator(".trace-now")).toBeHidden(); await fits(page);
  };
  // State 1: the receipt text and amounts are being typed.
  await login(page, "maria"); await page.getByRole("link", { name: "Start an expense", exact: true }).click(); await step("Receipt", 1);
  // State 2: an unconfirmed receipt draft is at AI review.
  await page.getByLabel("This receipt holds no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click(); await step("AI review", 2);
  // State 3: confirmed categories, a draft claim at the fund split.
  for (const [line, category] of [["L1", "robot_kits_parts"], ["L2", "classroom_supplies"], ["L3", "participant_meals"]]) {
    await page.getByLabel(`Category for ${line}`, { exact: true }).selectOption(category!); await page.getByLabel(`Reason for manual choice ${line}`, { exact: true }).fill("Checked this fictional receipt directly");
  }
  await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click(); await step("Fund split", 4);
  await page.getByRole("link", { name: "Continue to funding", exact: true }).click(); const claim = page.url(); await step("Fund split", 4);
  // The regrouped claim page: header band, the receipt side left, rule checks, funding review, and the Decision panel right (one column at 390).
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".rh .crumb a")).toHaveAttribute("href", "/"); await expect(page.locator(".rh .state-badge")).toHaveCount(1); await expect(page.locator(".rh .tot")).toContainText("Claim total");
  await expect(page.locator("#funding-review, #approvals, #payment")).toHaveCount(3);
  const [receipt, rules, funding, decision] = await Promise.all([".receipt-panel", ".rules-panel", "#funding-review", ".hybrid-summary.dec"].map(selector => page.locator(selector).boundingBox()));
  expect(receipt!.x + receipt!.width).toBeLessThanOrEqual(decision!.x + 1); expect(rules!.y).toBeGreaterThanOrEqual(receipt!.y + receipt!.height - 1); expect(funding!.y).toBeGreaterThanOrEqual(rules!.y + rules!.height - 1);
  await expect(page.locator("#decision-title")).toHaveText("Decision"); await expect(page.locator("#fund-split-title")).toHaveText("Fund split");
  await page.setViewportSize({ width: 390, height: 844 }); const [phoneReceipt, phoneDecision] = await Promise.all([".receipt-panel", ".hybrid-summary.dec"].map(selector => page.locator(selector).boundingBox()));
  expect(phoneDecision!.y).toBeGreaterThanOrEqual(phoneReceipt!.y + phoneReceipt!.height - 1);
  // State 4: frozen, awaiting two approvals.
  await page.getByRole("button", { name: "Freeze allocation for approval", exact: true }).click(); await step("Approvals", 5);
  // State 5: two different approvers saved, approved and unpaid.
  for (const role of ["tara", "ben"] as const) { await page.getByRole("button", { name: "Sign out", exact: true }).click(); await login(page, role); await page.goto(claim); await page.getByRole("button", { name: "Approve these terms", exact: true }).click(); }
  await step("PayPal payout", 6);
  expect(await connection.db.select().from(s.approvals)).toHaveLength(2); expect(await connection.db.select().from(s.disbursementAttempts)).toHaveLength(0);
  // State 6: a prohibited category blocks Rule checks. Presentation fixture on the seeded draft: only a stored category changes, nothing is posted or approved.
  await connection.db.update(s.claimLines).set({ category: "alcohol", budgetLine: "prohibited" }).where(and(eq(s.claimLines.claimId, "C-104"), eq(s.claimLines.id, "L1")));
  await page.getByRole("button", { name: "Sign out", exact: true }).click(); await login(page, "maria"); await page.goto("/claims/C-104");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Organization policy stops this expense.");
  await expect(trace.locator("li")).toHaveCount(6); await expect(trace.locator("[aria-current=step]")).toHaveCount(0);
  const blocked = trace.locator("li[data-state=blocked]"); await expect(blocked).toHaveCount(1); await expect(blocked.locator(".t")).toHaveText("Rule checks"); await expect(blocked.locator(".d")).toHaveText("Stopped by organization policy");
  const treeBlocked = await trace.ariaSnapshot(); for (const each of NAMES) expect(treeBlocked).toContain(each);
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator(".trace-now")).toContainText("Step 3 of 6, Rule checks"); await fits(page);
  // The verdict row marks the stopped line only, with the block icon and the policy wording. No line is ever called Allowed.
  await expect(page.locator("li[data-line-stop=true]")).toHaveCount(1); await expect(page.locator("li[data-line-stop=true]")).toContainText("L1: Robot kit and parts"); await expect(page.locator("li[data-line-stop=true] .verdict-stop")).toContainText("Not allowed by organization policy.");
  await expect(page.locator(".expense-lines .verdict-stop")).toHaveCount(1);
  await expect(page.locator(".rules li[data-state=stop]").first()).toContainText("Prohibited categories");
  await expect(page.locator(".rules-panel > h2")).toHaveText("Checks"); await expect(page.locator(".rules-panel .lbl")).toHaveCount(0);
  expect(await connection.db.select().from(s.approvals)).toHaveLength(2);
});

const cents = (text: string) => { const negative = text.startsWith("-"); const value = BigInt(text.replace(/[^0-9]/g, "")); return negative ? -value : value; };
type Figures = { book: bigint; reserved: bigint; available: bigint };
/** The meters on the approver home, by fund name. Parsed from the visible sentence and the meter's accessible label. */
async function homeMeters(page: Page): Promise<Map<string, Figures & { percent: number }>> {
  await page.goto("/"); await expect(page.locator("[data-testid=fund-meter]").first()).toBeVisible();
  const out = new Map<string, Figures & { percent: number }>();
  for (const meter of await page.locator("[data-testid=fund-meter]").all()) {
    const fund = (await meter.locator(".fund-r-name").innerText()).trim(); const line = (await meter.locator(".fund-r-line").innerText()).trim();
    const match = /^Available (\S+) of (\S+) book balance, (\S+) reserved$/.exec(line); expect(match, line).not.toBeNull();
    const label = (await meter.locator(".meter").getAttribute("aria-label"))!; const percent = Number(/^(\d+) percent of book balance still available$/.exec(label)![1]); // November 10: the bar shows the available share
    out.set(fund, { available: cents(match![1]!), book: cents(match![2]!), reserved: cents(match![3]!), percent });
  }
  return out;
}
/** The funding widget on /analytics for the same session, by fund name. */
async function analyticsFunds(page: Page): Promise<Map<string, Figures>> {
  await page.goto("/analytics"); const widget = page.getByTestId("funding-widget"); await expect(widget.locator("li").first()).toBeVisible();
  const out = new Map<string, Figures>();
  for (const item of await widget.locator("ul.analytics-funds > li").all()) {
    const fund = (await item.locator("h3").innerText()).trim(); const values = await item.locator("dd").allInnerTexts();
    out.set(fund, { book: cents(values[0]!), reserved: cents(values[1]!), available: cents(values[2]!) });
  }
  return out;
}
async function compareMeters(page: Page) {
  const meters = await homeMeters(page); const analytics = await analyticsFunds(page);
  expect(meters.size).toBeGreaterThan(0); expect([...meters.keys()].sort()).toEqual([...analytics.keys()].sort());
  for (const [fund, meter] of meters) {
    const widget = analytics.get(fund)!;
    expect(meter.book, `${fund} book`).toBe(widget.book); expect(meter.reserved, `${fund} reserved`).toBe(widget.reserved); expect(meter.available, `${fund} available`).toBe(widget.available);
    // The fill is the integer share of book still available (November 10), clamped to 0 through 100, recomputed here from the widget figures.
    const raw = widget.book <= 0n ? 0n : (widget.available * 100n) / widget.book; expect(meter.percent, `${fund} percent`).toBe(Number(raw < 0n ? 0n : raw > 100n ? 100n : raw));
  }
  return meters;
}
/** Maria creates the $6 practice expense, confirms categories by hand and opens its claim. Returns the claim URL. */
async function makeClaim(page: Page) {
  await login(page, "maria"); await page.getByRole("link", { name: "Start an expense", exact: true }).click();
  await page.getByLabel("This receipt holds no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  for (const [line, category] of [["L1", "robot_kits_parts"], ["L2", "classroom_supplies"], ["L3", "participant_meals"]]) {
    await page.getByLabel(`Category for ${line}`, { exact: true }).selectOption(category!); await page.getByLabel(`Reason for manual choice ${line}`, { exact: true }).fill("Checked this fictional receipt directly");
  }
  await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await page.getByRole("link", { name: "Continue to funding", exact: true }).click(); await expect(page.locator(".rh h1")).toBeVisible();
  return page.url();
}
async function noHoldOrAllowed(page: Page) {
  await expect(page.getByRole("button", { name: "Hold for review" })).toHaveCount(0); await expect(page.getByRole("link", { name: "Hold for review" })).toHaveCount(0); await expect(page.getByText("Hold for review")).toHaveCount(0);
  for (const text of await page.locator(".receipt-panel, .rules-panel").allInnerTexts()) expect(text).not.toMatch(/\bAllowed\b/);
}

test("TV-15: honest states on the approver home, the claimant home and the claim page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Approver home with nothing awaiting: the plain headline, no accent word, no mode word, no passed lane, meters equal /analytics.
  await login(page, "tara");
  const before = await compareMeters(page); await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("No expense needs your review."); await expect(page.locator("h1 .act")).toHaveCount(0);
  const text = await page.locator("body").innerText(); expect(text).not.toContain("Passed every check"); expect(text).not.toMatch(/Autopilot|Assisted|Design preview/);
  await expect(page.locator(".funds")).toHaveAttribute("aria-label", "Fund balances");
  // A claimant home has no meters. The claim pages (the typed draft and C-104) have no Hold for review control and no Allowed verdict.
  await page.getByRole("button", { name: "Sign out", exact: true }).click(); const claim = await makeClaim(page);
  await page.goto("/"); await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); await expect(page.locator(".funds")).toHaveCount(0);
  await page.goto(claim); await noHoldOrAllowed(page); await expect(page.locator(".expense-lines .verdict-stop")).toHaveCount(0);
  await page.goto("/claims/C-104"); await noHoldOrAllowed(page); await expect(page.locator(".expense-lines .verdict-stop")).toHaveCount(0);
  // Freeze, then the approver home leads with one accent word and the meters move with the reservation and still equal /analytics.
  await page.goto(claim); await page.getByRole("button", { name: "Freeze allocation for approval", exact: true }).click();
  await expect(page.locator("nav[aria-label='Expense trace'] [aria-current=step] .t")).toHaveText("Approvals"); await noHoldOrAllowed(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click(); await login(page, "tara");
  const after = await compareMeters(page); await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("One expense needs your review."); await expect(page.locator("h1 .act")).toHaveText("One");
  expect([...after.values()].reduce((sum, meter) => sum + meter.reserved, 0n)).toBeGreaterThan([...before.values()].reduce((sum, meter) => sum + meter.reserved, 0n));
  // November 10: the bar shows the available share, so the reservation makes the summed bar widths shrink.
  expect([...after.values()].reduce((sum, meter) => sum + meter.percent, 0)).toBeLessThan([...before.values()].reduce((sum, meter) => sum + meter.percent, 0));
  // IAC-414 Q1: the awaiting claim is a row of the queue grid, once, at Approvals with no approval yet, and its Review link opens the claim.
  await expect(page.locator("article[data-claim]")).toHaveCount(0);
  const queued = page.getByTestId("gx-approver-queue").locator(".ag-row:not(.ag-row-pinned)");
  await expect(queued).toHaveCount(1); await expect(queued.locator('[col-id="approvals"]')).toHaveText("Approvals: 0 of 2");
  await expect(queued.getByRole("img")).toHaveAttribute("aria-label", /^Step 5 of 6, Approvals\./);
  await expect(queued.getByRole("link", { name: /^Review / })).toHaveAttribute("href", new URL(claim).pathname);
  await page.goto(claim); await noHoldOrAllowed(page); await expect(page.getByRole("button", { name: "Approve these terms", exact: true })).toBeVisible();
  expect(await connection.db.select().from(s.approvals)).toHaveLength(0); expect(await connection.db.select().from(s.disbursementAttempts)).toHaveLength(0);
});
