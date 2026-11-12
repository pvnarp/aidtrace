import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// IAC-413 PR A (tests GT-22 and GT-24 at the proxy). The limiter and the database
// handle are replaced, so no database is touched: this checks which paths take a slot and what a refused request looks like.
const mocks = vi.hoisted(() => ({ take: vi.fn<(db: unknown) => Promise<boolean>>(), handle: { sentinel: "db-handle" } }));
vi.mock("../src/server/gift-rate-limit", () => ({ takeGiftPageSlot: mocks.take }));
vi.mock("../src/server/db", () => ({ getDatabase: () => mocks.handle }));
import { config, proxy } from "../src/proxy";

const TOKEN = "A".repeat(43);
const ORIGIN = "http://127.0.0.1:3100";
const STATIC = { "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const call = (path: string) => proxy(new NextRequest(`${ORIGIN}${path}`));
beforeEach(() => { mocks.take.mockReset(); mocks.take.mockResolvedValue(true); });

describe("GT-24 only well-formed tokens take a slot", () => {
  it("takes one slot for a well-formed token, including a percent-encoded spelling of it", async () => {
    await call(`/gift/${TOKEN}`);
    expect(mocks.take).toHaveBeenCalledTimes(1);
    expect(mocks.take).toHaveBeenCalledWith(mocks.handle);
    await call(`/gift/${"A".repeat(42)}%41`);
    expect(mocks.take).toHaveBeenCalledTimes(2);
    await call(`/gift/${"A".repeat(20)}-_${"B".repeat(21)}`);
    expect(mocks.take).toHaveBeenCalledTimes(3);
  });
  it("takes none for malformed tokens, other segments, other paths and /give", async () => {
    for (const path of ["/gift", "/gift/", "/gift/short", `/gift/${"A".repeat(44)}`, `/gift/${"A".repeat(42)}%2F`, `/gift/${"A".repeat(42)}=`, "/gift/%E0%A4%A", `/gift/${TOKEN}/extra`, `/gift/${"A".repeat(42)}%`, "/give"]) await call(path);
    expect(mocks.take).not.toHaveBeenCalled();
  });
  it("matches only /give and /gift paths", () => { expect(config.matcher).toEqual(["/give", "/gift/:path*"]); });
});

describe("GT-22 and GT-24 a refused request is a real 429 with the privacy headers and no gift data", () => {
  it("answers 429 with Retry-After 60, fixed text, the four static headers and a gift CSP", async () => {
    mocks.take.mockResolvedValue(false);
    const response = await call(`/gift/${TOKEN}`);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.text()).toBe("Too many requests. Try again in a minute.");
    for (const [name, value] of Object.entries(STATIC)) expect(response.headers.get(name)).toBe(value);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const policy = response.headers.get("content-security-policy")!;
    expect(policy).toContain("default-src 'none'"); expect(policy).toContain("frame-ancestors 'none'"); expect(policy).not.toContain("paypal");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it("lets a request through with the same headers on every /gift path, a fresh nonce each time, and none on /give", async () => {
    const seen = new Set<string>();
    for (const path of [`/gift/${TOKEN}`, "/gift/short", "/gift/", "/gift"]) {
      const response = await call(path);
      expect(response.status).toBe(200);
      for (const [name, value] of Object.entries(STATIC)) expect(response.headers.get(name)).toBe(value);
      const policy = response.headers.get("content-security-policy")!;
      expect(policy).toMatch(/^default-src 'none'; script-src 'self' 'nonce-[A-Za-z0-9+/=]+'; style-src 'self';/);
      seen.add(policy);
    }
    expect(seen.size).toBe(4);
    const give = await call("/give");
    expect(give.headers.get("content-security-policy")).toContain("paypal");
    for (const name of Object.keys(STATIC)) expect(give.headers.get(name)).toBeNull();
  });
  it("lets a request continue when the limiter itself cannot run, because the page fails closed on its own database read", async () => {
    mocks.take.mockRejectedValue(new Error("database unreachable"));
    const response = await call(`/gift/${TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
