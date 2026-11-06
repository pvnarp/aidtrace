import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";

// IAC-384, the browser check of the receipt photo reader (docs/GATE_REPORT.md section 72, PH-40 and onward). The real flow in a desktop browser: a claimant chooses a photo of a
// sample receipt, sees the draft form filled and the photo beside it, reads an arithmetic mismatch, a failed read, submits, and reaches the draft with the photo evidence line.
// Every model answer comes from a loopback stub that this file defines (UI_TEST_CONTAINER sends Claude requests to 127.0.0.1:8080). It is NOT a real model result.
// The fixture PNG is rendered by the browser itself from inline HTML. Each test starts its own database and next server on 3100, like rules-draft.spec.
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });
const ORIGIN = "http://127.0.0.1:3100";
const STILLS = "local/rules-ui-artifacts";
let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof connectDatabase>;
let server: ChildProcess | undefined, model: Server | undefined, name: string;
let passwords: Record<"maria" | "tara" | "ben", string>;
let photoMode: "good" | "mismatch" | "tip" | "refused" = "good";
let photoRequests: { model: string; mediaType: string; dataLength: number; system: string }[] = [];
let otherRequests = 0;
let printedDate = "2026-10-12";

const LINES = [{ text: "Acrylic paint set", amount_cents: 1250 }, { text: "Brush pack", amount_cents: 480 }, { text: "Poster board", amount_cents: 390 }, { text: "Lunch sandwiches", amount_cents: 760 }];
const transcript = (total: number) => ({ readable: true, vendor: "Lakeside Craft Supply", date_printed: printedDate, lines: LINES, subtotal_cents: 2880, tax_cents: -1, total_cents: total });

