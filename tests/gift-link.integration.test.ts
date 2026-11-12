import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as s from "../db/schema";
import { findGiftLinkCapture, hashGiftToken, issueGiftLink } from "../src/donation/gift-link";
import { createTestDatabase, recordGift, type TestDatabase } from "./support/attribution-db";

// IAC-413 PR A (tests GT-02 to GT-05). Real Postgres, stubbed provider
// observations, no network. The gift is recorded through the existing recordDesignatedDonation path, as the other gift tests do.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase("aidtrace_giftlink"); });
afterAll(async () => { await t.close(); });
const message = async (work: Promise<unknown>) => { try { await work; return null; } catch (error) { const e = error as { message?: string; cause?: { message?: string } }; return `${e.message ?? ""} ${e.cause?.message ?? ""}`; } };
const rows = (captureId: string) => t.db.select().from(s.giftLinks).where(eq(s.giftLinks.captureId, captureId));

describe("GT-02 only the hash of the token is stored", () => {
  it("stores sha256 of the prefixed token and no column of the row holds the token", async () => {
    const captureId = await recordGift(t.db, "fund_a", 2500n);
    const issued = await issueGiftLink(t.db, captureId);
    expect(issued?.state).toBe("ISSUED");
    if (issued?.state !== "ISSUED") throw new Error("Expected an issued link");
    const [row] = await rows(captureId);
    // An independent sha256 of the documented preimage, not the module's own helper, so a different encoding of the token cannot pass.
    expect(row).toMatchObject({ tokenHash: createHash("sha256").update(`gift-link-v1:${issued.token}`, "utf8").digest("hex"), captureId, policyVersion: "GIFT_LINK_V1" });
    expect(row!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    for (const value of Object.values(row!)) if (typeof value === "string") expect(value).not.toContain(issued.token);
    // The whole row as the database renders it, and the plain column list, never carry the token either.
    const [raw] = await t.db.execute(sql`select to_jsonb(r)::text as v from gift_links r where capture_id = ${captureId}`);
    expect(String(raw!.v)).not.toContain(issued.token);
    expect(await findGiftLinkCapture(t.db, issued.token)).toBe(captureId);
    expect(await findGiftLinkCapture(t.db, newToken())).toBeNull();
    expect(await findGiftLinkCapture(t.db, "short")).toBeNull();
  });
});
const newToken = () => randomBytes(32).toString("base64url");

describe("GT-03 the table is append only", () => {
  it("refuses UPDATE, DELETE and TRUNCATE with the immutability error", async () => {
    const captureId = await recordGift(t.db, "fund_a", 1000n); await issueGiftLink(t.db, captureId);
    const immutable = "Immutable accounting or approval record";
    expect(await message(t.db.update(s.giftLinks).set({ policyVersion: "GIFT_LINK_V1" }).where(eq(s.giftLinks.captureId, captureId)))).toContain(immutable);
    expect(await message(t.db.update(s.giftLinks).set({ tokenHash: "f".repeat(64) }).where(eq(s.giftLinks.captureId, captureId)))).toContain(immutable);
    expect(await message(t.db.delete(s.giftLinks).where(eq(s.giftLinks.captureId, captureId)))).toContain(immutable);
    expect(await message(t.db.execute(sql`truncate table gift_links`))).toContain(immutable);
    expect((await rows(captureId)).length).toBe(1);
  });
});

describe("GT-04 the insert guard and the CHECK constraints", () => {
  it("refuses a PENDING receipt, a missing capture, a non-hex hash and a wrong policy version, and a second link for one capture", async () => {
    const pending = await recordGift(t.db, "fund_a", 900n, 0n, "PENDING");
    expect((await t.db.select().from(s.donationReceipts).where(eq(s.donationReceipts.captureId, pending)))[0]!.status).toBe("PENDING");
    const guard = "A gift link names a completed gift";
    expect(await message(t.db.insert(s.giftLinks).values({ tokenHash: hashGiftToken(newToken()), captureId: pending, policyVersion: "GIFT_LINK_V1" }))).toContain(guard);
    expect(await message(t.db.insert(s.giftLinks).values({ tokenHash: hashGiftToken(newToken()), captureId: "NO_SUCH_CAPTURE", policyVersion: "GIFT_LINK_V1" }))).not.toBeNull();
    const done = await recordGift(t.db, "fund_a", 800n);
    for (const bad of ["not hex", "F".repeat(64), "a".repeat(63), "a".repeat(65), ""]) expect(await message(t.db.insert(s.giftLinks).values({ tokenHash: bad, captureId: done, policyVersion: "GIFT_LINK_V1" }))).toContain("gift_link_hash");
    expect(await message(t.db.insert(s.giftLinks).values({ tokenHash: hashGiftToken(newToken()), captureId: done, policyVersion: "GIFT_LINK_V2" }))).toContain("gift_link_policy");
    expect((await rows(done)).length).toBe(0);
    await t.db.insert(s.giftLinks).values({ tokenHash: hashGiftToken(newToken()), captureId: done, policyVersion: "GIFT_LINK_V1" });
    expect(await message(t.db.insert(s.giftLinks).values({ tokenHash: hashGiftToken(newToken()), captureId: done, policyVersion: "GIFT_LINK_V1" }))).toContain("gift_links_capture_id_unique");
    expect((await rows(done)).length).toBe(1);
    expect((await rows(pending)).length).toBe(0);
  });
  it("issueGiftLink returns null for a PENDING or unknown capture, never throws and never logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(name => vi.spyOn(console, name).mockImplementation(() => undefined));
    try {
      const pending = await recordGift(t.db, "fund_a", 700n, 0n, "PENDING");
      expect(await issueGiftLink(t.db, pending)).toBeNull();
      expect(await issueGiftLink(t.db, "NO_SUCH_CAPTURE")).toBeNull();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally { for (const spy of spies) spy.mockRestore(); }
  });
});

describe("GT-05 a second issue shows no token, and a race issues one", () => {
  it("returns SHOWN_BEFORE with no token for the same capture and keeps one row", async () => {
    const captureId = await recordGift(t.db, "fund_a", 1200n);
    const first = await issueGiftLink(t.db, captureId);
    expect(first?.state).toBe("ISSUED");
    const second = await issueGiftLink(t.db, captureId);
    expect(second).toEqual({ state: "SHOWN_BEFORE" });
    expect(second).not.toHaveProperty("token");
    expect((await rows(captureId)).length).toBe(1);
  });
  it("gives exactly one ISSUED across concurrent calls", async () => {
    const captureId = await recordGift(t.db, "fund_a", 1300n);
    const results = await Promise.all(Array.from({ length: 8 }, () => issueGiftLink(t.db, captureId)));
    expect(results.filter(result => result?.state === "ISSUED")).toHaveLength(1);
    expect(results.filter(result => result?.state === "SHOWN_BEFORE")).toHaveLength(7);
    expect(results.filter(result => result === null)).toHaveLength(0);
    const issued = results.find(result => result?.state === "ISSUED");
    const [row] = await rows(captureId);
    expect((await rows(captureId)).length).toBe(1);
    expect(issued?.state === "ISSUED" && row!.tokenHash === hashGiftToken(issued.token)).toBe(true);
  });
});
