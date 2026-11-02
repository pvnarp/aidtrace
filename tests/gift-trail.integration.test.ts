import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase, type AppDatabase } from "../src/server/db";
import { seedFixture } from "../db/fixture";
import * as s from "../db/schema";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { refreshClaimPayout, sendClaimPayout } from "../src/ledger/payout";
import { authenticate } from "../src/server/auth";
import { buildNoteFacts, factDigest } from "../src/donation/note";
import { approveGiftNote } from "../src/donation/note-approval";
import { buildGiftTrail, donorPageSentence, loadGiftPage, loadGiftTrailFacts } from "../src/donation/trail";
import { createPayPalAdapter, type PayoutTransport, type PersistedPayout } from "../src/paypal/adapter";
import { GIFT_PAGE_LIMIT, GIFT_PAGE_LIMIT_KEY, takeGiftPageSlot } from "../src/server/gift-rate-limit";
import { pause, recognizeClaim, recordGift } from "./support/attribution-db";
import { financialHash, tableHash } from "./support/policy-db";

// IAC-413 PR A (docs/plans/DONOR_TRAIL_SCOPE.md sections 3 and 5.2, tests GT-16, GT-17 and GT-24 to GT-26). Real Postgres, stubbed provider
// observations and a stubbed payout transport, no network. Each test gets its own database so none depends on another's state.
const ORG = "cedar-hollow"; const PAYEE = "trail-test@personal.example.com"; const BATCH = "BATCH_TRAIL_1";
interface Fixture { db: AppDatabase; client: ReturnType<typeof connectDatabase>["client"]; name: string; close: () => Promise<void> }
const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://aidtrace@db:5432/aidtrace"); adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 });
const open: Fixture[] = [];
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
beforeAll(() => { process.env.APP_ORIGIN = "http://127.0.0.1:3100"; });
afterAll(async () => { for (const fixture of open) await fixture.close().catch(() => undefined); await admin.end(); });

async function fresh(): Promise<Fixture> {
  const name = `aidtrace_gifttrail_${randomBytes(6).toString("hex")}`;
  if (!/^aidtrace_[a-z0-9_]+_[a-f0-9]{12}$/.test(name)) throw new Error("Unexpected test database name");
  const url = new URL(adminUrl); url.pathname = `/${name}`;
  await admin`create database ${admin(name)}`;
  const { db, client } = connectDatabase(url.toString());
  await migrate(db, { migrationsFolder: "db/migrations" });
  const password = () => randomBytes(18).toString("hex");
  await seedFixture(db, { passwords: { maria: password(), tara: password(), ben: password() }, payeeEmail: PAYEE, payeeAllowlist: [PAYEE] });
  await db.transaction(tx => ensureFixtureOpening(tx, ORG));
  const fixture: Fixture = { db, client, name, close: async () => { await client.end(); await admin`drop database ${admin(name)} with (force)`; } };
  open.push(fixture); return fixture;
}
// A gift recorded before recognition, then the USD 500 claim recognized by both approvers, so the gift is applied by GIFT_ATTRIBUTION_V1.
async function giftedClaim(db: AppDatabase, fundId: string, cents: bigint) {
  const captureId = await recordGift(db, fundId, cents); await pause(25);
  const { frozen } = await recognizeClaim(db, "C-104");
  return { captureId, hash: frozen.decisionHash };
}
async function approveNote(db: AppDatabase, captureId: string, approver = "ben") {
  const built = await buildNoteFacts(db, ORG, captureId, "C-104", 1);
  if (!built.ok) throw new Error(`Facts refused: ${built.refusal}`);
  return approveGiftNote(db, approver, { captureId, claimId: "C-104", claimVersion: 1, factDigest: factDigest(built.facts) });
}
function transport(itemStatus = "SUCCESS") {
  let sent: PersistedPayout | undefined;
  const validatePayout = createPayPalAdapter({ baseUrl: "https://api-m.sandbox.paypal.com", clientId: "synthetic", clientSecret: "synthetic", payeeAllowlist: [PAYEE], maxDemoPayoutCents: 50000n }, vi.fn()).validatePayout;
  return { validatePayout: vi.fn(validatePayout), balance: vi.fn<PayoutTransport["balance"]>().mockResolvedValue({ readable: false }),
    send: vi.fn<PayoutTransport["send"]>(async payout => { sent = payout; return { httpStatus: 201, batchId: BATCH, batchStatus: "PENDING" }; }),
    batch: vi.fn<PayoutTransport["batch"]>(async () => ({ httpStatus: 200, batchId: BATCH, senderBatchId: sent?.senderBatchId, batchStatus: "SUCCESS", itemIds: ["ITEM_TRAIL_1"] })),
    item: vi.fn<PayoutTransport["item"]>(async () => ({ httpStatus: 200, itemId: "ITEM_TRAIL_1", batchId: BATCH, senderBatchId: sent?.senderBatchId, senderItemId: sent?.senderItemId, payeeEmail: sent?.payeeEmail, amountCents: sent?.amountCents,
      itemStatus, feeCents: 25n, processedOn: "2026-10-22" })) } satisfies PayoutTransport;
}
const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);

