import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as s from "../db/schema";
import type { AppDatabase } from "../src/server/db";
import { ApproverQueueAccessError, loadApproverQueue, type ApproverQueueRow } from "../src/server/approver-queue";
import { advanceSolverPriority, approveDecision, freezeDecision, rejectClaim } from "../src/ledger/service";
import { createReceiptDraft } from "../src/receipt/service";
import { createPolicyDatabase, financialHash, insertClaim, receiptClaim, RECEIPT_PAYEE, tableHash, type PolicyDatabase } from "./support/policy-db";

// IAC-414 Q1, tests AQ-01 to AQ-10 and AQ-26. Real Postgres in the isolated check project. No network, no model,
// no provider. One database holds every planted case of AQ-01 to AQ-10, because the loader only reads: each test reads the same planted state.
// AQ-26 changes state (an invalidation and a re-freeze), so it plants its own database at the end of the file.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const BIG = 9007199254740993n; // 2^53 + 1: the first integer a JavaScript number cannot hold
const ONE_LINE = (amount: string) => [{ description: "Robot servo kit", amount, category: "robot_kits_parts" }];

let ctx: PolicyDatabase;
const planted: Record<string, { id: string; hash?: string; decisionId?: string }> = {};
const vendors = (rows: readonly ApproverQueueRow[]) => rows.map(row => row.vendor).sort();
const byVendor = (rows: readonly ApproverQueueRow[], vendor: string) => rows.find(row => row.vendor === vendor);

beforeAll(async () => {
  ctx = await createPolicyDatabase("aidtrace_aq");
  const { db } = ctx;
  planted.open = await receiptClaim(db, { vendor: "Aq open shop", lines: ONE_LINE("12.00") });
  planted.byTara = await receiptClaim(db, { vendor: "Aq tara shop", lines: ONE_LINE("15.00") });
  planted.byBen = await receiptClaim(db, { vendor: "Aq ben shop", lines: ONE_LINE("18.00") });
  planted.both = await receiptClaim(db, { vendor: "Aq both shop", lines: ONE_LINE("21.00") });
  planted.rejected = await receiptClaim(db, { vendor: "Aq rejected shop", lines: ONE_LINE("24.00") });
  await approveDecision(db, planted.byTara!.decisionId!, "tara", planted.byTara!.hash!);
  await approveDecision(db, planted.byBen!.decisionId!, "ben", planted.byBen!.hash!);
  await approveDecision(db, planted.both!.decisionId!, "tara", planted.both!.hash!);
  await approveDecision(db, planted.both!.decisionId!, "ben", planted.both!.hash!);
  await rejectClaim(db, planted.rejected!.id, "tara", "Planted rejection for the queue test");
  // A receipt draft that was never frozen.
  planted.draft = { id: await createReceiptDraft(db, "maria", { vendor: "Aq draft shop", program: "robotics", incurredOn: "2026-10-14", source: "Robot servo kit", total: "9.00", lines: [{ description: "Robot servo kit", amount: "9.00" }] }, RECEIPT_PAYEE) };
  // Statuses the page never lists, planted straight into the claims table (tests only).
  await insertClaim(db, { id: "R-aq-paid", vendor: "Aq paid shop", status: "PAID", lines: [{ id: "L1", category: "robot_kits_parts", budgetLine: "Robotics", amountCents: 3000n }] });
  planted.paid = { id: "R-aq-paid" };
  // An id that is not a practice receipt claim, awaiting approval.
  await insertClaim(db, { id: "X-aq-not-receipt", vendor: "Aq not a receipt shop", status: "AWAITING_APPROVAL", lines: [{ id: "L1", category: "robot_kits_parts", budgetLine: "Robotics", amountCents: 3300n }] });
  // An amount no JavaScript number holds, with no frozen terms.
  await insertClaim(db, { id: "R-aq-big", vendor: "Aq big shop", status: "AWAITING_APPROVAL", lines: [{ id: "L1", category: "robot_kits_parts", budgetLine: "Robotics", amountCents: BIG }] });
  planted.big = { id: "R-aq-big" };
  // Another organization with its own approver, claimant and one claim awaiting approval.
  await db.insert(s.organizations).values({ id: "aq-other", name: "Private other organization", prohibitedCategories: [], openingSourceType: "fixture_opening_balance" });
  await db.insert(s.users).values([
    { id: "aq-claimant", organizationId: "aq-other", username: "aq-claimant", displayName: "Other Claimant", role: "CLAIMANT", passwordHash: "not-a-real-hash" },
    { id: "aq-approver", organizationId: "aq-other", username: "aq-approver", displayName: "Other Approver", role: "APPROVER", passwordHash: "not-a-real-hash" },
  ]);
  await insertClaim(db, { id: "R-aq-other", vendor: "Aq other organization shop", status: "AWAITING_APPROVAL", organizationId: "aq-other", claimantId: "aq-claimant", lines: [{ id: "L1", category: "robot_kits_parts", budgetLine: "Robotics", amountCents: 4242n }] });
  planted.other = { id: "R-aq-other" };
});
afterAll(async () => { await ctx?.close(); });

