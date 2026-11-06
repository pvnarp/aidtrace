import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { recordDesignatedDonation } from "../src/ledger/donation";
import { issueGiftLink } from "../src/donation/gift-link";
import type { DonationObservation } from "../src/paypal/adapter";

// AW-02 (IAC-416 PR 2, docs/GATE_REPORT.md section 57): the rendered words at 1440 px. Pavan, November 1: "drop sanbox, drop fictional, drop the word "claude"
// we need to just say "AI" so drive home the point". Every screen the recording can reach is read as document.body.innerText with every <details> opened.
// A screen may name the model and Anthropic only inside one of three disclosure sentences, which are removed before the word check and counted. So the
// check cannot pass by deleting the disclosure: the pages where text leaves the app must carry exactly one. AW-01 (tests/says-ai.test.ts) scans the
// source literals. This test is the real guard, because model names are built at run time from stored ids.
// Each test starts its own isolated database and next server on 3100. The model answers come from a loopback stub on 8080 (UI_TEST_CONTAINER sends the
// requests there). They are NOT a real model result. The browser aborts every request that is not loopback. No PayPal or Anthropic request is made.
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });
let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof connectDatabase>;
let server: ChildProcess | undefined, model: Server | undefined, name: string;
let passwords: Record<"maria" | "tara" | "ben", string>;
let giftToken = "";
let suggestions = 0; let compliance: string[] = [];
const PAYEE = "aw@example.invalid";

const observation = (orderId: string, captureId: string): DonationObservation => ({ httpStatus: 200, orderId, intent: "CAPTURE", status: "COMPLETED", units: [{ fundId: "fund_a", amountCents: 1000n }],
  captures: [{ captureId, status: "COMPLETED", amountCents: 1000n, grossCents: 1000n, feeCents: 120n, netCents: 880n, effectiveOn: "2026-10-22" }] });