async function start(photoFlag: "true" | "false") {
  if (process.env.UI_TEST_CONTAINER !== "true") throw new Error("Use the isolated OrbStack browser service");
  name = `aidtrace_iac384_ph_${randomBytes(6).toString("hex")}`;
  const adminUrl = new URL(process.env.DATABASE_URL!); adminUrl.pathname = "/postgres";
  admin = postgres(adminUrl.toString(), { max: 1 }); await admin`create database ${admin(name)}`;
  const url = new URL(adminUrl); url.pathname = `/${name}`; connection = connectDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "photo-test@personal.example.com", payeeAllowlist: ["photo-test@personal.example.com"] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  photoMode = "good"; photoRequests = []; otherRequests = 0; printedDate = "2026-10-12";
  model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const content = body.messages[0].content;
    let text: string; let stop = "end_turn";
    if (Array.isArray(content)) {
      const image = content.find((block: { type: string }) => block.type === "image");
      photoRequests.push({ model: body.model, mediaType: image.source.media_type, dataLength: image.source.data.length, system: body.system });
      text = JSON.stringify(photoMode === "tip" ? { ...transcript(2880), subtotal_cents: 1730 } : transcript(photoMode === "mismatch" ? 2881 : 2880));
      if (photoMode === "refused") stop = "refusal";
    } else {
      otherRequests++;
      const data = JSON.parse(content); const categories = ["robot_kits_parts", "classroom_supplies", "participant_meals", "classroom_supplies"];
      text = JSON.stringify({ proposals: data.lines.map((line: { id: string; description: string }, i: number) => ({ lineId: line.id, category: categories[i], quote: line.description })) });
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_ui_stub", type: "message", role: "assistant", model: body.model, stop_reason: stop, stop_sequence: null, content: [{ type: "text", text }], usage: { input_tokens: 812, output_tokens: 57 } }));
  });
  await new Promise<void>(resolve => model!.listen(8080, "0.0.0.0", resolve));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AIDTRACE_JUDGE_SESSION: "false", AI_RECEIPT_ENABLED: "true", AI_RECEIPT_PHOTO_ENABLED: photoFlag, AI_RULE_DRAFTS_ENABLED: "false", AI_COMPLIANCE_ENABLED: "false", AI_EXPENSE_PROPOSALS_ENABLED: "false", ANTHROPIC_API_KEY: "sk-ant-api03-UI-STUB-NOT-A-REAL-KEY", PAYPAL_SANDBOX_PAYEE_EMAIL: "photo-test@personal.example.com", PAYEE_ALLOWLIST: "photo-test@personal.example.com", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
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
  model?.closeAllConnections(); if (model) { await new Promise<void>(resolve => model!.close(() => resolve())); model = undefined; }
  if (admin && /^aidtrace_iac384_ph_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]);
  const response = page.waitForResponse(r => r.url().endsWith("/api/auth/login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); expect((await response).status()).toBe(303);
  await page.waitForURL(url => url.pathname === "/");
}
// A sample receipt drawn by the browser from inline HTML: no network, no stored file.
async function receiptPng(page: Page): Promise<Buffer> {
  const draw = await page.context().newPage();
  await draw.setContent(`<html><body style="margin:0;background:#fff;font:20px monospace;width:420px;padding:24px"><h3>Lakeside Craft Supply</h3><p>2026-10-12</p>${LINES.map(line => `<p>${line.text} ${(line.amount_cents / 100).toFixed(2)}</p>`).join("")}<p>Total 28.80</p></body></html>`);
  const png = await draw.screenshot({ type: "png" }); await draw.close(); return png;
}

test("PH-40 to PH-44: a claimant reads a photo into the draft form, sees a mismatch and a failed read, submits, and the draft says it was read from a photo", async ({ page }) => {
  test.setTimeout(300_000);
  await start("true");
  const png = await receiptPng(page);
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  await login(page, "maria"); await page.goto("/receipts/new");

  await test.step("PH-40: the control is there, the form is the practice example, and extra line slots are hidden until a photo fills them", async () => {
    await expect(page.getByTestId("photo-reader")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Read a photo of a sample receipt" })).toBeVisible();
    await expect(page.locator("#vendor")).toHaveValue("Cedar Science Shop");
    await expect(page.locator("fieldset.receipt-line:visible")).toHaveCount(3);
    expect(await page.locator("fieldset.receipt-line").count()).toBe(12);
    await expect(page.locator("#photoReadId")).toHaveValue("");
    // The photo layout is real styling: the form and the photo column sit side by side on a wide screen.
    const columns = await page.locator(".photo-layout").evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    expect(columns).toBe(2);
  });

  await test.step("PH-41: choosing a photo fills the form, shows the browser's own copy beside it and sends one request with the image from the bytes", async () => {
    await page.getByTestId("photo-input").setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: png });
    await expect(page.getByTestId("photo-status")).toContainText("AI read this photo. Check every line against the photo before you continue.");
    await expect(page.locator("#vendor")).toHaveValue("Lakeside Craft Supply");
    await expect(page.locator("#incurredOn")).toHaveValue("2026-10-12");
    await expect(page.locator("#description1")).toHaveValue("Acrylic paint set"); await expect(page.locator("#amount1")).toHaveValue("12.50");
    await expect(page.locator("#description4")).toHaveValue("Lunch sandwiches"); await expect(page.locator("#amount4")).toHaveValue("7.60");
    await expect(page.locator("#description5")).toHaveValue("");
    await expect(page.locator("fieldset.receipt-line:visible")).toHaveCount(4);
    await expect(page.locator("#total")).toHaveValue("28.80");
    await expect(page.locator("#source")).toHaveValue("Acrylic paint set $12.50\nBrush pack $4.80\nPoster board $3.90\nLunch sandwiches $7.60\nSubtotal $28.80\nTotal $28.80");
    await expect(page.locator("#program")).toHaveValue("robotics");
    await expect(page.getByLabel("This receipt is sample data with no real personal details.")).not.toBeChecked();
    await expect(page.locator("#photoReadId")).toHaveValue(/^[0-9a-f-]{36}$/);
    await expect(page.getByTestId("photo-mismatch")).toHaveCount(0);
    const preview = page.getByTestId("photo-preview");
    await expect(preview).toBeVisible();
    expect(await preview.getAttribute("src")).toMatch(/^blob:/);
    expect(await preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    expect(photoRequests).toHaveLength(1);
    expect(photoRequests[0]).toMatchObject({ model: "claude-haiku-5-5", mediaType: "image/png" });
    expect(photoRequests[0]!.dataLength).toBeGreaterThan(100);
    expect(photoRequests[0]!.system).toContain("untrusted data");
    await page.screenshot({ path: `${STILLS}/ph-photo-filled.png`, fullPage: true });
  });

  await test.step("PH-42: an arithmetic mismatch is shown with both amounts and nothing is repaired", async () => {
    photoMode = "mismatch";
    await page.getByTestId("photo-input").setInputFiles({ name: "receipt2.png", mimeType: "image/png", buffer: png });
    await expect(page.getByTestId("photo-mismatch")).toHaveText("The amounts do not add up: lines plus tax are $28.80, the total reads $28.81. Fix the numbers or retake the photo.");
    await expect(page.locator("#total")).toHaveValue("28.81"); await expect(page.locator("#amount1")).toHaveValue("12.50");
    await page.screenshot({ path: `${STILLS}/ph-mismatch.png`, fullPage: true });
  });

  await test.step("PH-86: an amount after the printed subtotal shows the neutral note and no warning", async () => {
    await page.goto("/receipts/new");
    photoMode = "tip";
    await page.getByTestId("photo-input").setInputFiles({ name: "receipt-tip.png", mimeType: "image/png", buffer: png });
    await expect(page.getByTestId("photo-note")).toHaveText("The subtotal $17.30 covers the first 2 lines. The $11.50 after it, such as a tip added by hand, is in the total of $28.80. Check that line against the photo.");
    await expect(page.getByTestId("photo-mismatch")).toHaveCount(0);
    await expect(page.getByTestId("photo-status")).not.toHaveClass(/warning/);
    await expect(page.locator("#total")).toHaveValue("28.80");
  });

  await test.step("PH-43: a failed read pre-fills nothing and says so in the fixed words", async () => {
    await page.goto("/receipts/new");
    photoMode = "refused";
    await page.getByTestId("photo-input").setInputFiles({ name: "receipt3.png", mimeType: "image/png", buffer: png });
    await expect(page.getByTestId("photo-status")).toHaveText("Could not read this photo. Type the receipt instead.");
    await expect(page.getByTestId("photo-status")).toHaveClass(/warning/);
    await expect(page.locator("#vendor")).toHaveValue("Cedar Science Shop"); await expect(page.locator("#total")).toHaveValue("6.00");
    await expect(page.locator("#photoReadId")).toHaveValue("");
    await expect(page.getByTestId("photo-preview")).toBeVisible();
    await page.screenshot({ path: `${STILLS}/ph-failed.png`, fullPage: true });
    // A file that is not an image is refused in the browser, with the same words, and nothing more is sent.
    const before = photoRequests.length;
    await page.getByTestId("photo-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") });
    await expect(page.getByTestId("photo-status")).toHaveText("Could not read this photo. Type the receipt instead.");
    expect(photoRequests).toHaveLength(before);
  });

  await test.step("PH-44: submitting the filled form reaches the draft, which says it was read from a photo, and the person's confirmation is recorded after the existing flow", async () => {
    photoMode = "good";
    await page.goto("/receipts/new");
    // PB-09: the photo control names the model before the photo is sent, and the status names the model that read it.
    await expect(page.getByTestId("photo-powered-by")).toHaveText("Powered by Claude Haiku 5.5.");
    await page.getByTestId("photo-input").setInputFiles({ name: "receipt4.png", mimeType: "image/png", buffer: png });
    await expect(page.getByTestId("photo-status")).toContainText("AI read this photo.");
    await expect(page.getByTestId("photo-powered-by")).toHaveText("Powered by Claude Haiku 5.5.");
    await page.getByLabel("This receipt is sample data with no real personal details.").check();
    await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
    await expect(page.getByRole("status").first()).toContainText("Unpaid draft created");
    await expect(page.getByTestId("photo-evidence")).toHaveText("Pre-filled from a photo by AI (Haiku 5.5). The claimant made no changes.");
    await expect(page.getByTestId("photo-powered-by")).toHaveText("Powered by Claude Haiku 5.5.");
    await expect(page.locator(".receipt-source")).toContainText("Acrylic paint set $12.50");
    expect(otherRequests).toBe(0);
    await page.getByRole("button", { name: "Request AI suggestions" }).click(); await expect(page.locator(".notice")).toContainText("AI suggestions are ready");
    await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible();
    await expect(page.getByTestId("photo-evidence")).toHaveText("Pre-filled from a photo by AI (Haiku 5.5). The claimant made no changes.");
    await page.screenshot({ path: `${STILLS}/ph-claim-evidence.png`, fullPage: true });
    const [claims] = await connection.client`select count(*)::int as n from claims where id like 'R-%'`; expect(claims!.n).toBe(1);
    const reads = await connection.client`select outcome from receipt_photo_reads order by created_at`;
    expect(reads.map(row => row.outcome)).toEqual(["READ", "READ", "READ", "REFUSED", "READ"]);
    const [linked] = await connection.client`select count(*)::int as n from receipt_reviews where photo_read_id is not null`; expect(linked!.n).toBe(1);
    for (const table of ["approvals", "disbursements", "disbursement_attempts", "allocation_decisions"]) { const [row] = await connection.client.unsafe(`select count(*)::int as n from ${table}`); expect(row!.n, table).toBe(0); }
  });
});

