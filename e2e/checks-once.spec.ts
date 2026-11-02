import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Locator, type Page } from "@playwright/test";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";
import * as s from "../db/schema";

// CO-01 to CO-03 (IAC-415 PR 6, "checks read once", docs/GATE_REPORT.md section 53): the Checks panel reads once, a finished preparation does not offer a second run as
// the primary action, and a DRAFT claim page says "0 of 2" once. Every test is self-contained: it starts its own isolated database and next server on 3100, so a failure names
// one fact and a single test can run alone with -g. All at 1440 px. The loopback Claude stub (UI_TEST_CONTAINER sends Claude requests to 127.0.0.1:8080) gives synthetic
// answers: a receipt suggestion request has top-level lines, a compliance request has a fund. They are NOT a real model result, and no Claude or PayPal request leaves the container.
//   CO-01a: Tara's checked claim with stubbed model rows (one CONFLICT fund, one OK fund) and rule Hold rows. CO-01b: the AI-off approved claim page, as Ben.
//   CO-02a: a stubbed preparation that ends NEEDS_REVIEW. CO-02b: READY_FOR_REVIEW, then STALE. CO-03: the seeded DRAFT claim C-104.
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

let admin: ReturnType<typeof postgres> | undefined, connection: ReturnType<typeof connectDatabase> | undefined;
let server: ChildProcess | undefined, model: Server | undefined, name = "";
let passwords: Record<"maria" | "tara" | "ben", string>;
// What the stub answers: conflict makes the Ashmere fund answer CONFLICT, unknown makes every receipt line UNKNOWN (a preparation that ends NEEDS_REVIEW).
let stubMode: { conflict: boolean; unknown: boolean } = { conflict: false, unknown: false };
const STUB_KEY = "sk-ant-api03-UI-STUB-NOT-A-REAL-KEY";
const FLAGS = {
  off: { AI_RECEIPT_ENABLED: "false", AI_EXPENSE_PROPOSALS_ENABLED: "true" },
  claim: { AI_RECEIPT_ENABLED: "true", AI_COMPLIANCE_ENABLED: "true", AI_EXPENSE_PROPOSALS_ENABLED: "false", ANTHROPIC_API_KEY: STUB_KEY },
  proposal: { AI_RECEIPT_ENABLED: "true", AI_EXPENSE_PROPOSALS_ENABLED: "true", ANTHROPIC_API_KEY: STUB_KEY },
} as const;

async function start(ai: keyof typeof FLAGS) {
  if (process.env.UI_TEST_CONTAINER !== "true") throw Error("Use isolated OrbStack browser service");
  const url = new URL(process.env.DATABASE_URL!); url.pathname = "/postgres";
  admin = postgres(url.toString(), { max: 1 }); name = "aidtrace_checksonce_" + randomBytes(6).toString("hex");
  await admin`create database ${admin(name)}`; url.pathname = "/" + name;
  connection = connectDatabase(url.toString()); await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "checks-once@example.invalid", payeeAllowlist: ["checks-once@example.invalid"] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  if (ai !== "off") {
    model = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); const data = JSON.parse(body.messages[0].content);
      const categories = ["robot_kits_parts", "classroom_supplies", "participant_meals"];
      const text = data.fund
        ? JSON.stringify({ lines: data.receipt.lines.map((line: { id: string }) => stubMode.conflict && data.fund.name.startsWith("Ashmere")
          ? { lineId: line.id, verdict: "CONFLICT", clauseId: data.fund.clauses[3].id } : { lineId: line.id, verdict: "OK", clauseId: null }) })
        : JSON.stringify({ proposals: data.lines.map((line: { id: string; description: string }, i: number) => ({ lineId: line.id, category: stubMode.unknown ? "UNKNOWN" : categories[i], quote: stubMode.unknown ? "" : line.description })) });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_ui_stub", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text }], usage: { input_tokens: 812, output_tokens: 57 } }));
    });
    await new Promise<void>(resolve => model!.listen(8080, "0.0.0.0", resolve));
  }
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AIDTRACE_JUDGE_SESSION: "false", ...FLAGS[ai], PAYPAL_SANDBOX_PAYEE_EMAIL: "checks-once@example.invalid", PAYEE_ALLOWLIST: "checks-once@example.invalid", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch("http://127.0.0.1:3100/api/health", { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Wait for this container's server. */ }
    if (server.exitCode !== null) throw Error("Isolated server exited");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error("Server readiness timeout");
}
test.afterEach(async () => {
  if (server?.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* Exited. */ } await Promise.race([new Promise(resolve => server!.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 1500))]); try { process.kill(-server.pid, "SIGKILL"); } catch { /* Exited. */ } }
  server = undefined;
  await connection?.client.end(); connection = undefined;
  model?.closeAllConnections(); if (model) { await new Promise<void>(resolve => model!.close(() => resolve())); model = undefined; }
  if (admin && /^aidtrace_checksonce_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
  admin = undefined; name = ""; stubMode = { conflict: false, unknown: false };
});
async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.pathname === "/");
}
async function logout(page: Page) { await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(url => url.pathname === "/login"); }
const approve = (page: Page) => page.getByRole("button", { name: "Approve these terms", exact: true });
const FOOTER = "Holds do not block approval. Two approvers are still required.";
const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

