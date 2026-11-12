import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { modelFullName } from "../src/policy/copy";
import { CLAUSE_CAP, CLAUSE_PERIOD, drafted, flatAnswer, goodAnswer, unsureList } from "../tests/support/rules-draft";

// IAC-440 Package B, the browser check (DR-130 and onward). The real flow in a desktop browser: an approver finds the rules page from the
// fund row, reads a PDF into the box with no model call, drafts rules from a pasted grant, fills the one field the grant does not settle, approves, a second approver
// approves and the rules bind, and a new receipt then allocates under the new rules. Every model answer comes from a loopback stub that this file defines
// (UI_TEST_CONTAINER sends Claude requests to 127.0.0.1:8080). It is NOT a real model result. Each test starts its own database and next server on 3100, like
// model-rows.spec. AI_RULE_DRAFTS_ENABLED and the placeholder key exist only in this spec's server environment.
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });
const ORIGIN = "http://127.0.0.1:3100";
const FUND = "fund_a";
const PDF_FIXTURE = "tests/fixtures/grant-two-pages.pdf";
let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof connectDatabase>;
let server: ChildProcess | undefined, model: Server | undefined, name: string;
let passwords: Record<"maria" | "tara" | "ben", string>;
let answerMode: "robot-kits-only" | "refused" = "robot-kits-only";
let draftRequests: { model: string; agreement: string }[] = [];
let otherRequests = 0;

// A grant that stops the robotics fund paying for classroom supplies: robot kits and parts only. The program is left for the person to fill in.
const SCOPE = "Section 1. Funds may be used only for direct costs of the robotics afterschool program: robot kits and robot parts only.";
const GRANT = ["Grant agreement between Cedar Hollow Community Fund and the Eastside Robotics Club.", SCOPE, CLAUSE_PERIOD, CLAUSE_CAP].join("\n");
function stubAnswer(): Record<string, any> {
  const answer = goodAnswer();
  answer.clauses[0] = { id: "1.1", text: SCOPE };
  answer.allowedCategories = drafted(["robot_kits_parts"], "1.1", "robot kits and robot parts only");
  answer.breadth = 1;
  answer.summary = "Pays direct costs of the robotics afterschool program: robot kits and robot parts only.";
  answer.programs = unsureList();
  if (answerMode === "refused") answer.clauses[0] = { id: "1.1", text: "A sentence that is not in the grant at all." };
  return answer;
}

