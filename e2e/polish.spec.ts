import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";

// PL-01 to PL-06 (IAC-415 polish, "say it once", docs/GATE_REPORT.md section 50): the desktop pages at 1440 px.
// One isolated database and one next server on 3100 serve the whole serial group, like journey.spec. AI is off, so a person chooses the categories.
// The first test walks the real flow (draft, freeze by the claimant, two separate approver sign-ins) and measures every page it reaches in the browser.
// The PL tests then assert on those measurements, so one flow answers all six and each failure message names the offending element.
// The measurements go to a file, not a module variable: Playwright starts a new worker after any failed test, which would empty a variable and
// make every later PL test fail with a misleading "no data" message. PL-00 resets the file, so a stale file never outlives a run that walks the flow.
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });
let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof connectDatabase>;
let server: ChildProcess | undefined, name: string;
let passwords: Record<"maria" | "tara" | "ben", string>;

type Measure = {
  label: string; claim: boolean;
  paid: number;            // occurrences of the boundary sentence in textContent, closed <details> included, scripts excluded
  fixture: string[];       // lines of innerText (closed <details> excluded) that say fixture or fictional
  uuids: string[];         // full UUIDs in innerText (closed <details> excluded, so the Reference disclosure is outside it)
  nested: string[];        // claim page only: an element with a visible border inside an ancestor with a visible border, below the panel
  small: string[];         // claim page only: p, li and dd with a computed font size under 14 px
  height: number;          // document scrollHeight
};
const RESULTS_DIR = "local/polish-results", RESULTS_FILE = RESULTS_DIR + "/measurements.json";
const results: Measure[] = [];
const save = () => { mkdirSync(RESULTS_DIR, { recursive: true }); writeFileSync(RESULTS_FILE, JSON.stringify(results)); };
const load = (): Measure[] => { try { return JSON.parse(readFileSync(RESULTS_FILE, "utf8")) as Measure[]; } catch { throw Error("PL-00 wrote no measurements: fix PL-00 first"); } };