/** Maria confirms a receipt review by hand or from stubbed suggestions, views the allocation and freezes it. Returns the claim URL. */
async function frozenClaim(page: Page, suggestions: boolean) {
  await login(page, "maria"); await page.getByRole("link", { name: "Start a $6 practice expense", exact: true }).click();
  await page.getByLabel("This receipt is sample data with no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  if (suggestions) { await expect(page.getByRole("status")).toContainText("Unpaid draft created"); await page.getByRole("button", { name: "Request AI suggestions" }).click(); await expect(page.locator(".notice")).toContainText("AI suggestions are ready"); }
  else {
    await expect(page.getByLabel("Category for L1", { exact: true })).toBeVisible();
    for (const [line, category] of [["L1", "robot_kits_parts"], ["L2", "classroom_supplies"], ["L3", "participant_meals"]]) {
      await page.getByLabel(`Category for ${line}`, { exact: true }).selectOption(category!); await page.getByLabel(`Reason for manual choice ${line}`, { exact: true }).fill("Checked this receipt directly");
    }
  }
  await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible();
  await page.getByRole("link", { name: suggestions ? "View allocation" : "Continue to funding", exact: true }).click();
  await expect(page.getByRole("button", { name: "Freeze allocation for approval", exact: true })).toBeVisible(); const claim = page.url();
  await page.getByRole("button", { name: "Freeze allocation for approval", exact: true }).click(); await expect(page.locator(".trace [aria-current=step] .t")).toHaveText("Approvals");
  return claim;
}

/** The headings of the Checks panel: one h2 named Checks, no h2 named Policy checks, and the Policy checks block as an h3 inside the same panel. */
async function oneChecksPanel(page: Page) {
  const h2 = await page.locator("main h2").allInnerTexts();
  expect(h2.filter(text => text.trim() === "Checks"), `main h2 texts ${JSON.stringify(h2)}`).toHaveLength(1);
  expect(h2.filter(text => /policy checks/i.test(text)), "no h2 reads Policy checks").toHaveLength(0);
  await expect(page.getByRole("heading", { level: 2, name: "Checks", exact: true })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Policy checks", exact: true })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 3, name: "Policy checks", exact: true })).toHaveCount(1);
  await expect(page.locator("#rule-checks h3#policy-checks-title")).toHaveCount(1);
  await expect(page.locator("#rule-checks > h2")).toHaveText("Checks");
}

test("CO-01a: Tara's checked claim with stubbed model rows has one Checks h2, 'clear' only in the rule rows and the summary, a summary that names the Hold count, and no 'Flags do not block'", async ({ page }) => {
  test.setTimeout(300000); stubMode = { conflict: true, unknown: false }; await start("claim");
  const claim = await frozenClaim(page, true); await logout(page);
  await login(page, "tara"); await page.goto(claim);
  const section = page.locator("#policy-checks"); await section.getByRole("button", { name: "Run policy checks" }).click();
  await expect(page.getByRole("status")).toContainText("Policy checks ran and are stored"); await expect(section).toContainText("Model status");
  await oneChecksPanel(page);
  // The summary: the clear count the page computed from its rule rows, then the Hold count the stored policy run has. The database is the independent count of that run.
  const rows = page.locator("#rule-checks ul.rules li"); const total = await rows.count(); const clear = await page.locator('#rule-checks ul.rules li[data-state="ok"]').count();
  const stored = await connection!.db.select().from(s.policyCheckResults).where(and(eq(s.policyCheckResults.entry, "FLAG"), eq(s.policyCheckResults.severity, "HOLD")));
  const holds = stored.length; expect(holds, "the stored policy run has Hold flags").toBeGreaterThan(0);
  const shownHolds = await section.locator("ul.reasons li").filter({ hasText: /^Hold: / }).count(); expect(shownHolds, "Hold rows shown beside the summary").toBe(holds);
  const expected = `Rule checks: ${clear} of ${total} clear. ${holds} ${holds === 1 ? "Hold below goes" : "Holds below go"} to the approvers.`;
  const summary = page.locator("#rule-checks > p.sub"); await expect(summary).toHaveText(`${expected} Each row comes from stored data this page loaded.`);
  expect((await summary.innerText()), "the summary never calls a Hold approved, passed or cleared").not.toMatch(/\b(approved|passed|cleared)\b/i);
  // The word clear: only the Clear state word of each rule row and the one in the summary, none in the Policy checks block (rows or footer).
  const text = await page.locator("main").innerText(); const clearWords = count(text, /\bclear\b/gi);
  expect(clearWords, `"clear" in main: ${clear} rule rows plus the summary`).toBe(clear + 1);
  expect(await section.innerText(), "no 'clear' inside the Policy checks block").not.toMatch(/\bclear/i);
  const states = await page.locator("#rule-checks ul.rules .rule-state").allInnerTexts(); expect(states.filter(word => /clear/i.test(word)), "Clear is the state word of the clear rows only").toHaveLength(clear);
  // The footer uses the row label, and the old word is gone from the whole page.
  await expect(section).toContainText(FOOTER); expect(count(await section.innerText(), /Holds do not block approval\./g), "the footer appears once").toBe(1);
  await expect(page.locator("body")).not.toContainText("Flags do not block");
  console.log("CO-01a " + JSON.stringify({ total, clear, holds, clearWords, summary: expected }));
});

test("CO-01b: the AI-off approved claim page, as an approver, keeps its Checks panel and changes only the footer word", async ({ page }) => {
  test.setTimeout(300000); await start("off");
  const claim = await frozenClaim(page, false); await logout(page);
  await login(page, "tara"); await page.goto(claim); await expect(approve(page)).toBeVisible(); await approve(page).click(); await expect(page.locator(".hybrid-review-count")).toContainText("1 of 2"); await logout(page);
  await login(page, "ben"); await page.goto(claim); await expect(approve(page)).toBeVisible(); await approve(page).click(); await expect(page.locator(".hybrid-review-count")).toContainText("2 of 2");
  await page.goto(claim); await expect(page.locator(".hybrid-review-count")).toContainText("2 of 2");
  await oneChecksPanel(page);
  const total = await page.locator("#rule-checks ul.rules li").count(); const clear = await page.locator('#rule-checks ul.rules li[data-state="ok"]').count();
  // No stored policy run exists, so the summary is the count alone. It adds no Hold clause and no other words beyond the provenance sentence it had before.
  await expect(page.locator("#rule-checks > p.sub")).toHaveText(`Rule checks: ${clear} of ${total} clear. Each row comes from stored data this page loaded.`);
  const section = page.locator("#policy-checks"); await expect(section).toContainText("Policy checks have not run for this frozen decision."); await expect(section).toContainText(FOOTER);
  expect(await section.locator("ul.reasons").count(), "no rule rows without a stored run").toBe(0);
  expect(count(await page.locator("main").innerText(), /\bclear\b/gi), `"clear" in main: ${clear} rule rows plus the summary`).toBe(clear + 1);
  await expect(page.locator("body")).not.toContainText("Flags do not block");
  console.log("CO-01b " + JSON.stringify({ total, clear }));
});

type Look = { secondary: boolean; background: string; shadow: string };
/** Class and computed look of one control. Primary is the accent fill with no ring, secondary is the paper fill with an inset ring. */
const look = (locator: Locator): Promise<Look> => locator.evaluate(node => { const style = getComputedStyle(node); return { secondary: node.classList.contains("secondary"), background: style.backgroundColor, shadow: style.boxShadow }; });
/** Move the pointer off every control and let the 0.15 s hover transition finish, so a computed colour is the resting colour. */
async function rest(page: Page) { await page.mouse.move(1, 1); await page.waitForTimeout(400); }
async function expectPrimary(control: Locator, label: string, primary: Look, secondary: Look) {
  const seen = await look(control); expect(seen.secondary, `${label}: class secondary`).toBe(false);
  expect(seen.background, `${label}: resting fill is the primary fill`).toBe(primary.background); expect(seen.background, `${label}: not the secondary fill`).not.toBe(secondary.background); expect(seen.shadow, `${label}: no ring`).toBe(primary.shadow);
}
async function expectSecondary(control: Locator, label: string, primary: Look, secondary: Look) {
  const seen = await look(control); expect(seen.secondary, `${label}: class secondary`).toBe(true);
  expect(seen.background, `${label}: resting fill is the secondary fill`).toBe(secondary.background); expect(seen.background, `${label}: not the primary fill`).not.toBe(primary.background); expect(seen.shadow, `${label}: ring`).not.toBe("none");
}
const PREPARE = "Prepare expense proposal";
async function newReceipt(page: Page) {
  await login(page, "maria"); await page.goto("/receipts/new");
  await page.getByLabel("This receipt is sample data with no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Prepare this expense for review", exact: true })).toBeVisible();
}
/** The panel's resting looks. The class-less Confirm categories button is the primary reference. The Edit receipt summary is not used: the secondary reference is read from the NOT_STARTED link. */
async function references(page: Page) {
  await rest(page); const primary = await look(page.getByRole("button", { name: "Confirm categories", exact: true }));
  const secondary = await look(page.locator('.proposal-panel a[href="#category-review"]'));
  expect(primary.secondary, "reference primary").toBe(false); expect(secondary.secondary, "reference secondary").toBe(true); expect(primary.background, "the two looks differ").not.toBe(secondary.background);
  return { primary, secondary };
}

