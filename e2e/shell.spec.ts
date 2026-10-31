import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";

// SHELL-11 (IAC-373): the app shell at 1440 and 390 px. Rail, both status cards, header tag, footer and no horizontal overflow.
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

const CONFIGS: { label: string; env: Record<string, string>; tag: string; line: string }[] = [
  { label: "Claude key set", env: { AI_RECEIPT_ENABLED: "true", ANTHROPIC_API_KEY: "sk-ant-api03-UI-STUB-NOT-A-REAL-KEY" }, tag: "Claude AI + PayPal sandbox", line: "Built with PayPal Payouts (sandbox) and Claude Haiku" },
  { label: "no Claude key", env: { AI_RECEIPT_ENABLED: "true", ANTHROPIC_API_KEY: "" }, tag: "PayPal sandbox, AI off", line: "Built with PayPal Payouts (sandbox). AI suggestions are off: no Claude key is configured." },
  { label: "AI switched off", env: { AI_RECEIPT_ENABLED: "false", ANTHROPIC_API_KEY: "sk-ant-api03-UI-STUB-NOT-A-REAL-KEY" }, tag: "PayPal sandbox, AI off", line: "Built with PayPal Payouts (sandbox). AI suggestions are switched off in this session." },
];
for (const config of CONFIGS) {
  test(`SHELL-11: app shell at 1440 and 390 px, ${config.label}`, async ({ page }) => {
    await start(config.env);
    await login(page, "maria");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/claims/C-104");
      // Header tag and footer follow the configured receipt AI, on every screen.
      await expect(page.locator(".header-tag")).toHaveText(config.tag);
      await expect(page.locator(".footer-promise")).toHaveText("AI suggests. People decide. PayPal pays.");
      await expect(page.locator(".footer-built")).toHaveText(config.line);
      await expect(page.locator(".footer-promise .paypal-word")).toHaveText("PayPal");
      // Rail: five stages, the Funding stage current for a confirmed draft, later stages locked, tags on AI and PayPal.
      const rail = page.getByRole("navigation", { name: "Expense stages" });
      await expect(rail.locator("li")).toHaveCount(5);
      await expect(rail.locator("[aria-current=step]")).toHaveCount(1);
      await expect(rail.getByLabel(/^Approvals: locked/)).toBeVisible();
      await expect(rail.getByLabel(/^PayPal: locked\. Locked\./)).toBeVisible();
      await expect(rail.locator(".rail-tag.ai")).toHaveText("AI");
      await expect(rail.locator(".rail-tag.paypal")).toHaveText("PayPal");
      // Summary cards: AI teal, PayPal blue, boundary notes, states from loaded state only.
      const ai = page.getByLabel("AI review status"), paypal = page.getByLabel("PayPal payout status");
      await expect(ai).toBeVisible(); await expect(paypal).toBeVisible();
      await expect(ai).toContainText("No financial tools. It cannot approve, choose funds or pay.");
      await expect(paypal).toContainText("Approved does not mean paid.");
      await expect(paypal).toHaveAttribute("data-paypal-state", "not-ready");
      await expect(paypal).toContainText("Not ready: 0 of 2 approvals");
      await expect(paypal).not.toContainText(/Paid, verified/);
      await expect(page.locator(".hybrid-review-count")).toContainText("Human reviews: 0 of 2");
      expect(await ai.evaluate(node => getComputedStyle(node).borderTopColor)).not.toBe(await paypal.evaluate(node => getComputedStyle(node).borderTopColor));
      expect(await paypal.locator(".card-kicker .paypal-word").evaluate(node => getComputedStyle(node).color)).toBe("rgb(0, 48, 135)");
      await fits(page);
      if (width === 1440) {
        // Three columns: rail left of the decision area, left of the summary.
        const [r, c, s] = await Promise.all([".hybrid-rail", ".hybrid-content", ".hybrid-summary"].map(selector => page.locator(selector).boundingBox()));
        expect(r!.x + r!.width).toBeLessThanOrEqual(c!.x + 1); expect(c!.x + c!.width).toBeLessThanOrEqual(s!.x + 1);
        expect(Math.round(r!.width)).toBe(180); expect(Math.round(s!.width)).toBe(232);
      } else {
        // At 1100 px and below the summary sits above the content and the rail is a two-column grid.
        const [c, s] = await Promise.all([".hybrid-content", ".hybrid-summary"].map(selector => page.locator(selector).boundingBox()));
        expect(s!.y).toBeLessThan(c!.y);
        expect(await page.locator(".stage-rail").evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").length)).toBe(2);
      }
    }
    // Sign-in and the claim list carry the same header tag and footer, without a rail or summary.
    for (const path of ["/", "/receipts/new", "/architecture"]) {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 }); await page.goto(path);
        await expect(page.locator(".header-tag")).toHaveText(config.tag);
        await expect(page.locator(".footer-built")).toHaveText(config.line);
        await fits(page);
      }
    }
    await page.context().clearCookies(); await page.goto("/login");
    await expect(page.locator(".header-tag")).toHaveText(config.tag); await expect(page.locator(".footer-promise")).toBeVisible(); await expect(page.locator(".hybrid-rail")).toHaveCount(0); await fits(page);
  });
}
