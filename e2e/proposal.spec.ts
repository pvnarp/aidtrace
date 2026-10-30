import { randomBytes, createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import * as s from "../db/schema";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { createReceiptDraft, readReceiptView, suggestionHash } from "../src/receipt/service";
import { readExpenseProposal, prepareExpenseProposal } from "../src/proposal/service";
import { ReceiptAiError } from "../src/ai/receipt";
const actual = process.env.PROPOSAL_ACTUAL_UI === "true";
let admin: ReturnType<typeof postgres>; let connection: ReturnType<typeof connectDatabase>; let server: ChildProcess | undefined; let model: Server | undefined; let name: string;
let passwords: Record<"maria" | "tara" | "ben", string>; let mode: "ready" | "unknown" | "alcohol" | "unavailable" = "ready"; let calls = 0; let gate: Promise<void> | undefined;
test.beforeEach(async ({}, testInfo) => {
  if (process.env.UI_TEST_CONTAINER !== "true") throw new Error("Use the isolated OrbStack browser service");
  name = `aidtrace_iac245_ui_${randomBytes(6).toString("hex")}`;
  const adminUrl = new URL(process.env.DATABASE_URL!); adminUrl.pathname = "/postgres";
  admin = postgres(adminUrl.toString(), { max: 1 }); await admin`create database ${admin(name)}`;
  const url = new URL(adminUrl); url.pathname = `/${name}`; connection = connectDatabase(url.toString()); await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "review@example.invalid", payeeAllowlist: ["review@example.invalid"] });
  mode = "ready"; calls = 0; gate = undefined;
  if (!actual) {
    model = createServer(async (request, response) => {
      calls++; await gate;
      if (mode === "unavailable") { response.writeHead(503).end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString());
      const data = JSON.parse(body.messages[1].content);
      const categories = ["science_kits", "notebooks", "hospitality"];
      const content = JSON.stringify({ proposals: data.lines.map((line: { id: string; description: string }, i: number) => ({ lineId: line.id, category: mode === "unknown" ? "UNKNOWN" : mode === "alcohol" ? "alcohol" : categories[i], quote: mode === "unknown" ? "" : line.description })) });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model: "aidtrace-category-qwen3", choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] }));
    });
    await new Promise<void>(resolve => model!.listen(8080, "0.0.0.0", resolve));
  }
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AIDTRACE_JUDGE_SESSION: testInfo.title.startsWith("JUDGE") ? "true" : "false", AI_RECEIPT_ENABLED: testInfo.title.includes("AI disabled") ? "false" : "true", AI_EXPENSE_PROPOSALS_ENABLED: "true", PAYPAL_SANDBOX_PAYEE_EMAIL: "review@example.invalid", PAYEE_ALLOWLIST: "review@example.invalid", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch("http://127.0.0.1:3100/api/health", { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Isolated readiness only. */ }
    if (server.exitCode !== null) throw new Error("Private review server exited"); await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Private review server timed out");
});
test.afterEach(async () => {
  if (server?.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* Already stopped. */ } await Promise.race([new Promise(resolve => server!.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 1500))]); try { process.kill(-server.pid, "SIGKILL"); } catch { /* Already stopped. */ } }
  model?.closeAllConnections(); if (model) { await new Promise<void>(resolve => model!.close(() => resolve())); model = undefined; }
  await connection?.client.end(); if (admin && /^aidtrace_iac245_ui_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.pathname === "/");
}
async function create(page: Page, wine = false) {
  await login(page, "maria"); await page.goto("/receipts/new");
  if (wine) {
    await page.getByLabel("Description 1", { exact: true }).fill("Wine"); await page.getByLabel("USD amount 1", { exact: true }).fill("1.00");
    for (const i of [2, 3]) { await page.getByLabel(`Description ${i}`, { exact: true }).fill(""); await page.getByLabel(`USD amount ${i}`, { exact: true }).fill(""); }
    await page.getByLabel("Receipt total in USD").fill("1.00"); await page.getByLabel("Invented receipt text").fill("Wine");
  }
  await page.getByLabel("This receipt is fictional sandbox data.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click(); await expect(page.getByRole("heading", { name: "Prepare this expense for review", exact: true })).toBeVisible();
  return page.url().split("?")[0]!;
}
async function noOverflow(page: Page) {
  const width = page.viewportSize()!.width;
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const control of await page.locator("button,input,select,textarea").all()) { if (!await control.isVisible()) continue; const box = await control.boundingBox(); if (box) { expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width); } }
}
async function financial() {
  const hash = createHash("sha256");
  for (const table of ["claims", "claim_lines", "fund_credits", "fund_debits", "allocation_decisions", "allocation_edges", "fund_reservations", "reservation_budget_lines", "approvals", "journal_entries", "journal_postings", "disbursements", "disbursement_attempts", "donation_receipts", "retry_authorizations", "provider_events", "receipt_confirmations"]) {
    const rows = await connection.client`select to_jsonb(r)::text as row from ${connection.client(table)} r order by (to_jsonb(r)::text) collate "C"`; hash.update(table).update(JSON.stringify(rows));
  }
  return hash.digest("hex");
}
test.describe("Synthetic response interface checks", () => {
  test.skip(actual, "Separate actual-model run");
  test("FONT-04: local font renders offline with tabular amounts and a usable blocked-font fallback", async ({ page, browser }) => {
    await page.route("**/*", async route => {
      expect(new URL(route.request().url()).hostname).toBe("127.0.0.1");
      await route.continue();
    });
    const fontResponse = page.waitForResponse(response => /\.woff2(?:\?|$)/.test(response.url()) && response.ok());
    await page.goto("/login");
    expect(createHash("sha256").update(await (await fontResponse).body()).digest("hex")).toBe("693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3");
    await login(page, "maria");
    await page.evaluate(() => document.fonts.ready);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const doc = await cdp.send("DOM.getDocument");
    const node = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "h1" });
    const rendered = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: node.nodeId });
    expect(rendered.fonts.some(font => font.isCustomFont && /Inter/.test(font.familyName))).toBe(true);
    const widths = await page.evaluate(() => {
      const sample = document.createElement("span"); sample.style.cssText = "font-size:24px;position:absolute;visibility:hidden";
      document.body.append(sample); sample.textContent = "$111.11"; const ones = sample.getBoundingClientRect().width;
      sample.textContent = "$888.88"; const eights = sample.getBoundingClientRect().width;
      const numeric = getComputedStyle(sample).fontVariantNumeric, family = getComputedStyle(sample).fontFamily;
      sample.remove(); return { ones, eights, numeric, family };
    });
    console.log(JSON.stringify({ check: "loaded local font and numeric layout", widths, renderedFonts: rendered.fonts }));
    expect(Math.abs(widths.ones - widths.eights)).toBeLessThan(0.1);
    for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 900 }); await noOverflow(page); }
    const fallback = await browser.newContext({ baseURL: "http://127.0.0.1:3100", viewport: { width: 390, height: 844 } });
    try {
      await fallback.route("**/*", async route => {
        expect(new URL(route.request().url()).hostname).toBe("127.0.0.1");
        if (/\.woff2(?:\?|$)/.test(route.request().url())) await route.abort(); else await route.continue();
      });
      const other = await fallback.newPage(); await login(other, "maria"); await other.evaluate(() => document.fonts.ready);
      await expect(other.getByRole("heading", { level: 1 })).toBeVisible(); await noOverflow(other);
      const status = await other.evaluate(() => Array.from(document.fonts).filter(face => /inter/i.test(face.family)).map(face => face.status));
      expect(status).toContain("error");
      await other.goto("/receipts/new"); await other.getByLabel("Fictional vendor").fill("Font fallback remains editable");
      await expect(other.getByLabel("Fictional vendor")).toHaveValue("Font fallback remains editable"); await noOverflow(other);
    } finally { await fallback.close(); }
    expect(calls).toBe(0);
  });
  test("IAC-366: HTML-shaped source remains text in grounded highlights", async ({ page }) => {
    await login(page, "maria"); await page.goto("/receipts/new");
    const literal = '<img src="/never-load" onerror="window.__receiptInjection=1">';
    await page.getByLabel("Description 1", { exact: true }).fill(literal);
    await page.getByLabel("Invented receipt text").fill(literal + "\nBlank writing notebook\nSandwiches and apple juice");
    await page.getByLabel("This receipt is fictional sandbox data.").check();
    const unexpected: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname === "/never-load") unexpected.push(request.url()); });
    await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
    const before = await financial();
    await page.getByRole("button", { name: "Prepare expense proposal", exact: true }).click();
    await expect(page.locator(".receipt-source mark")).toHaveCount(3);
    await expect(page.locator("#receipt-source-L1")).toHaveText(literal);
    await expect(page.locator(".receipt-evidence img")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__receiptInjection)).toBeUndefined();
    expect(unexpected).toEqual([]); expect(await financial()).toBe(before);
  });
  test("AP-10: the unsubmitted receipt form remains stable while idle", async ({ page }) => {
    await login(page, "maria"); await page.goto("/receipts/new");
    await page.getByLabel("Fictional vendor").fill("Unsubmitted stability fixture");
    let reloads = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === "/receipts/new") reloads++; });
    await new Promise(resolve => setTimeout(resolve, 15000));
    await expect(page.getByLabel("Fictional vendor")).toHaveValue("Unsubmitted stability fixture");
    expect(reloads).toBe(0); expect(calls).toBe(0);
    expect(await connection.db.select().from(s.receiptReviews)).toHaveLength(0);
    expect(await connection.db.select().from(s.disbursements)).toHaveLength(0); await noOverflow(page);
  });
  test("AP-08: provisional review stays separate from claimant confirmation and both approvals", async ({ page }) => {
    const receipt = await create(page); expect(calls).toBe(0); const before = await financial(); await noOverflow(page);
    await page.getByRole("button", { name: "Prepare expense proposal", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Provisional funding available", exact: true })).toBeVisible();
    await expect(page.locator(".proposal-split")).toHaveText("$5.00 from restricted funds, $1.00 from General."); await page.getByText("How this proposal was prepared", { exact: true }).click(); await expect(page.getByRole("list", { name: "Preparation steps" })).toBeVisible();
    expect(await financial()).toBe(before); expect(calls).toBe(1); await expect(page.locator("blockquote")).toHaveCount(3); await noOverflow(page);
    await expect(page.locator(".receipt-source mark")).toHaveCount(3);
    await page.getByRole("link", { name: "See quote in receipt", exact: true }).first().click();
    await expect(page.locator("#receipt-source-L1")).toBeInViewport();
    await expect(page.locator("#receipt-source-L1")).toHaveText("Science experiment kit");
    await page.getByRole("button", { name: "Confirm categories", exact: true }).click(); expect(await page.getByLabel(/I checked every category/).evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
    await page.getByLabel("Category for L1", { exact: true }).selectOption("notebooks"); await page.getByLabel("Reason for manual choice L1", { exact: true }).fill("Human correction for this fixture");
    await expect(page.locator(".proposal-split")).toHaveCount(0); await expect(page.getByRole("button", { name: "Refresh funding preview" })).toBeDisabled();
    await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click(); await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible();
    await page.getByRole("link", { name: "View allocation", exact: true }).click(); await expect(page.getByRole("button", { name: "Freeze allocation for approval" })).toBeVisible();
    await expect(page.getByText(/Opening journals have not been created yet/)).toBeVisible();
    await expect(page.getByText(/less General than this comparison/)).toHaveCount(0);
    await page.getByRole("button", { name: "Freeze allocation for approval" }).click(); await expect(page.getByText("The allocation is frozen.", { exact: false })).toBeVisible();
    await expect(page.getByText("Ledger tie-out: Matches.", { exact: true })).toBeVisible();
    await expect(page.locator(".expense-review")).toContainText("Human correction for this fixture");
    await expect(page.locator(".expense-review")).toContainText("Original AI suggestion: Science kits");
    await expect(page.locator(".recipient-review")).toHaveCount(0);
    const claimUrl = receipt.replace(/\/receipt$/, "");
    await page.getByRole("button", { name: "Sign out" }).click(); await login(page, "tara"); await page.goto(claimUrl);
    await expect(page.locator(".expense-review")).toContainText("L1: Science experiment kit");
    await expect(page.locator(".expense-review")).toContainText("Claimant made a manual category choice");
    await expect(page.locator(".expense-review")).toContainText("Claimant accepted an AI category suggestion");
    await page.getByText("Review exact sandbox recipient", { exact: true }).click();
    await expect(page.locator(".recipient-review")).toContainText("review@example.invalid"); await noOverflow(page);
    await page.getByRole("button", { name: "Approve these terms", exact: true }).click();
    await expect(page.getByText("A different approver is still required.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click(); await login(page, "ben"); await page.goto(claimUrl); await page.getByRole("button", { name: "Approve these terms", exact: true }).click();
    await expect(page.getByText("Both approvals are complete.", { exact: false })).toBeVisible();
    await expect(page.getByText("Organization-wide open payable: $6.00.", { exact: false })).toBeVisible();
    expect(await connection.db.select().from(s.approvals)).toHaveLength(2);
    expect(await connection.db.select().from(s.disbursements)).toHaveLength(0); await noOverflow(page);
    await page.goto(receipt); await expect(page.getByRole("button", { name: "Prepare expense proposal", exact: true })).toHaveCount(0);
  });
  test("AP-04/06: repeated requests, unsaved choices, stale capacity and stale forms stay in the review flow", async ({ page }) => {
    const receipt = await create(page); const fields = await page.locator(".proposal-form").evaluate((form: HTMLFormElement) => Object.fromEntries(new FormData(form)) as Record<string, string>);
    let release!: () => void; gate = new Promise<void>(resolve => { release = resolve; });
    try { await page.locator(".proposal-form").evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); }); await expect(page.getByRole("button", { name: "Preparation in progress...", exact: true })).toBeDisabled(); await expect.poll(() => calls).toBe(1); }
    finally { release(); }
    await expect(page.getByRole("heading", { name: "Provisional funding available", exact: true })).toBeVisible();
    const endpoint = receipt.replace("/claims/", "/api/receipts/").replace(/\/receipt$/, "/proposal");
    const replay = await page.request.post(endpoint, { form: fields, headers: { origin: "http://127.0.0.1:3100" } }); expect(replay.status()).toBe(200); expect(calls).toBe(1);
    await connection.db.update(s.fundBudgetLines).set({ capCents: 0n }); await page.reload(); await expect(page.getByRole("heading", { name: "Preview needs refreshing", exact: true })).toBeVisible(); await expect(page.locator(".proposal-edges li")).toHaveCount(0);
    await page.getByRole("button", { name: "Refresh funding preview", exact: true }).click(); await expect(page.locator(".proposal-split")).toHaveText("$0.00 from restricted funds, $6.00 from General."); expect(calls).toBe(1);
    await page.route("**/proposal", route => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Review changed" }) }));
    await page.getByRole("button", { name: "Refresh funding preview", exact: true }).click(); await expect(page.locator(".proposal-panel").getByRole("alert")).toContainText("This review changed"); expect(new URL(page.url()).pathname).toContain("/claims/"); await page.unroute("**/proposal");
    await page.getByLabel("Category for L1", { exact: true }).selectOption("notebooks"); await expect(page.getByRole("button", { name: "Refresh funding preview" })).toBeDisabled(); await expect(page.getByLabel("Category for L1", { exact: true })).toHaveValue("notebooks");
    expect(await connection.db.select().from(s.receiptConfirmations)).toHaveLength(0); expect(await connection.db.select().from(s.disbursements)).toHaveLength(0);
  });
  test("AP-03/09: prohibited, unknown and unavailable proposals preserve manual review", async ({ page }) => {
    await create(page, true); mode = "alcohol"; await page.getByRole("button", { name: "Prepare expense proposal", exact: true }).click(); await expect(page.getByRole("heading", { name: "Funding blocked by current rules", exact: true })).toBeVisible(); await expect(page.locator(".proposal-issues")).toContainText("prohibited category"); await noOverflow(page);
    await expect(page.locator(".notice.warning")).toContainText("Alcohol is prohibited across all funds");
    await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
    await page.getByRole("link", { name: "View allocation", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Organization policy stops this expense.");
    await expect(page.getByRole("button", { name: "Freeze allocation for approval" })).toHaveCount(0);
    expect(await connection.db.select().from(s.approvals)).toHaveLength(0);
    expect(await connection.db.select().from(s.disbursements)).toHaveLength(0);
    await page.goto("/receipts/new"); await page.getByLabel("This receipt is fictional sandbox data.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click(); mode = "unknown";
    await page.getByRole("button", { name: "Prepare expense proposal", exact: true }).click(); await expect(page.getByRole("heading", { name: "Category review needed", exact: true })).toBeVisible(); await expect(page.getByLabel("Category for L1", { exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "Confirm categories", exact: true }).click(); expect(await page.getByLabel("Category for L1", { exact: true }).evaluate((el: HTMLSelectElement) => el.validity.valueMissing)).toBe(true);
    await page.goto("/receipts/new"); await page.getByLabel("This receipt is fictional sandbox data.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click(); mode = "unavailable";
    await page.getByRole("button", { name: "Prepare expense proposal", exact: true }).click(); await expect(page.getByRole("heading", { name: "Preparation unavailable", exact: true })).toBeVisible();
    for (const [line, category] of [["L1", "science_kits"], ["L2", "notebooks"], ["L3", "hospitality"]]) { await page.getByLabel(`Category for ${line}`, { exact: true }).selectOption(category!); await page.getByLabel(`Reason for manual choice ${line}`, { exact: true }).fill("Checked invented source"); }
    await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click(); await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible();
    expect(await connection.db.select().from(s.disbursements)).toHaveLength(0); expect(await connection.db.select().from(s.approvals)).toHaveLength(0);
  });
  test("AP-09: persisted timeout is clear and receipt edits are preserved", async ({ page }) => {
    const receipt = await create(page); const id = receipt.split("/")[4]!;
    const v = await readReceiptView(connection.db, id, "maria"); const p = await readExpenseProposal(connection.db, id, "maria");
    await prepareExpenseProposal(connection.db, id, "maria", { reviewId: v.review.id, draftHash: v.review.draftHash, suggestionHash: suggestionHash(v.suggestion), runHash: p.runHash }, async () => { throw new ReceiptAiError("TIMEOUT"); });
    await page.reload(); await expect(page.locator(".proposal-panel")).toContainText("Preparation timed out");
    await page.getByText("Edit receipt or amounts", { exact: true }).click(); await page.getByLabel("Fictional vendor").fill("Unsaved fictional vendor"); await expect(page.getByRole("button", { name: "Prepare expense proposal", exact: true })).toBeDisabled(); await expect(page.getByRole("button", { name: "Confirm categories", exact: true })).toBeDisabled();
    await page.getByLabel("This receipt is fictional sandbox data.").check(); await page.getByRole("button", { name: "Save edits and require a new review" }).click(); await expect(page.getByText("Unsaved fictional vendor", { exact: false }).first()).toBeVisible();
    expect(calls).toBe(0); expect(await connection.db.select().from(s.receiptConfirmations)).toHaveLength(0); await noOverflow(page);
  });
  test("AP-09: AI disabled still allows explicit manual category confirmation", async ({ page }) => {
    await create(page); await page.getByRole("button", { name: "Prepare expense proposal", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Preparation unavailable", exact: true })).toBeVisible(); expect(calls).toBe(0);
    for (const [line, category] of [["L1", "science_kits"], ["L2", "notebooks"], ["L3", "hospitality"]]) {
      await page.getByLabel(`Category for ${line}`, { exact: true }).selectOption(category!); await page.getByLabel(`Reason for manual choice ${line}`, { exact: true }).fill("Manual check with AI disabled");
    }
    await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible(); expect(calls).toBe(0);
    expect(await connection.db.select().from(s.approvals)).toHaveLength(0); expect(await connection.db.select().from(s.disbursements)).toHaveLength(0);
  });
});
test.describe("Isolated single-receipt judging", () => {
  test.skip(actual, "Synthetic boundary suite; actual model is verified separately");
  test("JUDGE-01/03: one $500 receipt reaches two approvals and a read-only unpaid handoff", async ({ page }) => {
    await login(page, "maria");
    await expect(page.getByRole("link", { name: "Review Maria's $500 receipt", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Inspect the separate claim C-104", exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Review Maria's $500 receipt", exact: true }).click();
    await page.getByLabel("This receipt is fictional sandbox data.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Prepare this expense for review", exact: true })).toBeVisible();
    const receipt = page.url().split("?")[0]!; const input = await readReceiptView(connection.db, receipt.split("/").at(-2)!, "maria");
    expect(input.lines.map(line => line.amountCents)).toEqual([28000n, 15000n, 7000n]);
    await page.getByRole("button", { name: "Prepare expense proposal", exact: true }).click();
    await expect(page.locator(".proposal-split")).toHaveText("$430.00 from restricted funds, $70.00 from General.");
    await expect(page.locator(".receipt-source mark")).toHaveCount(3);
    await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
    const claimUrl = (await page.getByRole("link", { name: "View allocation", exact: true }).getAttribute("href"))!;
    await page.goto(claimUrl); await expect(page.getByText("$200.00 from General", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("$430.00 restricted. $70.00 General.");
    await page.getByRole("button", { name: "Freeze allocation for approval", exact: true }).click();
    for (const role of ["tara", "ben"] as const) { await page.getByRole("button", { name: "Sign out", exact: true }).click(); await login(page, role); await page.goto(claimUrl); await page.getByRole("button", { name: "Approve these terms", exact: true }).click(); }
    await expect(page.getByLabel("Unpaid PayPal handoff", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Send .*PayPal sandbox/ })).toHaveCount(0);
    await expect(page.getByText("Organization-wide open payable: $500.00.", { exact: false })).toBeVisible();
    const before = await financial();
    await page.getByText("Inspect the proposed request structure", { exact: true }).click();
    await expect(page.locator(".paypal-handoff pre")).toContainText('"value": "500.00"');
    await expect(page.locator(".paypal-handoff pre")).not.toContainText("review@example.invalid");
    await page.getByText("How a separately authorized payment would finish", { exact: true }).click();
    await noOverflow(page);
    for (const action of ["send", "refresh", "retry", "authorize-retry"]) {
      const result = await page.request.post(`${claimUrl}/actions`.replace("/claims/", "/api/claims/"), { headers: { origin: "http://127.0.0.1:3100" }, form: { action, confirmSandbox: "yes", decisionHash: "a".repeat(64) } });
      expect(result.status()).toBe(403);
    }
    expect(await financial()).toBe(before);
    expect(await connection.db.select().from(s.disbursementAttempts)).toHaveLength(0);
    expect(await connection.db.select().from(s.approvals)).toHaveLength(2);
    await page.getByRole("button", { name: "Sign out", exact: true }).click(); await login(page, "maria");
    await expect(page.getByRole("link", { name: "Continue Maria's receipt", exact: true })).toHaveAttribute("href", claimUrl);
    await page.goto("/receipts/new"); await expect(page).toHaveURL(new RegExp(claimUrl + "/receipt$"));
    await page.goto("/claims/C-104"); await expect(page).toHaveURL("http://127.0.0.1:3100/");
  });
  test("JUDGE-02: UNKNOWN remains manual and a prohibited expense cannot freeze", async ({ page }) => {
    mode = "unknown"; await create(page);
    await page.getByRole("button", { name: "Prepare expense proposal", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Category review needed", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Freeze allocation for approval", exact: true })).toHaveCount(0);
    for (const [line, category] of [["L1", "alcohol"], ["L2", "notebooks"], ["L3", "hospitality"]]) { await page.getByLabel(`Category for ${line}`, { exact: true }).selectOption(category!); await page.getByLabel(`Reason for manual choice ${line}`, { exact: true }).fill("Manual prohibited-item boundary check"); }
    await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
    await page.getByRole("link", { name: "View allocation", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Organization policy stops this expense.", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Freeze allocation for approval", exact: true })).toHaveCount(0);
    expect(await connection.db.select().from(s.approvals)).toHaveLength(0); expect(await connection.db.select().from(s.disbursementAttempts)).toHaveLength(0);
  });
});
test.describe("Actual pinned model interface", () => {
  test.skip(!actual, "Runs separately with private inference network");
  test("AP-01/08: actual model receipt stays unpaid after the claimant confirms categories", async ({ page }) => {
    const receipt = await create(page); const before = await financial(); const started = performance.now();
    await page.getByRole("button", { name: "Prepare expense proposal", exact: true }).click(); await expect(page.getByRole("heading", { name: "Provisional funding available", exact: true })).toBeVisible({ timeout: 80000 });
    console.log(JSON.stringify({ check: "actual-model browser preparation", observedMilliseconds: Math.round(performance.now() - started), note: "Includes browser navigation and rendering; one fixture, not a latency guarantee." }));
    expect(await financial()).toBe(before); await expect(page.locator("blockquote")).toHaveCount(3); await noOverflow(page);
    await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click(); await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible();
    await page.getByRole("link", { name: "View allocation", exact: true }).click(); await expect(page.getByRole("button", { name: "Freeze allocation for approval" })).toBeVisible();
    expect(await connection.db.select().from(s.approvals)).toHaveLength(0); expect(await connection.db.select().from(s.disbursements)).toHaveLength(0); expect(await connection.db.select().from(s.fundReservations)).toHaveLength(0);
    await page.goto(receipt); await page.setViewportSize({ width: 1100, height: 850 }); await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible();
  });
});