describe("AQ-01 a claim this approver already approved is not in the queue", () => {
  it("leaves it out for the approver who approved it and keeps it for the other approver", async () => {
    const tara = await loadApproverQueue(ctx.db, "tara"); const ben = await loadApproverQueue(ctx.db, "ben");
    expect(vendors(tara.rows)).not.toContain("Aq tara shop"); expect(vendors(ben.rows)).toContain("Aq tara shop");
    expect(vendors(ben.rows)).not.toContain("Aq ben shop"); expect(vendors(tara.rows)).toContain("Aq ben shop");
  });
});

describe("AQ-02 a claim the other approver approved waits for this approver", () => {
  it("lists it with one of two approvals, and lists an unapproved claim with none", async () => {
    const tara = await loadApproverQueue(ctx.db, "tara"); const ben = await loadApproverQueue(ctx.db, "ben");
    expect(byVendor(tara.rows, "Aq ben shop")).toMatchObject({ id: planted.byBen!.id, approvalCount: 1, approvals: "Approvals: 1 of 2", href: `/claims/${planted.byBen!.id}` });
    expect(byVendor(ben.rows, "Aq tara shop")).toMatchObject({ id: planted.byTara!.id, approvalCount: 1, approvals: "Approvals: 1 of 2" });
    for (const view of [tara, ben]) expect(byVendor(view.rows, "Aq open shop")).toMatchObject({ id: planted.open!.id, approvalCount: 0, approvals: "Approvals: 0 of 2" });
  });
});

describe("AQ-03 only a claim awaiting approval is listed", () => {
  it("leaves out a fully approved, a paid, a rejected and a draft claim for both approvers", async () => {
    const ids = [planted.both!.id, planted.paid!.id, planted.rejected!.id, planted.draft!.id];
    const statuses = await ctx.db.select({ id: s.claims.id, status: s.claims.status }).from(s.claims);
    for (const [id, status] of [[planted.both!.id, "APPROVED"], [planted.paid!.id, "PAID"], [planted.rejected!.id, "REJECTED"], [planted.draft!.id, "DRAFT"]] as const)
      expect(statuses.find(row => row.id === id)?.status, `planted ${id}`).toBe(status);
    for (const actor of ["tara", "ben"]) {
      const view = await loadApproverQueue(ctx.db, actor);
      for (const id of ids) expect(view.rows.map(row => row.id), `${actor} ${id}`).not.toContain(id);
    }
  });
});

describe("AQ-04 the queue is scoped to the approver's organization", () => {
  it("never lists another organization's claim, and lists that organization's claim only for its own approver", async () => {
    const tara = await loadApproverQueue(ctx.db, "tara"); const other = await loadApproverQueue(ctx.db, "aq-approver");
    expect(tara.rows.map(row => row.id)).not.toContain(planted.other!.id);
    // The other organization's amount is matched as a whole JSON value ("4242" or a bare 4242 number), so a random claim id that happens to contain 4242 cannot fail this test.
    const OTHER_AMOUNT = /"4242"|:4242[,}\]]/;
    expect('{"amountCents":"4242"}').toMatch(OTHER_AMOUNT); expect('{"total":4242}').toMatch(OTHER_AMOUNT); expect('{"id":"R-a98442423e7a"}').not.toMatch(OTHER_AMOUNT);
    expect(JSON.stringify(tara)).not.toMatch(/Private other organization|Aq other organization shop|Other Claimant/); expect(JSON.stringify(tara)).not.toMatch(OTHER_AMOUNT);
    expect(other.rows).toHaveLength(1);
    // No frozen terms exist for this claim, so the fund falls back to the claim's program and the age is unknown.
    expect(other.rows[0]).toMatchObject({ id: "R-aq-other", vendor: "Aq other organization shop", claimant: "Other Claimant", amountCents: "4242", approvalCount: 0, waitingSince: "", age: "Unknown" });
    expect(JSON.stringify(other)).not.toMatch(/Aq open shop|Aq ben shop|Aq tara shop|Aq big shop/);
  });
});

describe("AQ-05 only practice receipt claims are listed", () => {
  it("leaves out an awaiting claim whose id is not R- and the seeded C-104", async () => {
    for (const actor of ["tara", "ben"]) {
      const view = await loadApproverQueue(ctx.db, actor);
      expect(view.rows.map(row => row.id).filter(id => !id.startsWith("R-"))).toEqual([]);
      expect(vendors(view.rows)).not.toContain("Aq not a receipt shop");
    }
  });
});

