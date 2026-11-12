import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { fixtureClauses, seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { runPolicyChecks } from "../src/policy/service";
import * as s from "../db/schema";

// IAC-405 step 1 piece G, the browser check. The real flow: Maria's receipt review is confirmed, she freezes the allocation,
// an approver presses Run policy checks (or, for rules that ran earlier, Run model check), and the stored model rows render under the rule rows.
// Every model answer here comes from a loopback stub that this file defines (UI_TEST_CONTAINER sends Claude requests to 127.0.0.1:8080). It is NOT a
// real model result. The stills are labeled STUBBED in their file names. Each test starts its own database and next server on 3100, like receipt.spec.
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });
const OUT = "local/model-check-stills";
let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof connectDatabase>;
let server: ChildProcess | undefined, model: Server | undefined, name: string;
let passwords: Record<"maria" | "tara" | "ben", string>;
let mode: "ok" | "conflict" | "invalid" = "ok";
let compliance: { model: string; fund: string }[] = [];
let suggestions = 0;
const CONFLICT_CLAUSE = "1.4";
const clauseText = (fundId: string, clauseId: string) => fixtureClauses.find(clause => clause.fundId === fundId && clause.clauseId === clauseId)!.text;

test.beforeEach(async () => {
  if (process.env.UI_TEST_CONTAINER !== "true") throw new Error("Use the isolated OrbStack browser service");
  name = `aidtrace_iac405_mc_${randomBytes(6).toString("hex")}`;
  const adminUrl = new URL(process.env.DATABASE_URL!); adminUrl.pathname = "/postgres";
  admin = postgres(adminUrl.toString(), { max: 1 }); await admin`create database ${admin(name)}`;
  const url = new URL(adminUrl); url.pathname = `/${name}`; connection = connectDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "model-test@personal.example.com", payeeAllowlist: ["model-test@personal.example.com"] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  mode = "ok"; compliance = []; suggestions = 0;
  // Synthetic answers only. This test network has no internet route. A receipt suggestion request has top-level lines. A compliance request has a fund.
  model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const data = JSON.parse(body.messages[0].content);
    let text: string;
    if (data.fund) {
      compliance.push({ model: body.model, fund: data.fund.name });
      const first = data.fund.name.startsWith("Ashmere");
      text = mode === "invalid" ? "this is not json" : JSON.stringify({ lines: data.receipt.lines.map((line: { id: string }) => mode === "conflict" && first
        ? { lineId: line.id, verdict: "CONFLICT", clauseId: data.fund.clauses[3].id } : { lineId: line.id, verdict: "OK", clauseId: null }) });
    } else {
      suggestions++;
      const categories = ["robot_kits_parts", "classroom_supplies", "participant_meals"];
      text = JSON.stringify({ proposals: data.lines.map((line: { id: string; description: string }, i: number) => ({ lineId: line.id, category: categories[i], quote: line.description })) });
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_ui_stub", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text }], usage: { input_tokens: 812, output_tokens: 57 } }));
  });
  await new Promise<void>(resolve => model!.listen(8080, "0.0.0.0", resolve));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AIDTRACE_JUDGE_SESSION: "false", AI_RECEIPT_ENABLED: "true", AI_COMPLIANCE_ENABLED: "true", AI_EXPENSE_PROPOSALS_ENABLED: "false", ANTHROPIC_API_KEY: "sk-ant-api03-UI-STUB-NOT-A-REAL-KEY", PAYPAL_SANDBOX_PAYEE_EMAIL: "model-test@personal.example.com", PAYEE_ALLOWLIST: "model-test@personal.example.com", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
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
  model?.closeAllConnections(); if (model) { await new Promise<void>(resolve => model!.close(() => resolve())); model = undefined; }
  if (admin && /^aidtrace_iac405_mc_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]);
  const response = page.waitForResponse(r => r.url().endsWith("/api/auth/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); expect((await response).status()).toBe(303);
  await page.waitForURL(url => url.pathname === "/");
}
// Maria confirms a receipt review through the page (the stub answers the suggestion request), views the allocation and freezes it. Returns the claim id.
async function frozenReceiptClaim(page: Page) {
  await login(page, "maria"); await page.goto("/"); await page.getByRole("link", { name: "Start an expense", exact: true }).click();
  await page.getByLabel("This receipt holds no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Unpaid draft created");
  await page.getByRole("button", { name: "Request AI suggestions" }).click(); await expect(page.locator(".notice")).toContainText("AI suggestions are ready");
  await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible();
  await page.getByRole("link", { name: "Continue to funding", exact: true }).click();
  await expect(page.getByRole("heading", { name: "$5.00 restricted. $1.00 General.", exact: true })).toBeVisible();
  const claimId = new URL(page.url()).pathname.split("/")[2]!;
  await page.getByRole("button", { name: "Freeze allocation for approval" }).click(); await expect(page.getByRole("status")).toContainText("allocation is frozen");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  expect(suggestions).toBe(1); expect(compliance).toHaveLength(0);
  return claimId;
}
async function financial() {
  const hash = createHash("sha256");
  for (const table of ["claims", "claim_lines", "fund_credits", "fund_debits", "allocation_decisions", "allocation_edges", "fund_reservations", "reservation_budget_lines", "approvals", "journal_entries", "journal_postings", "disbursements", "disbursement_attempts", "donation_receipts", "retry_authorizations", "provider_events", "receipt_confirmations"]) {
    const rows = await connection.client`select to_jsonb(r)::text as row from ${connection.client(table)} r order by (to_jsonb(r)::text) collate "C"`; hash.update(table).update(JSON.stringify(rows));
  }
  return hash.digest("hex");
}
const kinds = async () => (await connection.db.select({ kind: s.policyCheckRuns.kind }).from(s.policyCheckRuns)).map(row => row.kind).sort();
// The Approve control as the page renders it: the whole form, compared before and after the checks.
const approveForm = (page: Page) => page.getByRole("button", { name: "Approve these terms" }).locator("xpath=ancestor::form");
const GENERAL_SKIPPED = "General Operating: not checked by the model. The General fund has no clauses to check.";
async function still(page: Page, label: string) {
  mkdirSync(OUT, { recursive: true }); await page.locator("#policy-checks").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/STUBBED-${label}-1440.png`, fullPage: true });
}
// The rule rows sit above the model rows in the same section: the first Hold row of the rules is higher on the page than the model status line.
async function rulesAboveModel(page: Page) {
  const section = page.locator("#policy-checks");
  const rule = section.locator("li").filter({ hasText: /^Hold: / }).first(); await expect(rule).toBeVisible();
  const status = section.getByText(/^Model status: /); await expect(status).toHaveCount(1);
  const ruleBox = (await rule.boundingBox())!, statusBox = (await status.boundingBox())!;
  expect(ruleBox.y + ruleBox.height).toBeLessThanOrEqual(statusBox.y);
  expect(await section.locator("li").filter({ hasText: /^Hold: / }).count()).toBeGreaterThan(0);
}
async function plainWords(page: Page) {
  const section = page.locator("#policy-checks");
  expect(await section.innerText()).not.toMatch(/\b(cleared|approved|passed)\b/i);
  await expect(page.locator("body")).not.toContainText("Hold for review");
  await expect(section).toContainText("Holds do not block approval. Two approvers are still required.");
}

test("MC-01 (stubbed model): a mixed run shows an OK line, a CONFLICT line with its clause id and quoted clause text, the General fund as skipped, and the rule rows stay above", async ({ page }) => {
  mode = "conflict";
  const claimId = await frozenReceiptClaim(page);
  await login(page, "tara"); await page.goto(`/claims/${claimId}`);
  const section = page.locator("#policy-checks"); await expect(section).toBeVisible();
  await expect(section).toContainText("Policy checks have not run for this frozen decision.");
  await expect(approveForm(page)).toHaveCount(1); const approveBefore = await approveForm(page).evaluate(el => el.outerHTML);
  const money = await financial();
  await section.getByRole("button", { name: "Run policy checks" }).click();
  await expect(page.getByRole("status")).toContainText("Policy checks ran and are stored");

  // The CONFLICT line names the clause id and quotes the stored clause text. The model wrote no quote: the page reads it from the clause table.
  const conflict = section.locator("li").filter({ hasText: "conflict with clause 1.4:" }); await expect(conflict).toHaveCount(1);
  await expect(conflict).toContainText(`conflict with clause ${CONFLICT_CLAUSE}: "${clauseText("fund_a", CONFLICT_CLAUSE)}"`);
  // IAC-415 PR 4: the OK lines of a fund read as one sentence that names the lines. "This is not an approval." stays once, in the status line.
  const ok = section.locator("li").filter({ hasText: /^No conflict found by the model on Line L\d \(.+\)\.$/ }); await expect(ok).toHaveCount(1);
  await expect(ok).not.toContainText("This is not an approval.");
  await expect(section).toContainText(GENERAL_SKIPPED);
  await expect(section).toContainText("Model status: Hold. A person decides.");
  // PB-10: Ashmere was sent Haiku first and then Sonnet, so its row says both and the page names both models (before November 5 it named only the stored Sonnet pair). Tallow stopped at Haiku.
  await expect(section).toContainText("Checked by AI (Haiku 5.5, then Sonnet 5.5) at low effort."); await expect(section).toContainText("Checked by AI (Haiku 5.5) at low effort.");
  await expect(section).toContainText("Powered by Claude Haiku 5.5 and Claude Sonnet 5.5. Claim line and clause text was sent to Anthropic.");
  await rulesAboveModel(page); await plainWords(page);
  // Routing: Ashmere went Haiku then Sonnet (a Haiku CONFLICT escalates), the other restricted fund stopped at Haiku, and the General fund sent nothing.
  expect(compliance.map(call => `${call.fund.split(" ")[0]}:${call.model}`).sort()).toEqual(["Ashmere:claude-haiku-5-5", "Ashmere:claude-sonnet-5-5", "Tallow:claude-haiku-5-5"]);

  // Nothing financial moved, the Approve control is byte-identical, and the stored result survives a reload without a second run.
  expect(await financial()).toBe(money); expect(await kinds()).toEqual(["MODEL", "RULES"]);
  await expect(approveForm(page)).toBeVisible(); expect(await approveForm(page).evaluate(el => el.outerHTML)).toBe(approveBefore);
  await expect(page.getByRole("button", { name: "Approve these terms" })).toBeEnabled();
  await page.reload(); await expect(conflict).toHaveCount(1); await expect(ok).toHaveCount(1); expect(compliance).toHaveLength(3);
  await expect(section.getByRole("button", { name: "Run policy checks" })).toHaveCount(0); await expect(section.getByRole("button", { name: "Run model check" })).toHaveCount(0);
  await still(page, "model-mixed");
});

test("MC-02 (stubbed model): an invalid answer on both steps shows Not checked for each fund, never an OK, and the rule rows stay above", async ({ page }) => {
  mode = "invalid";
  const claimId = await frozenReceiptClaim(page);
  await login(page, "tara"); await page.goto(`/claims/${claimId}`);
  const section = page.locator("#policy-checks"); await expect(approveForm(page)).toHaveCount(1); const approveBefore = await approveForm(page).evaluate(el => el.outerHTML);
  const money = await financial();
  await section.getByRole("button", { name: "Run policy checks" }).click();
  await expect(page.getByRole("status")).toContainText("Policy checks ran and are stored");
  // Haiku was invalid, so Sonnet was asked, and it was invalid too: the row names Sonnet, which is the step that failed.
  await expect(section.getByText("Not checked by the model: the answer was invalid and was discarded.")).toHaveCount(2);
  await expect(section).toContainText("Asked AI (Haiku 5.5, then Sonnet 5.5) at low effort."); await expect(section).not.toContainText("Checked by");
  await expect(section).toContainText("Powered by Claude Haiku 5.5 and Claude Sonnet 5.5. Claim line and clause text was sent to Anthropic.");
  await expect(section.getByText("no conflict found by the model")).toHaveCount(0); await expect(section.getByText(/conflict with clause/)).toHaveCount(0);
  await expect(section).toContainText(GENERAL_SKIPPED); await expect(section).toContainText("Model status: Hold. A person decides.");
  await rulesAboveModel(page); await plainWords(page);
  expect(compliance.map(call => `${call.fund.split(" ")[0]}:${call.model}`).sort()).toEqual(["Ashmere:claude-haiku-5-5", "Ashmere:claude-sonnet-5-5", "Tallow:claude-haiku-5-5", "Tallow:claude-sonnet-5-5"]);
  expect(await financial()).toBe(money); expect(await kinds()).toEqual(["MODEL", "RULES"]);
  expect(await approveForm(page).evaluate(el => el.outerHTML)).toBe(approveBefore); await expect(page.getByRole("button", { name: "Approve these terms" })).toBeEnabled();
  await still(page, "model-not-checked");
});

test("MC-03 (stubbed model): rules that ran with the model absent show Run model check, which runs only the model check once and then disappears", async ({ page }) => {
  mode = "ok";
  const claimId = await frozenReceiptClaim(page);
  // The rules ran earlier, as when the compliance AI was off at that time: the service stores the rule rows only.
  const [decision] = await connection.db.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.claimId, claimId));
  expect(await runPolicyChecks(connection.db, decision!.decisionHash, { id: "tara" })).toMatchObject({ status: "RAN" });
  expect(await kinds()).toEqual(["RULES"]);
  await login(page, "tara"); await page.goto(`/claims/${claimId}`);
  const section = page.locator("#policy-checks");
  await expect(section.getByRole("button", { name: "Run policy checks" })).toHaveCount(0);
  await expect(section).toContainText("The model check did not run for this frozen decision.");
  const control = section.getByRole("button", { name: "Run model check" }); await expect(control).toHaveCount(1);
  await expect(approveForm(page)).toHaveCount(1); const approveBefore = await approveForm(page).evaluate(el => el.outerHTML);
  const money = await financial(); expect(compliance).toHaveLength(0);
  await still(page, "run-model-control");
  await control.click();
  await expect(page.getByRole("status")).toContainText("The model check ran and is stored for this frozen decision.");
  // One sentence per restricted fund (IAC-415 PR 4). The row no longer repeats "This is not an approval.": the status line below says it once.
  await expect(section.locator("li").filter({ hasText: /^No conflict found by the model on Line L\d \(.+\)\.$/ })).toHaveCount(2);
  await expect(section.locator("li").filter({ hasText: "This is not an approval." })).toHaveCount(0);
  await expect(section).toContainText(GENERAL_SKIPPED); await expect(section).toContainText("Model status: no conflict found by the model. This is not an approval.");
  await expect(section.getByRole("button", { name: "Run model check" })).toHaveCount(0);
  await rulesAboveModel(page); await plainWords(page);
  expect(compliance.map(call => `${call.fund.split(" ")[0]}:${call.model}`).sort()).toEqual(["Ashmere:claude-haiku-5-5", "Tallow:claude-haiku-5-5"]);
  expect(await kinds()).toEqual(["MODEL", "RULES"]); expect(await financial()).toBe(money);
  expect(await approveForm(page).evaluate(el => el.outerHTML)).toBe(approveBefore); await expect(page.getByRole("button", { name: "Approve these terms" })).toBeEnabled();
  await page.reload(); await expect(section.locator("li").filter({ hasText: /^No conflict found by the model on Line L\d \(.+\)\.$/ })).toHaveCount(2); expect(compliance).toHaveLength(2);
  await still(page, "model-ok");
});