async function start(ai: Record<string, string>) {
  if (process.env.UI_TEST_CONTAINER !== "true") throw Error("Use isolated OrbStack browser service");
  const url = new URL(process.env.DATABASE_URL!); url.pathname = "/postgres";
  admin = postgres(url.toString(), { max: 1 }); name = "aidtrace_aw_" + randomBytes(6).toString("hex");
  await admin`create database ${admin(name)}`; url.pathname = "/" + name;
  connection = connectDatabase(url.toString()); await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: PAYEE, payeeAllowlist: [PAYEE] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  // One recorded gift with an issued link, so the public gift trail page can be read. The provider observation is a stub: no PayPal URL is reached.
  await recordDesignatedDonation(connection.db, "tara", { orderId: "ORDER_AW_1", captureId: "CAPTURE_AW_1", fundId: "fund_a", amountCents: 1000n }, { donationOrder: async () => observation("ORDER_AW_1", "CAPTURE_AW_1") });
  const link = await issueGiftLink(connection.db, "CAPTURE_AW_1"); if (link?.state !== "ISSUED") throw Error("Expected an issued gift link"); giftToken = link.token;
  suggestions = 0; compliance = [];
  model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); const data = JSON.parse(body.messages[0].content);
    let text: string;
    if (data.fund) {
      // The first restricted fund conflicts on its fourth clause, so Haiku escalates to Sonnet for it and stops at Haiku for the other fund.
      compliance.push(`${data.fund.name.split(" ")[0]}:${body.model}`); const conflicts = data.fund.name.startsWith("Ashmere");
      text = JSON.stringify({ lines: data.receipt.lines.map((line: { id: string }) => conflicts ? { lineId: line.id, verdict: "CONFLICT", clauseId: data.fund.clauses[3].id } : { lineId: line.id, verdict: "OK", clauseId: null }) });
    } else {
      suggestions++; const categories = ["robot_kits_parts", "classroom_supplies", "participant_meals"];
      text = JSON.stringify({ proposals: data.lines.map((line: { id: string; description: string }, i: number) => ({ lineId: line.id, category: categories[i], quote: line.description })) });
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_ui_stub", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text }], usage: { input_tokens: 812, output_tokens: 57 } }));
  });
  await new Promise<void>(resolve => model!.listen(8080, "0.0.0.0", resolve));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AIDTRACE_JUDGE_SESSION: "false", AI_EXPENSE_PROPOSALS_ENABLED: "false", PAYPAL_SANDBOX_PAYEE_EMAIL: PAYEE, PAYEE_ALLOWLIST: PAYEE, PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false", ...ai } });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch("http://127.0.0.1:3100/api/health", { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Wait for this container's server. */ }
    if (server.exitCode !== null) throw Error("Isolated server exited");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error("Server readiness timeout");
}
test.afterEach(async () => {
  if (server?.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* Exited. */ } await Promise.race([new Promise(resolve => server!.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 3000))]); try { process.kill(-server.pid, "SIGKILL"); } catch { /* Exited. */ } }
  await connection?.client.end();
  model?.closeAllConnections(); if (model) { await new Promise<void>(resolve => model!.close(() => resolve())); model = undefined; }
  if (admin && /^aidtrace_aw_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
// Abort every request that is not loopback, so nothing here can reach a real provider.
test.beforeEach(async ({ page }) => { await page.route(url => !/^(127\.0\.0\.1|localhost)$/.test(url.hostname), route => route.abort()); });

async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.pathname === "/");
}
async function logout(page: Page) { await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(url => url.pathname === "/login"); }
async function bodyText(page: Page) {
  await page.evaluate(() => document.querySelectorAll("details").forEach(details => { details.open = true; }));
  return page.evaluate(() => document.body.innerText);
}
// November 5 (Pavan: "Powered by [model name]" wherever a model is used): the only places a screen may name the model or the provider are lines that start "Powered by". Three carry the
// provider sentence, and a standalone "Powered by" line (the AI review card, the receipt evidence) carries no sentence after it. The three: the idle receipt strip, the saved suggestion line and the
// model check line. Each is matched whole, so a changed or half-deleted sentence leaves "Claude" behind and fails the word check.
const DISCLOSURE = {
  idle: /Powered by Claude \w+ \d+\.\d+\. The receipt text goes to Anthropic\./g,
  saved: /Powered by Claude \w+ \d+\.\d+\. The receipt text was sent to Anthropic for these suggestions\./g,
  check: /Powered by Claude \w+ \d+\.\d+(?:(?:, | and )Claude \w+ \d+\.\d+)*\. Claim line and clause text was sent to Anthropic\./g,
  // Standalone: "Powered by" and the model names, then the full stop, and nothing else in the line.
  standalone: /Powered by Claude \w+ \d+\.\d+(?:(?:, | and )Claude \w+ \d+\.\d+)*\./g,
};
const seen: { label: string; text: string }[] = [];
/** The words check for one screen. It returns the text with the disclosure sentences removed, and how many of each it found. */
async function words(page: Page, label: string) {
  const text = await bodyText(page); seen.push({ label, text });
  expect(text.length, `${label} has text`).toBeGreaterThan(200);
  const found = { idle: text.match(DISCLOSURE.idle)?.length ?? 0, saved: text.match(DISCLOSURE.saved)?.length ?? 0, check: text.match(DISCLOSURE.check)?.length ?? 0 };
  const rest = text.replace(DISCLOSURE.idle, "").replace(DISCLOSURE.saved, "").replace(DISCLOSURE.check, "").replace(DISCLOSURE.standalone, "");
  expect(rest, `${label}: Claude`).not.toMatch(/claude/i);
  expect(rest, `${label}: fictional`).not.toMatch(/fictional/i);
  expect(rest, `${label}: sandbox`).not.toMatch(/sandbox/i);
  expect(rest, `${label}: Test payments`).not.toMatch(/test payments/i);
  return { text, rest, found, standalone: text.match(DISCLOSURE.standalone)?.length ?? 0 };
}
const NONE = { idle: 0, saved: 0, check: 0 };
const AI_ON = { AI_RECEIPT_ENABLED: "true", AI_COMPLIANCE_ENABLED: "true", AI_ANALYTICS_ENABLED: "false", ANTHROPIC_API_KEY: "sk-ant-api03-UI-STUB-NOT-A-REAL-KEY" };
const AI_NONE = { AI_RECEIPT_ENABLED: "true", AI_COMPLIANCE_ENABLED: "true", AI_ANALYTICS_ENABLED: "false", ANTHROPIC_API_KEY: "" };