describe("AQ-06 amounts are strings of integer cents", () => {
  it("returns every amount as a canonical decimal string equal to the claim's lines, including one above 2 to the 53rd", async () => {
    const tara = await loadApproverQueue(ctx.db, "tara");
    for (const row of tara.rows) { expect(typeof row.amountCents).toBe("string"); expect(row.amountCents).toMatch(/^(0|[1-9][0-9]*)$/); }
    expect(byVendor(tara.rows, "Aq open shop")?.amountCents).toBe("1200");
    expect(byVendor(tara.rows, "Aq ben shop")?.amountCents).toBe("1800");
    expect(byVendor(tara.rows, "Aq big shop")?.amountCents).toBe("9007199254740993");
    expect(BigInt(byVendor(tara.rows, "Aq big shop")!.amountCents)).toBe(BIG);
    // Nothing in the result is a bigint or a float, so it serializes.
    expect(() => JSON.stringify(tara)).not.toThrow();
    expect(JSON.stringify(tara.rows.map(row => row.amountCents))).toContain("\"9007199254740993\"");
  });
  it("names the funds of the frozen split for a frozen claim and falls back to the program when no terms are frozen", async () => {
    const tara = await loadApproverQueue(ctx.db, "tara");
    const frozen = byVendor(tara.rows, "Aq open shop")!; const unfrozen = byVendor(tara.rows, "Aq big shop")!;
    const names = (await ctx.db.select({ name: s.funds.name }).from(s.funds)).map(fund => fund.name);
    expect(frozen.fund.length).toBeGreaterThan(0);
    for (const part of frozen.fund.split(", ")) expect(names, `fund ${part}`).toContain(part);
    const [program] = await ctx.db.select({ program: s.claims.program }).from(s.claims).where(sql`${s.claims.id} = 'R-aq-big'`);
    expect(unfrozen.fund).toBe(program!.program);
  });
});

describe("AQ-07 only an approver can read the queue", () => {
  it("refuses a claimant, an unknown user and an empty id with a 403", async () => {
    for (const actor of ["maria", "nobody", "", "aq-claimant"]) {
      const result = await loadApproverQueue(ctx.db, actor).then(() => null, (error: unknown) => error);
      expect(result, `actor ${JSON.stringify(actor)}`).toBeInstanceOf(ApproverQueueAccessError);
      expect(result).toMatchObject({ status: 403, message: "Approver access required" });
    }
  });
});

describe("AQ-08 a row carries only what the grid shows", () => {
  it("has exactly the documented fields and no claimant id, approver id, decision hash, decision id or payee email", async () => {
    const tara = await loadApproverQueue(ctx.db, "tara");
    expect(Object.keys(tara).sort()).toEqual(["observedAt", "rows"]);
    for (const row of tara.rows) expect(Object.keys(row).sort()).toEqual(["age", "amountCents", "approvalCount", "approvals", "claimant", "fund", "href", "id", "vendor", "waitingSince"]);
    const text = JSON.stringify(tara);
    for (const secret of [planted.open!.hash!, planted.byBen!.hash!, planted.open!.decisionId!, RECEIPT_PAYEE, "\"tara\"", "\"ben\"", "\"maria\""]) expect(text, secret).not.toContain(secret);
    expect(byVendor(tara.rows, "Aq open shop")?.claimant).toBe((await ctx.db.select({ name: s.users.displayName }).from(s.users).where(sql`${s.users.id} = 'maria'`))[0]!.name);
  });
});

describe("AQ-09 the longest waiting claim comes first", () => {
  it("orders by when the terms were frozen, oldest first, and puts a claim with no frozen terms last", async () => {
    const tara = await loadApproverQueue(ctx.db, "tara");
    const frozen = tara.rows.filter(row => row.waitingSince !== "");
    expect(frozen.length).toBeGreaterThanOrEqual(2);
    expect(frozen.map(row => row.waitingSince)).toEqual([...frozen.map(row => row.waitingSince)].sort());
    expect(tara.rows.slice(-1)[0]?.vendor).toBe("Aq big shop");
    expect(frozen.map(row => row.vendor)).toEqual(["Aq open shop", "Aq ben shop"]);
  });
  it("reads the age from the clock it is given and says Unknown when no terms are frozen", async () => {
    const later = new Date(Date.now() + 3 * 3_600_000 + 5 * 60_000);
    const tara = await loadApproverQueue(ctx.db, "tara", later);
    expect(tara.observedAt).toBe(later.toISOString());
    expect(byVendor(tara.rows, "Aq open shop")?.age).toBe("3h");
    expect(byVendor(tara.rows, "Aq big shop")?.age).toBe("Unknown");
  });
});