test.beforeAll(async () => {
  if (process.env.UI_TEST_CONTAINER !== "true") throw Error("Use isolated OrbStack browser service");
  const url = new URL(process.env.DATABASE_URL!); url.pathname = "/postgres";
  admin = postgres(url.toString(), { max: 1 }); name = "aidtrace_polish_" + randomBytes(6).toString("hex");
  await admin`create database ${admin(name)}`; url.pathname = "/" + name;
  connection = connectDatabase(url.toString()); await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "polish@example.invalid", payeeAllowlist: ["polish@example.invalid"] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AI_RECEIPT_ENABLED: "false", AI_EXPENSE_PROPOSALS_ENABLED: "true", PAYPAL_SANDBOX_PAYEE_EMAIL: "polish@example.invalid", PAYEE_ALLOWLIST: "polish@example.invalid", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch("http://127.0.0.1:3100/api/health", { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Wait for this container's server. */ }
    if (server.exitCode !== null) throw Error("Isolated server exited");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error("Server readiness timeout");
});
test.afterAll(async () => {
  if (server?.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* Exited. */ } await Promise.race([new Promise(resolve => server!.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 1500))]); try { process.kill(-server.pid, "SIGKILL"); } catch { /* Exited. */ } }
  await connection?.client.end();
  if (admin && /^aidtrace_polish_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.pathname === "/");
}
async function logout(page: Page) { await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL(url => url.pathname === "/login"); }

/** Measure the page in the browser. The border test skips form controls (input, select, textarea, button), which keep their own field border by design. */
async function measure(page: Page, label: string, claim: boolean) {
  await page.waitForLoadState("load");
  results.push(await page.evaluate(({ label, claim }) => {
    const describe = (el: Element) => { const cls = el.getAttribute("class")?.trim(); return el.tagName.toLowerCase() + (cls ? "." + cls.split(/\s+/).join(".") : ""); };
    const copy = document.body.cloneNode(true) as HTMLElement; copy.querySelectorAll("script, style, noscript").forEach(node => node.remove());
    const paid = (copy.textContent ?? "").split("Approved does not mean paid.").length - 1;
    const visible = document.body.innerText;
    const fixture = [...visible.matchAll(/[^\n]*(?:fixture|fictional)[^\n]*/gi)].map(match => match[0].trim());
    const uuids = [...visible.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].map(match => match[0]);
    const hasBorder = (el: Element) => { const style = getComputedStyle(el); return ["top", "right", "bottom", "left"].some(side => {
      const color = style.getPropertyValue(`border-${side}-color`);
      return parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0 && !["none", "hidden"].includes(style.getPropertyValue(`border-${side}-style`)) && color !== "transparent" && color !== "rgba(0, 0, 0, 0)";
    }); };
    const controls = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON"]);
    const nested = new Set<string>(), small = new Set<string>();
    if (claim) {
      for (const panel of document.querySelectorAll(".hybrid-content > section, .hybrid-content > details, aside.dec")) {
        for (const el of panel.querySelectorAll("*")) {
          if (controls.has(el.tagName) || !hasBorder(el)) continue;
          for (let ancestor = el.parentElement; ancestor && ancestor !== panel; ancestor = ancestor.parentElement) {
            if (hasBorder(ancestor)) { nested.add(`${describe(el)} inside ${describe(ancestor)} in ${describe(panel)}`); break; }
          }
        }
      }
      for (const el of document.querySelectorAll("p, li, dd")) { const size = parseFloat(getComputedStyle(el).fontSize); if (size < 14) small.add(`${describe(el)} ${size}px`); }
    }
    return { label, claim, paid, fixture, uuids, nested: [...nested], small: [...small], height: document.documentElement.scrollHeight };
  }, { label, claim }));
  save();
}

test("PL-00: walk the real flow at 1440 and measure each page", async ({ page }) => {
  test.setTimeout(300000); results.length = 0; save();
  await login(page, "tara"); await measure(page, "approver home (empty)", false); await logout(page);
  await login(page, "maria"); await measure(page, "claimant home (empty)", false);
  await page.getByRole("link", { name: "Start an expense", exact: true }).click();
  await page.getByLabel("This receipt holds no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
  await expect(page.getByLabel("Category for L1", { exact: true })).toBeVisible();
  await measure(page, "receipt page", false);
  for (const [line, category] of [["L1", "robot_kits_parts"], ["L2", "classroom_supplies"], ["L3", "participant_meals"]]) {
    await page.getByLabel(`Category for ${line}`, { exact: true }).selectOption(category!); await page.getByLabel(`Reason for manual choice ${line}`, { exact: true }).fill("Checked this receipt directly");
  }
  await page.getByLabel(/I checked every category/).check(); await page.getByRole("button", { name: "Confirm categories", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Human confirmation recorded" })).toBeVisible(); await measure(page, "receipt page (confirmed)", false);
  await page.getByRole("link", { name: "Continue to funding", exact: true }).click();
  await expect(page.getByRole("button", { name: "Freeze allocation for approval", exact: true })).toBeVisible(); const claim = page.url(); await measure(page, "claim draft", true);
  // November 11 calm pass (CP-01): the same reason typed on all three lines is said once under the list.
  await expect(page.getByTestId("shared-reason")).toHaveText("Claimant's reason for all 3 lines: Checked this receipt directly"); await expect(page.locator(".expense-lines")).not.toContainText("Claimant's reason");
  await page.goto("/"); await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); await measure(page, "claimant home", false);
  await page.goto(claim); await page.getByRole("button", { name: "Freeze allocation for approval", exact: true }).click();
  await expect(page.locator(".trace [aria-current=step] .t")).toHaveText("Approvals"); await measure(page, "claim awaiting (claimant)", true);
  await logout(page); await login(page, "tara"); await measure(page, "approver home", false);
  await page.goto(claim); await expect(page.getByRole("button", { name: "Approve these terms", exact: true })).toBeVisible(); await measure(page, "claim awaiting (approver)", true);
  await page.getByRole("button", { name: "Approve these terms", exact: true }).click();
  await expect(page.locator(".hybrid-review-count")).toContainText("1 of 2"); await measure(page, "claim one approval", true);
  await logout(page); await login(page, "ben"); await page.goto(claim);
  await page.getByRole("button", { name: "Approve these terms", exact: true }).click();
  await expect(page.locator(".trace [aria-current=step] .t")).toHaveText("PayPal payout"); await expect(page.locator(".hybrid-review-count")).toContainText("2 of 2"); await measure(page, "claim approved", true);
  await page.goto(claim); await expect(page.locator(".hybrid-review-count")).toContainText("2 of 2"); await measure(page, "claim approved (reopened)", true);
  await page.goto(claim + "/receipt"); await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); await measure(page, "receipt page (approved claim)", false);
});

const CLAIM_PAGES = ["claim draft", "claim awaiting (claimant)", "claim awaiting (approver)", "claim one approval", "claim approved", "claim approved (reopened)"];
const claimPages = () => { const found = load().filter(item => item.claim); expect(found.map(item => item.label), "the flow measured every claim page").toEqual(CLAIM_PAGES); return found; };
const primary = (...labels: string[]) => { const found = load().filter(item => labels.includes(item.label)); expect(found.map(item => item.label), "the flow measured every primary page").toEqual(labels); return found; };

test("PL-01: the sentence 'Approved does not mean paid.' appears at most once on each claim page, closed details included", () => {
  for (const item of claimPages()) expect(item.paid, item.label).toBeLessThanOrEqual(1);
  // Said once, not removed: the approved page still states it, in the Decision panel.
  expect(load().find(item => item.label === "claim approved")!.paid).toBe(1);
});

test("PL-02: no 'fixture' or 'fictional' in the visible text of the homes, the claim pages and the receipt page", () => {
  for (const item of [...primary("approver home (empty)", "claimant home (empty)", "receipt page", "receipt page (confirmed)", "claimant home", "approver home", "receipt page (approved claim)"), ...claimPages()]) expect(item.fixture, item.label).toEqual([]);
});

test("PL-03: no full UUID in the visible text of the same pages (the full id lives in the closed Reference disclosure)", () => {
  for (const item of [...primary("approver home (empty)", "claimant home (empty)", "receipt page", "receipt page (confirmed)", "claimant home", "approver home", "receipt page (approved claim)"), ...claimPages()]) expect(item.uuids, item.label).toEqual([]);
});

test("PL-04: inside each claim panel, no bordered element sits inside a bordered ancestor (form controls excluded)", () => {
  for (const item of claimPages()) expect(item.nested, item.label).toEqual([]);
});

test("PL-05: every p, li and dd on the claim page is at least 14 px at 1440", () => {
  for (const item of claimPages()) expect(item.small, item.label).toEqual([]);
});

test("PL-06: the approved claim page is under 2,600 px tall at 1440", () => {
  const heights = Object.fromEntries(claimPages().map(item => [item.label, item.height])); console.log("PL-06 heights " + JSON.stringify(heights));
  expect(heights["claim approved"]!, `approved ${JSON.stringify(heights)}`).toBeLessThan(2600);
  expect(heights["claim approved (reopened)"]!, `approved, reopened ${JSON.stringify(heights)}`).toBeLessThan(2600);
});
