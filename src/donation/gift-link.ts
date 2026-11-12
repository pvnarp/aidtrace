import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";

// IAC-413 PR A: the private gift link.
// The token is a bearer secret: 32 random bytes as base64url, shown once and never stored. Only its hash is stored, so a link
// cannot be recovered or regenerated. This module never logs, throws on, or returns a token except from a fresh issue.
// It imports no ledger writer and no PayPal adapter. The only write is the gift_links insert in issueGiftLink.
export const GIFT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PREFIX = "gift-link-v1:";
export const isGiftTokenShape = (value: unknown): value is string => typeof value === "string" && GIFT_TOKEN_PATTERN.test(value);
// The prefix keeps a gift token from ever being valid as a session token. 256 bits of entropy needs no salt or slow hash.
export const hashGiftToken = (token: string): string => createHash("sha256").update(`${HASH_PREFIX}${token}`, "utf8").digest("hex");
export const newGiftToken = (): string => randomBytes(32).toString("base64url");

export type GiftLinkIssue = { state: "ISSUED"; token: string } | { state: "SHOWN_BEFORE" };
// Returns ISSUED with the one-time token when a row was inserted, SHOWN_BEFORE when the capture already has a link, and null
// when the guard or the database refused. It never throws and never logs, so a refusal can never fail a donation response.
export async function issueGiftLink(db: AppDatabase, captureId: string): Promise<GiftLinkIssue | null> {
  try {
    const token = newGiftToken();
    const rows = await db.insert(s.giftLinks).values({ tokenHash: hashGiftToken(token), captureId, policyVersion: s.giftLinkPolicy })
      .onConflictDoNothing({ target: s.giftLinks.captureId }).returning({ tokenHash: s.giftLinks.tokenHash });
    return rows.length > 0 ? { state: "ISSUED", token } : { state: "SHOWN_BEFORE" };
  } catch {
    return null;
  }
}

// The capture a token names, or null. One indexed read of the primary key, by hash.
export async function findGiftLinkCapture(db: AppDatabase, token: string): Promise<string | null> {
  if (!isGiftTokenShape(token)) return null;
  const [row] = await db.select({ captureId: s.giftLinks.captureId }).from(s.giftLinks).where(eq(s.giftLinks.tokenHash, hashGiftToken(token))).limit(1);
  return row?.captureId ?? null;
}
