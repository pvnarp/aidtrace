import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { sendClaimPayout, refreshClaimPayout } from "../src/ledger/payout";
import * as s from "../db/schema";
import type { PersistedPayout, PayoutTransport } from "../src/paypal/adapter";

let connection: ReturnType<typeof connectDatabase>;
let admin: ReturnType<typeof postgres>; let server: ChildProcess | undefined; let name: string;
let passwords: Record<"maria" | "tara" | "ben", string>;
let model: Server; let unavailable = false; let modelCalls = 0;
let modelGate: Promise<void> | undefined;
test.beforeEach(async () => {
  if (process.env.UI_TEST_CONTAINER !== "true") throw new Error("Run phone checks only through the isolated OrbStack UI service");
  name = `aidtrace_iac211_test_${randomBytes(6).toString("hex")}`;
  const adminUrl = new URL(process.env.DATABASE_URL!); adminUrl.pathname = "/postgres";
  admin = postgres(adminUrl.toString(), { max: 1 }); await admin`create database ${admin(name)}`;
  const url = new URL(adminUrl); url.pathname = `/${name}`; connection = connectDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "phone-test@personal.example.com", payeeAllowlist: ["phone-test@personal.example.com"] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  unavailable = false; modelCalls = 0; modelGate = undefined;
  // Synthetic model responses only. This test network has no internet route.
  model = createServer(async (request, response) => {
    modelCalls++;
    await modelGate;
    if (unavailable) { response.writeHead(503).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const data = JSON.parse(body.messages[0].content); // Anthropic request: one user message, the system prompt is a separate field.
    const categories = ["robot_kits_parts", "classroom_supplies", "participant_meals"];
    const content = JSON.stringify({ proposals: data.lines.map((line: { id: string; description: string }, i: number) => ({ lineId: line.id, category: categories[i], quote: line.description })) });
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_ui_stub", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text: content }], usage: { input_tokens: 812, output_tokens: 57 } }));
  });
  await new Promise<void>(resolve => model.listen(8080, "0.0.0.0", resolve));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AI_RECEIPT_ENABLED: "true", ANTHROPIC_API_KEY: "sk-ant-api03-UI-STUB-NOT-A-REAL-KEY", AI_EXPENSE_PROPOSALS_ENABLED: "false", PAYPAL_SANDBOX_PAYEE_EMAIL: "phone-test@personal.example.com", PAYEE_ALLOWLIST: "phone-test@personal.example.com", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
  for (let attempt = 0; attempt < 90; attempt++) {
    try { if ((await fetch("http://127.0.0.1:3100/api/health", { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Wait for the isolated server, never the main application. */ }
    if (server.exitCode !== null) throw new Error("Isolated UI server exited before readiness");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Isolated UI server readiness timed out");
});
test.afterEach(async () => {
  if (server?.pid) {
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* Already stopped. */ }
    await Promise.race([new Promise(resolve => server!.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    try { process.kill(-server.pid, "SIGKILL"); } catch { /* Already stopped. */ }
  }
  await connection?.client.end();
  await new Promise<void>(resolve => model?.close(() => resolve()));
  if (admin && /^aidtrace_iac211_test_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const control of await page.locator("button, input, textarea, select").all()) {
    if (!await control.isVisible()) continue;
    const box = await control.boundingBox(); if (box) { expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(375); }
  }
}
async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]);
  const response = page.waitForResponse(r => r.url().endsWith("/api/auth/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); expect((await response).status()).toBe(303);
  await page.waitForURL(url => url.pathname === "/"); await page.goto("/claims/C-104");
}
async function create(page: Page) {
  await login(page, "maria"); await page.goto("/"); await page.getByRole("link", { name: "Start a $6 practice expense", exact: true }).click();
  await noOverflow(page); await page.getByLabel("This receipt is fictional sandbox data.").check();
  await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Unpaid draft created"); await noOverflow(page);
}
test("GB-02: 375-pixel receipt quotes, explicit confirmation, allocation and edits requiring new review", async ({ page }) => {
  await create(page); const receiptUrl = page.url().split("?")[0]!;
  // IAC-383: before any suggestion exists the page names no provider, and never derives one from the environment.
  await expect(page.locator(".receipt-evidence .muted")).toContainText("No AI suggestion is saved yet"); await expect(page.locator(".receipt-evidence")).not.toContainText("Claude Haiku 5.5");
  await page.getByRole("button", { name: "Request AI suggestions" }).click();
  await expect(page.locator(".notice")).toContainText("AI suggestions are ready"); expect(modelCalls).toBe(1);
  await expect(page.locator(".receipt-evidence .muted")).toContainText("Claude Haiku 5.5. Text in, category suggestions out. No PayPal tools or approval access.");
  await expect(page.locator(".ai-label").first()).toContainText("Claude Haiku 5.5 suggests:");
  await expect(page.locator("blockquote")).toHaveCount(3); await noOverflow(page);
  await expect(page.locator(".ai-recommendation")).toContainText("A person confirms each category."); await expect(page.locator(".category-choice .ai-tag")).toHaveCount(3);
  // 44 px hit area for the confirmation checkbox, and a whole current-step label in the rail.
  const checkbox = (await page.getByLabel(/I checked every category/).boundingBox())!; expect(checkbox.width).toBeGreaterThanOrEqual(44); expect(checkbox.height).toBeGreaterThanOrEqual(44);
  // Every word of every stage label must fit its own column, so no word is split mid-word.
  const rail = await page.locator(".stage-rail .stage-item").evaluateAll(items => items.map(el => {
    const text = [...el.childNodes].find(node => node.nodeType === Node.TEXT_NODE)!; const words = text.textContent!.trim().split(/\s+/); let start = text.textContent!.indexOf(words[0]!);
    const widest = Math.max(...words.map(word => { const range = document.createRange(); start = text.textContent!.indexOf(word, start); range.setStart(text, start); range.setEnd(text, start + word.length); start += word.length; return range.getBoundingClientRect().width; }));
    return { label: text.textContent, column: Math.round(el.clientWidth), widest: Math.round(widest), whole: el.scrollWidth <= el.clientWidth };
  }));
  expect(rail.filter(item => !item.whole || item.widest > item.column)).toEqual([]);
  await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  expect(await page.getByLabel(/I checked every category/).evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
  await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible(); await page.getByRole("link", { name: "View allocation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "$5.00 restricted. $1.00 General.", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Freeze allocation for approval" })).toBeVisible(); await noOverflow(page);
  await page.goto(receiptUrl); await page.getByText("Edit receipt or amounts", { exact: true }).click();
  await page.getByLabel("Invented receipt text").fill("Edited fictional source"); await page.getByLabel("This receipt is fictional sandbox data.").check();
  await page.getByRole("button", { name: "Save edits and require a new review" }).click();
  await expect(page.getByRole("status")).toContainText("Earlier suggestions and confirmation no longer apply"); await expect(page.locator("blockquote")).toHaveCount(0);
  await expect(page.getByLabel("Category for L1", { exact: true })).toHaveValue("");
  await page.goto(receiptUrl.replace(/\/receipt$/, "")); await expect(page).toHaveURL(/\/receipt$/);
  const confirmations = await connection.db.select().from(s.receiptConfirmations); expect(confirmations).toHaveLength(1);
  expect(await connection.db.select().from(s.disbursements)).toHaveLength(0);
  expect((await connection.db.select().from(s.journalEntries)).every(entry => entry.sourceType === "fixture_opening_balance")).toBe(true);
});
test("Demo UI: changing one category shows Changed by you on review and Person chose on the claim", async ({ page }) => {
  await create(page);
  await page.getByRole("button", { name: "Request AI suggestions" }).click();
  await expect(page.locator(".notice")).toContainText("AI suggestions are ready");
  const tags = page.locator(".category-choice-head .ai-tag");
  await expect(tags).toHaveText(["AI suggested", "AI suggested", "AI suggested"]);
  await page.getByLabel("Category for L1", { exact: true }).selectOption("participant_meals");
  await expect(tags).toHaveText(["Changed by you", "AI suggested", "AI suggested"]);
  await page.getByLabel("Reason for manual choice L1").fill("Receipt shows this item is a snack");
  await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible(); await page.getByRole("link", { name: "View allocation", exact: true }).click();
  const provenance = page.locator(".provenance-tags");
  await expect(provenance).toHaveCount(3);
  await expect(provenance.nth(0)).toHaveText("Person chose"); await expect(provenance.nth(0)).not.toContainText("AI suggested");
  await expect(provenance.nth(1)).toHaveText("AI suggestedPerson confirmed"); await expect(provenance.nth(2)).toHaveText("AI suggestedPerson confirmed");
});
test("CAI-35: the receipt page names the provider and model from the stored audit, never from the environment", async ({ page }) => {
  await create(page); modelCalls = 0;
  const [review] = await connection.db.select().from(s.receiptReviews); const lines = await connection.db.select().from(s.claimLines).where(eq(s.claimLines.claimId, review!.claimId));
  const categories = ["robot_kits_parts", "classroom_supplies", "participant_meals"];
  const proposals = lines.sort((a, b) => a.id.localeCompare(b.id)).map((line, index) => { const start = review!.source.indexOf(line.description);
    return { lineId: line.id, category: categories[index]!, quote: line.description, start, end: start + line.description.length }; });
  const sha = review!.sourceHash; const hash = (letter: string) => letter.repeat(64);
  const claude = (model: string) => ({ provider: "claude", model, responseModel: model, effort: "low", promptVersion: "receipt-category-claude-v1", schemaVersion: "receipt-proposals-v1",
    sourceSha256: sha, requestSha256: hash("a"), responseSha256: hash("b"), latencyMs: 1200, inputTokens: 812, outputTokens: 57 });
  // Direct inserts of stored suggestions only. This server runs with no model variable, so a Claude name here can only come from the audit.
  const check = async (attempt: number, audit: Record<string, string | number>, columns: { provider: "local" | "claude"; model: string }, model: string, label: string, recommendation: string) => {
    await connection.db.insert(s.receiptSuggestions).values({ reviewId: review!.id, attempt, status: "READY", proposals, audit, ...columns }); await page.reload();
    await expect(page.locator(".receipt-evidence .muted")).toContainText(`${model}. Text in, category suggestions out. No PayPal tools or approval access.`);
    await expect(page.locator(".ai-label").first()).toContainText(`${label} suggests:`); await expect(page.locator("blockquote")).toHaveCount(3);
    await expect(page.locator(".ai-recommendation .ai-model-line")).toContainText(recommendation);
  };
  // The idle strip names the configured Claude model: a key is set and no model variable is set, so the Haiku default.
  await expect(page.locator(".ai-recommendation.ai-strip .ai-model-line")).toContainText("Claude Haiku 5.5 through the Claude API");
  await check(1, claude("claude-haiku-5-5"), { provider: "claude", model: "claude-haiku-5-5" }, "Claude Haiku 5.5", "Claude Haiku 5.5", "Model: Claude Haiku 5.5 through the Claude API");
  await check(2, claude("claude-sonnet-5-5"), { provider: "claude", model: "claude-sonnet-5-5" }, "Claude Sonnet 5.5", "Claude Sonnet 5.5", "Model: Claude Sonnet 5.5 through the Claude API");
  await check(3, { sourceSha256: sha, requestSha256: hash("a"), responseSha256: hash("b"), modelSha256: hash("c"), modelRevision: "d".repeat(40), promptVersion: "receipt-category-v1" }, { provider: "local", model: "d".repeat(40) }, "Earlier AI model, since retired", "Earlier AI", "Model: Earlier AI model, since retired. This suggestion was saved before AidTrace moved to Claude.");
  // The database check refuses a provider the audit contradicts, so the unrecognized case is an audit the columns accept but the reader refuses (effort outside the stored contract).
  await check(4, { ...claude("claude-haiku-5-5"), effort: "high" }, { provider: "claude", model: "claude-haiku-5-5" }, "Unrecognized AI record", "AI", "the saved AI record is not recognized");
  expect(modelCalls).toBe(0); expect(await connection.db.select().from(s.disbursements)).toHaveLength(0);
});
test("IAC-351: proposal-disabled manual-review link reaches an editable category without posting", async ({ page }) => {
  await create(page);
  // This suite explicitly disables the proposal extension, exercising its legacy review branch.
  const target = page.locator("#category-review"); await expect(target).toHaveCount(1);
  const posts: string[] = []; page.on("request", request => { if (request.method() === "POST") posts.push(request.url()); });
  await page.getByRole("link", { name: "Go to category review", exact: true }).click();
  await expect(target).toBeFocused(); await expect(page.getByLabel("Category for L1", { exact: true })).toBeInViewport();
  await expect(page).toHaveURL(/#category-review$/); await noOverflow(page);
  expect(posts).toEqual([]); expect(modelCalls).toBe(0);
  expect(await connection.db.select().from(s.receiptConfirmations)).toHaveLength(0);
  expect(await connection.db.select().from(s.approvals)).toHaveLength(0);
  expect(await connection.db.select().from(s.disbursementAttempts)).toHaveLength(0);
});
test("GB-02: unavailable model leaves human review usable and approvers read-only at 375 pixels", async ({ page }) => {
  await create(page); unavailable = true;
  await page.getByRole("button", { name: "Request AI suggestions" }).click();
  await expect(page.getByText("No usable AI suggestions are available.", { exact: false })).toBeVisible(); expect(modelCalls).toBe(1);
  for (const [line, category] of [["L1", "robot_kits_parts"], ["L2", "classroom_supplies"], ["L3", "participant_meals"]]) {
    await page.getByLabel(`Category for ${line}`, { exact: true }).selectOption(category!);
    await page.getByLabel(`Reason for manual choice ${line}`, { exact: true }).fill("Checked fictional receipt");
  }
  await noOverflow(page); await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await expect(page.getByText(/Human choice: Checked fictional receipt/)).toHaveCount(3); const url = page.url();
  await page.getByRole("button", { name: "Sign out" }).click(); await login(page, "tara"); await page.goto(url);
  await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible(); await expect(page.getByText("Edit receipt or amounts", { exact: true })).toHaveCount(0); await noOverflow(page);
  expect(modelCalls).toBe(1); expect(await connection.db.select().from(s.disbursements)).toHaveLength(0);
});
test("GB-02: double submit shows progress and duplicate/stale posts return to the receipt", async ({ page }) => {
  await create(page); const receiptUrl = page.url().split("?")[0]!;
  const fields = await page.locator(".action-form").evaluate((form: HTMLFormElement) => Object.fromEntries(new FormData(form).entries()) as Record<string, string>);
  const endpoint = receiptUrl.replace("/claims/", "/api/receipts/").replace(/\/receipt$/, "");
  let release!: () => void; modelGate = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.locator(".action-form").evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit(); });
    await expect(page.getByRole("button", { name: "AI review in progress...", exact: true })).toBeDisabled();
    await expect.poll(() => modelCalls).toBe(1);
    const overlapping = await page.request.post(endpoint, { form: fields, headers: { origin: "http://127.0.0.1:3100" }, maxRedirects: 0 });
    expect(overlapping.status()).toBe(303); expect(overlapping.headers().location).toContain("notice=running");
  } finally { release(); }
  await expect(page.locator(".notice")).toContainText("AI suggestions are ready");
  await expect(page.locator("blockquote")).toHaveCount(3); expect(modelCalls).toBe(1);
  const duplicate = await page.request.post(endpoint, { form: fields, headers: { origin: "http://127.0.0.1:3100" }, maxRedirects: 0 });
  expect(duplicate.status()).toBe(303); expect(duplicate.headers().location).toContain("notice=suggested"); expect(modelCalls).toBe(1);
  const stale = await page.request.post(endpoint, { form: { ...fields, draftHash: "0".repeat(64) }, headers: { origin: "http://127.0.0.1:3100" }, maxRedirects: 0 });
  expect(stale.status()).toBe(303); expect(stale.headers().location).toContain("notice=review-changed");
  await page.goto(stale.headers().location); await expect(page.locator(".notice")).toContainText("Your saved draft is below");
  await expect(page.locator("blockquote")).toHaveCount(3); await noOverflow(page);
  expect(await connection.db.select().from(s.receiptSuggestions)).toHaveLength(1);
  expect(await connection.db.select().from(s.receiptConfirmations)).toHaveLength(0);
  expect(await connection.db.select().from(s.disbursements)).toHaveLength(0);
});
test("PTG-22: a gift card mention shows the notice, needs the unticked acknowledgement, and reaches the claim page as a flag at 375 pixels", async ({ page }) => {
  await create(page); const receiptUrl = page.url().split("?")[0]!;
  await page.getByText("Edit receipt or amounts", { exact: true }).click();
  const source = await page.getByLabel("Invented receipt text").inputValue();
  await page.getByLabel("Invented receipt text").fill(`${source}\nRaffle prize: gift card`); await page.getByLabel("This receipt is fictional sandbox data.").check();
  await page.getByRole("button", { name: "Save edits and require a new review" }).click();
  await expect(page.getByRole("status")).toContainText("Earlier suggestions and confirmation no longer apply");
  const choose = async () => { for (const [line, category] of [["L1", "robot_kits_parts"], ["L2", "classroom_supplies"], ["L3", "participant_meals"]]) {
    await page.getByLabel(`Category for ${line}`, { exact: true }).selectOption(category!); await page.getByLabel(`Reason for manual choice ${line}`, { exact: true }).fill("Checked fictional receipt"); } };
  await expect(page.locator(".prohibited-notice")).toContainText("This receipt mentions: gift card (Gift cards: needs pre-approval)."); await noOverflow(page);
  const acknowledge = page.getByLabel(/I checked: this is not claimed under another category/);
  await expect(acknowledge).not.toBeChecked();
  // Without the tick the server refuses, saves nothing and says why.
  await choose(); await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("This receipt mentions a possibly prohibited item"); await expect(page).toHaveURL(/notice=acknowledge-required$/);
  expect(await connection.db.select().from(s.receiptConfirmations)).toHaveLength(0);
  await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toHaveCount(0);
  await expect(acknowledge).not.toBeChecked(); await noOverflow(page);
  await choose(); await acknowledge.check(); await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible();
  await expect(page.locator(".prohibited-flag")).toContainText("Receipt text flag (prohibited-terms-v1): mentions gift card (Gift cards: needs pre-approval). You acknowledged it is not claimed under another category."); await noOverflow(page);
  await page.getByRole("link", { name: "View allocation", exact: true }).click();
  await expect(page.locator(".prohibited-flag")).toContainText("Receipt text flag (prohibited-terms-v1): mentions gift card (Gift cards: needs pre-approval). The claimant acknowledged it is not claimed under another category.");
  await expect(page.getByRole("button", { name: "Freeze allocation for approval" })).toBeVisible(); await noOverflow(page);
  const [confirmation] = await connection.db.select().from(s.receiptConfirmations);
  expect(confirmation!.prohibitedScreen).toEqual({ version: "prohibited-terms-v1", matches: [{ category: "gift_cards", term: "gift card" }], unresolved: [{ category: "gift_cards", term: "gift card" }], acknowledged: true });
  expect(receiptUrl).toContain("/receipt"); expect(await connection.db.select().from(s.disbursements)).toHaveLength(0);
  expect((await connection.db.select().from(s.journalEntries)).every(entry => entry.sourceType === "fixture_opening_balance")).toBe(true);
});
