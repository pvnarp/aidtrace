import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { appOrigin, expiredSessionCookie, isSameOrigin, sessionCookie } from "../src/server/auth";
import { hostedSession } from "../src/server/hosted-mode";
import { paymentConfigured } from "../src/server/judge-mode";

// HOST-01 to HOST-06 (hosted judging bundle, docs/HOSTED_RUNBOOK.md). Pure: no database, no network, no clock beyond Date.
// Hosted mode is AIDTRACE_HOSTED=true, set only by release/hosted/compose.yaml. It admits exactly one https://<host> APP_ORIGIN, sets Secure on the session
// cookie, and requires a judge session. Owner mode and plain judge sessions are unchanged (tests/owner-origin.test.ts holds their set).
const KEYS = ["AIDTRACE_HOSTED", "AIDTRACE_JUDGE_SESSION", "APP_ORIGIN"] as const;
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
beforeEach(() => { for (const key of KEYS) delete process.env[key]; });
afterEach(() => { for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
const set = (hosted: string | undefined, judge: string | undefined, origin: string | undefined) => {
  for (const [key, value] of [["AIDTRACE_HOSTED", hosted], ["AIDTRACE_JUDGE_SESSION", judge], ["APP_ORIGIN", origin]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
};
const answer = () => { try { return appOrigin(); } catch { return "refused"; } };
const HOST = "https://203-0-113-9.sslip.io";
const EXPIRES = new Date("2026-11-11T12:00:00Z");

describe("HOST-01 hosted mode accepts exactly one configured https origin", () => {
  test("a lowercase https DNS name is accepted", () => {
    for (const origin of [HOST, "https://aidtrace.test", "https://demo.example.com", "https://a-b.c-d.example.org"]) { set("true", "true", origin); expect(answer(), origin).toBe(origin); }
  });
  test("the origin check is an exact string match against the request Origin header", () => {
    set("true", "true", HOST);
    const post = (origin?: string) => new Request(`${HOST}/api/auth/login`, { method: "POST", headers: origin === undefined ? {} : { origin } });
    expect(isSameOrigin(post(HOST))).toBe(true);
    for (const other of ["https://other.sslip.io", "http://203-0-113-9.sslip.io", `${HOST}/`, `${HOST}:443`, "https://203-0-113-9.sslip.io.evil.example", "HTTPS://203-0-113-9.SSLIP.IO", "null", ""]) expect(isSameOrigin(post(other)), other).toBe(false);
    expect(isSameOrigin(post()), "missing header").toBe(false);
  });
});

describe("HOST-02 hosted mode refuses every other origin and any unsafe combination", () => {
  const refused = ["http://203-0-113-9.sslip.io", "http://127.0.0.1:3100", "http://127.0.0.1:3102", "http://localhost:3100", "https://127.0.0.1", "https://203.0.113.9", "https://localhost", "https://nodots",
    "https://host.example.com:8443", "https://host.example.com:443", "https://host.example.com/", "https://host.example.com/x", "https://user@host.example.com", "https://host.example.com?x=1", "https://host.example.com#x",
    "https://Host.Example.com", "https://-host.example.com", "https://host-.example.com", "https://host..example.com", "https://host.example.com.", " https://host.example.com", "https://host.example.com ", "https://host.example.com\n", "https://*.example.com", "*", "null", ""];
  test("every listed origin throws in hosted mode", () => {
    for (const origin of refused) { set("true", "true", origin); expect(() => appOrigin(), JSON.stringify(origin)).toThrow("APP_ORIGIN must be the one hosted https origin"); }
  });
  test("an unset APP_ORIGIN throws in hosted mode", () => { set("true", "true", undefined); expect(() => appOrigin()).toThrow(); });
  test("hosted mode without a judge session is refused, so a hosted workspace can never be payable", () => {
    for (const judge of [undefined, "false", "", "TRUE"]) { set("true", judge, HOST); expect(() => appOrigin(), String(judge)).toThrow(); }
    set("true", "true", HOST);
    expect(paymentConfigured("recipient@personal.example.com", { PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "x", PAYPAL_CLIENT_SECRET: "y", PAYEE_ALLOWLIST: "recipient@personal.example.com", AIDTRACE_JUDGE_SESSION: "true", AIDTRACE_HOSTED: "true" })).toBe(false);
  });
  test("only the exact string true turns hosted mode on", () => {
    for (const flag of [undefined, "", "false", "TRUE", "True", "1", "yes", " true"]) { expect(hostedSession({ AIDTRACE_HOSTED: flag })).toBe(false); set(flag, "true", HOST); expect(() => appOrigin(), String(flag)).toThrow("APP_ORIGIN must be the explicit local demo origin"); }
    expect(hostedSession({ AIDTRACE_HOSTED: "true" })).toBe(true);
  });
  test("hosted mode does not keep the loopback rule", () => {
    for (const origin of ["http://127.0.0.1:3100", "http://localhost:3100", "http://127.0.0.1:3102", "http://127.0.0.1:3120"]) { set("true", "true", origin); expect(() => appOrigin(), origin).toThrow(); }
  });
});

describe("HOST-03 the Secure flag is set only in hosted mode", () => {
  test("hosted: the session cookie and the expiring cookie carry Secure, HttpOnly, SameSite=Strict and Path=/", () => {
    set("true", "true", HOST);
    for (const header of [sessionCookie("a".repeat(64), EXPIRES), expiredSessionCookie()]) {
      expect(header).toMatch(/; Secure$/); expect(header).toContain("HttpOnly"); expect(header).toContain("SameSite=Strict"); expect(header).toContain("Path=/");
    }
  });
  test("owner mode, a plain judge session and any non-true flag carry no Secure", () => {
    for (const [hosted, judge, origin] of [[undefined, undefined, "http://127.0.0.1:3100"], [undefined, "true", "http://127.0.0.1:3102"], ["false", "true", "http://127.0.0.1:3102"], ["TRUE", "true", "http://127.0.0.1:3102"], ["", undefined, "http://127.0.0.1:3120"]] as const) {
      set(hosted, judge, origin);
      for (const header of [sessionCookie("a".repeat(64), EXPIRES), expiredSessionCookie()]) expect(header, `${hosted} ${judge}`).not.toMatch(/Secure/i);
    }
  });
});

describe("HOST-04 owner mode and judge sessions are unchanged by the hosted code", () => {
  test("an https origin is still refused when hosted mode is off", () => {
    for (const judge of [undefined, "false", "true"]) { set(undefined, judge, HOST); expect(() => appOrigin(), String(judge)).toThrow("APP_ORIGIN must be the explicit local demo origin"); }
  });
  test("the loopback set still passes with the hosted flag unset", () => {
    for (const judge of [undefined, "true"]) for (const origin of ["http://127.0.0.1:3100", "http://localhost:3100", "http://127.0.0.1:3102", "http://127.0.0.1:3120"]) { set(undefined, judge, origin); expect(answer(), `${judge} ${origin}`).toBe(origin); }
    set(undefined, undefined, "http://localhost:3102"); expect(() => appOrigin()).toThrow();
  });
});

describe("HOST-06 the login page says the data is sample data and AI is limited per workspace, in hosted mode only", () => {
  const page = readFileSync("src/app/login/page.tsx", "utf8");
  test("the notice is guarded by hostedSession() and keeps the existing copy guards", () => {
    expect(page).toContain("hostedSession() &&");
    const notice = /data-testid="hosted-notice">([^<]+)</.exec(page)?.[1] ?? "";
    expect(notice).toContain("sample data with no real personal details"); expect(notice).toContain("AI requests are limited per workspace");
    expect(notice).not.toMatch(/claude|sandbox|fictional|AI is off|turned off/i);
  });
  test("the sign-in card caption keeps its line (the duplicate footer was cut, judge thread)", () => { expect(page).toContain("Sign in separately for each role."); expect(page).not.toContain("<footer>Sign in separately"); });
});