describe("AQ-10 the loader only reads", () => {
  type Tx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];
  // users has no immutability trigger, so only the read-only setting can be the reason for a refusal. The write runs in a savepoint so the surrounding transaction still commits.
  const probe = (tx: Tx) => tx.transaction(async inner => { await inner.execute(sql`update users set display_name = display_name`); })
    .then(() => "allowed", (error: Error) => `${error.message} ${(error.cause as Error | undefined)?.message ?? ""}`);
  it("refuses a write made through the very handle the loader used, and allows the same write in an ordinary transaction", async () => {
    let outcome = "not probed";
    const probing = new Proxy(ctx.db, { get(target, property) {
      if (property === "transaction") return (callback: (tx: Tx) => Promise<unknown>, config?: unknown) => (target.transaction as (cb: unknown, cfg?: unknown) => Promise<unknown>)(async (tx: Tx) => { const result = await callback(tx); outcome = await probe(tx); return result; }, config);
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    } }) as AppDatabase;
    const view = await loadApproverQueue(probing, "tara");
    expect(view.rows.length).toBeGreaterThan(0);
    expect(outcome).toMatch(/read-only transaction/);
    expect(await ctx.db.transaction(tx => probe(tx))).toBe("allowed");
  });
  it("changes no financial row, no user, no session and no claim version", async () => {
    const before = { financial: await financialHash(ctx.client), users: await tableHash(ctx.client, "users"), sessions: await tableHash(ctx.client, "sessions") };
    await loadApproverQueue(ctx.db, "tara"); await loadApproverQueue(ctx.db, "ben"); await loadApproverQueue(ctx.db, "aq-approver");
    await loadApproverQueue(ctx.db, "maria").catch(() => undefined);
    expect({ financial: await financialHash(ctx.client), users: await tableHash(ctx.client, "users"), sessions: await tableHash(ctx.client, "sessions") }).toEqual(before);
  });
});

// The IAC-440 demo path: a rule bind advances the solver priority, which invalidates every frozen decision of the organization (advanceSolverPriority is the
// administrative entry point of that step). The claimant then freezes again on the new terms. The queue counts approvals on the current terms only. It has its
// own database because the invalidation reaches every stale decision of the organization, which would change what AQ-01 to AQ-10 read.
describe("AQ-26 a re-frozen claim returns to the queue with no approvals", () => {
  const VENDOR = "Aq refrozen shop";
  let own: PolicyDatabase;
  beforeAll(async () => { own = await createPolicyDatabase("aidtrace_aq26"); });
  afterAll(async () => { await own?.close(); });
  it("drops the claim for the approver who approved it, drops it for both once invalidated, and restores it to both at 0 of 2 when frozen again", async () => {
    const { db } = own;
    const queues = async () => ({ tara: await loadApproverQueue(db, "tara"), ben: await loadApproverQueue(db, "ben") });
    const approvalsOn = (hash: string) => db.select().from(s.approvals).where(eq(s.approvals.decisionHash, hash));
    const first = await receiptClaim(db, { vendor: VENDOR, lines: ONE_LINE("27.00") });

    // 1. Tara approves the frozen terms.
    expect(await approveDecision(db, first.decisionId, "tara", first.hash)).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    let view = await queues();
    expect(byVendor(view.tara.rows, VENDOR)).toBeUndefined();
    expect(byVendor(view.ben.rows, VENDOR)).toMatchObject({ id: first.id, approvalCount: 1, approvals: "Approvals: 1 of 2" });

    // 2. The decision is invalidated through the real ledger path. The claim returns to DRAFT and is in neither queue. Tara's approval stays on the old hash.
    expect(await advanceSolverPriority(db, "cedar-hollow", "tara", 1)).toEqual({ version: 2, invalidatedDecisions: 1 });
    expect((await db.select({ status: s.claims.status }).from(s.claims).where(eq(s.claims.id, first.id)))[0]?.status).toBe("DRAFT");
    view = await queues();
    expect(byVendor(view.tara.rows, VENDOR)).toBeUndefined();
    expect(byVendor(view.ben.rows, VENDOR)).toBeUndefined();
    expect(await approvalsOn(first.hash)).toHaveLength(1);

    // 3. The claimant freezes again on the new terms. Tara's old approval does not count: both approvers see the claim with no approvals.
    const second = await freezeDecision(db, first.id, "maria");
    if (second.status !== "AWAITING_APPROVAL") throw new Error("Expected a funded frozen decision");
    expect(second.decisionHash).not.toBe(first.hash); expect(second.decisionId).not.toBe(first.decisionId);
    view = await queues();
    for (const actor of ["tara", "ben"] as const) expect(byVendor(view[actor].rows, VENDOR), actor).toMatchObject({ id: first.id, approvalCount: 0, approvals: "Approvals: 0 of 2" });
    expect(await approvalsOn(first.hash)).toHaveLength(1); expect(await approvalsOn(second.decisionHash)).toHaveLength(0);
  });
});
