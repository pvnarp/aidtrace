import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";

// SHELL-11 (IAC-373, IAC-415): the app shell at 1440 and 390 px. Trace stepper, both status cards, header tag, footer and no horizontal overflow.
// The server env fixes the receipt AI configuration, so the header tag and footer line are asserted against it.
let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof connectDatabase>;
let server: ChildProcess | undefined, name: string;
let passwords: Record<"maria" | "tara" | "ben", string>;

async function start(ai: Record<string, string>) {
  if (process.env.UI_TEST_CONTAINER !== "true") throw Error("Use isolated OrbStack browser service");
  const url = new URL(process.env.DATABASE_URL!); url.pathname = "/postgres";
  admin = postgres(url.toString(), { max: 1 }); name = "aidtrace_shell_" + randomBytes(6).toString("hex");
  await admin`create database ${admin(name)}`; url.pathname = "/" + name;
  connection = connectDatabase(url.toString()); await migrate(connection.db, { migrationsFolder: "db/migrations" });
  passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "shell@example.invalid", payeeAllowlist: ["shell@example.invalid"] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AI_EXPENSE_PROPOSALS_ENABLED: "true", PAYPAL_SANDBOX_PAYEE_EMAIL: "shell@example.invalid", PAYEE_ALLOWLIST: "shell@example.invalid", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false", ...ai } });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch("http://127.0.0.1:3100/api/health", { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Wait for this container's server. */ }
    if (server.exitCode !== null) throw Error("Isolated server exited");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error("Server readiness timeout");
}
test.afterEach(async () => {
  if (server?.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* Exited. */ } await Promise.race([new Promise(resolve => server!.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 1500))]); try { process.kill(-server.pid, "SIGKILL"); } catch { /* Exited. */ } }
  await connection?.client.end();
  if (admin && /^aidtrace_shell_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function login(page: Page, user: keyof typeof passwords) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(passwords[user]); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.pathname === "/");
}
async function fits(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
// IAC-416: with no AI configured the header renders no tag element at all, so an empty tag asserts that.
async function headerTag(page: Page, tag: string) { if (tag === "") await expect(page.locator(".header-tag")).toHaveCount(0); else await expect(page.locator(".header-tag")).toHaveText(tag); }

const CONFIGS: { label: string; env: Record<string, string>; tag: string; line: string }[] = [
  { label: "AI key set", env: { AI_RECEIPT_ENABLED: "true", ANTHROPIC_API_KEY: "sk-ant-api03-UI-STUB-NOT-A-REAL-KEY" }, tag: "AI + PayPal", line: "Built with PayPal Payouts and AI" },
  { label: "no AI key", env: { AI_RECEIPT_ENABLED: "true", ANTHROPIC_API_KEY: "" }, tag: "", line: "Built with PayPal Payouts." },
  { label: "AI switched off", env: { AI_RECEIPT_ENABLED: "false", ANTHROPIC_API_KEY: "sk-ant-api03-UI-STUB-NOT-A-REAL-KEY" }, tag: "", line: "Built with PayPal Payouts." },
];
for (const config of CONFIGS) {
  test(`SHELL-11: app shell at 1440 and 390 px, ${config.label}`, async ({ page }) => {
    await start(config.env);
    await login(page, "maria");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/claims/C-104");
      // Header tag and footer follow the configured receipt AI, on every screen.
      await headerTag(page, config.tag);
      await expect(page.locator(".footer-promise")).toHaveText("AI suggests. Rules and people decide. PayPal pays.");
      await expect(page.locator(".footer-built")).toHaveText(config.line);
      await expect(page.locator(".footer-promise .paypal-word")).toHaveText("PayPal");
      // Trace: six steps, Fund split current for a confirmed draft, Approvals and the PayPal payout not reached.
      const trace = page.getByRole("navigation", { name: "Expense trace" });
      await expect(trace.locator("li")).toHaveCount(6);
      await expect(trace.locator("[aria-current=step]")).toHaveCount(1);
      await expect(trace.locator("[aria-current=step] .t")).toHaveText("Fund split");
      const approvals = trace.locator("li").nth(4), payout = trace.locator("li").nth(5);
      await expect(approvals).toHaveAttribute("data-state", "future"); await expect(approvals).toContainText("Not reached: ");
      await expect(approvals.locator(".t")).toHaveText("Approvals"); await expect(approvals.locator(".d")).toHaveText("Locked. Two approvers");
      await expect(payout).toHaveAttribute("data-state", "future"); await expect(payout).toContainText("Not reached: ");
      await expect(payout.locator(".t")).toHaveText("PayPal payout"); await expect(payout.locator(".d")).toHaveText("Locked. Not ready");
      // IAC-415 PR 5: at 1440 every step detail stays on one line ("Locked. Two different people" wrapped), so all detail heights match.
      if (width === 1440) { const heights = await trace.locator("li .d").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).offsetHeight)); expect(new Set(heights).size, `trace detail heights ${heights.join(",")}`).toBe(1); }
      await expect(page.locator(".trace-now")).toContainText("Step 4 of 6, Fund split");
      // Summary cards: AI teal, PayPal blue, boundary notes, states from loaded state only.
      const ai = page.getByLabel("AI review status"), paypal = page.getByLabel("PayPal payout status");
      await expect(ai).toBeVisible(); await expect(paypal).toBeVisible();
      await expect(ai).toContainText("No financial tools. It cannot approve, choose funds or pay.");
      await expect(paypal).toContainText("Approved does not mean paid.");
      await expect(paypal).toHaveAttribute("data-paypal-state", "not-ready");
      await expect(paypal).toContainText("Not ready: needs two approvals"); await expect(paypal).not.toContainText(/\d of 2/);
      await expect(paypal).not.toContainText(/Paid, verified/);
      await expect(page.locator(".hybrid-review-count")).toContainText("Human reviews: 0 of 2");
      expect(await ai.evaluate(node => getComputedStyle(node).boxShadow)).not.toBe(await paypal.evaluate(node => getComputedStyle(node).boxShadow));
      expect(await paypal.locator(".card-kicker .paypal-word").evaluate(node => getComputedStyle(node).color)).toBe("rgb(0, 48, 135)");
      await fits(page);
      const [c, s] = await Promise.all([".hybrid-content", ".hybrid-summary"].map(selector => page.locator(selector).boundingBox()));
      if (width === 1440) {
        // Two columns of 3fr and 2fr with a 24 px gap: the receipt side left of the Decision panel.
        expect(c!.x + c!.width).toBeLessThanOrEqual(s!.x + 1);
        expect(c!.width / s!.width).toBeGreaterThan(1.4); expect(c!.width / s!.width).toBeLessThan(1.6);
      } else {
        // At 900 px and below the grid is one column and the Decision panel sits below the receipt side. The trace is compact.
        expect(s!.y).toBeGreaterThanOrEqual(c!.y + c!.height - 1);
        await expect(page.locator(".trace-now")).toBeVisible(); await expect(page.locator(".trace-now")).toContainText("Fund split");
      }
    }
    // Sign-in and the claim list carry the same header tag and footer, without a rail or summary.
    for (const path of ["/", "/receipts/new", "/architecture"]) {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 }); await page.goto(path);
        await headerTag(page, config.tag);
        await expect(page.locator(".footer-built")).toHaveText(config.line);
        await fits(page);
      }
    }
    await page.context().clearCookies(); await page.goto("/login");
    await headerTag(page, config.tag); await expect(page.locator(".footer-promise")).toBeVisible(); await expect(page.locator("[aria-current=step]")).toHaveCount(0); await fits(page);
  });
}
