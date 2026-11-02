import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedFixture } from "../db/fixture";
import { closeDatabase } from "../src/server/db";
import { createPolicyDatabase, type PolicyDatabase } from "./support/policy-db";

// OO-04 (IAC-418, owner loopback origin, docs/GATE_REPORT.md section 54). Route level, real Postgres in the isolated check project, no network, no model, no provider.
// The recording instance runs owner mode (no judge session) on loopback port 3120. With APP_ORIGIN=http://127.0.0.1:3120 the sign-in POST from the page at that
// origin must work and the same POST from another origin must not. The unit cases are OO-01 to OO-03 in tests/owner-origin.test.ts.
const RECORDING = "http://127.0.0.1:3120";
const passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
let ctx: PolicyDatabase;
const saved = { mode: process.env.AIDTRACE_JUDGE_SESSION, origin: process.env.APP_ORIGIN, url: process.env.DATABASE_URL };
const restore = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };

beforeAll(async () => {
  ctx = await createPolicyDatabase("aidtrace_origin", { seed: false });
  await seedFixture(ctx.db, { passwords, payeeEmail: "test-recipient@example.invalid", payeeAllowlist: ["test-recipient@example.invalid"] });
  const url = new URL(process.env.DATABASE_URL ?? "postgres://aidtrace@db:5432/aidtrace"); url.pathname = `/${ctx.name}`;
  process.env.DATABASE_URL = url.toString();
}, 60_000);
afterAll(async () => {
  await closeDatabase(); await ctx.close();
  restore("AIDTRACE_JUDGE_SESSION", saved.mode); restore("APP_ORIGIN", saved.origin); restore("DATABASE_URL", saved.url);
}, 60_000);
beforeEach(() => { delete process.env.AIDTRACE_JUDGE_SESSION; process.env.APP_ORIGIN = RECORDING; });

const loginRequest = (username: string, password: string, origin: string | null) => {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (origin !== null) headers.origin = origin;
  return new Request(`${RECORDING}/api/auth/login`, { method: "POST", headers, body: new URLSearchParams({ username, password }).toString() });
};
const counts = async () => ({ sessions: (await ctx.client`select count(*)::int as n from sessions`)[0]!.n as number, windows: (await ctx.client`select count(*)::int as n from login_windows`)[0]!.n as number });

describe("OO-04 owner mode signs in at the recording origin and refuses every other origin", () => {
  for (const mode of [undefined, "false"]) {
    it(`judge flag ${mode === undefined ? "unset" : `"${mode}"`}: login, session, wrong-origin logout and logout at ${RECORDING}`, async () => {
      if (mode !== undefined) process.env.AIDTRACE_JUDGE_SESSION = mode;
      const login = await import("../src/app/api/auth/login/route");
      const session = await import("../src/app/api/auth/session/route");
      const logout = await import("../src/app/api/auth/logout/route");
      const response = await login.POST(loginRequest("maria", passwords.maria, RECORDING));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/");
      const cookie = response.headers.get("set-cookie")!;
      expect(cookie).toMatch(/^aidtrace_session=[0-9a-f]{64}; /);
      // The cookie attributes are unchanged: HttpOnly, SameSite=Strict, Path=/, no Domain (host-only) and no Secure (loopback HTTP).
      expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Strict"); expect(cookie).toContain("Path=/;");
      expect(cookie).not.toMatch(/Domain=/i); expect(cookie).not.toMatch(/Secure/i);
      const pair = cookie.split(";")[0]!;
      const read = await session.GET(new Request(`${RECORDING}/api/auth/session`, { headers: { cookie: pair } }));
      expect(read.status).toBe(200); expect((await read.json()).user.username).toBe("maria");
      // A later state-changing POST is held to the same exact origin: another origin cannot sign the session out, the recording origin can.
      for (const origin of ["http://127.0.0.1:3100", "http://localhost:3120", "null"]) {
        expect((await logout.POST(new Request(`${RECORDING}/api/auth/logout`, { method: "POST", headers: { origin, cookie: pair } }))).status, origin).toBe(403);
      }
      expect((await logout.POST(new Request(`${RECORDING}/api/auth/logout`, { method: "POST", headers: { cookie: pair } }))).status, "missing Origin").toBe(403);
      expect((await session.GET(new Request(`${RECORDING}/api/auth/session`, { headers: { cookie: pair } }))).status).toBe(200);
      expect((await logout.POST(new Request(`${RECORDING}/api/auth/logout`, { method: "POST", headers: { origin: RECORDING, cookie: pair } }))).status).toBe(303);
      expect((await session.GET(new Request(`${RECORDING}/api/auth/session`, { headers: { cookie: pair } }))).status).toBe(401);
    }, 30_000);
  }

  it("a valid password with Origin http://127.0.0.1:3100, another loopback origin, the null origin or no Origin gets 403, no cookie, no session row and no throttle row", async () => {
    const login = await import("../src/app/api/auth/login/route");
    const before = await counts();
    for (const origin of ["http://127.0.0.1:3100", "http://localhost:3100", "http://localhost:3120", "http://127.0.0.1:3102", "https://127.0.0.1:3120", `${RECORDING}/`, "null", null]) {
      const response = await login.POST(loginRequest("tara", passwords.tara, origin));
      expect(response.status, String(origin)).toBe(403);
      expect(response.headers.get("set-cookie"), String(origin)).toBeNull();
    }
    expect(await counts()).toEqual(before);
  }, 30_000);

  it("an APP_ORIGIN outside the accepted set fails closed: the request throws, no cookie, no session row", async () => {
    const login = await import("../src/app/api/auth/login/route");
    const before = await counts();
    for (const origin of ["http://127.0.0.1:3101", "http://localhost:3120", "https://127.0.0.1:3120"]) {
      process.env.APP_ORIGIN = origin;
      await expect(login.POST(loginRequest("ben", passwords.ben, origin)), origin).rejects.toThrow("APP_ORIGIN must be the explicit local demo origin");
    }
    expect(await counts()).toEqual(before);
  }, 30_000);
});
