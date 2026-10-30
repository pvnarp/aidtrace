import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GIVE_PRESET_CENTS, decimalFromCents, formatUsd, maskTail, parseUsdAmount, requestShape } from "../src/donation/display";
import { KEYLESS_HEADLINE, keylessPanelModel } from "../src/donation/give-model";
import { donationMode } from "../src/server/donation-mode";
import { giveContentSecurityPolicy } from "../src/server/give-csp";
import { config, proxy } from "../src/proxy";

const SANDBOX = "https://api-m.sandbox.paypal.com";
const keyed = { PAYPAL_BASE_URL: SANDBOX, PAYPAL_CLIENT_ID: "e2e-fake-client-id", PAYPAL_CLIENT_SECRET: "e2e-fake-secret" };

describe("DON-09 donation mode is decided on the server from configuration alone", () => {
  it("is KEYED only for a non-judge session, the exact sandbox URL and both credentials", () => {
    expect(donationMode(keyed)).toBe("KEYED");
    expect(donationMode({ ...keyed, AIDTRACE_JUDGE_SESSION: "false" })).toBe("KEYED");
    expect(donationMode({})).toBe("KEYLESS");
    expect(donationMode({ ...keyed, AIDTRACE_JUDGE_SESSION: "true" })).toBe("KEYLESS");
    for (const url of [undefined, "", "https://api-m.paypal.com", "https://api-m.sandbox.paypal.com/", "http://api-m.sandbox.paypal.com", "https://api-m.sandbox.paypal.com.evil.example", "HTTPS://API-M.SANDBOX.PAYPAL.COM"]) expect(donationMode({ ...keyed, PAYPAL_BASE_URL: url })).toBe("KEYLESS");
    for (const missing of [undefined, "", "   "]) {
      expect(donationMode({ ...keyed, PAYPAL_CLIENT_ID: missing })).toBe("KEYLESS");
      expect(donationMode({ ...keyed, PAYPAL_CLIENT_SECRET: missing })).toBe("KEYLESS");
    }
  });
  it("needs no payee allowlist, which gates payouts only", () => {
    expect(donationMode({ ...keyed, PAYEE_ALLOWLIST: "" })).toBe("KEYED");
  });
});

describe("DON-09 the keyless panel model has no order, capture or paid state", () => {
  const funds = [{ id: "fund_b", name: "Tallow Creek Robot Kit Initiative" }, { id: "fund_a", name: "Ashmere County Afterschool STEM Subgrant" }];
  it("carries the headline, the choices, the request shape and unassigned IDs", () => {
    const model = keylessPanelModel(funds);
    expect(model.headline).toBe(KEYLESS_HEADLINE);
    expect(model.headline).toBe("No order created, nothing captured");
    expect(model.state).toBe("Not started");
    expect(model.funds).toEqual(funds);
    expect(model.amounts).toEqual(["$5.00", "$10.00", "$25.00", "Other amount"]);
    expect(model.requestShape).toEqual({ intent: "CAPTURE", purchase_units: [{ custom_id: "fund_b", amount: { currency_code: "USD", value: "25.00" } }] });
    expect(model.ids).toEqual({ paypalOrderId: "Unassigned", captureId: "Unassigned" });
  });
  it("never contains a paid, completed or recorded state", () => {
    const text = JSON.stringify(keylessPanelModel(funds));
    expect(text).not.toMatch(/\bpaid\b|completed|recorded|thank you|\bapproved\b/i);
    expect(Object.keys(keylessPanelModel(funds)).sort()).toEqual(["amounts", "exampleLabel", "funds", "headline", "ids", "requestShape", "state"]);
    expect(keylessPanelModel([]).requestShape).toBeNull();
  });
});

describe("DON-10 support: amounts are parsed by digits into integer cents", () => {
  it("accepts whole dollars and up to two decimals, and refuses everything else", () => {
    expect(parseUsdAmount("5")).toBe(500n); expect(parseUsdAmount("5.5")).toBe(550n); expect(parseUsdAmount("5.50")).toBe(550n);
    expect(parseUsdAmount("$25")).toBe(2500n); expect(parseUsdAmount(" 12.34 ")).toBe(1234n); expect(parseUsdAmount("0.01")).toBe(1n);
    // Values that floating point gets wrong are exact here.
    expect(parseUsdAmount("0.29")).toBe(29n); expect(parseUsdAmount("1.15")).toBe(115n); expect(parseUsdAmount("19.99")).toBe(1999n); expect(parseUsdAmount("0.1")).toBe(10n);
    expect(parseUsdAmount("99999999999.99")).toBe(9_999_999_999_999n);
    for (const bad of ["", " ", "0", "0.00", "-1", "+1", "1e3", "5.555", "1,000", "5.", ".5", "abc", "5 USD", "100000000000", "1_000", "0x10", "٣"]) expect(parseUsdAmount(bad), bad).toBeNull();
  });
  it("formats and builds decimal text from cents only", () => {
    expect(GIVE_PRESET_CENTS).toEqual([500n, 1000n, 2500n]);
    expect(formatUsd(5n)).toBe("$0.05"); expect(formatUsd(123456789n)).toBe("$1,234,567.89"); expect(decimalFromCents(5n)).toBe("0.05"); expect(decimalFromCents(2500n)).toBe("25.00");
    expect(requestShape("fund_a", 1n).purchase_units[0]!.amount.value).toBe("0.01");
  });
  it("masks to the last six characters only", () => {
    expect(maskTail("CAPTURE_1234567890")).toBe("567890"); expect(maskTail("abc")).toBe("abc"); expect(maskTail(null)).toBeNull(); expect(maskTail("")).toBeNull();
  });
});

describe("DON-10 support: the /give CSP and the proxy that sets it", () => {
  const nonce = Buffer.from("00000000-0000-4000-8000-000000000000").toString("base64");
  it("uses a nonce for scripts and PayPal hosts for script, frame, connect and image", () => {
    const policy = giveContentSecurityPolicy(nonce);
    const directive = (name: string) => policy.split("; ").find(part => part.startsWith(`${name} `)) ?? "";
    expect(directive("script-src")).toContain(`'nonce-${nonce}'`);
    expect(directive("script-src")).not.toContain("unsafe-inline");
    expect(directive("script-src")).not.toContain("unsafe-eval");
    for (const name of ["script-src", "frame-src", "connect-src", "img-src"]) { expect(directive(name)).toContain("https://*.paypal.com"); expect(directive(name)).toContain("https://*.paypalobjects.com"); }
    expect(directive("connect-src")).toContain("'self'");
    expect(policy).toContain("object-src 'none'"); expect(policy).toContain("frame-ancestors 'none'");
    expect(() => giveContentSecurityPolicy("short")).toThrow(); expect(() => giveContentSecurityPolicy("x'; script-src *;aaaaaaaaaa")).toThrow();
  });
  it("is matched to /give only and gives every request a fresh nonce", () => {
    expect(config.matcher).toEqual(["/give"]);
    const first = proxy(new NextRequest("http://127.0.0.1:3100/give")).headers.get("content-security-policy")!;
    const second = proxy(new NextRequest("http://127.0.0.1:3100/give")).headers.get("content-security-policy")!;
    expect(first).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{48}'/);
    expect(first).not.toBe(second);
  });
});