test("AW-02a: with AI configured and stubbed, no screen says Claude, fictional or sandbox outside three disclosure lines, and the one money line is on Give", async ({ page }) => {
  test.setTimeout(300000); seen.length = 0;
  await start(AI_ON);
  // Public pages. The header tag and the footer say AI, and the sign-in footer drops the old demo wording.
  await page.goto("/login"); expect((await words(page, "sign-in")).found).toEqual(NONE);
  await expect(page.locator(".header-tag")).toHaveText("AI + PayPal"); await expect(page.locator(".footer-built")).toHaveText("Built with PayPal Payouts and AI");
  await expect(page.locator("footer").filter({ hasText: "Sign in separately for each role." })).toHaveCount(1);
  await page.goto("/give"); const give = await words(page, "Give"); expect(give.found).toEqual(NONE); expect(give.text.match(/No real money moves\./g)).toHaveLength(1);
  await page.goto(`/gift/${giftToken}`); const gift = await words(page, "gift trail"); expect(gift.found).toEqual(NONE);
  await expect(page.getByTestId("gift-footer")).toBeVisible(); await expect(page.getByTestId("gift-footer")).not.toContainText(/test payments/i);
  // Maria: home, the new receipt form (the $6 practice default and the workshop example), then the draft receipt page before any suggestion.
  await login(page, "maria"); expect((await words(page, "claimant home")).found).toEqual(NONE);
  await page.getByRole("link", { name: "Start a $6 practice expense", exact: true }).click(); expect((await words(page, "new receipt")).found).toEqual(NONE);
  await expect(page.getByLabel("Vendor", { exact: true })).toBeVisible(); await expect(page.getByLabel("This receipt is sample data with no real personal details.")).toBeVisible();
  await page.goto("/receipts/new?example=workshop"); expect((await words(page, "new receipt, workshop example")).found).toEqual(NONE);
  await page.goto("/receipts/new"); await page.getByLabel("This receipt is sample data with no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  await expect(page.getByText(/Unpaid draft created/).first()).toBeVisible();
  // Before a suggestion: the idle strip names the model and Anthropic once.
  const idle = await words(page, "receipt page, idle"); expect(idle.found).toEqual({ idle: 1, saved: 0, check: 0 });
  // Receipt text leaves the app on this press. Afterwards the saved suggestion line names the model and Anthropic once, and the strip is gone.
  await page.getByRole("button", { name: "Request AI suggestions" }).click(); await expect(page.locator(".notice")).toContainText("AI suggestions are ready"); expect(suggestions).toBe(1);
  const ready = await words(page, "receipt page, AI suggested"); expect(ready.found).toEqual({ idle: 0, saved: 1, check: 0 });
  expect(ready.text.match(/sent to Anthropic/g), "the honest line: receipt text went to Anthropic, once").toHaveLength(1);
  await expect(page.locator(".ai-model-line")).toContainText("Powered by Claude Haiku 5.5. The receipt text was sent to Anthropic for these suggestions.");
  await expect(page.locator(".ai-label").first()).toContainText("AI suggests:"); await expect(page.locator(".receipt-evidence .muted")).toHaveText("Text in, category suggestions out. No PayPal tools or approval access.");
  expect(ready.text).toMatch(/Saved record: model AI \(Haiku 5\.5\), schema \S+\./);
  await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible();
  const confirmed = await words(page, "receipt page, confirmed"); expect(confirmed.found).toEqual({ idle: 0, saved: 1, check: 0 });
  await page.getByRole("link", { name: "View allocation", exact: true }).click(); await expect(page.getByRole("heading", { name: "$5.00 restricted. $1.00 General.", exact: true })).toBeVisible();
  const claimId = new URL(page.url()).pathname.split("/")[2]!;
  expect((await words(page, "claim page, draft")).found).toEqual(NONE); await expect(page.locator(".card-model").first()).toHaveText("Powered by Claude Haiku 5.5.");
  await page.getByRole("button", { name: "Freeze allocation for approval", exact: true }).click(); await expect(page.getByRole("status")).toContainText("allocation is frozen");
  expect((await words(page, "claim page, awaiting approval, claimant")).found).toEqual(NONE);
  // Tara: home, then the claim page. Run policy checks sends claim line and clause text to the stub. The rows say AI, and one line names the models and Anthropic.
  await logout(page); await login(page, "tara"); expect((await words(page, "approver home")).found).toEqual(NONE);
  await page.goto(`/claims/${claimId}`); expect((await words(page, "claim page, before the checks")).found).toEqual(NONE);
  await page.locator("#policy-checks").getByRole("button", { name: "Run policy checks" }).click(); await expect(page.getByRole("status")).toContainText("Policy checks ran and are stored");
  expect(compliance.length, "the stub answered the model check").toBeGreaterThanOrEqual(2);
  const checked = await words(page, "claim page, model rows"); expect(checked.found).toEqual({ idle: 0, saved: 0, check: 1 });
  expect(checked.text.match(/sent to Anthropic/g), "the honest line: clause text went to Anthropic, once").toHaveLength(1);
  await expect(page.locator("#policy-checks")).toContainText(/Checked by AI \((Haiku 5\.5|Sonnet 5\.5|Haiku 5\.5, then Sonnet 5\.5)\) at low effort\./);
  await expect(page.locator("#policy-checks")).toContainText(/Powered by Claude Haiku 5\.5( and Claude Sonnet 5\.5)?\. Claim line and clause text was sent to Anthropic\./);
  await page.getByRole("button", { name: "Approve these terms", exact: true }).click(); expect((await words(page, "claim page, one approval")).found).toEqual({ idle: 0, saved: 0, check: 1 });
  // Ben: home, the second approval, then the approved claim with its unpaid PayPal handoff and the placeholder recipient note.
  await logout(page); await login(page, "ben"); expect((await words(page, "second approver home")).found).toEqual(NONE);
  await page.goto(`/claims/${claimId}`); await page.getByRole("button", { name: "Approve these terms", exact: true }).click();
  const approved = await words(page, "claim page, approved"); expect(approved.found).toEqual({ idle: 0, saved: 0, check: 1 });
  expect(approved.text).toContain("PayPal handoff"); await expect(page.locator(".recipient-note").first()).toHaveText("Placeholder recipient for Maria. PayPal cannot pay it.");
  // Ledger, analytics and How it works. How it works may name the hosted API in its own explanation, and never Claude, sandbox or fictional.
  await page.goto("/ledger"); expect((await words(page, "ledger")).found).toEqual(NONE);
  await page.goto("/analytics"); expect((await words(page, "analytics")).found).toEqual(NONE);
  await page.goto("/architecture"); const how = await words(page, "How it works"); expect(how.found).toEqual(NONE);
  await expect(page.getByRole("button", { name: "Explore AI model", exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: /Explore Claude/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Explore AI model", exact: true }).click(); await words(page, "How it works, AI model stage");
  await page.getByRole("button", { name: "PayPal handoff", exact: true }).click(); await words(page, "How it works, PayPal handoff stage");
  // The one test-money line sits on Give alone, and no other screen says it in any form.
  for (const screen of seen.filter(entry => entry.label !== "Give")) expect(screen.text, `${screen.label}: no money line outside Give`).not.toMatch(/no real money|test money|test funds|test accounts/i);
  expect(seen.length, "every screen was read").toBeGreaterThanOrEqual(22);
  // Nothing outside the stub answered: the provider was never reached, and only the two stubbed request kinds were made.
  expect(suggestions).toBe(1);
});

test("AW-02b: with no AI key, no screen says Claude, fictional or sandbox, the receipt page says why in AI words, and no disclosure appears because nothing was sent", async ({ page }) => {
  test.setTimeout(180000); seen.length = 0;
  await start(AI_NONE);
  await page.goto("/login"); expect((await words(page, "sign-in")).found).toEqual(NONE); await expect(page.locator(".header-tag")).toHaveCount(0); await expect(page.locator(".footer-built")).toHaveText("Built with PayPal Payouts.");
  await page.goto("/give"); expect((await words(page, "Give")).found).toEqual(NONE);
  await login(page, "maria"); expect((await words(page, "claimant home")).found).toEqual(NONE);
  await page.goto("/receipts/new"); await page.getByLabel("This receipt is sample data with no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  await expect(page.getByText(/Unpaid draft created/).first()).toBeVisible();
  const receipt = await words(page, "receipt page, no key"); expect(receipt.found).toEqual(NONE);
  expect(receipt.text).toContain("AI suggestions are off in this session: no AI key is configured.");
  expect(receipt.text, "nothing was sent, so no provider is named on the receipt page").not.toMatch(/Anthropic/);
  await page.goto("/claims/C-104"); expect((await words(page, "claim page, no key")).found).toEqual(NONE);
  await page.goto("/architecture"); expect((await words(page, "How it works, no key")).found).toEqual(NONE);
  for (const screen of seen) expect(screen.text, `${screen.label}: nothing was sent, so no Powered by line`).not.toMatch(/Powered by/);
  expect(suggestions, "no request was made").toBe(0); expect(compliance).toEqual([]);
});
