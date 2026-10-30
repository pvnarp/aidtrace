import { randomBytes } from "node:crypto";
import { beforeEach, afterEach, afterAll, expect, it } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq, sql } from "drizzle-orm";
import { connectDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import * as s from "../db/schema";
import { createReceiptDraft, readReceiptView, confirmReceipt, suggestionHash, ProhibitedAcknowledgementRequired } from "../src/receipt/service";
import { digest, draftHash, budgetFor, type DraftInput } from "../src/receipt/terms";
import { PROHIBITED_TERMS_VERSION } from "../src/receipt/prohibited-screen";
import { freezeDecision, approveDecision } from "../src/ledger/service";
import { hashDecision, type DecisionPayload } from "../src/domain/hash";
import { loadClaimView } from "../src/server/claim-view";
import { handleReceiptAction } from "../src/server/receipt-actions";
import { SESSION_COOKIE } from "../src/server/auth";

const adminUrl = new URL(process.env.DATABASE_URL!); adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 });
let connection: ReturnType<typeof connectDatabase>; let name: string;
const payee = "receipt-test@personal.example.com";
const env = { PAYPAL_SANDBOX_PAYEE_EMAIL: payee, PAYEE_ALLOWLIST: payee };
const plain: DraftInput = { vendor: "Fictional shop", program: "robotics", incurredOn: "2026-10-14", source: "Science experiment kit", total: "3.00", lines: [{ description: "Science experiment kit", amount: "3.00" }] };
// The receipt text names a gift card, the line description does not.
const flagged: DraftInput = { ...plain, source: "Science experiment kit\nRaffle prize: gift card" };
type Screen = typeof s.receiptConfirmations.$inferInsert["prohibitedScreen"];
const giftCard = { category: "gift_cards" as const, term: "gift card" };
beforeEach(async () => {
  name = `aidtrace_iac211_test_${randomBytes(6).toString("hex")}`;
  await admin`create database ${admin(name)}`;
  const url = new URL(adminUrl); url.pathname = `/${name}`; connection = connectDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: "db/migrations" });
  await seedFixture(connection.db, { passwords: { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") }, payeeEmail: payee, payeeAllowlist: [payee] });
  process.env.APP_ORIGIN = "http://127.0.0.1:3100";
}, 30000);
afterEach(async () => { await connection?.client.end(); if (/^aidtrace_iac211_test_[a-f0-9]{12}$/.test(name)) await admin`drop database ${admin(name)} with (force)`; }, 30000);
afterAll(async () => { await admin.end(); });
const draft = (input: DraftInput) => createReceiptDraft(connection.db, "maria", input, payee);
const view = (id: string) => readReceiptView(connection.db, id, "maria");
async function confirm(id: string, category: string, acknowledge?: boolean) {
  const v = await view(id);
  return confirmReceipt(connection.db, id, "maria", v.review.id, v.review.draftHash, null, suggestionHash(v.suggestion), [{ lineId: "L1", category, reason: "Checked synthetic source" }], acknowledge);
}
const stored = async (id: string) => (await view(id)).confirmation?.prohibitedScreen;
// Simulates a preserved or tampered confirmation row: categories set directly, row inserted directly with the given screen.
async function plant(id: string, screen: Screen, category = "robot_kits_parts") {
  const v = await view(id);
  await connection.db.update(s.claimLines).set({ category, budgetLine: budgetFor(category) }).where(eq(s.claimLines.claimId, id));
  const lines = (await view(id)).lines;
  await connection.db.insert(s.receiptConfirmations).values({ reviewId: v.review.id, suggestionId: null, confirmedBy: "maria", termsHash: draftHash(v.claim, lines, true),
    selections: [{ lineId: "L1", category, provenance: "HUMAN", reason: "Planted for the test" }], prohibitedScreen: screen });
}
const dbErrorCode = (error: unknown) => { let current: unknown = error; let found = ""; for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
  if ("code" in current && typeof current.code === "string" && "constraint_name" in current) found = `${current.code}:${String(current.constraint_name)}`; current = "cause" in current ? current.cause : undefined; } return found; };
