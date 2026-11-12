import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { asc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { WORKSHOP_EXAMPLE, type DraftExample } from "../src/app/receipts/examples";
import * as s from "../db/schema";

// WX-01 to WX-05 (IAC-415 PR 7, "one workshop example"): the new-receipt form loads the one USD 500.00 workshop receipt in a judge session,
// and in owner mode on request (?example=workshop), while the owner default stays the USD 6.00 practice expense that the older tests rely on. Each test starts its own
// isolated database and next server on 3100 (judge or owner mode). WX-04 also starts a loopback Claude stub (UI_TEST_CONTAINER sends Claude requests to 127.0.0.1:8080).
// The stub answers are synthetic. They are NOT a real model result, and no Claude or PayPal request leaves the container.
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

let admin: ReturnType<typeof postgres> | undefined, connection: ReturnType<typeof connectDatabase> | undefined;
let server: ChildProcess | undefined, model: Server | undefined, name = "";
let passwords: Record<"maria" | "tara" | "ben", string>;
// What the loopback stub saw, so WX-04 can show the model was sent the example and nothing else.
const requests: { receiptText: string; lines: { id: string; description: string }[] }[] = [];

async function start(opts: { judge: boolean; stub?: boolean }) {
  if (process.env.UI_TEST_CONTAINER !== "true") throw Error("Use isolated OrbStack browser service");
  const url = new URL(process.env.DATABASE_URL!); url.pathname = "/postgres";
  admin = postgres(url.toString(), { max: 1 }); name = "aidtrace_wx_" + randomBytes(6).toString("hex");
  await admin`create database ${admin(name)}`; url.pathname = "/" + name;
  connection = connectDatabase(url.toString()); await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "workshop@example.invalid", payeeAllowlist: ["workshop@example.invalid"] });
  requests.length = 0;
  if (opts.stub) {
    model = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); const data = JSON.parse(body.messages[0].content);
      // A receipt suggestion request has top-level lines. A compliance request has a fund and is answered OK for every line.
      const categories = ["robot_kits_parts", "classroom_supplies", "participant_meals"];
      if (!data.fund) requests.push({ receiptText: data.receiptText, lines: data.lines });
      const text = data.fund
        ? JSON.stringify({ lines: data.receipt.lines.map((line: { id: string }) => ({ lineId: line.id, verdict: "OK", clauseId: null })) })
        : JSON.stringify({ proposals: data.lines.map((line: { id: string; description: string }, i: number) => ({ lineId: line.id, category: categories[i], quote: line.description })) });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_ui_stub", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text }], usage: { input_tokens: 812, output_tokens: 57 } }));
    });
    await new Promise<void>(resolve => model!.listen(8080, "0.0.0.0", resolve));
  }
  const ai = opts.stub
    ? { AI_RECEIPT_ENABLED: "true", AI_EXPENSE_PROPOSALS_ENABLED: "true", ANTHROPIC_API_KEY: "sk-ant-api03-UI-STUB-NOT-A-REAL-KEY" }
    : { AI_RECEIPT_ENABLED: "false", AI_EXPENSE_PROPOSALS_ENABLED: "true" };
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AIDTRACE_JUDGE_SESSION: opts.judge ? "true" : "false", ...ai, PAYPAL_SANDBOX_PAYEE_EMAIL: "workshop@example.invalid", PAYEE_ALLOWLIST: "workshop@example.invalid", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
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
  if (admin && /^aidtrace_wx_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
  admin = undefined; name = "";
});
async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.pathname === "/");
}

// The words and values the test expects, written out here so a change to the page or to the shared example module cannot move the expectation with it.
const WORKSHOP_INTRO = "$280 of robot kit parts. $150 of engineering notebooks. $70 of sandwiches and juice. Which funds may cover each part?";
const PRACTICE_INTRO = "A $3 science kit. A $2 notebook. $1 of refreshments. Which funds may cover each part?";
const PRACTICE: DraftExample = {
  vendor: "Cedar Science Shop", program: "robotics", incurredOn: "2026-10-14", total: "6.00",
  lines: [{ description: "Science experiment kit", amount: "3.00" }, { description: "Blank writing notebook", amount: "2.00" }, { description: "Sandwiches and apple juice", amount: "1.00" }],
  source: "Science experiment kit\nBlank writing notebook\nSandwiches and apple juice",
};
const WORKSHOP_LITERAL: DraftExample = {
  vendor: "Brightbench Supply Co.", program: "robotics", incurredOn: "2026-10-14", total: "500.00",
  lines: [{ description: "Robot kit and parts", amount: "280.00" }, { description: "Engineering notebooks", amount: "150.00" }, { description: "Sandwiches and apple juice", amount: "70.00" }],
  source: "Brightbench Supply Co.\nRobot kit and parts 280.00\nEngineering notebooks 150.00\nSandwiches and apple juice 70.00\nTotal 500.00",
};
const TO_WORKSHOP = "Use the $500 workshop example", TO_PRACTICE = "Use the $6 small example";
const toWorkshop = (page: Page) => page.getByRole("link", { name: TO_WORKSHOP, exact: true });
const toPractice = (page: Page) => page.getByRole("link", { name: TO_PRACTICE, exact: true });

