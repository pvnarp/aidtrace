import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { approveDecision, freezeDecision } from "../src/ledger/service";
import { refreshClaimPayout, sendClaimPayout } from "../src/ledger/payout";
import * as s from "../db/schema";
import type { PayoutTransport, PersistedPayout } from "../src/paypal/adapter";

// PE-02 to PE-04 (IAC-415 PR 8, "payout end states say what is true", docs/GATE_REPORT.md section 56). The October 31 keyed rehearsal ended one send UNKNOWN (the adapter failed before PayPal
// answered) and one PAID after a single Refresh status; three passages on those pages read wrong. Each test starts its own isolated database and its own `next start` on 3100, then
// drives the REAL ledger functions (freezeDecision, approveDecision, sendClaimPayout, refreshClaimPayout) with an in-test fake PayoutTransport. The attempt rows come from those
// functions, never from an insert. The fake is a test double, NOT a PayPal result. The server runs KEYED with synthetic credentials so an approver's page has payment configured
// (canPay true), which is the case where the old words promised a button. Nothing here presses Send or Refresh status: every request that leaves loopback is aborted and
// counted, and every POST to a claim action route is counted (both must stay empty).
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });
const PAYEE = "payout-end@personal.example.com";
const UNKNOWN_TITLE = "Send outcome unknown. Do not send again.";
const UNKNOWN_DETAIL = "PayPal did not confirm this send. It is neither paid nor failed. Reconcile it in PayPal; the saved sender IDs identify it.";
const UNKNOWN_REFRESH_DETAIL = "PayPal did not confirm this send, but it returned a batch ID. It is neither paid nor failed. An approver can use Refresh status below.";
const OLD_NOTE = "Submitted, not yet verified as paid";
const SUBMITTED_TITLE = "Payment submitted. Not yet verified as paid.";
const REFRESH_DETAIL = "An approver can use Refresh status below. A batch acceptance or pending item is not proof of payment.";
const CHECK_DETAIL = "An approver checks the result with PayPal. A batch acceptance or pending item is not proof of payment.";
const NOT_RECORDED = "No provider balance was recorded at submission.";
const BATCH = "PE_SYNTHETIC_BATCH_1"; const ITEM = "PE_SYNTHETIC_ITEM_1";

let admin: ReturnType<typeof postgres> | undefined, connection: ReturnType<typeof connectDatabase> | undefined;
let server: ChildProcess | undefined, name = "", decisionHash = "";
let passwords: Record<"maria" | "tara" | "ben", string>;

