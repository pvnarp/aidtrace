import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import * as s from "../db/schema";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { runModelCheck } from "../src/policy/model-run";
import { runPolicyChecks } from "../src/policy/service";
import { receiptClaim, type ReceiptLineSpec } from "../tests/support/policy-db";
import { AI_ENV, ALL_ASSISTED, allOk, setModes, stub } from "../tests/support/fund-modes";

// IAC-405 step 2 PR A, the browser check of the Assisted approver queue (docs/ASSUMPTIONS.md section 77, AS-40 and AS-41). With the fund modes flag on and an Assisted fund, an approver sees the
// Checks column, selects the two clean claims, approves them in one click, and the claim with a hold stays waiting. With the flag off the same stored claims show the queue as it always was, and the
// route does not exist. No model call is made: the stored runs come from a stub in this test process, and the app server has no AI key. Each test starts its own database and next server on 3100.
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });
const ORIGIN = "http://127.0.0.1:3100";
let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof connectDatabase>;
let server: ChildProcess | undefined, name: string;
let passwords: Record<"maria" | "tara" | "ben", string>;
const LINES: ReceiptLineSpec[] = [{ description: "Robot servo kit", amount: "20.00", category: "robot_kits_parts" }, { description: "Classroom markers", amount: "10.00", category: "classroom_supplies" }];
const GIFT_CARD = `${LINES.map(line => line.description).join("\n")}\nRaffle prize: gift card`;