async function request(actor: string, fields: Record<string, string>, id: string) {
  const token = randomBytes(32).toString("hex"); await connection.db.insert(s.sessions).values({ tokenHash: digest(token), userId: actor, expiresAt: new Date(Date.now() + 60000) });
  return new Request(`http://127.0.0.1:3100/api/receipts/${id}`, { method: "POST", headers: { origin: "http://127.0.0.1:3100", cookie: `${SESSION_COOKIE}=${token}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
}

it("PTG-11: a flagged receipt without acknowledgement throws the named error and writes nothing", async () => {
  const id = await draft(flagged);
  for (const acknowledge of [undefined, false]) {
    const refused = confirm(id, "robot_kits_parts", acknowledge);
    await expect(refused).rejects.toBeInstanceOf(ProhibitedAcknowledgementRequired);
    await expect(refused).rejects.toThrow("Receipt mentions a possibly prohibited item; choose that category for the line or acknowledge it is not claimed");
  }
  expect(await connection.db.select().from(s.receiptConfirmations)).toHaveLength(0);
  expect((await view(id)).lines[0]).toMatchObject({ category: "UNKNOWN", budgetLine: "unconfirmed" });
  await expect(freezeDecision(connection.db, id, "maria")).rejects.toThrow("confirmation");
});
it("PTG-12: with acknowledgement the screen is stored with acknowledged true and the categories are unchanged", async () => {
  const id = await draft(flagged); await confirm(id, "robot_kits_parts", true);
  expect(await stored(id)).toEqual({ version: PROHIBITED_TERMS_VERSION, matches: [giftCard], unresolved: [giftCard], acknowledged: true });
  const v = await view(id);
  expect(v.lines[0]).toMatchObject({ category: "robot_kits_parts", budgetLine: "supplies", amountCents: 300n });
  expect(v.confirmation!.selections[0]).toMatchObject({ category: "robot_kits_parts", provenance: "HUMAN", reason: "Checked synthetic source" });
});
it("PTG-13: choosing the matching category resolves the flag with no acknowledgement and stores acknowledged false", async () => {
  const id = await draft(flagged); await confirm(id, "gift_cards");
  expect(await stored(id)).toEqual({ version: PROHIBITED_TERMS_VERSION, matches: [giftCard], unresolved: [], acknowledged: false });
  // An acknowledgement sent with a resolved flag is ignored, and the existing prohibited outcome is untouched.
  const second = await draft(flagged); await confirm(second, "gift_cards", true);
  expect((await stored(second))!.acknowledged).toBe(false);
  expect((await freezeDecision(connection.db, id, "maria")).status).toBe("INFEASIBLE");
  expect(await connection.db.select().from(s.fundReservations)).toHaveLength(0);
});
it("PTG-14: an unflagged receipt stores no matches and acknowledged false, and an unneeded acknowledgement is ignored", async () => {
  const id = await draft(plain); await confirm(id, "robot_kits_parts");
  expect(await stored(id)).toEqual({ version: PROHIBITED_TERMS_VERSION, matches: [], unresolved: [], acknowledged: false });
  const second = await draft(plain); await confirm(second, "robot_kits_parts", true);
  expect(await stored(second)).toEqual({ version: PROHIBITED_TERMS_VERSION, matches: [], unresolved: [], acknowledged: false });
  expect((await freezeDecision(connection.db, id, "maria")).status).toBe("AWAITING_APPROVAL");
});
it("PTG-15: description-only and source-only matches both flag, and a second category left unresolved still needs acknowledgement", async () => {
  const inDescription = await draft({ ...plain, source: "Fictional receipt", lines: [{ description: "Bottle of wine", amount: "3.00" }] });
  await expect(confirm(inDescription, "robot_kits_parts")).rejects.toBeInstanceOf(ProhibitedAcknowledgementRequired);
  await confirm(inDescription, "robot_kits_parts", true);
  expect((await stored(inDescription))!.unresolved).toEqual([{ category: "alcohol", term: "wine" }]);
  const both = await draft({ ...plain, source: "Wine tasting and a gift card" });
  await expect(confirm(both, "alcohol")).rejects.toBeInstanceOf(ProhibitedAcknowledgementRequired);
  await confirm(both, "alcohol", true);
  expect(await stored(both)).toMatchObject({ unresolved: [giftCard], acknowledged: true, matches: [{ category: "alcohol", term: "wine" }, giftCard] });
});
it("PTG-16: freezeDecision refuses a flagged receipt whose stored screen is null or does not match the current text", async () => {
  const good: Screen = { version: PROHIBITED_TERMS_VERSION, matches: [giftCard], unresolved: [giftCard], acknowledged: true };
  const refused: [string, Screen][] = [
    ["null screen", null],
    ["empty screen", { version: PROHIBITED_TERMS_VERSION, matches: [], unresolved: [], acknowledged: false }],
    ["other term list version", { ...good!, version: "prohibited-terms-v0" }],
    ["acknowledged a different term", { ...good!, matches: [{ category: "alcohol", term: "wine" }], unresolved: [{ category: "alcohol", term: "wine" }] }],
  ];
  for (const [label, screen] of refused) {
    const id = await draft(flagged); await plant(id, screen);
    await expect(freezeDecision(connection.db, id, "maria"), label).rejects.toThrow("Current receipt categories require human confirmation");
    expect(await connection.db.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.claimId, id)), label).toHaveLength(0);
  }
  const ok = await draft(flagged); await plant(ok, good);
  expect((await freezeDecision(connection.db, ok, "maria")).status).toBe("AWAITING_APPROVAL");
  // Text that gains a match after confirmation is refused too: the stored acknowledgement covers only gift card.
  const grown = await draft({ ...flagged, source: "Science experiment kit\nRaffle prize: gift card and a bottle of wine" }); await plant(grown, good);
  await expect(freezeDecision(connection.db, grown, "maria")).rejects.toThrow("Current receipt categories require human confirmation");
});
it("PTG-17: a preserved row with a null screen still passes when nothing is unresolved, and the approver view reads null", async () => {
  const id = await draft(plain); await plant(id, null);
  const frozen = await freezeDecision(connection.db, id, "maria"); expect(frozen.status).toBe("AWAITING_APPROVAL");
  expect((await loadClaimView(connection.db, id, "tara")).receiptReview!.prohibitedScreen).toBeNull();
  const resolved = await draft(flagged); await plant(resolved, null, "gift_cards");
  expect((await freezeDecision(connection.db, resolved, "maria")).status).toBe("INFEASIBLE");
});
it("PTG-18: the check constraint accepts null and a coherent object and refuses acknowledged mismatches and malformed objects", async () => {
  const ids = [await draft(plain), await draft(plain), await draft(plain), await draft(plain)]; const reviews = await Promise.all(ids.map(async id => (await view(id)).review.id));
  const row = (index: number, screen: unknown) => connection.db.insert(s.receiptConfirmations).values({ reviewId: reviews[index]!, suggestionId: null, confirmedBy: "maria", termsHash: "a".repeat(64), selections: [], prohibitedScreen: screen as Screen });
  const bad: unknown[] = [
    { version: "v", matches: [], unresolved: [], acknowledged: true }, { version: "v", matches: [giftCard], unresolved: [giftCard], acknowledged: false },
    {}, [], "text", 7, { version: 1, matches: [], unresolved: [], acknowledged: false }, { version: "v", matches: {}, unresolved: [], acknowledged: false },
    { version: "v", matches: [], unresolved: "none", acknowledged: false }, { version: "v", matches: [], unresolved: [] }, { version: "v", matches: [], unresolved: [], acknowledged: "false" },
    { matches: [], unresolved: [], acknowledged: false },
  ];
  for (const value of bad) { const error = await row(0, value).then(() => null, (caught: unknown) => caught); expect(error, JSON.stringify(value)).not.toBeNull(); expect(dbErrorCode(error), JSON.stringify(value)).toBe("23514:receipt_prohibited_screen_shape"); }
  await row(0, null); await row(1, { version: "v", matches: [], unresolved: [], acknowledged: false }); await row(2, { version: "v", matches: [giftCard], unresolved: [giftCard], acknowledged: true });
  expect(await connection.db.select().from(s.receiptConfirmations)).toHaveLength(3);
  // The immutability triggers cover the new column.
  await expect(connection.db.update(s.receiptConfirmations).set({ prohibitedScreen: null }).where(eq(s.receiptConfirmations.reviewId, reviews[2]!))).rejects.toThrow();
  await expect(connection.db.execute(sql`update receipt_confirmations set prohibited_screen = null`)).rejects.toThrow();
});
it("PTG-19: an acknowledged receipt allocates exactly like an unflagged equivalent and still needs two approvals", async () => {
  const plainId = await draft(plain); const flaggedId = await draft(flagged);
  await confirm(plainId, "robot_kits_parts"); await confirm(flaggedId, "robot_kits_parts", true);
  const a = await freezeDecision(connection.db, plainId, "maria"); const b = await freezeDecision(connection.db, flaggedId, "maria");
  if (a.status !== "AWAITING_APPROVAL" || b.status !== "AWAITING_APPROVAL") throw new Error("Expected both funded");
  const decision = async (id: string) => (await connection.db.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.claimId, id)))[0]!;
  const [da, db] = [await decision(plainId), await decision(flaggedId)];
  const edges = async (id: string) => (await connection.db.select().from(s.allocationEdges).where(eq(s.allocationEdges.decisionId, id))).map(e => `${e.fundId}:${e.lineId}:${e.amountCents}`).sort();
  const reservations = async (id: string) => (await connection.db.select().from(s.fundReservations).where(eq(s.fundReservations.decisionId, id))).map(r => `${r.fundId}:${r.amountCents}:${r.status}`).sort();
  expect(await edges(db.id)).toEqual(await edges(da.id)); expect(await edges(db.id)).not.toHaveLength(0);
  expect(await reservations(db.id)).toEqual(await reservations(da.id)); expect(await reservations(db.id)).not.toHaveLength(0);
  expect({ ...(db.payload as object), claimId: "-" }).toEqual({ ...(da.payload as object), claimId: "-" });
  // The decision hash differs only because the claim ids differ: it is the same function of the same payload with the id swapped.
  expect(hashDecision(db.payload as DecisionPayload)).toBe(db.decisionHash);
  expect(hashDecision({ ...(db.payload as DecisionPayload), claimId: plainId })).toBe(da.decisionHash);
  expect(JSON.stringify(db.payload)).not.toMatch(/prohibited|acknowledg/i);
  expect((await approveDecision(connection.db, b.decisionId, "tara", b.decisionHash)).status).toBe("AWAITING_APPROVAL");
  expect((await approveDecision(connection.db, b.decisionId, "ben", b.decisionHash)).status).toBe("APPROVED");
});
it("PTG-20: every authorized approver reads the stored flag, and it comes only from the stored confirmation", async () => {
  const id = await draft(flagged); await confirm(id, "robot_kits_parts", true); await freezeDecision(connection.db, id, "maria");
  for (const actor of ["maria", "tara", "ben"]) expect((await loadClaimView(connection.db, id, actor)).receiptReview!.prohibitedScreen).toEqual({ version: PROHIBITED_TERMS_VERSION, matches: [giftCard], unresolved: [giftCard], acknowledged: true });
  const clean = await draft(plain); await confirm(clean, "robot_kits_parts");
  expect((await loadClaimView(connection.db, clean, "tara")).receiptReview!.prohibitedScreen!.unresolved).toEqual([]);
});
it("PTG-21: the receipt action maps a missing acknowledgement to its own status and forwards a ticked box", async () => {
  const deps = { db: connection.db, env };
  const id = await draft(flagged); const v = await view(id);
  const fields = { action: "confirm", reviewId: v.review.id, draftHash: v.review.draftHash, suggestionHash: suggestionHash(undefined), categoryL1: "robot_kits_parts", reasonL1: "Checked", confirm: "yes" };
  const missing = await handleReceiptAction(await request("maria", fields, id), id, deps);
  expect(missing.status).toBe(303); expect(missing.headers.get("location")).toBe(`/claims/${id}/receipt?notice=acknowledge-required`);
  const notTicked = await handleReceiptAction(await request("maria", { ...fields, acknowledgeProhibited: "no" }, id), id, deps);
  expect(notTicked.headers.get("location")).toContain("notice=acknowledge-required");
  expect(await connection.db.select().from(s.receiptConfirmations)).toHaveLength(0);
  // Every other failure keeps the generic status.
  expect((await handleReceiptAction(await request("maria", { ...fields, draftHash: "0".repeat(64) }, id), id, deps)).headers.get("location")).toContain("notice=review-changed");
  expect((await handleReceiptAction(await request("maria", { ...fields, confirm: "no", acknowledgeProhibited: "yes" }, id), id, deps)).headers.get("location")).toContain("notice=review-changed");
  expect((await handleReceiptAction(await request("maria", { ...fields, acknowledgeProhibited: "yes", extra: "x" }, id), id, deps)).status).toBe(400);
  const ticked = await handleReceiptAction(await request("maria", { ...fields, acknowledgeProhibited: "yes" }, id), id, deps);
  expect(ticked.status).toBe(303); expect(ticked.headers.get("location")).toContain("notice=confirmed");
  expect(await stored(id)).toMatchObject({ acknowledged: true, unresolved: [giftCard] });
  expect(await connection.db.select().from(s.journalEntries).where(and(eq(s.journalEntries.sourceType, "claim_recognition")))).toHaveLength(0);
});
