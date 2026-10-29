import { afterEach, expect, test, vi } from "vitest";
import { paymentConfigured } from "../src/server/judge-mode";
import { appOrigin } from "../src/server/auth";
import { getPayments } from "../src/server/payments";
afterEach(() => vi.unstubAllEnvs());
const configured = { PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com", PAYPAL_CLIENT_ID: "synthetic-id", PAYPAL_CLIENT_SECRET: "synthetic-secret", PAYEE_ALLOWLIST: "recipient@personal.example.com" };
test("configured sandbox keeps its Send boundary; absent, disallowed and judge configuration cannot", () => {
  expect(paymentConfigured("recipient@personal.example.com", configured)).toBe(true);
  for (const env of [{}, { ...configured, PAYPAL_CLIENT_ID: "" }, { ...configured, PAYPAL_BASE_URL: "https://api-m.paypal.com" }, { ...configured, PAYEE_ALLOWLIST: "other@personal.example.com" }, { ...configured, AIDTRACE_JUDGE_SESSION: "true" }]) expect(paymentConfigured("recipient@personal.example.com", env)).toBe(false);
  expect(paymentConfigured("judge@example.invalid", { ...configured, PAYEE_ALLOWLIST: "judge@example.invalid" })).toBe(false);
});
test("judge mode refuses provider construction even if credentials are injected", () => {
  vi.stubEnv("AIDTRACE_JUDGE_SESSION", "true");
  vi.stubEnv("PAYPAL_CLIENT_ID", "synthetic-injected"); vi.stubEnv("PAYPAL_CLIENT_SECRET", "synthetic-injected");
  expect(() => getPayments()).toThrow("Judge session payments disabled");
});
test("extra loopback ports require judge mode and never authorize a public origin", () => {
  vi.stubEnv("AIDTRACE_JUDGE_SESSION", "false"); vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3102");
  expect(() => appOrigin()).toThrow();
  vi.stubEnv("AIDTRACE_JUDGE_SESSION", "true"); expect(appOrigin()).toBe("http://127.0.0.1:3102");
  for (const origin of ["http://127.0.0.1:3101", "http://127.0.0.1:65536", "http://127.0.0.1:03102", "http://localhost.evil:3102", "https://127.0.0.1:3102", "http://user@127.0.0.1:3102", "http://127.0.0.1:3102/", "http://0.0.0.0:3102"]) { vi.stubEnv("APP_ORIGIN", origin); expect(() => appOrigin()).toThrow(); }
});
