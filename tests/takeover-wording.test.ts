import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PAYPAL_NOTE, PAYPAL_TAKEOVER_WAITING, paypalCard, type PayPalInput } from "../src/app/shell-copy";

// AU-52 and AU-53 (IAC-405 takeover wording, docs/ASSUMPTIONS.md section 82). Pure functions and a static source pin: no database, network or clock.
const attempt = { state: "SUBMITTED", itemStatus: null, payoutBatchId: null };
const base = (claimStatus: string, payout: PayPalInput["payout"], extra: Partial<PayPalInput> = {}): PayPalInput => ({ claimStatus, approvals: 1, payout, amount: "$69.00", ...extra });
const keyless = { attempt: null, keyless: true };
const keyed = { attempt: null, keyless: false };

describe("AU-52 takeoverWaiting changes the PayPal card only for an APPROVED claim with no attempt", () => {
  it("reads the not-ready words in a keyless and a keyed session", () => {
    expect(PAYPAL_TAKEOVER_WAITING).toBe("Not ready: two approvers must take over");
    for (const payout of [keyless, keyed]) {
      expect(paypalCard(base("APPROVED", payout, { takeoverWaiting: true }))).toEqual({ key: "not-ready", state: PAYPAL_TAKEOVER_WAITING, rail: "Not ready", note: PAYPAL_NOTE, batchId: null });
    }
  });
  it("is byte-identical to the old output when the flag is false or absent", () => {
    expect(paypalCard(base("APPROVED", keyless))).toEqual({ key: "ready-keyless", state: "Ready: $69.00. Unpaid in this keyless session, no request is made", rail: "Ready, unpaid", note: PAYPAL_NOTE, batchId: null });
    expect(paypalCard(base("APPROVED", keyed))).toEqual({ key: "ready", state: "Approved: $69.00. No payment has been sent yet", rail: "Ready, not sent", note: PAYPAL_NOTE, batchId: null });
    for (const payout of [keyless, keyed]) {
      expect(paypalCard(base("APPROVED", payout, { takeoverWaiting: false }))).toEqual(paypalCard(base("APPROVED", payout)));
    }
  });
  it("changes nothing when an attempt exists", () => {
    const withAttempt = { attempt, keyless: false };
    expect(paypalCard(base("APPROVED", withAttempt, { takeoverWaiting: true }))).toEqual(paypalCard(base("APPROVED", withAttempt)));
    expect(paypalCard(base("PAYOUT_PROCESSING", withAttempt, { takeoverWaiting: true }))).toEqual(paypalCard(base("PAYOUT_PROCESSING", withAttempt)));
  });
  it("changes nothing for PAID, AWAITING_APPROVAL or REJECTED", () => {
    for (const status of ["PAID", "AWAITING_APPROVAL", "REJECTED"]) {
      for (const payout of [keyless, keyed, null]) {
        expect(paypalCard(base(status, payout, { takeoverWaiting: true }))).toEqual(paypalCard(base(status, payout)));
      }
    }
  });
  it("the fixed sentence has no dash character", () => {
    expect(PAYPAL_TAKEOVER_WAITING).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`));
  });
});

describe("AU-53 only the claim page passes takeoverWaiting, derived from autoWaiting alone", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
  const PAGE = join("src", "app", "claims", "[claimId]", "page.tsx");
  it("the claim page passes takeoverWaiting: autoWaiting and nothing else", () => {
    const source = readFileSync(PAGE, "utf8");
    expect(source.match(/takeoverWaiting/g)?.length).toBe(1);
    expect(source).toContain("takeoverWaiting: autoWaiting,");
    expect(source).toContain('const autoWaiting = view.reviewMode === "AUTO_RECOGNIZED_PEOPLE" && claim.status === "APPROVED" && approvals.length < 2;');
  });
  it("no other file under src or scripts passes it", () => {
    const hits = [...walk("src"), ...walk("scripts")].filter(file => file !== PAGE && file !== join("src", "app", "shell-copy.ts") && readFileSync(file, "utf8").includes("takeoverWaiting"));
    expect(hits).toEqual([]);
  });
});