test.beforeEach(async () => {
  if (process.env.UI_TEST_CONTAINER !== "true") throw new Error("Use the isolated OrbStack browser service");
  name = `aidtrace_iac440_rd_${randomBytes(6).toString("hex")}`;
  const adminUrl = new URL(process.env.DATABASE_URL!); adminUrl.pathname = "/postgres";
  admin = postgres(adminUrl.toString(), { max: 1 }); await admin`create database ${admin(name)}`;
  const url = new URL(adminUrl); url.pathname = `/${name}`; connection = connectDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "rules-test@personal.example.com", payeeAllowlist: ["rules-test@personal.example.com"] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  answerMode = "robot-kits-only"; draftRequests = []; otherRequests = 0;
  // Synthetic answers only. This test network has no internet route. A rules draft request has an agreement. A receipt suggestion request has lines.
  model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const data = JSON.parse(body.messages[0].content);
    let text: string;
    if (typeof data.agreement === "string") {
      draftRequests.push({ model: body.model, agreement: data.agreement });
      text = JSON.stringify(flatAnswer(stubAnswer()));
    } else {
      otherRequests++;
      const categories = ["robot_kits_parts", "classroom_supplies", "participant_meals"];
      text = JSON.stringify({ proposals: data.lines.map((line: { id: string; description: string }, i: number) => ({ lineId: line.id, category: categories[i], quote: line.description })) });
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_ui_stub", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text }], usage: { input_tokens: 812, output_tokens: 57 } }));
  });
  await new Promise<void>(resolve => model!.listen(8080, "0.0.0.0", resolve));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AIDTRACE_JUDGE_SESSION: "false", AI_RECEIPT_ENABLED: "true", AI_RULE_DRAFTS_ENABLED: "true", AI_COMPLIANCE_ENABLED: "false", AI_EXPENSE_PROPOSALS_ENABLED: "false", ANTHROPIC_API_KEY: "sk-ant-api03-UI-STUB-NOT-A-REAL-KEY", PAYPAL_SANDBOX_PAYEE_EMAIL: "rules-test@personal.example.com", PAYEE_ALLOWLIST: "rules-test@personal.example.com", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
  for (let attempt = 0; attempt < 90; attempt++) {
    try { if ((await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Wait for the isolated server, never the main application. */ }
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
  if (admin && /^aidtrace_iac440_rd_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]);
  const response = page.waitForResponse(r => r.url().endsWith("/api/auth/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); expect((await response).status()).toBe(303);
  await page.waitForURL(url => url.pathname === "/");
}
async function signOut(page: Page) { await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(url => url.pathname === "/login"); }
// Maria makes the $6 practice receipt through the page, confirms the categories the stub proposes and reads the allocation headline. Nothing is frozen.
async function practiceAllocation(page: Page, headline: string) {
  await login(page, "maria"); await page.goto("/"); await page.getByRole("link", { name: "Start an expense", exact: true }).click();
  await page.getByLabel("This receipt holds no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Unpaid draft created");
  await page.getByRole("button", { name: "Request AI suggestions" }).click(); await expect(page.locator(".notice")).toContainText("AI suggestions are ready");
  await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible();
  await page.getByRole("link", { name: "Continue to funding", exact: true }).click();
  await expect(page.getByRole("heading", { name: headline, exact: true })).toBeVisible();
  await signOut(page);
}
const reviewUrl = (page: Page) => new URL(page.url()).pathname;
const draftIdOf = (page: Page) => reviewUrl(page).split("/").pop()!;
const approveButton = (page: Page, which: "first" | "second") => page.getByRole("button", { name: `Approve (${which} of two)` });
// HP-04: how many times the text on a page says a second, different approver is needed.
const secondApproverSentences = (text: string) => (text.match(/A second, different approver must approve/g) ?? []).length;
// A post made the way the page's own forms post: the cookie jar of the page, the app's own origin, urlencoded fields, no redirect followed.
const post = (page: Page, path: string, form: Record<string, string>, headers: Record<string, string> = { origin: ORIGIN }) => page.request.post(path, { form, headers, maxRedirects: 0 });

test("DR-130 to DR-133: an approver drafts rules from a PDF and pasted grant, a second approver binds them, and a new receipt allocates under the new rules", async ({ page }) => {
  test.setTimeout(300_000);

  await test.step("DR-130: the fund row leads to the rules page, which reads a PDF with no model call and stays unstyled-proof", async () => {
    await practiceAllocation(page, "$5.00 restricted. $1.00 General.");
    expect(otherRequests).toBe(1); expect(draftRequests).toHaveLength(0);
    await login(page, "tara"); await page.goto("/");
    const link = page.getByTestId("fund-rules-link").first(); await expect(link).toBeVisible(); await expect(link).toHaveText("Draft rules from a grant");
    await link.click(); await page.waitForURL(`**/funds/${FUND}/rules`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Rules for Ashmere County Afterschool STEM Subgrant");
    await expect(page.getByRole("heading", { name: "Current approved rules, version 1" })).toBeVisible();
    // November 10 cut 24: a fund with no drafts shows no drafts section at all (it used to show "No drafts yet for this fund.").
    await expect(page.getByTestId("rules-no-drafts")).toHaveCount(0); await expect(page.getByRole("heading", { name: "Drafts of this fund" })).toHaveCount(0);
    await expect(page.getByTestId("rules-draft-form")).toHaveAttribute("data-ready", "true");
    // Computed styles, so a page that lost its stylesheet fails here and not only in a screenshot.
    const section = await page.locator("section.rules-section").first().evaluate(el => { const s = getComputedStyle(el); return { top: s.paddingTop, margin: s.marginTop }; });
    expect(section).toEqual({ top: "24px", margin: "32px" });
    const button = await page.getByTestId("rules-draft-submit").evaluate(el => getComputedStyle(el).backgroundColor);
    expect(button).not.toBe("rgba(0, 0, 0, 0)");
    // The disclosure names the model and Anthropic and says nothing has gone yet. The button is off until there is text.
    // PB-11: the line starts with "Powered by" and names the model a new draft would use, by its stored id (the rules arm is Sonnet 5.5).
    await expect(page.getByTestId("rules-form-disclosure")).toContainText(/^Powered by Claude Sonnet 5\.5\. Nothing is sent until you press Draft rules\./);
    await expect(page.getByTestId("rules-form-disclosure")).toContainText("Anthropic");
    await expect(page.getByTestId("rules-draft-submit")).toBeDisabled();
    // DR-144: the sample grant fills the box and turns the button on. Nothing is sent: the PDF step below replaces the text before any draft.
    await page.getByTestId("rules-sample").click(); await expect(page.getByLabel("Grant text")).toHaveValue(/^Ashmere County Education Foundation\n/);
    await expect(page.getByTestId("rules-draft-submit")).toBeEnabled(); expect(draftRequests).toHaveLength(0);

    // A PDF fills the box. Nothing is sent to the model.
    await page.getByLabel("Choose a PDF").setInputFiles(PDF_FIXTURE);
    await expect(page.getByTestId("rules-pdf-status")).toContainText("Read 2 pages. Check the text below and edit it if needed. Nothing was sent to the AI.");
    await expect(page.getByLabel("Grant text")).toHaveValue(/Section 3\. Spending on supplies may not exceed \$300\.00 in total\./);
    expect(draftRequests).toHaveLength(0);
    // A file that is not a PDF is refused in plain words, the box keeps its text, and still nothing is sent.
    await page.getByLabel("Choose a PDF").setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from("this is not a pdf, only text") });
    await expect(page.getByTestId("rules-pdf-status")).toHaveClass(/warning/);
    await expect(page.getByLabel("Grant text")).toHaveValue(/Section 3\. Spending on supplies/);
    expect(draftRequests).toHaveLength(0);
    // An unrestricted fund has no grant to draft from.
    await page.goto("/funds/fund_g/rules"); await expect(page.getByTestId("rules-unrestricted")).toBeVisible(); await expect(page.getByTestId("rules-draft-form")).toHaveCount(0);
    expect(draftRequests).toHaveLength(0);
  });

  await test.step("DR-131: pressing Draft rules sends the text once and opens a review that marks the field the grant left open", async () => {
    await page.goto(`/funds/${FUND}/rules`);
    await expect(page.getByTestId("rules-draft-form")).toHaveAttribute("data-ready", "true");
    await page.getByLabel("Grant text").fill(GRANT);
    expect(draftRequests).toHaveLength(0);
    await page.getByTestId("rules-draft-submit").click();
    await page.waitForURL(`**/funds/${FUND}/rules/drafts/*`);
    expect(draftRequests).toHaveLength(1);
    expect(draftRequests[0]!.agreement).toBe(GRANT);
    await expect(page.getByTestId("rules-state")).toHaveText("Open");
    await expect(page.getByTestId("rules-disclosure")).toContainText(`Powered by ${modelFullName(draftRequests[0]!.model)}. The grant text was sent to Anthropic.`);
    await expect(page.getByTestId("rules-disclosure")).toContainText("Anthropic");
    const table = page.getByTestId("rules-review-table");
    await expect(table.locator('tr[data-path="allowedCategories"]')).toContainText("Robot kits and parts");
    await expect(table.locator('tr[data-path="allowedCategories"]')).toContainText("Clause 1.1");
    await expect(table.locator('tr[data-path="allowedCategories"] blockquote')).toHaveText("robot kits and robot parts only");
    const needed = table.locator('tr[data-path="programs"]');
    await expect(needed).toHaveAttribute("data-tone", "NEEDED"); await expect(needed).toContainText("Needs a value"); await expect(needed).toContainText("Required");
    // The highlight is real styling, and an unstyled table would have neither.
    expect(await needed.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe("none");
    expect(await table.evaluate(el => getComputedStyle(el).borderCollapse)).toBe("collapse");
    await expect(page.getByTestId("rules-missing")).toContainText("Still needed before approval: Programs.");
    await expect(approveButton(page, "first")).toBeDisabled();
    await expect(page.getByTestId("rules-payorder-warning")).toContainText("Approving these rules changes the pay order.");
    await expect(page.getByRole("heading", { name: "Approvals: 0 of 2" })).toBeVisible();
    // The grant text is there to read, collapsed by default.
    await expect(page.getByTestId("rules-source")).toBeHidden();
    await page.getByText("Grant text this draft came from").click(); await expect(page.getByTestId("rules-source")).toHaveText(GRANT);
  });

  let editedId = "";
  await test.step("DR-132: filling the open field saves a new draft that carries a person's name for it, and the first approver approves it", async () => {
    const firstId = draftIdOf(page);
    // November 10: the missing field is asked for first, in its own short form; the full edit form stays collapsed.
    await expect(page.locator("details.rules-edit-details")).not.toHaveAttribute("open", "");
    const needs = page.getByTestId("rules-needs"); await expect(needs).toBeVisible();
    expect(await needs.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    await needs.getByRole("group", { name: "Programs" }).getByLabel("Robotics").check();
    await needs.getByRole("button", { name: "Save and make a new draft" }).click();
    await expect(page.getByTestId("rules-notice")).toContainText("Your change is saved as a new draft. It needs its own two approvals.");
    editedId = draftIdOf(page); expect(editedId).not.toBe(firstId);
    await expect(page.getByTestId("rules-state")).toHaveText("Open");
    await expect(page.getByTestId("rules-disclosure")).toContainText("A person edited this draft.");
    await expect(page.getByTestId("rules-disclosure")).not.toContainText("Powered by");
    await expect(page.getByTestId("rules-review-table").locator('tr[data-path="programs"]')).toContainText("Robotics");
    await expect(page.getByTestId("rules-review-table").locator('tr[data-path="programs"]')).toContainText("Changed by a person");
    await expect(page.getByTestId("rules-missing")).toHaveCount(0);
    await expect(page.getByTestId("rules-payorder-warning")).toBeVisible();
    await expect(approveButton(page, "first")).toBeEnabled();
    await approveButton(page, "first").click();
    // HP-04: the first approval redirects with no notice code, so the page says "a second, different approver" once, in its persistent state notice.
    await expect(page.getByRole("heading", { name: "Approvals: 1 of 2" })).toBeVisible();
    expect(new URL(page.url()).search).toBe("");
    await expect(page.getByTestId("rules-notice")).toHaveCount(0);
    await expect(page.getByTestId("rules-second-approver")).toBeVisible();
    await expect(page.getByTestId("rules-second-approver")).toHaveText("You approved this draft. A second, different approver must approve it before anything changes.");
    expect(secondApproverSentences(await page.locator("main").innerText())).toBe(1);
    if (process.env.RULES_STILLS) await page.screenshot({ path: `${process.env.RULES_STILLS}/hp-review-after-first-approval-1440.png`, fullPage: true });
    await expect(page.getByRole("button", { name: /^Approve \(/ })).toHaveCount(0);
    // The same approver cannot approve again by posting the form by hand either. The refusal is a notice, and the count does not move.
    const again = await post(page, `/api/funds/${FUND}/rules/drafts/${editedId}`, { action: "approve" });
    expect(again.status()).toBe(303); expect(again.headers()["location"]).toContain("notice=act-same-approver");
    await page.reload(); await expect(page.getByRole("heading", { name: "Approvals: 1 of 2" })).toBeVisible();
    // The grant is still version 1: nothing binds on one approval.
    await page.goto(`/funds/${FUND}/rules`); await expect(page.getByRole("heading", { name: "Current approved rules, version 1" })).toBeVisible();
    await signOut(page);
  });

  await test.step("DR-133: a second, different approver binds the rules, the screens go read only, and a new receipt allocates under them", async () => {
    await login(page, "ben"); await page.goto(`/funds/${FUND}/rules`);
    const list = page.getByTestId("rules-draft-list");
    await expect(list.locator('tr[data-state="OPEN"]')).toHaveCount(2);
    await page.locator(`a[href$="/drafts/${editedId}"]`).click(); await page.waitForURL(`**/drafts/${editedId}`);
    await expect(page.getByRole("heading", { name: "Approvals: 1 of 2" })).toBeVisible();
    await expect(page.getByTestId("rules-second-approver")).toHaveCount(0);
    await approveButton(page, "second").click();
    // A bound approval goes back to the rules page, whose notice says which version is now in use and that no receipt was waiting on two approvals.
    await page.waitForURL(url => url.pathname === `/funds/${FUND}/rules`);
    await expect(page.getByTestId("rules-notice")).toHaveText("Version 2 is now the fund's approved rules. New claims use it. The pay order changed, and no receipt was waiting on two approvals.");
    // The bound draft reads as in use, with both approvals and no controls.
    await page.locator(`a[href$="/drafts/${editedId}"]`).click(); await page.waitForURL(`**/drafts/${editedId}`);
    await expect(page.getByTestId("rules-state")).toHaveText("In use");
    await expect(page.getByTestId("rules-bound")).toContainText("is in use as version 2 of the fund's rules.");
    expect(secondApproverSentences(await page.locator("main").innerText())).toBe(0);
    await expect(page.getByRole("heading", { name: "Approvals: 2 of 2" })).toBeVisible();
    await expect(page.getByTestId("rules-edit-form")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Approve \(|^Withdraw this draft/ })).toHaveCount(0);
    // The rules page now shows version 2, the robot-kit-only categories, and the other draft out of date.
    await page.goto(`/funds/${FUND}/rules`);
    await expect(page.getByRole("heading", { name: "Current approved rules, version 2" })).toBeVisible();
    await expect(page.getByTestId("rules-current").locator("div", { has: page.getByText("Categories", { exact: true }) }).first()).toContainText("Robot kits and parts");
    await expect(page.getByTestId("rules-current")).not.toContainText("Classroom supplies");
    await expect(page.getByTestId("rules-draft-list").locator('tr[data-state="BOUND"]')).toHaveCount(1);
    await expect(page.getByTestId("rules-draft-list").locator('tr[data-state="STALE"]')).toHaveCount(1);
    await signOut(page);
    expect(draftRequests).toHaveLength(1);
    // The same $6 practice receipt now allocates differently: the robot kit goes to the robotics fund, the notebook has no restricted fund and falls to General.
    await practiceAllocation(page, "$3.00 restricted. $3.00 General.");
    expect(draftRequests).toHaveLength(1);
  });
});

test("DR-134: a claimant and a signed-out visitor cannot read the rules pages or post to the routes, and nothing is sent to the model", async ({ page }) => {
  await login(page, "tara"); await page.goto(`/funds/${FUND}/rules`);
  await expect(page.getByTestId("rules-draft-form")).toHaveAttribute("data-ready", "true");
  await page.getByLabel("Grant text").fill(GRANT); await page.getByTestId("rules-draft-submit").click();
  await page.waitForURL(`**/funds/${FUND}/rules/drafts/*`);
  const reviewPath = reviewUrl(page), draftId = draftIdOf(page); expect(draftRequests).toHaveLength(1);
  await signOut(page);
  // Signed out: both pages send the visitor to sign in, and both routes answer 401.
  for (const path of [`/funds/${FUND}/rules`, reviewPath]) { await page.goto(path); await page.waitForURL(url => url.pathname === "/login"); }
  expect((await post(page, `/api/funds/${FUND}/rules/drafts`, { text: GRANT })).status()).toBe(401);
  expect((await post(page, `/api/funds/${FUND}/rules/drafts/${draftId}`, { action: "approve" })).status()).toBe(401);
  // A claimant sees a plain refusal on both pages with none of the grant, and the routes answer 403.
  await login(page, "maria");
  for (const path of [`/funds/${FUND}/rules`, reviewPath]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Approver access required." })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Eastside Robotics Club");
    await expect(page.getByTestId("rules-source")).toHaveCount(0);
  }
  expect((await post(page, `/api/funds/${FUND}/rules/drafts`, { text: GRANT })).status()).toBe(403);
  expect((await post(page, `/api/funds/${FUND}/rules/drafts/${draftId}`, { action: "approve" })).status()).toBe(403);
  expect((await post(page, `/api/funds/${FUND}/rules/drafts/${draftId}`, { action: "approve" }, { origin: "http://evil.example" })).status()).toBe(403);
  await page.goto("/"); await expect(page.getByTestId("fund-rules-link")).toHaveCount(0);
  expect(draftRequests).toHaveLength(1);
});

test("DR-135: a refused model answer opens a screen with no drafted values, no approval and no edit", async ({ page }) => {
  answerMode = "refused";
  await login(page, "tara"); await page.goto(`/funds/${FUND}/rules`);
  await expect(page.getByTestId("rules-draft-form")).toHaveAttribute("data-ready", "true");
  await page.getByLabel("Grant text").fill(GRANT); await page.getByTestId("rules-draft-submit").click();
  await page.waitForURL(`**/funds/${FUND}/rules/drafts/*`);
  expect(draftRequests).toHaveLength(1);
  await expect(page.getByTestId("rules-state")).toHaveText("Refused");
  await expect(page.getByTestId("rules-refused")).toBeVisible();
  await expect(page.getByTestId("rules-review-table")).toHaveCount(0);
  await expect(page.getByTestId("rules-edit-form")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Approve \(/ })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Robot kits and parts");
  await expect(page.getByTestId("rules-refused")).toContainText("Nothing was approved or changed.");
  // The list says the same: refused, no approvals.
  await page.goto(`/funds/${FUND}/rules`);
  const row = page.getByTestId("rules-draft-list").locator('tr[data-state="REFUSED"]'); await expect(row).toHaveCount(1); await expect(row).toContainText("None");
  await expect(page.getByRole("heading", { name: "Current approved rules, version 1" })).toBeVisible();
});