async function start(serverFlag: boolean) {
  if (process.env.UI_TEST_CONTAINER !== "true") throw new Error("Use the isolated OrbStack browser service");
  name = `aidtrace_iac405_as_${randomBytes(6).toString("hex")}`;
  const adminUrl = new URL(process.env.DATABASE_URL!); adminUrl.pathname = "/postgres";
  admin = postgres(adminUrl.toString(), { max: 1 }); await admin`create database ${admin(name)}`;
  const url = new URL(adminUrl); url.pathname = `/${name}`; connection = connectDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "modes-test@personal.example.com", payeeAllowlist: ["modes-test@personal.example.com"] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  // The test process freezes the claims, so its own environment carries the flag. The app server below gets its own value.
  process.env.FUND_MODES_ENABLED = "true";
  await setModes(connection.db, ALL_ASSISTED);
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AIDTRACE_JUDGE_SESSION: "false",
    FUND_MODES_ENABLED: serverFlag ? "true" : "false", AI_RECEIPT_ENABLED: "false", AI_RULE_DRAFTS_ENABLED: "false", AI_COMPLIANCE_ENABLED: "false", AI_EXPENSE_PROPOSALS_ENABLED: "false", ANTHROPIC_API_KEY: "", PAYPAL_SANDBOX_PAYEE_EMAIL: "modes-test@personal.example.com",
    PAYEE_ALLOWLIST: "modes-test@personal.example.com", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
  for (let attempt = 0; attempt < 90; attempt++) {
    try { if ((await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Wait for the isolated server, never the main application. */ }
    if (server.exitCode !== null) throw new Error("Isolated UI server exited before readiness");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Isolated UI server readiness timed out");
}
test.afterEach(async () => {
  if (server?.pid) {
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* Already stopped. */ }
    await Promise.race([new Promise(resolve => server!.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    try { process.kill(-server.pid, "SIGKILL"); } catch { /* Already stopped. */ }
  }
  await connection?.client.end();
  if (admin && /^aidtrace_iac405_as_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]);
  const response = page.waitForResponse(r => r.url().endsWith("/api/auth/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); expect((await response).status()).toBe(303);
  await page.waitForURL(url => url.pathname === "/");
}
// AS_STILLS names a folder for screenshots (the owner visual review). Unset, nothing is written.
const still = async (page: Page, file: string) => { if (process.env.AS_STILLS) await page.screenshot({ path: `${process.env.AS_STILLS}/${file}.png`, fullPage: true }); };
const post = (page: Page, path: string, form: Record<string, string>, headers: Record<string, string> = { origin: ORIGIN }) => page.request.post(path, { form, headers, maxRedirects: 0 });

// Three frozen claims by Maria under Assisted funds: two with finished clean stored runs, one with a rules hold (a gift card on the receipt).
async function plant() {
  const db = connection.db;
  const make = async (vendor: string, source?: string) => {
    const claim = await receiptClaim(db, { vendor, lines: LINES, ...(source ? { source } : {}) });
    expect((await runPolicyChecks(db, claim.hash, { id: "tara" })).status).toBe("RAN");
    const { client } = stub(allOk);
    expect((await runModelCheck(db, claim.hash, { id: "tara" }, { env: AI_ENV, client })).status).toBe("RAN");
    return claim;
  };
  return { one: await make("Ember Bulk One"), two: await make("Ember Bulk Two"), held: await make("Ember Held Shop", GIFT_CARD) };
}
const statusOf = async (id: string) => (await connection.db.select().from(s.claims).where(eq(s.claims.id, id)))[0]!.status;
const rowOf = (page: Page, vendor: string) => page.locator(".ag-row[row-id]:not(.ag-row-pinned)", { hasText: vendor });

test("AS-40: with the flag on, an approver selects the two claims with no holds, approves them in one click, and the held claim stays waiting", async ({ page }) => {
  test.setTimeout(300_000);
  await start(true);
  const claims = await plant();
  await login(page, "tara");
  const queue = page.getByTestId("gx-approver-queue-assisted");
  await expect(queue).toBeVisible();
  await expect(page.getByTestId("gx-approver-queue")).toHaveCount(0);
  // GV-08: the assisted queue caption adds row selection.
  await expect(page.getByTestId("gx-caption")).toHaveText("Table by AG Grid Community, read only: search, sort and filter any column, select rows. Your column layout is kept for you.");
  await expect(page.locator(".reference-intro")).toHaveText("Check the items, the recipient and the funding. Two different approvers must approve the same frozen terms before anything is payable. In Assisted funds, a claim with no holds needs one approver.");
  await expect(page.getByRole("columnheader", { name: "Checks" })).toBeVisible();
  await expect(rowOf(page, "Ember Bulk One")).toContainText("No holds found");
  await expect(rowOf(page, "Ember Bulk Two")).toContainText("No holds found");
  await expect(rowOf(page, "Ember Held Shop")).toContainText(/\d+ holds?/);
  await expect(rowOf(page, "Ember Bulk One")).toContainText("Approvals: 0 of 1");
  // Computed styles, so a page that lost its stylesheet fails here and not only in a screenshot.
  expect(await page.locator(".aq-check[data-state=none-found]").first().evaluate(el => { const c = getComputedStyle(el); return { color: c.color, weight: c.fontWeight }; })).toEqual({ color: "rgb(5, 96, 58)", weight: "600" });
  expect(await page.locator(".aq-check[data-state=holds]").first().evaluate(el => getComputedStyle(el).color)).toBe("rgb(138, 75, 8)");
  expect(await page.locator(".aq-bulk").evaluate(el => { const c = getComputedStyle(el); return { display: c.display, gap: c.columnGap, bottom: c.marginBottom }; })).toEqual({ display: "flex", gap: "12px", bottom: "12px" });
  const button = page.getByTestId("aq-bulk-approve");
  await expect(button).toHaveText("Approve 0 selected"); await expect(button).toBeDisabled();
  // The held row offers no way to select it.
  const heldBox = rowOf(page, "Ember Held Shop").locator(".ag-selection-checkbox input");
  if (await heldBox.count()) expect(await heldBox.first().evaluate(el => (el as HTMLInputElement).disabled || getComputedStyle(el).visibility === "hidden" || el.closest(".ag-invisible, .ag-hidden") !== null || getComputedStyle(el.closest(".ag-selection-checkbox")!).display === "none")).toBe(true);
  await still(page, "as-1-queue-checks-before-selection");
  await rowOf(page, "Ember Bulk One").locator(".ag-selection-checkbox input").check();
  await rowOf(page, "Ember Bulk Two").locator(".ag-selection-checkbox input").check();
  await expect(button).toHaveText("Approve 2 selected"); await expect(button).toBeEnabled();
  expect(await button.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  await still(page, "as-2-queue-two-selected");
  await button.click();
  const result = page.getByTestId("aq-bulk-result");
  await expect(result).toContainText("Approved 2 claims.");
  await expect(result).not.toContainText("Skipped");
  await expect(queue.getByText("Ember Held Shop")).toBeVisible();
  await expect(queue.getByText("Ember Bulk One")).toHaveCount(0);
  await expect(queue.getByText("Ember Bulk Two")).toHaveCount(0);
  await still(page, "as-3-queue-after-bulk-approve");
  expect(await statusOf(claims.one.id)).toBe("APPROVED"); expect(await statusOf(claims.two.id)).toBe("APPROVED"); expect(await statusOf(claims.held.id)).toBe("AWAITING_APPROVAL");
  expect((await connection.db.select().from(s.approvals).where(eq(s.approvals.decisionHash, claims.held.hash)))).toHaveLength(0);
  expect((await connection.db.select().from(s.approvals).where(eq(s.approvals.decisionHash, claims.one.hash))).map(row => row.approverId)).toEqual(["tara"]);
  // The claim page line in its three states.
  await page.goto(`/claims/${claims.one.id}`);
  const line = page.locator(".hybrid-review-count");
  await expect(line).toHaveText("Human reviews: 1 of 1, Assisted, no holds found");
  await expect(line).toHaveAttribute("data-review-mode", "ASSISTED_NO_HOLDS");
  expect(await line.evaluate(el => { const c = getComputedStyle(el); return { size: c.fontSize, margin: c.marginTop }; })).toEqual({ size: "14px", margin: "8px" });
  // The words that used to say two. All come from the stored decision the server read.
  await expect(page.locator("#approvals-title")).toHaveText("Human review");
  await expect(page.locator("#approvals .claim-reference")).toContainText("The approval binds this reference.");
  await expect(page.locator("#approvals .claim-reference")).not.toContainText("Both approvals");
  await expect(page.locator(".trace li", { hasText: "Approvals" })).toContainText("People: 1 of 1");
  await expect(page.locator("#policy-checks .muted").last()).toHaveText("No holds found, so one approver was enough.");
  await expect(page.locator("main")).not.toContainText("Two approvers are still required");
  await still(page, "as-4-claim-page-no-holds-line");
  await page.goto(`/claims/${claims.held.id}`);
  await expect(line).toHaveText("Human reviews: 0 of 2");
  await expect(line).toHaveAttribute("data-review-mode", "ASSISTED_HOLD");
  await expect(page.locator("#approvals-title")).toHaveText("Two independent approvals");
  await expect(page.locator("#approvals .claim-reference")).toContainText("Both approvals bind this reference.");
  await expect(page.locator("#policy-checks .muted").last()).toHaveText("Holds do not block approval. Two approvers are still required.");
  await expect(page.locator("h1")).toContainText("Awaiting two approvals");
  await still(page, "as-5-claim-page-hold-line");
  // A hold means two approvals: the held claim is not recognized by one approver, and a claimant has no way in to the route.
  expect((await post(page, "/api/approvals/bulk", { claim: `${claims.held.id}:1`, decisionHash: claims.held.hash })).status()).toBe(400);
  const skipped = await page.request.post("/api/approvals/bulk", { form: { claim: `${claims.held.id}:1` }, headers: { origin: ORIGIN } });
  expect(skipped.status()).toBe(200);
  expect((await skipped.json()).skipped[0].reason).toBe("HOLD_FOUND");
  expect(await statusOf(claims.held.id)).toBe("AWAITING_APPROVAL");
  await page.getByRole("button", { name: "Sign out" }).click(); await page.waitForURL(url => url.pathname === "/login");
  await login(page, "maria");
  expect((await post(page, "/api/approvals/bulk", { claim: `${claims.held.id}:1` })).status()).toBe(403);
});

test("AS-41: with the flag off, the same stored claims show the queue as it always was, and the route does not exist", async ({ page }) => {
  test.setTimeout(300_000);
  await start(false);
  const claims = await plant();
  await login(page, "tara");
  await expect(page.getByTestId("gx-approver-queue")).toBeVisible();
  await expect(rowOf(page, "Ember Bulk One")).toBeVisible();
  await expect(page.locator(".reference-intro")).toHaveText("Check the items, the recipient and the funding. Two different approvers must approve the same frozen terms before anything is payable.");
  await expect(page.getByTestId("gx-approver-queue-assisted")).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Checks" })).toHaveCount(0);
  await expect(page.locator(".ag-selection-checkbox")).toHaveCount(0);
  await expect(page.getByTestId("aq-bulk-approve")).toHaveCount(0);
  await expect(page.getByText("No holds found")).toHaveCount(0);
  await expect(rowOf(page, "Ember Bulk One")).toContainText("Approvals: 0 of 2");
  await still(page, "as-6-flag-off-queue");
  expect((await post(page, "/api/approvals/bulk", { claim: `${claims.one.id}:1` })).status()).toBe(404);
  expect((await page.request.get("/api/approvals/bulk")).status()).toBe(404);
  await page.goto(`/claims/${claims.one.id}`);
  await expect(page.locator(".hybrid-review-count")).toHaveText("Human reviews: 0 of 2");
  await expect(page.locator(".hybrid-review-count")).toHaveAttribute("data-review-mode", "MANUAL");
  await expect(page.locator("#approvals-title")).toHaveText("Two independent approvals");
  await expect(page.locator("#approvals .claim-reference")).toContainText("Both approvals bind this reference.");
  await expect(page.locator("#policy-checks .muted").last()).toHaveText("Holds do not block approval. Two approvers are still required.");
  expect(await statusOf(claims.one.id)).toBe("AWAITING_APPROVAL");
});