test("CO-02a: before preparation 'Prepare expense proposal' is primary, and after a preparation that ends NEEDS_REVIEW it is gone: 'Run preparation again' is secondary and once, and the primary link goes to #category-review", async ({ page }) => {
  test.setTimeout(300000); stubMode = { conflict: false, unknown: true }; await start("proposal");
  await newReceipt(page); const panel = page.locator(".proposal-panel");
  const before = await references(page); const prepare = panel.getByRole("button", { name: PREPARE, exact: true });
  await expect(prepare).toHaveCount(1); await expectPrimary(prepare, "before: Prepare expense proposal", before.primary, before.secondary);
  await expectSecondary(panel.getByRole("link", { name: "Review categories manually", exact: true }), "before: Review categories manually", before.primary, before.secondary);
  expect(await panel.locator("button:not(.secondary), a.button-link:not(.secondary)").count(), "before: one primary control in the panel").toBe(1);
  await expect(prepare).toBeEnabled(); await prepare.click();
  await expect(page.getByRole("heading", { name: "Category review needed", exact: true })).toBeVisible();
  await rest(page); const after = before; // the resting fills are static CSS, so the NOT_STARTED references still apply (the link is primary now, so it cannot be the secondary reference)
  // Nothing on the page says Prepare expense proposal any more: no button, no link, no text.
  await expect(page.getByText(PREPARE)).toHaveCount(0); await expect(page.getByRole("button", { name: PREPARE })).toHaveCount(0);
  expect(count(await page.locator("main").innerText(), /Prepare expense proposal/g), "the label in main text").toBe(0);
  // The repeat is one button, secondary, with the new label.
  const again = panel.getByRole("button", { name: "Run preparation again", exact: true });
  await expect(again).toHaveCount(1); await expect(page.getByText("Run preparation again")).toHaveCount(1); await expect(again).toHaveAttribute("type", "submit");
  await expectSecondary(again, "after: Run preparation again", after.primary, after.secondary);
  // The primary control is the link to the unresolved categories, and it is the only primary control in the panel.
  const choose = panel.getByRole("link", { name: "Choose the unresolved categories", exact: true });
  await expect(choose).toHaveCount(1); await expect(choose).toHaveAttribute("href", "#category-review"); await expect(page.locator("#category-review")).toHaveCount(1);
  await expectPrimary(choose, "after: Choose the unresolved categories", after.primary, after.secondary);
  await expect(panel.getByRole("link", { name: "Review categories manually" })).toHaveCount(0);
  expect(await panel.locator("button:not(.secondary), a.button-link:not(.secondary)").allInnerTexts(), "after: the only primary control in the panel").toEqual(["Choose the unresolved categories"]);
  // The repeat is still a working control: enabled, in the same form, with the same action.
  await expect(again).toBeEnabled(); expect(await again.evaluate(node => (node.closest("form") as HTMLFormElement).querySelector<HTMLInputElement>('input[name="action"]')!.value)).toBe("prepare");
  console.log("CO-02a " + JSON.stringify({ before: { primary: before.primary, secondary: before.secondary }, afterAgain: await look(again), afterChoose: await look(choose) }));
});

