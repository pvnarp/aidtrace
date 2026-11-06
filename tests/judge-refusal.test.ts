import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDatabase, connectDatabase } from "../src/server/db";
import { authenticate } from "../src/server/auth";
import { seedFixture } from "../db/fixture";
import * as s from "../db/schema";
import { ensureFixtureOpening } from "../src/ledger/opening";
import { handleClaimAction } from "../src/server/claim-actions";
import { judgeSession } from "../src/server/judge-mode";
import type { PayoutTransport } from "../src/paypal/adapter";

// JS-01 to JS-08: a judging session (AIDTRACE_JUDGE_SESSION=true) can never request or change a payment. src/server/claim-actions.ts
// refuses send, refresh, retry, authorize-retry, resolve-historical and takeover, and every action on a claim whose id does not start
// "R-", with 403 before any ledger code runs. Freeze and approve on an R- claim still work. The route passes judgeSession() from the
// server environment only. Real Postgres, a stubbed PayPal transport that must never be called, synthetic credentials.
const REFUSAL = "This judging session cannot request or change a payment. Continue the unpaid receipt review.";
const REFUSED = ["send", "refresh", "retry", "authorize-retry", "resolve-historical", "takeover"] as const;
const ORIGIN = "http://127.0.0.1:3100";
const databaseName = `aidtrace_js_test_${randomBytes(6).toString("hex")}`;
const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://aidtrace@db:5432/aidtrace"); adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 }); const testUrl = new URL(adminUrl); testUrl.pathname = `/${databaseName}`;
const { db, client } = connectDatabase(testUrl.toString());
const passwords = { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") };
const cookies: Record<string, string> = {};
let created = false; const savedEnv = { url: process.env.DATABASE_URL, judge: process.env.AIDTRACE_JUDGE_SESSION, origin: process.env.APP_ORIGIN };

const provider = {
  validatePayout: vi.fn<PayoutTransport["validatePayout"]>(), balance: vi.fn<PayoutTransport["balance"]>(), send: vi.fn<PayoutTransport["send"]>(),
  batch: vi.fn<PayoutTransport["batch"]>(), item: vi.fn<PayoutTransport["item"]>(),
} satisfies PayoutTransport;
const transportCalls = () => Object.values(provider).reduce((sum, mock) => sum + mock.mock.calls.length, 0);

async function counts() {
  const rows = async (table: PgTable) => (await db.select().from(table)).length;
  return {
    disbursements: await rows(s.disbursements), attempts: await rows(s.disbursementAttempts), approvals: await rows(s.approvals), journal: await rows(s.journalEntries),
    postings: await rows(s.journalPostings), providerEvents: await rows(s.providerEvents), reviews: await rows(s.historicalEventReviews),
    resolutions: await rows(s.historicalEventReviewResolutions), decisions: await rows(s.allocationDecisions),
  };
}
const ZERO_ID = "00000000-0000-4000-8000-000000000000", HASH = "a".repeat(64);
function formFor(action: string, extra: Record<string, string> = {}) {
  return { action, confirmSandbox: "yes", decisionHash: HASH, decisionId: ZERO_ID, authorizationId: ZERO_ID, failedAttemptId: ZERO_ID, reviewId: ZERO_ID, note: "Checked both attempts in PayPal.", ...extra };
}
function post(user: keyof typeof passwords, claimId: string, body: Record<string, string>, judge: boolean | undefined, url = `${ORIGIN}/api/claims/${claimId}/actions`, headers: Record<string, string> = {}) {
  return handleClaimAction(new Request(url, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", cookie: cookies[user]!, ...headers }, body: new URLSearchParams(body) }), claimId, { db, provider: () => provider, judgeSession: judge });
}
async function addClaim(id: string) {
  const [original] = await db.select().from(s.claims).where(eq(s.claims.id, "C-104"));
  await db.insert(s.claims).values({ ...original!, id, status: "DRAFT" });
  await db.insert(s.claimLines).values({ claimId: id, claimVersion: 1, id: "js-line", description: "Judge refusal test only", category: "participant_meals", budgetLine: "other", amountCents: 100n });
}

beforeAll(async () => {
  await admin`create database ${admin(databaseName)}`; created = true;
  await migrate(db, { migrationsFolder: "db/migrations" });
  await seedFixture(db, { passwords, payeeEmail: "payout-test@personal.example.com", payeeAllowlist: ["payout-test@personal.example.com"] });
  await db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  process.env.APP_ORIGIN = ORIGIN;
  for (const user of ["maria", "tara", "ben"] as const) { const session = await authenticate(user, passwords[user], db); cookies[user] = `aidtrace_session=${session!.token}`; }
  await addClaim("R-js-1");
}, 30_000);
afterAll(async () => {
  process.env.DATABASE_URL = savedEnv.url; if (savedEnv.judge === undefined) delete process.env.AIDTRACE_JUDGE_SESSION; else process.env.AIDTRACE_JUDGE_SESSION = savedEnv.judge;
  if (savedEnv.origin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = savedEnv.origin;
  await closeDatabase(); await client.end(); if (created) await admin`drop database ${admin(databaseName)}`; await admin.end();
});

describe("JS judging session payment refusal", () => {
  it("JS-01: every payment action on an R- claim returns 403 with the refusal text, writes no row in any money or review table, and never reaches PayPal", async () => {
    const before = await counts();
    for (const action of REFUSED) {
      const response = await post("tara", "R-js-1", formFor(action), true);
      expect(response.status, action).toBe(403); expect(await response.text(), action).toBe(REFUSAL);
    }
    expect(await counts()).toEqual(before); expect(transportCalls()).toBe(0);
  });
  it("JS-02: the refusal comes before the role check and the body checks, so a claimant and a malformed body get the same 403", async () => {
    const before = await counts();
    for (const action of REFUSED) {
      const claimant = await post("maria", "R-js-1", { action }, true);
      expect(claimant.status, `claimant ${action}`).toBe(403); expect(await claimant.text()).toBe(REFUSAL);
    }
    expect(await counts()).toEqual(before); expect(transportCalls()).toBe(0);
  });
  it("JS-03: a claim id that does not start R- is refused for every action, freeze and approve included, and nothing is written", async () => {
    const before = await counts();
    for (const action of [...REFUSED, "freeze", "approve", "reject", "approve-note"]) {
      const user = action === "freeze" ? "maria" : "tara";
      const response = await post(user, "C-104", formFor(action), true);
      expect(response.status, action).toBe(403); expect(await response.text(), action).toBe(REFUSAL);
    }
    expect(await counts()).toEqual(before); expect(transportCalls()).toBe(0);
    // Same requests with no judge session are not refused by this rule (the control that shows the refusal is the judge flag).
    const control = await post("maria", "C-104", formFor("freeze"), false);
    expect(control.status).toBe(303);
  });
  it("JS-04: a claim whose id only contains R- or starts with a lowercase r- is not an R- claim", async () => {
    await addClaim("xR-js-2"); await addClaim("r-js-3");
    for (const id of ["xR-js-2", "r-js-3"]) {
      const response = await post("maria", id, formFor("freeze"), true);
      expect(response.status, id).toBe(403); expect(await response.text()).toBe(REFUSAL);
    }
  });
  it("JS-05: freeze and approve on an R- claim still work in a judge session", async () => {
    const frozen = await post("maria", "R-js-1", { action: "freeze" }, true);
    expect(frozen.status).toBe(303); expect(frozen.headers.get("location")).toBe("/claims/R-js-1?notice=frozen");
    const [decision] = await db.select().from(s.allocationDecisions).where(eq(s.allocationDecisions.claimId, "R-js-1"));
    expect(decision).toBeDefined();
    const before = await counts();
    const first = await post("tara", "R-js-1", { action: "approve", decisionId: decision!.id, decisionHash: decision!.decisionHash }, true);
    expect(first.status).toBe(303); expect(first.headers.get("location")).toBe("/claims/R-js-1?notice=approval-saved");
    const second = await post("ben", "R-js-1", { action: "approve", decisionId: decision!.id, decisionHash: decision!.decisionHash }, true);
    expect(second.status).toBe(303); expect(second.headers.get("location")).toBe("/claims/R-js-1?notice=approved");
    const after = await counts();
    expect(after.approvals).toBe(before.approvals + 2);
    // Approval records a decision. It moves no money: no disbursement, attempt or provider event, and PayPal is untouched.
    expect(after.disbursements).toBe(before.disbursements); expect(after.attempts).toBe(before.attempts); expect(after.providerEvents).toBe(before.providerEvents);
    expect(transportCalls()).toBe(0);
  });
  it("JS-06: after approval the payment actions on that same R- claim are still refused", async () => {
    const before = await counts();
    for (const action of ["send", "takeover"]) {
      const response = await post("tara", "R-js-1", formFor(action), true);
      expect(response.status, action).toBe(403); expect(await response.text()).toBe(REFUSAL);
    }
    expect(await counts()).toEqual(before); expect(transportCalls()).toBe(0);
  });
});

describe("JS route wiring", () => {
  async function route() {
    process.env.DATABASE_URL = testUrl.toString(); process.env.APP_ORIGIN = ORIGIN;
    const { POST } = await import("../src/app/api/claims/[claimId]/actions/route");
    return POST;
  }
  const call = async (POST: Awaited<ReturnType<typeof route>>, claimId: string, body: Record<string, string>, url?: string, headers: Record<string, string> = {}) =>
    POST(new Request(url ?? `${ORIGIN}/api/claims/${claimId}/actions`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", cookie: cookies.tara!, ...headers }, body: new URLSearchParams(body) }), { params: Promise.resolve({ claimId }) });

  it("JS-07: the judgeSession helper reads only AIDTRACE_JUDGE_SESSION from the server environment, and only the exact value true", () => {
    expect(judgeSession({ AIDTRACE_JUDGE_SESSION: "true" })).toBe(true);
    for (const value of [undefined, "", "false", "TRUE", "1", "yes", " true"]) expect(judgeSession({ AIDTRACE_JUDGE_SESSION: value }), String(value)).toBe(false);
  });
  it("JS-08: the route applies the server judge flag and a header, a body field or a query value cannot turn it off", async () => {
    const POST = await route();
    process.env.AIDTRACE_JUDGE_SESSION = "true";
    const before = await counts();
    const attempts: [string, Record<string, string>, string | undefined, Record<string, string>][] = [
      ["plain", formFor("send"), undefined, {}],
      ["header", formFor("send"), undefined, { "x-aidtrace-judge-session": "false", "x-judge-session": "false", "x-forwarded-for": "10.0.0.1" }],
      ["body", formFor("send", { judgeSession: "false", AIDTRACE_JUDGE_SESSION: "false" }), undefined, {}],
      ["query", formFor("send"), `${ORIGIN}/api/claims/R-js-1/actions?judgeSession=false&AIDTRACE_JUDGE_SESSION=false`, {}],
    ];
    for (const [name, body, url, headers] of attempts) {
      const response = await call(POST, "R-js-1", body, url, headers);
      expect(response.status, name).toBe(403); expect(await response.text(), name).toBe(REFUSAL);
    }
    const nonR = await call(POST, "C-104", formFor("freeze"));
    expect(nonR.status).toBe(403); expect(await nonR.text()).toBe(REFUSAL);
    expect(await counts()).toEqual(before);
    // With the server flag off the same route does not use this refusal (it is not a judging session), which shows the flag is what the route reads.
    process.env.AIDTRACE_JUDGE_SESSION = "false";
    const off = await call(POST, "R-js-1", formFor("send"));
    expect(await off.text()).not.toBe(REFUSAL);
  });
});