test("PH-45: with the flag off the page shows no photo control and the route answers 404", async ({ page }) => {
  await start("false");
  await login(page, "maria"); await page.goto("/receipts/new");
  await expect(page.getByRole("button", { name: "Create receipt draft", exact: true })).toBeVisible();
  await expect(page.getByTestId("photo-reader")).toHaveCount(0);
  await expect(page.getByTestId("photo-input")).toHaveCount(0);
  await expect(page.getByText("Read a photo of a sample receipt")).toHaveCount(0);
  await expect(page.locator("#photoReadId")).toHaveCount(0);
  await expect(page.locator("fieldset.receipt-line")).toHaveCount(3);
  // RS-05: the flag is off, so the new receipt page keeps its old words.
  await expect(page.getByRole("navigation", { name: "Expense trace" })).toContainText("Typed text and amounts");
  await expect(page.getByRole("navigation", { name: "Expense trace" })).not.toContainText("Photo or typed text");
  const response = await page.request.post("/api/receipts/photo-text", { headers: { origin: ORIGIN, "content-type": "image/png" }, data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), maxRedirects: 0 });
  expect(response.status()).toBe(404);
  expect(photoRequests).toHaveLength(0);
});

test("PH-60 to PH-63: a printed date that is not a date is cleared and shown, the text box is labelled, the photo fits its column and the claim rail says it was read from a photo", async ({ page }) => {
  test.setTimeout(300_000);
  await start("true");
  const png = await receiptPng(page);
  await login(page, "maria"); await page.goto("/receipts/new");

  await test.step("RS-04: with the photo reader on, the new receipt page says Photo or typed text before any photo is read", async () => {
    await expect(page.getByRole("navigation", { name: "Expense trace" })).toContainText("Photo or typed text");
    await expect(page.getByRole("navigation", { name: "Expense trace" })).not.toContainText("Typed text and amounts");
  });

  await test.step("PH-60: a printed date the form cannot hold clears the date field, shows the printed text and the required field forces entry", async () => {
    printedDate = "12 Oct 26";
    await page.getByTestId("photo-input").setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: png });
    await expect(page.getByTestId("photo-status")).toContainText("AI read this photo.");
    await expect(page.locator("#incurredOn")).toHaveValue("");
    await expect(page.getByTestId("printed-date")).toBeVisible();
    await expect(page.getByTestId("printed-date")).toHaveText("Printed date: 12 Oct 26. Enter it as a date.");
    await page.getByLabel("This receipt is sample data with no real personal details.").check();
    await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
    await expect(page).toHaveURL(/\/receipts\/new/);
    expect(await page.locator("#incurredOn").evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
    await expect(page.getByTestId("photo-evidence")).toHaveCount(0);
    await page.locator("#incurredOn").fill("2026-10-12");
    await page.screenshot({ path: `${STILLS}/ph-printed-date.png`, fullPage: true });
  });

  await test.step("PH-61: the text box label says it was read from the photo, and says typed again for a file that cannot be read", async () => {
    await expect(page.locator("#sourceLabel")).toHaveText("Receipt text read from the photo");
    photoMode = "refused";
    await page.getByTestId("photo-input").setInputFiles({ name: "receipt2.png", mimeType: "image/png", buffer: png });
    await expect(page.getByTestId("photo-status")).toHaveText("Could not read this photo. Type the receipt instead.");
    await expect(page.locator("#sourceLabel")).not.toHaveText("Receipt text read from the photo");
  });

  await test.step("PH-62: the photo preview fits its column", async () => {
    photoMode = "good"; printedDate = "2026-10-12";
    await page.getByTestId("photo-input").setInputFiles({ name: "receipt3.png", mimeType: "image/png", buffer: png });
    await expect(page.getByTestId("photo-status")).toContainText("AI read this photo.");
    const sizes = await page.getByTestId("photo-preview").evaluate((img: HTMLImageElement) => ({ img: img.getBoundingClientRect().width, column: img.closest(".photo-reader")!.getBoundingClientRect().width, high: img.getBoundingClientRect().height, view: window.innerHeight }));
    expect(sizes.img).toBeLessThanOrEqual(sizes.column + 0.5);
    expect(sizes.high).toBeLessThanOrEqual(sizes.view * 0.7 + 0.5);
  });

  await test.step("PH-63: the claim rail says Read from a photo for a linked receipt and the typed text for a receipt with no photo", async () => {
    await page.getByLabel("This receipt is sample data with no real personal details.").check();
    await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
    await expect(page.getByRole("status").first()).toContainText("Unpaid draft created");
    await expect(page.getByRole("navigation", { name: "Expense trace" })).toContainText("Read from a photo");
    await expect(page.getByRole("navigation", { name: "Expense trace" })).not.toContainText("Typed text and amounts");
    await page.goto("/receipts/new");
    await page.getByLabel("This receipt is sample data with no real personal details.").check();
    await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
    await expect(page.getByRole("status").first()).toContainText("Unpaid draft created");
    await expect(page.getByRole("navigation", { name: "Expense trace" })).toContainText("Typed text and amounts");
    await expect(page.getByRole("navigation", { name: "Expense trace" })).not.toContainText("Read from a photo");
  });
});
