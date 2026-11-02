import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { test, type Page } from "@playwright/test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import { ensureFixtureOpening } from "../src/ledger/opening";
import * as s from "../db/schema";

// IAC-403 still capture. Not part of the default run: only playwright.mock-capture.config.ts matches it.
// Run it by explicit command (see docs/GATE_REPORT.md section 40). Stills go to local/mock-stills/ (ignored by Git).
// The one practice claim is created through the form, then its status is set directly in the isolated database as a presentation
// fixture. No provider call, no approval, no payment attempt.
const OUT = "local/mock-stills";
let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof connectDatabase>;
let server: ChildProcess | undefined, name: string;
test.afterAll(async () => {
  if (server?.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* Exited. */ } await Promise.race([new Promise(resolve => server!.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 1500))]); try { process.kill(-server.pid, "SIGKILL"); } catch { /* Exited. */ } }
  await connection?.client.end();
  if (admin && /^aidtrace_mockcap_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});
async function login(page: Page, user: string, password: string) {
  await page.goto("/login"); await page.getByLabel("Username").fill(user); await page.getByLabel("Password").fill(password); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(url => url.pathname === "/");
}

test("IAC-403: capture 1440 and 390 stills of the five mock screens", async ({ browser }) => {
  test.setTimeout(600000);
  if (process.env.UI_TEST_CONTAINER !== "true") throw Error("Use isolated OrbStack browser service");
  mkdirSync(OUT, { recursive: true });
  const url = new URL(process.env.DATABASE_URL!); url.pathname = "/postgres";
  admin = postgres(url.toString(), { max: 1 }); name = "aidtrace_mockcap_" + randomBytes(6).toString("hex");
  await admin`create database ${admin(name)}`; url.pathname = "/" + name;
  connection = connectDatabase(url.toString()); await migrate(connection.db, { migrationsFolder: "db/migrations" });
  const passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "mockcap@example.invalid", payeeAllowlist: ["mockcap@example.invalid"] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), AI_RECEIPT_ENABLED: "false", AI_EXPENSE_PROPOSALS_ENABLED: "true", AI_ANALYTICS_ENABLED: "false", PAYPAL_SANDBOX_PAYEE_EMAIL: "mockcap@example.invalid", PAYEE_ALLOWLIST: "mockcap@example.invalid", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
  for (let i = 0; ; i++) {
    try { if ((await fetch("http://127.0.0.1:3100/api/health", { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* Wait. */ }
    if (i > 90 || server.exitCode !== null) throw Error("Server did not start");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const sizes = [{ tag: "1440", width: 1440, height: 900 }, { tag: "390", width: 390, height: 844 }];
  for (const user of ["maria", "tara"] as const) {
    const context = await browser.newContext({ baseURL: "http://127.0.0.1:3100" });
    const page = await context.newPage();
    const shot = async (label: string, path: string) => {
      for (const size of sizes) { await page.setViewportSize({ width: size.width, height: size.height }); await page.goto(path); await page.screenshot({ path: `${OUT}/${label}-${size.tag}.png`, fullPage: true }); }
    };
    if (user === "maria") {
      await shot("signin", "/login");
      await login(page, "maria", passwords.maria);
      await shot("claimant-home-empty", "/");
      await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/receipts/new");
      await page.getByLabel("This receipt is sample data with no real personal details.").check(); await page.getByRole("button", { name: "Create receipt draft", exact: true }).click();
      await page.waitForURL(target => /\/receipt$/.test(target.pathname));
      await shot("claimant-home", "/");
      await shot("architecture", "/architecture");
    } else {
      await login(page, "tara", passwords.tara);
      await shot("approver-home-empty", "/");
      const [claim] = await connection.db.select().from(s.claims).where(eq(s.claims.claimantId, "maria")).then(rows => rows.filter(row => row.id.startsWith("R-")));
      await connection.db.update(s.claims).set({ status: "AWAITING_APPROVAL" }).where(eq(s.claims.id, claim!.id));
      await shot("approver-home", "/");
      await shot("analytics", "/analytics");
    }
    await context.close();
  }
});