test("CO-02b: after a READY_FOR_REVIEW preparation and after it goes STALE, 'Refresh funding preview' is secondary and the link to #category-review is primary", async ({ page }) => {
  test.setTimeout(300000); stubMode = { conflict: false, unknown: false }; await start("proposal");
  await newReceipt(page); const panel = page.locator(".proposal-panel"); const base = await references(page);
  await panel.getByRole("button", { name: PREPARE, exact: true }).click(); await expect(page.getByRole("heading", { name: "Provisional funding available", exact: true })).toBeVisible();
  await rest(page); const ready = base;
  await expect(page.getByText(PREPARE)).toHaveCount(0);
  const refresh = panel.getByRole("button", { name: "Refresh funding preview", exact: true }); await expect(refresh).toHaveCount(1); await expectSecondary(refresh, "ready: Refresh funding preview", ready.primary, ready.secondary);
  const review = panel.getByRole("link", { name: "Review suggested categories", exact: true }); await expect(review).toHaveCount(1); await expect(review).toHaveAttribute("href", "#category-review");
  await expectPrimary(review, "ready: Review suggested categories", ready.primary, ready.secondary);
  expect(await panel.locator("button:not(.secondary), a.button-link:not(.secondary)").allInnerTexts(), "ready: the only primary control in the panel").toEqual(["Review suggested categories"]);
  // The funding cap falls to zero after the preparation, so the stored preview is stale (the same change AP-04 makes).
  await connection!.db.update(s.fundBudgetLines).set({ capCents: 0n }); await page.reload();
  await expect(page.getByRole("heading", { name: "Preview needs refreshing", exact: true })).toBeVisible();
  await rest(page); const stale = base;
  await expect(page.getByText(PREPARE)).toHaveCount(0);
  await expectSecondary(panel.getByRole("button", { name: "Refresh funding preview", exact: true }), "stale: Refresh funding preview", stale.primary, stale.secondary);
  const manual = panel.getByRole("link", { name: "Review categories manually", exact: true }); await expect(manual).toHaveCount(1); await expect(manual).toHaveAttribute("href", "#category-review");
  await expectPrimary(manual, "stale: Review categories manually", stale.primary, stale.secondary);
  expect(await panel.locator("button:not(.secondary), a.button-link:not(.secondary)").allInnerTexts(), "stale: the only primary control in the panel").toEqual(["Review categories manually"]);
});

test("CO-03: on the C-104 DRAFT claim page the visible main text says '0 of 2' exactly once, in Human reviews, and the PayPal card reads 'Not ready: needs two approvals'", async ({ page }) => {
  test.setTimeout(300000); await start("off");
  await login(page, "maria"); await page.goto("/claims/C-104");
  await expect(page.locator(".hybrid-review-count")).toContainText("Human reviews: 0 of 2");
  const text = await page.locator("main").innerText(); const matches = text.match(/\b0 of 2\b/g) ?? [];
  expect(matches, `main text "0 of 2" matches`).toHaveLength(1);
  const paypal = page.locator(".paypal-card"); await expect(paypal).toHaveCount(1); await expect(paypal).toContainText("Not ready: needs two approvals"); await expect(paypal).not.toContainText(/\d of 2/);
  await expect(page.getByLabel("PayPal payout status")).toHaveAttribute("data-paypal-state", "not-ready");
  console.log("CO-03 " + JSON.stringify({ zeroOfTwo: matches.length, otherCounts: text.match(/\b\d of 2\b/g) }));
});