describe("the loader reads one gift from stored facts", () => {
  it("returns null for a PENDING receipt and an unknown capture, and loads a recognized gift as APPROVED with no payment", async () => {
    const { db } = await fresh();
    const pending = await recordGift(db, "fund_b", 700n, 0n, "PENDING");
    expect(await loadGiftPage(db, pending)).toBeNull();
    expect(await loadGiftPage(db, "NO_SUCH_CAPTURE")).toBeNull();
    const { captureId } = await giftedClaim(db, "fund_b", 2500n);
    const page = (await loadGiftPage(db, captureId))!;
    expect(page.trail.state).toBe("APPROVED");
    expect(page.trail.grossCents).toBe(2500n); expect(page.trail.unspentCents).toBe(0n); expect(page.trail.matchedCents).toBe(2500n);
    expect(page.trail.lines.length).toBeGreaterThan(0);
    expect(page.trail.lines.reduce((sum, line) => sum + line.appliedCents, 0n)).toBe(2500n);
    expect(page.trail.payout.status).toBe("NO_PAYMENT");
    expect(page.note).toBeNull();
    expect(page.trail.gift).toMatchObject({ amount: "$25.00", fundName: "Tallow Creek Robot Kit Initiative", received: "October 22, 2026" });
  });
  it("loads by one capture, a list and ALL with the same facts, newest first, and never across organizations", async () => {
    const { db } = await fresh();
    const first = await recordGift(db, "fund_b", 1000n); await pause(25);
    const second = await recordGift(db, "fund_b", 1500n); await pause(25);
    const { frozen } = await recognizeClaim(db, "C-104"); expect(frozen.status).toBe("AWAITING_APPROVAL");
    const all = await loadGiftTrailFacts(db, ORG, "ALL");
    expect(all.map(row => row.captureId)).toEqual([second, first]);
    expect(await loadGiftTrailFacts(db, ORG, [first])).toEqual([all[1]]);
    expect(await loadGiftTrailFacts(db, ORG, [first, second, "NO_SUCH_CAPTURE"])).toEqual(all);
    expect(await loadGiftTrailFacts(db, ORG, [])).toEqual([]);
    expect(await loadGiftTrailFacts(db, "other-org", "ALL")).toEqual([]);
    expect(await loadGiftTrailFacts(db, "other-org", [first])).toEqual([]);
    for (const row of all) expect(() => buildGiftTrail(row.input)).not.toThrow();
  });
  it("shows PROCESSING after a payout starts and PAID with only the batch tail once the item settles", async () => {
    const { db } = await fresh(); const { captureId, hash } = await giftedClaim(db, "fund_b", 2500n);
    const provider = transport();
    await sendClaimPayout(db, "C-104", "tara", hash, provider);
    const processing = (await loadGiftPage(db, captureId))!;
    expect(processing.trail.state).toBe("PAYING"); expect(processing.trail.steps[3]!.detail).toBe("Processing");
    await refreshClaimPayout(db, "C-104", "tara", provider);
    const paid = (await loadGiftPage(db, captureId))!;
    expect(paid.trail.state).toBe("PAID"); expect(paid.trail.steps[3]!.detail).toBe("Paid, batch ending RAIL_1");
    expect(json(paid)).not.toContain(BATCH);
  });
  it("a payout item that is not SUCCESS never reads as paid", async () => {
    const { db } = await fresh(); const { captureId, hash } = await giftedClaim(db, "fund_b", 2500n);
    const provider = transport("PENDING");
    await sendClaimPayout(db, "C-104", "tara", hash, provider); await refreshClaimPayout(db, "C-104", "tara", provider);
    const page = (await loadGiftPage(db, captureId))!;
    expect(page.trail.state).not.toBe("PAID"); expect(page.trail.payout.status).not.toBe("PAID");
    expect(json(page)).not.toContain(BATCH);
    expect(json(page)).not.toMatch(/failed|declined/i);
  });
});

