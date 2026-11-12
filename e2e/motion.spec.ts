import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";

// MO-06 (November 10 motion pass). Like copy-words.spec, the test starts its own
// isolated database and next server on 3100. The sign-in page needs no account. With no motion preference, the main content fades in once and ends fully
// opaque. With reduced motion, nothing animates and controls do not transition.
let admin: ReturnType<typeof postgres> | undefined, connection: ReturnType<typeof connectDatabase> | undefined;
let server: ChildProcess | undefined, name = "";

async function start() {
  if (process.env.UI_TEST_CONTAINER !== "true") throw Error("Use isolated OrbStack browser service");
  const url = new URL(process.env.DATABASE_URL!); url.pathname = "/postgres";
  admin = postgres(url.toString(), { max: 1 }); name = "aidtrace_mo_" + randomBytes(6).toString("hex");
  await admin`create database ${admin(name)}`; url.pathname = "/" + name;
  connection = connectDatabase(url.toString()); await migrate(connection.db, { migrationsFolder: "db/migrations" });
  const passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
  await seedFixture(connection.db, { passwords, payeeEmail: "mo@example.invalid", payeeAllowlist: ["mo@example.invalid"] });
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3100"], { detached: true, stdio: "ignore", env: { ...process.env, DATABASE_URL: url.toString(), PAYPAL_SANDBOX_PAYEE_EMAIL: "mo@example.invalid", PAYEE_ALLOWLIST: "mo@example.invalid", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false" } });
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
  if (admin && /^aidtrace_mo_[a-f0-9]{12}$/.test(name)) { await admin`drop database if exists ${admin(name)} with (force)`; await admin.end(); }
});

test("MO-06 the page-in fade plays and ends, and reduced motion turns it off", async ({ page }) => {
  await start();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/login");
  const main = page.locator(".page-shell main");
  await expect(main).toHaveCount(1);
  expect(await main.evaluate(node => getComputedStyle(node).animationName)).toBe("at-page-in");
  await main.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
  expect(await main.evaluate(node => getComputedStyle(node).opacity)).toBe("1");
  expect(await page.locator("body").evaluate(node => getComputedStyle(node).animationName)).toBe("none");
  expect(await page.locator("header.top").evaluate(node => node.closest("main") === null), "the header sits outside main").toBe(true);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  expect(await main.evaluate(node => getComputedStyle(node).animationName)).toBe("none");
  expect(await main.evaluate(node => node.getAnimations().length)).toBe(0);
  expect(await page.getByRole("button", { name: "Sign in", exact: true }).evaluate(node => getComputedStyle(node).transitionDuration)).toBe("0s");
});
