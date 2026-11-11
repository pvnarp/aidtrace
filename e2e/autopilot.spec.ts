import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { approveDecision, freezeDecision } from "../src/ledger/service";
import { runPolicySweep } from "../src/fund-modes/policy-sweep";
import { RECEIPT_PAYEE, receiptClaim } from "../tests/support/policy-db";
import { ALL_AUTOPILOT, SWEEP_ENV, allOk, setModes, stub } from "../tests/support/fund-modes";
import type { PayoutTransport } from "../src/paypal/adapter";

// IAC-405 step 3 PR P, the browser checks of the Autopilot kill switch and the claim page line (docs/ASSUMPTIONS.md section 78, AU-30 to AU-32). With both flags on, one approver proposes turning
// automation on, cannot confirm it, a second approver confirms it and either can turn it off. With the second flag off the section, the mode option and both routes do not exist. A planted automated
// record shows the claim page line and the Disagree control. No send happens: the provider is never configured and nothing here sets an AI key. Each test starts its own database and next server on 3100.
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });
const ORIGIN = "http://127.0.0.1:3100";
const RULES = "/funds/fund_a/rules";
let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof connectDatabase>;
let server: ChildProcess | undefined, name: string;
let passwords: Record<"maria" | "tara" | "ben", string>;

async function start(autopilot: boolean, payee = "modes-test@personal.example.com") {
  if (process.env.UI_TEST_CONTAINER !== "true") throw new Error("Use the isolated OrbStack browser service");
  name = `aidtrace_iac405_au_${randomBytes(6).toString("hex")}`;
  const adminUrl = new URL(process.env.DATABASE_URL!); adminUrl.pathname = "/postgres";
  admin = postgres(adminUrl.toString(), { max: 1 }); await admin`create database ${admin(name)}`;
  const url = new URL(adminUrl); url.pathname = `/${name}`; connection = connectDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: payee, payeeAllowlist: [payee] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(),
    FUND_MODES_ENABLED: "true", FUND_AUTOPILOT_ENABLED: autopilot ? "true" : "false", AI_RECEIPT_ENABLED: "false", AI_RULE_DRAFTS_ENABLED: "false", AI_COMPLIANCE_ENABLED: "false", AI_EXPENSE_PROPOSALS_ENABLED: "false", ANTHROPIC_API_KEY: "", PAYPAL_SANDBOX_PAYEE_EMAIL: "modes-test@personal.example.com",
    PAYEE_ALLOWLIST: payee, PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
  for (let attempt = 0; attempt < 90; attempt++) {
    try { if ((await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Wait for the isolated server, never the main application. */ }
    if (server.exitCode !== null) throw new Error("Isolated UI server exited before readiness");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Isolated UI server readiness timed out");
}
// AU-33 sets the two flags in the test process (the ledger reads them there); put them back so a later spec file in the same run starts its server with its own values.
const ORIGINAL_FLAGS = { modes: process.env.FUND_MODES_ENABLED, autopilot: process.env.FUND_AUTOPILOT_ENABLED };
const putBack = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
test.afterEach(async () => {
  putBack("FUND_MODES_ENABLED", ORIGINAL_FLAGS.modes); putBack("FUND_AUTOPILOT_ENABLED", ORIGINAL_FLAGS.autopilot);
  if (server?.pid) {
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* Already stopped. */ }
    await Promise.race([new Promise(resolve => server!.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    try { process.kill(-server.pid, "SIGKILL"); } catch { /* Already stopped. */ }
  }
  await connection?.client.end();
  if (admin && /^aidtrace_iac405_au_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]);
  const response = page.waitForResponse(r => r.url().endsWith("/api/auth/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); expect((await response).status()).toBe(303);
  await page.waitForURL(url => url.pathname === "/");
}
async function signOut(page: Page) { await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(url => url.pathname === "/login"); }
const post = (page: Page, path: string, form: Record<string, string>, headers: Record<string, string> = { origin: ORIGIN }) => page.request.post(path, { form, headers, maxRedirects: 0 });

test("AU-30: with both flags on, one approver proposes automation, cannot confirm it, a second confirms it, and an approver turns it off", async ({ page }) => {
  test.setTimeout(240_000);
  await start(true);
  await login(page, "tara"); await page.goto(RULES);
  await expect(page.getByRole("heading", { name: "Autopilot switch" })).toBeVisible();
  await expect(page.getByTestId("automation-state")).toContainText("Automation is off");
  // Computed styles, so a page that lost its stylesheet fails here and not only in a screenshot.
  expect(await page.getByTestId("automation-switch").evaluate(el => { const s = getComputedStyle(el); return { top: s.paddingTop, margin: s.marginTop }; })).toEqual({ top: "24px", margin: "32px" });
  await expect(page.getByRole("button", { name: /Propose Autopilot/ })).toBeVisible();
  await page.getByRole("button", { name: /Propose turning automation on/ }).click();
  await expect(page.getByTestId("rules-notice")).toContainText("Turning automation on is proposed");
  await expect(page.getByTestId("automation-pending")).toContainText("A different approver must confirm it.");
  await expect(page.getByRole("button", { name: /Confirm turning automation on/ })).toHaveCount(0);
  // The route refuses an extra field, a foreign origin and a claimant.
  expect((await post(page, "/api/funds/fund_a/automation", { action: "propose", extra: "1" })).status()).toBe(400);
  expect((await post(page, "/api/funds/fund_a/automation", { action: "propose" }, { origin: "http://evil.example" })).status()).toBe(403);
  await signOut(page);
  await login(page, "ben"); await page.goto(RULES);
  await page.getByRole("button", { name: /Confirm turning automation on/ }).click();
  await expect(page.getByTestId("rules-notice")).toContainText("Automation is on for the organization");
  await expect(page.getByTestId("automation-state")).toContainText("Automation is on");
  await page.getByRole("button", { name: "Turn automation off" }).click();
  await expect(page.getByTestId("rules-notice")).toContainText("Automation is off");
  await expect(page.getByTestId("automation-state")).toContainText("Automation is off");
  await expect(page.getByTestId("automation-state")).toContainText("an approver turned it off");
  expect((await connection.client`select event, reason from automation_switch_events order by seq`).map(row => `${row.event}:${row.reason ?? ""}`)).toEqual(["PROPOSE_ON:", "ON:", "OFF:APPROVER"]);
  await signOut(page);
  await login(page, "maria");
  expect((await post(page, "/api/funds/fund_a/automation", { action: "propose" })).status()).toBe(403);
});

test("AU-31: with the second flag off, the switch section, the Autopilot option and both routes do not exist", async ({ page }) => {
  test.setTimeout(240_000);
  await start(false);
  await login(page, "tara"); await page.goto(RULES);
  await expect(page.getByRole("heading", { name: "How claims are approved" })).toBeVisible();
  await expect(page.getByTestId("automation-switch")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Propose Autopilot/ })).toHaveCount(0);
  await expect(page.getByText("Autopilot", { exact: false })).toHaveCount(0);
  expect((await post(page, "/api/funds/fund_a/automation", { action: "propose" })).status()).toBe(404);
  expect((await post(page, "/api/claims/C-104/automation", { action: "disagree" })).status()).toBe(404);
});

test("AU-32: a claim recognized by an automated record shows the guardrail line, labels demo history, and offers Disagree to an approver once it was sent", async ({ page }) => {
  test.setTimeout(240_000);
  await start(true);
  const frozen = await freezeDecision(connection.db, "C-104", "maria");
  if (frozen.status !== "AWAITING_APPROVAL") throw new Error("Expected a funded decision");
  const inputs = { claimCents: "28000", guardrails: {
    G1: { pass: true, okLines: 3, checkedPairs: 6 }, G2: { pass: true, lines: 3, suppliesCapCents: "25000", equipmentCapCents: "50000" }, G3: { pass: true, capCents: "100000", funds: ["fund_a:0+10000"] },
    G4: { pass: true, usedCents: "0", claimCents: "28000", capCents: "50000" }, G5: { pass: true, priorClaim: "C-050" },
    G6: { pass: true, days: 30, anchorSeenAt: "2026-09-17T00:00:00.000Z", anchorSource: "FIXTURE", demoHistory: true }, G7: { pass: true, drawn: true, draw: 42, samplePercent: 5, sampled: false }, G8: { pass: true } } };
  // Planted with the triggers off for this one transaction: the claim was never really recognized, and no send happens.
  const plant = async (kind: string) => connection.client.begin(async q => {
    await q`set local session_replication_role = replica`;
    await q`insert into automated_decisions (decision_hash, kind, inputs) values (${frozen.decisionHash}, ${kind}, ${JSON.stringify(inputs)}::jsonb)`;
  });
  await plant("AUTO_RECOGNIZED");
  await login(page, "tara"); await page.goto("/claims/C-104");
  const trail = page.getByTestId("autopilot-trail");
  await expect(trail.getByRole("heading", { name: "Approved under Autopilot guardrails" })).toBeVisible();
  await expect(trail.locator("[data-guardrail]")).toHaveCount(8);
  await expect(trail.locator('[data-guardrail="G6"]')).toContainText("demo history");
  await expect(trail.locator('[data-guardrail="G7"]')).toContainText("Audit draw 42");
  await expect(trail).not.toContainText(/cleared|passed|approved by/i);
  await expect(trail.getByTestId("autopilot-payment")).toHaveText("Payment: not sent yet.");
  await expect(trail).not.toContainText(/Paid/);
  await expect(trail.getByRole("button", { name: "Disagree" })).toHaveCount(0); // not sent yet
  await plant("AUTO_SENT");
  await page.reload();
  await expect(trail.getByRole("button", { name: "Disagree" })).toBeVisible();
  expect(await trail.evaluate(el => getComputedStyle(el).paddingTop)).not.toBe("0px");
  await trail.getByRole("button", { name: "Disagree" }).click();
  await page.waitForURL(url => url.pathname === "/claims/C-104");
  expect((await connection.client`select event, reason, actor_id from automation_switch_events`).map(row => `${row.event}:${row.reason}:${row.actor_id}`)).toEqual(["OFF:DISAGREE:tara"]);
  await page.goto(RULES);
  await expect(page.getByTestId("automation-state")).toContainText("an approver disagreed with an automated payment");
  await signOut(page);
  await login(page, "maria"); await page.goto("/claims/C-104");
  await expect(page.getByTestId("autopilot-trail")).toBeVisible();
  await expect(page.getByRole("button", { name: "Disagree" })).toHaveCount(0);
  expect((await post(page, "/api/claims/C-104/automation", { action: "disagree" })).status()).toBe(403);
});

// AU-33 (IAC-405 PR P merge fix): the real flow, no planted records. Both flags on, two approvers turn the switch on, a sweep with a stub provider recognizes and sends one claim, and a second claim whose
// send is blocked is taken over by approvers. The pages are checked for contradictions and photographed into local/rules-ui-artifacts. The provider is a stub: no PayPal call and no model call is made.
test("AU-33: an auto-recognized and sent claim reads Autopilot only, a blocked one reads as a takeover, and the pages do not contradict themselves", async ({ page }) => {
  test.setTimeout(300_000);
  await start(true, RECEIPT_PAYEE);
  process.env.FUND_MODES_ENABLED = "true"; process.env.FUND_AUTOPILOT_ENABLED = "true";
  const db = connection.db;
  const prior = await receiptClaim(db, { vendor: "Earlier shop", lines: [{ description: "Earlier markers", amount: "30.00", category: "classroom_supplies" }] });
  await approveDecision(db, prior.decisionId, "tara", prior.hash); await approveDecision(db, prior.decisionId, "ben", prior.hash);
  await connection.client`update claims set status = 'PAID' where id = ${prior.id}`;
  await setModes(db, ALL_AUTOPILOT);
  const [proposal] = await connection.client`insert into automation_switch_events (organization_id, event, actor_id) values ('cedar-hollow', 'PROPOSE_ON', 'tara') returning seq`;
  await connection.client`insert into automation_switch_events (organization_id, event, actor_id, proposal_seq) values ('cedar-hollow', 'ON', 'ben', ${proposal!.seq})`;
  const provider = (blocked: boolean): PayoutTransport => ({ validatePayout: () => undefined, balance: async () => { if (blocked) throw new Error("the balance is not readable"); return { readable: false }; },
    send: async () => ({ httpStatus: 201, batchId: "BATCH_AU33", batchStatus: "PENDING" }), batch: async () => { throw new Error("not used"); }, item: async () => { throw new Error("not used"); } }) as PayoutTransport;
  const sweep = (blocked: boolean) => runPolicySweep(db, { env: { ...SWEEP_ENV, FUND_AUTOPILOT_ENABLED: "true" }, model: { client: stub(allOk).client }, log: () => undefined, provider: provider(blocked), audit: () => 50 });
  const lines = (n: number) => [{ description: "Robot servo kit", amount: `${40 + n}.00`, category: "robot_kits_parts" }, { description: "Classroom markers", amount: `${25 + n}.00`, category: "classroom_supplies" }];
  const sent = await receiptClaim(db, { vendor: "Shop number 1", lines: lines(1) });
  await sweep(false);
  expect((await connection.client`select count(*)::int as n from disbursements where claim_id = ${sent.id}`)[0]!.n).toBe(1);
  const stuck = await receiptClaim(db, { vendor: "Shop number 2", lines: lines(2) });
  await sweep(true);
  expect((await connection.client`select count(*)::int as n from disbursements where claim_id = ${stuck.id}`)[0]!.n).toBe(0);
  expect((await connection.client`select count(*)::int as n from automated_decisions where decision_hash = ${stuck.hash} and kind = 'AUTO_RECOGNIZED'`)[0]!.n).toBe(1);
  const shot = (name: string) => page.screenshot({ path: `local/rules-ui-artifacts/${name}.png`, fullPage: true });
  const body = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");
  // IAC-405 takeover wording: while fewer than two takeover approvals exist, neither the trace rail nor the PayPal card may say the payment is ready.
  const NOT_READY = "Not ready: two approvers must take over"; const READY_WORDS = ["Ready, unpaid", "Ready, not sent", "Unpaid in this keyless session", "No payment has been sent yet"];
  const expectTakeoverNotReady = async () => {
    const t = await body();
    expect(t, NOT_READY).toContain(NOT_READY);
    for (const word of READY_WORDS) expect(t, word).not.toContain(word);
    await expect(page.locator("nav.trace-nav li", { hasText: "PayPal" })).toContainText("Not ready");
  };

  await login(page, "tara"); await page.goto(`/claims/${sent.id}`);
  await expect(page.getByTestId("autopilot-trail")).toBeVisible();
  let text = await body();
  for (const needle of ["Autopilot review", "Human reviews: none required. Approved under Autopilot guardrails.", "The guardrail record binds this reference.", "No person approval was required."]) expect(text, needle).toContain(needle);
  for (const banned of ["Two independent approvals", "Human reviews: 0 of 2", "Both approvals bind this reference", "People: 0 of 2", "Waiting for two approvers", "Automatic payment did not go out", "Two approvers are still required"]) expect(text, banned).not.toContain(banned);
  await expect(page.locator("nav.trace-nav")).toContainText("Autopilot");
  await expect(page.getByTestId("autopilot-payment")).toHaveText("Payment: sent to PayPal, not paid yet.");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Payment submitted. Not yet verified as paid.");
  await shot("au33-sent");

  await page.goto(`/claims/${stuck.id}`);
  await expect(page.getByTestId("autopilot-people")).toHaveText("People: 0 of 2");
  await expectTakeoverNotReady();
  await page.getByRole("button", { name: "Approve to finish this claim" }).click();
  await page.waitForURL(url => url.pathname === `/claims/${stuck.id}`);
  await expect(page.getByTestId("autopilot-people")).toHaveText("People: 1 of 2");
  await expectTakeoverNotReady();
  text = await body();
  for (const needle of ["Automatic payment did not go out. Two approvers can finish this claim.", "People: 1 of 2", "Two independent approvals", "Human reviews: 1 of 2"]) expect(text, needle).toContain(needle);
  for (const banned of ["Autopilot review", "none required", "The guardrail record binds this reference"]) expect(text, banned).not.toContain(banned);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("$69.00 approved under Autopilot. Payment did not go out.");
  expect(text).not.toContain("PayPal handoff ready");
  await shot("au33-takeover");
  // After the second approval the ordinary title is true again: a person can now send.
  await signOut(page); await login(page, "ben"); await page.goto(`/claims/${stuck.id}`);
  await page.getByRole("button", { name: "Approve to finish this claim" }).click();
  await expect(page.getByTestId("autopilot-people")).toHaveText("People: 2 of 2");
  { const t = await body(); expect(t).not.toContain(NOT_READY); expect(READY_WORDS.some(word => t.includes(word)), "the ready words return after two approvals").toBe(true); }
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("$69.00 approved. PayPal handoff ready. Unpaid.");
  await shot("au33-takeover-two");
  await signOut(page); await login(page, "tara");

  await page.goto(RULES);
  await expect(page.getByTestId("automation-state")).toContainText("Automation is on");
  await shot("au33-switch");
});