describe("GT-16 an invalidated decision stops being shown as applied, with no cache", () => {
  it("the next load returns WAITING with the whole gift unmatched", async () => {
    const { db, client } = await fresh(); const { captureId } = await giftedClaim(db, "fund_b", 2500n);
    expect((await loadGiftPage(db, captureId))!.trail.state).toBe("APPROVED");
    // A recognized decision cannot be invalidated through the application: its trigger refuses it. This throwaway database lifts the
    // trigger only to simulate a stored invalidation, and nothing else changes.
    await client`alter table allocation_decisions disable trigger decision_immutable`;
    await client`update allocation_decisions set invalidated_at = now() where claim_id = 'C-104'`;
    const after = (await loadGiftPage(db, captureId))!;
    expect(after.trail.state).toBe("WAITING");
    expect(after.trail.lines).toEqual([]);
    expect(after.trail.unspentCents).toBe(2500n); expect(after.trail.matchedCents).toBe(0n);
    expect(after.trail.steps.map(step => step.state)).toEqual(["done", "cur", "fut", "fut"]);
    expect(after.note).toBeNull();
  });
});

describe("GT-17 the note panel appears only for a current approved note and never shows the stored text", () => {
  it("has no panel without a stored note, shows the facts sentence once approved, and drops it when the facts move on", async () => {
    const { db } = await fresh(); const { captureId, hash } = await giftedClaim(db, "fund_b", 2500n);
    const before = (await loadGiftPage(db, captureId))!;
    expect(before.trail.state).toBe("APPROVED"); expect(before.note).toBeNull();
    expect((await approveNote(db, captureId)).status).toBe("APPROVED");
    const [stored] = await db.select().from(s.giftNotes).where(eq(s.giftNotes.captureId, captureId));
    const [organization] = await db.select({ name: s.organizations.name }).from(s.organizations).where(eq(s.organizations.id, ORG));
    const current = (await loadGiftPage(db, captureId))!;
    expect(current.note).toEqual({ sentence: donorPageSentence(current.trail), organizationName: organization!.name });
    expect(current.note!.sentence).not.toBe(stored!.renderedText);
    // The fixed step title "Approved by two people" is not a person, so the whole page is checked for names and the note panel for the approval line.
    for (const forbidden of ["Thank you,", "Tara", "Ben", "Maria", "C-104", "A donor"]) expect(json(current)).not.toContain(forbidden);
    expect(json(current.note)).not.toContain("Approved by");
    // A payout changes the facts, so the stored note is out of date and the panel goes away until someone approves again.
    await sendClaimPayout(db, "C-104", "tara", hash, transport());
    const stale = (await loadGiftPage(db, captureId))!;
    expect(stale.trail.state).toBe("PAYING"); expect(stale.note).toBeNull();
    expect((await approveNote(db, captureId, "tara")).status).toBe("APPROVED");
    const renewed = (await loadGiftPage(db, captureId))!;
    expect(renewed.note?.sentence).toBe(donorPageSentence(renewed.trail));
    expect(renewed.note?.sentence).toContain("The payout is processing.");
  });
  it("has no panel for a gift with no recognized claim, and the gift is WAITING", async () => {
    const { db } = await fresh(); const captureId = await recordGift(db, "fund_b", 2500n); await pause(25);
    expect((await loadGiftPage(db, captureId))!.note).toBeNull();
  });
});