/** Every field of the draft form against the expected receipt, one named assertion each (vendor first, so a form that only changed the lines fails there). */
async function expectForm(page: Page, expected: DraftExample, where: string) {
  const value = (id: string) => page.locator(`#${id}`).inputValue();
  expect(await value("vendor"), `${where}: vendor`).toBe(expected.vendor);
  expect(await value("program"), `${where}: program`).toBe(expected.program);
  expect(await value("incurredOn"), `${where}: date`).toBe(expected.incurredOn);
  for (let i = 0; i < 3; i++) {
    expect(await value(`description${i + 1}`), `${where}: description ${i + 1}`).toBe(expected.lines[i]!.description);
    expect(await value(`amount${i + 1}`), `${where}: amount ${i + 1}`).toBe(expected.lines[i]!.amount);
  }
  expect(await value("total"), `${where}: total`).toBe(expected.total);
  expect(await value("source"), `${where}: source text`).toBe(expected.source);
  // The form keeps the same fields: three meta inputs, three line pairs, the total, the receipt text and the fictional-data box.
  await expect(page.locator("#receipt-entry input:not([type=hidden]), #receipt-entry textarea"), `${where}: field count`).toHaveCount(3 + 6 + 1 + 1 + 1);
}
async function expectIntro(page: Page, intro: string, where: string) { await expect(page.locator("p.intro"), `${where}: intro`).toHaveText(intro); }
// The browser submits a textarea with CRLF line breaks (HTML form submission), so the stored and the sent text read "\r\n" where the form shows "\n". Only that is normalized.
const lf = (text: string) => text.replace(/\r\n/g, "\n");

test("WX-01: a judge session loads the workshop receipt in every field, says so in the intro and shows no example link", async ({ page }) => {
  test.setTimeout(180000); await start({ judge: true }); await login(page, "maria");
  expect(WORKSHOP_EXAMPLE, "the shared module equals the literal in this test").toEqual(WORKSHOP_LITERAL);
  await page.goto("/receipts/new");
  await expectForm(page, WORKSHOP_LITERAL, "judge default"); await expectIntro(page, WORKSHOP_INTRO, "judge default");
  await expect(toWorkshop(page)).toHaveCount(0); await expect(toPractice(page)).toHaveCount(0);
  await expect(page.getByText(TO_WORKSHOP)).toHaveCount(0);
  // The parameter is ignored in a judge session: the same receipt, no link, whatever the value.
  for (const query of ["?example=workshop", "?example=other", "?example="]) {
    await page.goto("/receipts/new" + query);
    await expectForm(page, WORKSHOP_LITERAL, "judge " + query); await expectIntro(page, WORKSHOP_INTRO, "judge " + query);
    await expect(toWorkshop(page)).toHaveCount(0); await expect(toPractice(page)).toHaveCount(0);
  }
  // Loading the page creates nothing: the only claim Maria owns is the seeded fixture C-104, and no R- draft exists.
  expect((await connection!.db.select().from(s.claims).where(eq(s.claims.claimantId, "maria"))).map(claim => claim.id), "claims after only loading the form").toEqual(["C-104"]);
});