test.beforeEach(async () => {
  if (process.env.UI_TEST_CONTAINER !== "true") throw Error("Use isolated OrbStack browser service");
  const url = new URL(process.env.DATABASE_URL!); url.pathname = "/postgres";
  admin = postgres(url.toString(), { max: 1 }); name = "aidtrace_pe_" + randomBytes(6).toString("hex");
  await admin`create database ${admin(name)}`; url.pathname = "/" + name;
  connection = connectDatabase(url.toString()); await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: PAYEE, payeeAllowlist: [PAYEE] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  // C-104 reaches APPROVED through the real ledger service: Maria freezes, then Tara and Ben approve the same decision.
  const frozen = await freezeDecision(connection.db, "C-104", "maria");
  if (frozen.status !== "AWAITING_APPROVAL") throw Error("Expected a funded decision");
  await approveDecision(connection.db, frozen.decisionId, "tara", frozen.decisionHash); await approveDecision(connection.db, frozen.decisionId, "ben", frozen.decisionHash);
  decisionHash = frozen.decisionHash;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AIDTRACE_JUDGE_SESSION: "false",
    AI_RECEIPT_ENABLED: "false", AI_EXPENSE_PROPOSALS_ENABLED: "false", AI_ANALYTICS_ENABLED: "false", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false",
    PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "pe-synthetic-client-id", PAYPAL_CLIENT_SECRET: "pe-synthetic-secret", PAYEE_ALLOWLIST: PAYEE } });
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
  if (admin && /^aidtrace_pe_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
// Aborts and counts every request whose host is not the loopback app, and counts every POST to a claim action route (Send, Refresh status, retry). Both lists must stay empty.
async function watch(page: Page) {
  const seen = { external: [] as string[], actionPosts: [] as string[] };
  page.on("request", request => { if (request.method() === "POST" && /\/api\/claims\//.test(request.url())) seen.actionPosts.push(request.url()); });
  await page.route("**/*", route => { const target = new URL(route.request().url()); if (["127.0.0.1", "localhost"].includes(target.hostname)) return route.continue(); seen.external.push(target.toString()); return route.abort(); });
  return seen;
}
async function login(page: Page, user: keyof typeof passwords) {
  await page.context().clearCookies();
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]);
  const response = page.waitForResponse(r => r.url().endsWith("/api/auth/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); expect((await response).status()).toBe(303);
  await page.waitForURL(url => url.pathname === "/"); await page.goto("/claims/C-104");
}
const attempts = () => connection!.db.select().from(s.disbursementAttempts);
const claimStatus = async () => (await connection!.db.select().from(s.claims).where(eq(s.claims.id, "C-104")))[0]!.status;
type Counts = { send: number; batch: number; item: number };
// A fake transport. `mode` picks the end state. It records what it was asked, so a test can see the ledger functions (and only they) used it.
function fakeTransport(mode: "send-throws" | "send-ambiguous" | "paid", counts: Counts): PayoutTransport {
  let sent: PersistedPayout | undefined;
  return {
    validatePayout() {}, async balance() { return { readable: false }; },
    // "send-ambiguous" is an HTTP 200 that carries ids: the ledger keeps the ids and still stores UNKNOWN (only a 201 with a batch id is SUBMITTED).
    async send(payout) { counts.send++; sent = payout; if (mode === "send-throws") throw new Error("Synthetic adapter failure before PayPal answered"); if (mode === "send-ambiguous") return { httpStatus: 200, batchId: BATCH, itemId: ITEM, batchStatus: "PENDING" }; return { httpStatus: 201, batchId: BATCH, batchStatus: "PENDING" }; },
    async batch() { counts.batch++; return { httpStatus: 200, batchId: BATCH, senderBatchId: sent!.senderBatchId, batchStatus: "SUCCESS", itemIds: [ITEM] }; },
    async item() { counts.item++; return { httpStatus: 200, itemId: ITEM, batchId: BATCH, senderBatchId: sent!.senderBatchId, senderItemId: sent!.senderItemId, payeeEmail: sent!.payeeEmail, amountCents: 50000n, itemStatus: "SUCCESS", feeCents: 25n }; },
  };
}
async function quiet(page: Page, seen: Awaited<ReturnType<typeof watch>>) {
  expect(seen.external, "requests that left loopback").toEqual([]); expect(seen.actionPosts, "claim action POSTs").toEqual([]);
  await expect(page.getByRole("button", { name: /Send .* with PayPal/ })).toHaveCount(0);
}

test("PE-02: an UNKNOWN send reads as unknown, promises no Refresh status and drops the pre-send warning, for the approver and the claimant", async ({ page }) => {
  const seen = await watch(page); const counts: Counts = { send: 0, batch: 0, item: 0 };
  // The fake send throws, so sendClaimPayout stores an honest UNKNOWN attempt: no batch id, last error SEND_OUTCOME_UNKNOWN.
  expect(await sendClaimPayout(connection!.db, "C-104", "ben", decisionHash, fakeTransport("send-throws", counts))).toEqual({ state: "UNKNOWN" });
  expect(counts).toEqual({ send: 1, batch: 0, item: 0 });
  const stored = await attempts(); expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ state: "UNKNOWN", payoutBatchId: null, lastErrorCode: "SEND_OUTCOME_UNKNOWN", providerBalanceCents: null });
  expect(await claimStatus()).toBe("PAYOUT_PROCESSING");
  for (const user of ["ben", "maria"] as const) {
    await login(page, user);
    await expect(page.getByRole("heading", { level: 1 }), `${user} title`).toHaveText(UNKNOWN_TITLE);
    await expect(page.locator(".journey-critical"), `${user} guided detail`).toContainText(UNKNOWN_DETAIL);
    // The page really shows the stored UNKNOWN attempt and no batch id, which is why no Refresh status button can render.
    const payment = page.locator("#payment"); await expect(payment).toHaveCount(1);
    await expect(payment, `${user} payment section`).toContainText("SEND_OUTCOME_UNKNOWN");
    await expect(payment, `${user} balance sentence`).toContainText(`Book balances in this app are not proof of PayPal cash. ${NOT_RECORDED}`);
    await expect(payment, `${user} stale warning`).not.toContainText("may reject");
    await expect(page.getByRole("button", { name: "Refresh status" }), `${user} refresh button`).toHaveCount(0);
    await expect(page.locator("body"), `${user} refresh text`).not.toContainText("Refresh status below");
    await expect(page.locator("body"), `${user} any refresh text`).not.toContainText("Refresh status");
    await expect(page.locator("body"), `${user} old title`).not.toContainText("Payment submitted");
    // The summary note ("Submitted, not yet verified as paid") must not sit beside the unknown title. The claim page builds its summary note but ClaimHeader and DecisionPanel render no `data.note`, so the page itself never shows it; this asserts that fact in a browser.
    await expect(page.locator("body"), `${user} old summary note`).not.toContainText(OLD_NOTE);
    await quiet(page, seen);
  }
  // Nothing the browser did changed the ledger rows.
  const after = await attempts(); expect(after).toHaveLength(1); expect(after[0]).toMatchObject({ state: "UNKNOWN", payoutBatchId: null, lastErrorCode: "SEND_OUTCOME_UNKNOWN" });
  expect(await claimStatus()).toBe("PAYOUT_PROCESSING"); expect(counts).toEqual({ send: 1, batch: 0, item: 0 });
});

test("PE-03: a submitted payment keeps its title, then after one refresh the PAID page has no pre-send warning and says no balance was recorded", async ({ page }) => {
  const seen = await watch(page); const counts: Counts = { send: 0, batch: 0, item: 0 }; const transport = fakeTransport("paid", counts);
  expect(await sendClaimPayout(connection!.db, "C-104", "ben", decisionHash, transport)).toEqual({ state: "SUBMITTED" });
  expect((await attempts())[0]).toMatchObject({ state: "SUBMITTED", payoutBatchId: BATCH, providerBalanceCents: null });
  // Submitted, not yet verified: unchanged title. Ben (approver, payment configured, batch id recorded) is offered the Refresh status button, which is present and never pressed.
  await login(page, "ben");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(SUBMITTED_TITLE);
  await expect(page.locator(".journey-critical")).toContainText(REFRESH_DETAIL);
  await expect(page.getByRole("button", { name: "Refresh status", exact: true })).toHaveCount(1);
  await expect(page.locator("#payment")).toContainText(`Book balances in this app are not proof of PayPal cash. ${NOT_RECORDED}`);
  await expect(page.locator("#payment")).not.toContainText("may reject");
  await quiet(page, seen);
  // Maria never gets that button, so her guide must not point at it.
  await login(page, "maria");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(SUBMITTED_TITLE);
  await expect(page.locator(".journey-critical")).toContainText(CHECK_DETAIL);
  await expect(page.locator("body")).not.toContainText("Refresh status");
  await quiet(page, seen);
  // The real refresh function, with an item SUCCESS from the fake, takes C-104 to PAID.
  expect((await refreshClaimPayout(connection!.db, "C-104", "ben", transport)).state).toBe("SETTLED");
  expect(counts).toEqual({ send: 1, batch: 1, item: 1 });
  expect(await claimStatus()).toBe("PAID"); expect((await attempts())[0]).toMatchObject({ state: "SETTLED", itemStatus: "SUCCESS", payoutBatchId: BATCH, providerBalanceCents: null });
  for (const user of ["ben", "maria"] as const) {
    await login(page, user);
    await expect(page.getByRole("heading", { level: 1 }), `${user} title`).toHaveText("$500.00 paid. Settlement verified.");
    const payment = page.locator("#payment"); await expect(payment).toHaveCount(1);
    await expect(payment, `${user} balance sentence`).toContainText(`Book balances in this app are not proof of PayPal cash. ${NOT_RECORDED}`);
    await expect(payment, `${user} stale warning`).not.toContainText("may reject");
    await expect(payment, `${user} stale warning`).not.toContainText("insufficient funds");
    await expect(payment, `${user} unavailable`).not.toContainText("Provider balance is unavailable");
    // The decision (Opus, IAC-415 PR 8): Refresh status stays on a PAID claim for the approver, because it is the only browser path that detects a later reversal. The claimant never had it.
    await expect(page.getByRole("button", { name: "Refresh status", exact: true }), `${user} refresh button`).toHaveCount(user === "ben" ? 1 : 0);
    await quiet(page, seen);
  }
  // The browser pressed nothing: the fake saw exactly the two calls the ledger functions made, and the attempt is unchanged.
  expect(counts).toEqual({ send: 1, batch: 1, item: 1 }); expect(await attempts()).toHaveLength(1);
});

test("PE-04: an UNKNOWN send that kept a batch id says so, points the approver at Refresh status, and gives the claimant no button", async ({ page }) => {
  const seen = await watch(page); const counts: Counts = { send: 0, batch: 0, item: 0 };
  // The fake answers HTTP 200 with a batch id and an item id. The real sendClaimPayout keeps the ids and still stores UNKNOWN (only a 201 with a batch id is SUBMITTED), so the Refresh status form renders for the approver.
  expect(await sendClaimPayout(connection!.db, "C-104", "ben", decisionHash, fakeTransport("send-ambiguous", counts))).toEqual({ state: "UNKNOWN" });
  expect(counts).toEqual({ send: 1, batch: 0, item: 0 });
  const stored = await attempts(); expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ state: "UNKNOWN", payoutBatchId: BATCH, payoutItemId: ITEM, lastHttpStatus: 200, lastErrorCode: "SEND_OUTCOME_UNKNOWN", providerBalanceCents: null });
  expect(await claimStatus()).toBe("PAYOUT_PROCESSING");
  await login(page, "ben");
  await expect(page.getByRole("heading", { level: 1 }), "ben title").toHaveText(UNKNOWN_TITLE);
  await expect(page.locator(".journey-critical"), "ben guided detail").toContainText(UNKNOWN_REFRESH_DETAIL);
  await expect(page.locator(".journey-critical"), "ben refresh sentence").toContainText("An approver can use Refresh status below.");
  // Present, never pressed.
  await expect(page.getByRole("button", { name: "Refresh status", exact: true }), "ben refresh button").toHaveCount(1);
  const benPayment = page.locator("#payment"); await expect(benPayment).toHaveCount(1);
  await expect(benPayment, "ben payment section").toContainText("SEND_OUTCOME_UNKNOWN");
  await expect(benPayment, "ben balance sentence").toContainText(`Book balances in this app are not proof of PayPal cash. ${NOT_RECORDED}`);
  await expect(benPayment, "ben stale warning").not.toContainText("may reject");
  await expect(page.locator("body"), "ben old title").not.toContainText("Payment submitted");
  await expect(page.locator("body"), "ben old summary note").not.toContainText(OLD_NOTE);
  await quiet(page, seen);
  await login(page, "maria");
  await expect(page.getByRole("heading", { level: 1 }), "maria title").toHaveText(UNKNOWN_TITLE);
  await expect(page.locator(".journey-critical"), "maria guided detail").toContainText(UNKNOWN_DETAIL);
  await expect(page.locator(".journey-critical"), "maria refresh sentence").not.toContainText("Refresh status below");
  await expect(page.locator(".journey-critical"), "maria batch sentence").not.toContainText("batch ID");
  await expect(page.locator("body"), "maria any refresh text").not.toContainText("Refresh status");
  await expect(page.getByRole("button", { name: "Refresh status" }), "maria refresh button").toHaveCount(0);
  await expect(page.locator("body"), "maria old title").not.toContainText("Payment submitted");
  await expect(page.locator("body"), "maria old summary note").not.toContainText(OLD_NOTE);
  await quiet(page, seen);
  // The browser pressed nothing: the fake saw only the one send the ledger function made, and the attempt is unchanged.
  const after = await attempts(); expect(after).toHaveLength(1); expect(after[0]).toMatchObject({ state: "UNKNOWN", payoutBatchId: BATCH, payoutItemId: ITEM });
  expect(await claimStatus()).toBe("PAYOUT_PROCESSING"); expect(counts).toEqual({ send: 1, batch: 0, item: 0 });
});