describe("GT-24 the shared request window", () => {
  it("allows 120 requests, refuses the 121st and later ones, and a past resets_at restores service", async () => {
    const { db, client } = await fresh();
    for (let i = 1; i <= GIFT_PAGE_LIMIT; i++) expect(await takeGiftPageSlot(db)).toBe(true);
    expect(await takeGiftPageSlot(db)).toBe(false);
    expect(await takeGiftPageSlot(db)).toBe(false);
    const [row] = await client`select attempts, resets_at from login_windows where username = ${GIFT_PAGE_LIMIT_KEY}`;
    expect(row!.attempts).toBe(GIFT_PAGE_LIMIT + 2);
    expect(new Date(row!.resets_at as string).getTime()).toBeGreaterThan(Date.now());
    await client`update login_windows set resets_at = now() - interval '1 second' where username = ${GIFT_PAGE_LIMIT_KEY}`;
    expect(await takeGiftPageSlot(db)).toBe(true);
    const [restored] = await client`select attempts from login_windows where username = ${GIFT_PAGE_LIMIT_KEY}`;
    expect(restored!.attempts).toBe(1);
  });
  it("runs 121 concurrent calls into exactly 120 allowed and one refused", async () => {
    const { db } = await fresh();
    const results = await Promise.all(Array.from({ length: GIFT_PAGE_LIMIT + 1 }, () => takeGiftPageSlot(db)));
    expect(results.filter(Boolean)).toHaveLength(GIFT_PAGE_LIMIT);
    expect(results.filter(result => !result)).toHaveLength(1);
  });
});

describe("GT-25 the gift window is separate from the login windows", () => {
  it("uses the key gift-page, leaves failed logins at their own count, and is not blocked by them", async () => {
    const { db, client } = await fresh();
    for (let i = 0; i < 10; i++) expect(await authenticate("maria", `wrong-password-${i}`, db)).toBeNull();
    const [login] = await client`select attempts from login_windows where username = 'maria'`;
    expect(login!.attempts).toBe(10);
    for (let i = 0; i < GIFT_PAGE_LIMIT + 1; i++) await takeGiftPageSlot(db);
    const [after] = await client`select attempts from login_windows where username = 'maria'`;
    expect(after!.attempts).toBe(10);
    const keys = (await client`select username from login_windows order by username`).map(row => row.username);
    expect(keys).toEqual([GIFT_PAGE_LIMIT_KEY, "maria"]);
    expect(GIFT_PAGE_LIMIT_KEY).toBe("gift-page");
    // The gift window is exhausted now, and a login attempt for another user is still counted on its own row, not refused by it.
    expect(await authenticate("tara", "wrong-password", db)).toBeNull();
    const [tara] = await client`select attempts from login_windows where username = 'tara'`;
    expect(tara!.attempts).toBe(1);
    expect(GIFT_PAGE_LIMIT_KEY).not.toMatch(/^[a-z][a-z0-9_]{0,31}$/);
  });
});

describe("GT-26 loading the page writes nothing but the request window", () => {
  it("fifty loads leave every table except login_windows byte for byte unchanged", async () => {
    const { db, client } = await fresh(); const { captureId } = await giftedClaim(db, "fund_b", 2500n);
    await approveNote(db, captureId);
    const tables = (await client`select tablename from pg_tables where schemaname = 'public' and tablename <> 'login_windows' order by tablename`).map(row => row.tablename as string);
    expect(tables).toContain("gift_links"); expect(tables).toContain("gift_notes"); expect(tables).toContain("journal_entries");
    const snapshot = async () => { const out: Record<string, { count: number; hash: string }> = {}; for (const table of tables) out[table] = await tableHash(client, table); return out; };
    const beforeFinancial = await financialHash(client); const before = await snapshot();
    for (let i = 0; i < 50; i++) { await takeGiftPageSlot(db); expect((await loadGiftPage(db, captureId))!.trail.state).toBe("APPROVED"); }
    expect(await financialHash(client)).toBe(beforeFinancial);
    expect(await snapshot()).toEqual(before);
    const [windowRow] = await client`select attempts from login_windows where username = ${GIFT_PAGE_LIMIT_KEY}`;
    expect(windowRow!.attempts).toBe(50);
    expect(before.gift_links!.count).toBe(0);
    expect(before.gift_notes!.count).toBe(1);
  });
});