test("WX-02: owner mode keeps the USD 6.00 practice expense and its intro, and offers one link to the workshop example", async ({ page }) => {
  test.setTimeout(180000); await start({ judge: false }); await login(page, "maria");
  await page.goto("/receipts/new");
  await expectForm(page, PRACTICE, "owner default"); await expectIntro(page, PRACTICE_INTRO, "owner default");
  const link = toWorkshop(page); await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute("href", "/receipts/new?example=workshop");
  await expect(link, "secondary link style").toHaveClass(/\bbutton-link\b/); await expect(link, "secondary link style").toHaveClass(/\bsecondary\b/);
  await expect(toPractice(page)).toHaveCount(0);
  // The link sits below the intro, above the form.
  const intro = (await page.locator("p.intro").boundingBox())!, box = (await link.boundingBox())!, form = (await page.locator("#receipt-entry").boundingBox())!;
  expect(box.y, "link below the intro").toBeGreaterThanOrEqual(intro.y + intro.height); expect(box.y + box.height, "link above the form").toBeLessThanOrEqual(form.y);
  // The home page start link is unchanged and still lands on the practice default.
  await page.goto("/"); await page.getByRole("link", { name: "Start an expense", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:3100/receipts/new"); await expectForm(page, PRACTICE, "owner via home link");
});

test("WX-03: owner mode loads the workshop receipt only for exactly ?example=workshop, and the links switch between the two", async ({ page }) => {
  test.setTimeout(180000); await start({ judge: false }); await login(page, "maria");
  await page.goto("/receipts/new?example=workshop");
  await expectForm(page, WORKSHOP_LITERAL, "owner example"); await expectIntro(page, WORKSHOP_INTRO, "owner example");
  await expect(toPractice(page)).toHaveCount(1); await expect(toPractice(page)).toHaveAttribute("href", "/receipts/new");
  await expect(toWorkshop(page)).toHaveCount(0); await expect(page.getByText(TO_WORKSHOP)).toHaveCount(0);
  // Any other value, an empty value, another case, a trailing space, or two values is the practice default with the link to the example.
  for (const query of ["?example=other", "?example=", "?example", "?example=Workshop", "?example=workshop%20", "?example=workshop&example=other", "?example=other&example=workshop", "?sample=workshop"]) {
    await page.goto("/receipts/new" + query);
    await expectForm(page, PRACTICE, "owner " + query); await expectIntro(page, PRACTICE_INTRO, "owner " + query);
    await expect(toWorkshop(page), "owner " + query + ": link").toHaveCount(1); await expect(toPractice(page)).toHaveCount(0);
  }
  // One click each way. A value typed before the click is replaced, and the fictional-data box starts unchecked, because the form restarts when the receipt changes.
  await page.goto("/receipts/new"); await page.locator("#vendor").fill("Typed before the click"); await page.getByLabel("This receipt holds no real personal details.").check();
  await toWorkshop(page).click(); await expect(page).toHaveURL("http://127.0.0.1:3100/receipts/new?example=workshop");
  await expectForm(page, WORKSHOP_LITERAL, "after the example click"); await expectIntro(page, WORKSHOP_INTRO, "after the example click");
  await expect(page.getByLabel("This receipt holds no real personal details."), "checkbox restarts").not.toBeChecked();
  await page.locator("#source").fill("Typed before the second click");
  await toPractice(page).click(); await expect(page).toHaveURL("http://127.0.0.1:3100/receipts/new");
  await expectForm(page, PRACTICE, "after the practice click"); await expectIntro(page, PRACTICE_INTRO, "after the practice click"); await expect(toWorkshop(page)).toHaveCount(1);
});

test("WX-04: in a judge session the example runs end to end with stubbed suggestions and the solver splits it Ashmere 230.00, Tallow Creek 200.00, General 70.00", async ({ page }) => {
  test.setTimeout(300000); await start({ judge: true, stub: true }); await login(page, "maria");
  await page.getByRole("link", { name: "Review Maria's $500 receipt", exact: true }).click();
  await expectForm(page, WORKSHOP_LITERAL, "judge click-through"); await expectIntro(page, WORKSHOP_INTRO, "judge click-through");
  await page.getByLabel("This receipt holds no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Prepare this expense for review", exact: true })).toBeVisible();
  const receipt = page.url().split("?")[0]!;
  await page.getByRole("button", { name: "Prepare expense proposal", exact: true }).click();
  await expect(page.locator(".proposal-split")).toHaveText("$430.00 from restricted funds, $70.00 from General.");
  // The model was asked once, with the example text and the three descriptions, and no category came from the example module.
  expect(requests).toHaveLength(1);
  console.log("WX-04 text sent to the stub, raw " + JSON.stringify(requests[0]!.receiptText));
  expect(lf(requests[0]!.receiptText), "text sent to the stub").toBe(WORKSHOP_LITERAL.source);
  expect(requests[0]!.lines.map(line => line.description), "descriptions sent to the stub").toEqual(WORKSHOP_LITERAL.lines.map(line => line.description));
  await expect(page.locator(".receipt-source mark")).toHaveCount(3);
  await expect(page.locator(".category-choice .ai-tag", { hasText: "AI suggested" })).toHaveCount(3);
  await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible();
  const claimUrl = (await page.getByRole("link", { name: "Continue to funding", exact: true }).getAttribute("href"))!;
  await page.goto(claimUrl); await page.getByRole("button", { name: "Freeze allocation for approval", exact: true }).click();
  await expect(page.locator(".trace [aria-current=step] .t")).toHaveText("Approvals");
  // The split on the claim page, per fund, as the page prints it.
  const legend = await page.locator(".funding-legend li").evaluateAll(items => items.map(item => ({ fund: item.getAttribute("data-fund"), name: item.querySelector("span")!.textContent, amount: item.querySelector("strong")!.textContent })));
  console.log("WX-04 split " + JSON.stringify(legend));
  expect(legend).toEqual([
    { fund: "fund_a", name: "Ashmere County Afterschool STEM Subgrant", amount: "$230.00" },
    { fund: "fund_b", name: "Tallow Creek Robot Kit Initiative", amount: "$200.00" },
    { fund: "fund_g", name: "General Operating", amount: "$70.00" },
  ]);
  await expect(page.locator(".funding-summary")).toHaveAttribute("aria-label", "Computed split: $430.00 restricted, $70.00 General");
  // The same split from the stored decision, in integer cents, and nothing approved or paid.
  const id = receipt.split("/").at(-2)!;
  const lines = await connection!.db.select().from(s.claimLines).where(eq(s.claimLines.claimId, id)).orderBy(asc(s.claimLines.id));
  expect(lines.map(line => [line.description, line.category, line.amountCents]), "stored lines").toEqual([["Robot kit and parts", "robot_kits_parts", 28000n], ["Engineering notebooks", "classroom_supplies", 15000n], ["Sandwiches and apple juice", "participant_meals", 7000n]]);
  const edges = await connection!.db.select().from(s.allocationEdges).where(eq(s.allocationEdges.claimId, id));
  const byFund: Record<string, bigint> = {}; for (const edge of edges) byFund[edge.fundId] = (byFund[edge.fundId] ?? 0n) + edge.amountCents;
  console.log("WX-04 stored split " + JSON.stringify(Object.fromEntries(Object.entries(byFund).map(([fund, cents]) => [fund, cents.toString()]))));
  expect(byFund).toEqual({ fund_a: 23000n, fund_b: 20000n, fund_g: 7000n });
  expect(await connection!.db.select().from(s.approvals)).toHaveLength(0); expect(await connection!.db.select().from(s.disbursementAttempts)).toHaveLength(0);
});

