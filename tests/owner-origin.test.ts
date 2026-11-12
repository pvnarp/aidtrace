import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { appOrigin, isSameOrigin } from "../src/server/auth";

// OO-01 to OO-03 (IAC-418, owner loopback origin, docs/GATE_REPORT.md section 54). Pure: no database, no network, no clock.
// Rule since October 31: owner mode accepts the same extra loopback origins as a judge session, so a second owner-mode instance
// (the recording instance on 3120) can sign in. OO-04 is the route-level case in tests/owner-origin.integration.test.ts.
const saved = { mode: process.env.AIDTRACE_JUDGE_SESSION, origin: process.env.APP_ORIGIN };
const restore = (name: "AIDTRACE_JUDGE_SESSION" | "APP_ORIGIN", value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
beforeEach(() => { delete process.env.AIDTRACE_JUDGE_SESSION; delete process.env.APP_ORIGIN; });
afterEach(() => { restore("AIDTRACE_JUDGE_SESSION", saved.mode); restore("APP_ORIGIN", saved.origin); });

// A mode is a value of AIDTRACE_JUDGE_SESSION: unset and "false" are owner mode, "true" is a judge session. "" is owner mode too.
const ownerModes: (string | undefined)[] = [undefined, "false", ""];
const bothModes: (string | undefined)[] = [undefined, "false", "", "true"];
const inMode = (mode: string | undefined, origin: string | undefined) => { restore("AIDTRACE_JUDGE_SESSION", mode); restore("APP_ORIGIN", origin); };
const acceptsNow = (origin: string) => { process.env.APP_ORIGIN = origin; try { return appOrigin() === origin; } catch { return false; } };
// What appOrigin() answers for the current environment: the origin it accepted, or "refused", so a failure names the origin and the mode.
const answer = () => { try { return appOrigin(); } catch { return "refused"; } };
const FIVE = ["http://127.0.0.1:3100", "http://localhost:3100", "http://127.0.0.1:3102", "http://127.0.0.1:3120", "http://127.0.0.1:65535"];

describe("OO-01 owner mode accepts the explicit loopback origins", () => {
  test("3100 on both hosts, and 127.0.0.1 on 3102, 3120 and 65535, with the judge flag unset, false or empty", () => {
    for (const mode of ownerModes) for (const origin of FIVE) {
      inMode(mode, origin);
      expect(answer(), `judge flag ${JSON.stringify(mode)}, APP_ORIGIN ${origin}`).toBe(origin);
    }
  });
  test("a judge session accepts the same five origins", () => {
    for (const origin of FIVE) {
      inMode("true", origin);
      expect(answer(), `judge flag "true", APP_ORIGIN ${origin}`).toBe(origin);
    }
  });
});

describe("OO-02 both modes refuse everything outside that set", () => {
  const refused = ["http://127.0.0.1:3101", "http://localhost:3120", "http://localhost:3102", "https://127.0.0.1:3120", "http://127.0.0.1:65536", "http://127.0.0.1:03120", "http://127.0.0.1:999",
    "http://user@127.0.0.1:3120", "http://127.0.0.1:3120/", "http://0.0.0.0:3120", "http://[::1]:3120", "http://127.0.0.2:3120", "http://localhost.evil:3120", "http://127.0.0.1.nip.io:3120",
    " http://127.0.0.1:3120", "http://127.0.0.1:3120 ", "http://127.0.0.1:3120\n", "http://127.0.0.1", "http://127.0.0.1:3120?x=1", "http://127.0.0.1:3120#x", "HTTP://127.0.0.1:3120",
    "http://127.0.0.1:+3120", "http://127.0.0.1:3.1e3", "http://127.0.0.1:0x0C30", "http://localhost", "http://localhost:3101", "https://localhost:3100", "https://example.com", "null", "*", ""];
  test("every listed origin throws the same error in every mode", () => {
    for (const mode of bothModes) for (const origin of refused) {
      inMode(mode, origin);
      expect(() => appOrigin(), `${String(mode)} ${JSON.stringify(origin)}`).toThrow("APP_ORIGIN must be the explicit local demo origin");
    }
  });
  test("an unset APP_ORIGIN throws in every mode", () => {
    for (const mode of bothModes) { inMode(mode, undefined); expect(() => appOrigin(), String(mode)).toThrow("APP_ORIGIN must be the explicit local demo origin"); }
  });
  test("a request Origin header equal to a refused APP_ORIGIN cannot authorize itself", () => {
    for (const mode of bothModes) for (const origin of ["http://127.0.0.1:3101", "https://127.0.0.1:3120", "http://127.0.0.1:3120/", "http://0.0.0.0:3120"]) {
      inMode(mode, origin);
      expect(() => isSameOrigin(new Request("http://127.0.0.1:3120/api/auth/login", { method: "POST", headers: { origin } })), `${String(mode)} ${origin}`).toThrow();
    }
  });
});

describe("OO-03 the accepted set is exactly 3100 and 3102 to 65535, in both modes", () => {
  test("a sweep of ports 0 to 99999 on 127.0.0.1 accepts only 3100 and 3102 to 65535", () => {
    for (const mode of [undefined, "false", "true"]) {
      inMode(mode, undefined);
      const wrong: number[] = [];
      for (let port = 0; port < 100_000; port++) if (acceptsNow(`http://127.0.0.1:${port}`) !== (port === 3100 || (port >= 3102 && port <= 65535))) wrong.push(port);
      expect({ wrongCount: wrong.length, firstWrong: wrong.slice(0, 5) }, `judge flag ${JSON.stringify(mode)}`).toEqual({ wrongCount: 0, firstWrong: [] });
    }
  }, 60_000);
  test("a sweep of ports 0 to 99999 on localhost accepts only 3100", () => {
    for (const mode of [undefined, "false", "true"]) {
      inMode(mode, undefined);
      const wrong: number[] = [];
      for (let port = 0; port < 100_000; port++) if (acceptsNow(`http://localhost:${port}`) !== (port === 3100)) wrong.push(port);
      expect({ wrongCount: wrong.length, firstWrong: wrong.slice(0, 5) }, `judge flag ${JSON.stringify(mode)}`).toEqual({ wrongCount: 0, firstWrong: [] });
    }
  }, 60_000);
  test("isSameOrigin stays an exact string comparison with APP_ORIGIN=http://127.0.0.1:3120", () => {
    const post = (origin?: string) => new Request("http://127.0.0.1:3120/api/auth/login", { method: "POST", headers: origin === undefined ? {} : { origin } });
    for (const mode of ownerModes) {
      inMode(mode, "http://127.0.0.1:3120");
      expect(isSameOrigin(post("http://127.0.0.1:3120")), `${String(mode)} equal`).toBe(true);
      // No leading or trailing space case here: the Fetch Headers class strips it before isSameOrigin reads the value (measured: " http://127.0.0.1:3120" compared equal),
      // so a space is refused only on the APP_ORIGIN side, which OO-02 covers.
      for (const other of ["http://127.0.0.1:3100", "http://127.0.0.1:3102", "http://localhost:3120", "http://localhost:3100", "null", "", "http://127.0.0.1:3120/", "https://127.0.0.1:3120", "HTTP://127.0.0.1:3120"]) expect(isSameOrigin(post(other)), `${String(mode)} ${JSON.stringify(other)}`).toBe(false);
      expect(isSameOrigin(post()), `${String(mode)} missing header`).toBe(false);
    }
  });
});
