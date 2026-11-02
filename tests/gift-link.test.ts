import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GIFT_TOKEN_PATTERN, hashGiftToken, isGiftTokenShape, newGiftToken } from "../src/donation/gift-link";

// IAC-413 PR A (docs/plans/DONOR_TRAIL_SCOPE.md section 2.1, test GT-01). Pure checks: no database, no network.
describe("GT-01 the gift link token", () => {
  it("is 43 characters of base64url that decode to 32 bytes, and 1,000 tokens are distinct", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const token = newGiftToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      expect(Buffer.from(token, "base64url").toString("base64url")).toBe(token);
      expect(isGiftTokenShape(token)).toBe(true);
      seen.add(token);
    }
    expect(seen.size).toBe(1000);
  });
  it("comes from node:crypto randomBytes and the module never uses the non-cryptographic generator (a sanity check, not an entropy proof)", () => {
    const source = readFileSync("src/donation/gift-link.ts", "utf8");
    expect(source).toMatch(/import \{[^}]*\brandomBytes\b[^}]*\} from "node:crypto"/);
    expect(source).toMatch(/randomBytes\(32\)\.toString\("base64url"\)/);
    expect(source).not.toMatch(/Math\.random/);
  });
  it("accepts exactly one shape: 43 characters of A-Z a-z 0-9 _ -", () => {
    const valid = "A".repeat(43);
    expect(GIFT_TOKEN_PATTERN.source).toBe("^[A-Za-z0-9_-]{43}$");
    expect(isGiftTokenShape(valid)).toBe(true);
    for (const bad of ["", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`, `${"A".repeat(42)}+`, `${"A".repeat(42)}/`, `${"A".repeat(42)} `, `${"A".repeat(42)}\n`, `${"A".repeat(42)}.`, `${"A".repeat(42)}%`, "é".repeat(43), `\n${"A".repeat(43)}`]) expect(isGiftTokenShape(bad)).toBe(false);
    for (const notText of [undefined, null, 5, {}, ["A".repeat(43)]]) expect(isGiftTokenShape(notText)).toBe(false);
  });
  it("hashes as sha256 of the prefixed token in 64 lowercase hex, so a gift token is never a valid session digest", () => {
    const token = newGiftToken();
    expect(hashGiftToken(token)).toBe(createHash("sha256").update(`gift-link-v1:${token}`, "utf8").digest("hex"));
    expect(hashGiftToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashGiftToken(token)).not.toBe(createHash("sha256").update(token).digest("hex"));
    expect(hashGiftToken("A".repeat(43))).toBe(hashGiftToken("A".repeat(43)));
    expect(hashGiftToken("A".repeat(43))).not.toBe(hashGiftToken("B".repeat(43)));
  });
});