test("WX-05: in owner mode the example becomes the same draft, in integer cents with the exact receipt text, and no AI request is made", async ({ page }) => {
  test.setTimeout(180000); await start({ judge: false }); await login(page, "maria");
  await page.goto("/receipts/new"); await toWorkshop(page).click(); await expect(page).toHaveURL("http://127.0.0.1:3100/receipts/new?example=workshop");
  await expectForm(page, WORKSHOP_LITERAL, "owner click-through");
  await page.getByLabel("This receipt holds no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  await page.waitForURL(url => /^\/claims\/R-[a-f0-9-]{36}\/receipt$/.test(url.pathname));
  const id = new URL(page.url()).pathname.split("/")[2]!;
  const [claim] = await connection!.db.select().from(s.claims).where(eq(s.claims.id, id));
  expect([claim!.vendor, claim!.program, claim!.incurredOn, claim!.status], "stored claim").toEqual(["Brightbench Supply Co.", "robotics", "2026-10-14", "DRAFT"]);
  const lines = await connection!.db.select().from(s.claimLines).where(eq(s.claimLines.claimId, id)).orderBy(asc(s.claimLines.id));
  expect(lines.map(line => [line.description, line.amountCents]), "stored lines").toEqual([["Robot kit and parts", 28000n], ["Engineering notebooks", 15000n], ["Sandwiches and apple juice", 7000n]]);
  expect(lines.reduce((sum, line) => sum + line.amountCents, 0n), "stored total in cents").toBe(50000n);
  const [review] = await connection!.db.select().from(s.receiptReviews).where(eq(s.receiptReviews.claimId, id));
  console.log("WX-05 stored receipt text, raw " + JSON.stringify(review!.source));
  expect(lf(review!.source), "stored receipt text").toBe(WORKSHOP_LITERAL.source);
  expect(await connection!.db.select().from(s.approvals)).toHaveLength(0); expect(await connection!.db.select().from(s.disbursementAttempts)).toHaveLength(0);
  expect(await connection!.db.select().from(s.receiptSuggestions)).toHaveLength(0);
});
