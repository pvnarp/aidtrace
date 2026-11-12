import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../db/schema";
import { closeDatabase } from "../src/server/db";
import { SESSION_COOKIE } from "../src/server/auth";
import { approveDecision } from "../src/ledger/service";
import { runModelCheck } from "../src/policy/model-run";
import { runPolicyChecks } from "../src/policy/service";
import { loadClaimView } from "../src/server/claim-view";
import { handleBulkApprove, BULK_BODY_LIMIT } from "../src/server/bulk-approve-actions";
import { holdsLabel, loadAssistedChecks } from "../src/server/assisted-checks";
import { BULK_SKIP_TEXT } from "../src/fund-modes/bulk-reasons";
import { createPolicyDatabase, financialHash, receiptClaim, sessionFor, type PolicyDatabase, type ReceiptLineSpec } from "./support/policy-db";
import { AI_ENV, ALL_ASSISTED, FLAG_ON, allOk, setMode, setModes, stub, type Handler } from "./support/fund-modes";

// IAC-405 step 2 PR A, AS-01 to AS-19 on real Postgres in the isolated check project: the bulk approval route, the
// Checks column read and the claim page line. Every request is built by hand and handed to the handler the route file calls. Every model call goes to a stub. No network, no key, no provider.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const ORIGIN = "http://127.0.0.1:3100";
const FORM = "application/x-www-form-urlencoded";
const PATH = "/api/approvals/bulk";
let ctx: PolicyDatabase;
const open: PolicyDatabase[] = [];
const savedOrigin = process.env.APP_ORIGIN;
beforeAll(() => { process.env.APP_ORIGIN = ORIGIN; });
beforeEach(async () => { ctx = await createPolicyDatabase("aidtrace_as"); open.push(ctx); vi.stubEnv("FUND_MODES_ENABLED", "true"); }, 60_000);
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); while (open.length) await open.pop()!.close(); }, 60_000);
afterAll(async () => { if (savedOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = savedOrigin; await closeDatabase(); });

const tokens = new Map<string, string>();
const tokenOf = async (userId: string) => { const key = `${ctx.name}:${userId}`; if (!tokens.has(key)) tokens.set(key, await sessionFor(ctx.db, userId)); return tokens.get(key)!; };
type Init = { user?: string | null; origin?: string | null; type?: string | null; method?: string; body?: BodyInit | null; length?: string; cookie?: string };
async function build(init: Init = {}): Promise<Request> {
  const headers: Record<string, string> = {};
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  if (init.type !== null) headers["content-type"] = init.type ?? FORM;
  const user = init.user === undefined ? "tara" : init.user;
  if (init.cookie) headers.cookie = init.cookie; else if (user) headers.cookie = `${SESSION_COOKIE}=${await tokenOf(user)}`;
  if (init.length) headers["content-length"] = init.length;
  const method = init.method ?? "POST";
  const body = (method === "GET" || method === "HEAD" ? undefined : init.body === undefined ? "" : init.body) as BodyInit | null | undefined;
  return new Request(`${ORIGIN}${PATH}`, { method, headers, body, ...(body && typeof body === "object" && "getReader" in body ? { duplex: "half" } : {}) } as RequestInit);
}
const form = (fields: Record<string, string | string[]>) => new URLSearchParams(Object.entries(fields).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(item => [key, item] as [string, string]))).toString();
type Claim = { id: string; hash: string; decisionId: string };
const entry = (claim: { id: string }, version = 1) => `${claim.id}:${version}`;
const send = async (claims: string[], init: Init = {}, env: Record<string, string | undefined> = FLAG_ON) => handleBulkApprove(await build({ body: form({ claim: claims }), ...init }), { db: ctx.db, env });
type Answer = { approved: string[]; saved: { claimId: string; text: string }[]; skipped: { claimId: string; reason: string; text: string }[] };
const answer = async (response: Response) => (await response.json()) as Answer;

// Two small lines, so several claims in one test stay inside the restricted funds. A larger claim spills to the unrestricted fund, which the model has nothing to read for.
const CLEAN_LINES: ReceiptLineSpec[] = [{ description: "Robot servo kit", amount: "20.00", category: "robot_kits_parts" }, { description: "Classroom markers", amount: "10.00", category: "classroom_supplies" }];
const GIFT_CARD_SOURCE = `${CLEAN_LINES.map(line => line.description).join("\n")}\nRaffle prize: gift card`;
const clean = (vendor: string, spec: { source?: string; lines?: ReceiptLineSpec[] } = {}) => receiptClaim(ctx.db, { vendor, lines: CLEAN_LINES, ...spec });
const runChecks = async (hash: string, handler: Handler = allOk) => {
  expect((await runPolicyChecks(ctx.db, hash, { id: "tara" })).status).toBe("RAN");
  const { client } = stub(handler);
  expect((await runModelCheck(ctx.db, hash, { id: "tara" }, { env: AI_ENV, client })).status).toBe("RAN");
};
// A clean Assisted claim: frozen under Assisted funds with both stored runs finished and no hold.
const assistedClean = async (vendor: string) => { const claim = await clean(vendor); await runChecks(claim.hash); return claim; };
const approvalsOf = (hash: string) => ctx.db.select().from(s.approvals).where(eq(s.approvals.decisionHash, hash));
const automatedOf = (hash: string) => ctx.db.select().from(s.automatedDecisions).where(eq(s.automatedDecisions.decisionHash, hash));
const statusOf = async (id: string) => (await ctx.db.select().from(s.claims).where(eq(s.claims.id, id)))[0]!.status;
const recognitionEntries = async () => (await ctx.client`select count(*)::int as n from journal_entries where source_type = 'claim_recognition' and purpose = 'recognition'`)[0]!.n as number;
const journalCount = async () => (await ctx.client`select count(*)::int as n from journal_entries`)[0]!.n as number;
const unchanged = async (work: () => Promise<unknown>) => { const before = await financialHash(ctx.client); await work(); expect(await financialHash(ctx.client)).toBe(before); };

describe("AS-01 an approver bulk approves clean Assisted claims", () => {
  it("AS-01: two clean claims are each approved by the one approver, recognized, and carry one NO_HOLDS record that is not an approval", async () => {
    await setModes(ctx.db, ALL_ASSISTED);
    const one = await assistedClean("As one shop"); const two = await assistedClean("As two shop");
    const before = await journalCount();
    const response = await send([entry(one), entry(two)]);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await answer(response)).toEqual({ approved: [one.id, two.id], saved: [], skipped: [] });
    for (const claim of [one, two]) {
      expect(await statusOf(claim.id)).toBe("APPROVED");
      expect((await approvalsOf(claim.hash)).map(row => row.approverId)).toEqual(["tara"]);
      expect(await automatedOf(claim.hash)).toHaveLength(1);
    }
    expect(await journalCount()).toBeGreaterThan(before);
    expect(await recognitionEntries()).toBe(2);
    // Nothing was sent: no disbursement exists.
    expect((await ctx.client`select count(*)::int as n from disbursements`)[0]!.n).toBe(0);
  });
});

describe("AS-02 the claimant cannot bulk approve their own claim", () => {
  it("AS-02: a claimant session is refused with 403 and nothing changes", async () => {
    await setModes(ctx.db, ALL_ASSISTED);
    const claim = await assistedClean("As own shop");
    await unchanged(async () => { expect((await send([entry(claim)], { user: "maria" })).status).toBe(403); });
    expect(await approvalsOf(claim.hash)).toEqual([]);
  });
  it("AS-02: an approver who is the claim's own claimant is skipped as OWN_CLAIM and no approval is stored", async () => {
    await setModes(ctx.db, ALL_ASSISTED);
    const claim = await assistedClean("As own shop two");
    // A test-only role change in the throwaway database: the claimant of this claim now holds the approver role.
    await ctx.client`update users set role = 'APPROVER' where id = 'maria'`;
    const response = await send([entry(claim)], { user: "maria" });
    expect(response.status).toBe(200);
    expect(await answer(response)).toEqual({ approved: [], saved: [], skipped: [{ claimId: claim.id, reason: "OWN_CLAIM", text: BULK_SKIP_TEXT.OWN_CLAIM }] });
    expect(await approvalsOf(claim.hash)).toEqual([]);
    expect(await statusOf(claim.id)).toBe("AWAITING_APPROVAL");
  });
});

describe("AS-03 a stale claim version is refused", () => {
  it("AS-03: a version that is not the claim's newest is skipped as STALE_VERSION and stores nothing", async () => {
    await setModes(ctx.db, ALL_ASSISTED);
    const claim = await assistedClean("As stale shop");
    await unchanged(async () => {
      const body = await answer(await send([entry(claim, 2)]));
      expect(body.skipped).toEqual([{ claimId: claim.id, reason: "STALE_VERSION", text: BULK_SKIP_TEXT.STALE_VERSION }]);
      expect(body.approved).toEqual([]);
    });
    expect(await statusOf(claim.id)).toBe("AWAITING_APPROVAL");
  });
});

describe("AS-04 a held claim is skipped and the others in the request are approved", () => {
  it("AS-04: a rules hold is skipped with its reason, and the clean claims on both sides of it are approved", async () => {
    await setModes(ctx.db, ALL_ASSISTED);
    const first = await assistedClean("As first shop");
    const held = await clean("As held shop", { source: GIFT_CARD_SOURCE }); await runChecks(held.hash);
    const last = await assistedClean("As last shop");
    const body = await answer(await send([entry(first), entry(held), entry(last)]));
    expect(body.approved).toEqual([first.id, last.id]);
    expect(body.skipped).toEqual([{ claimId: held.id, reason: "HOLD_FOUND", text: BULK_SKIP_TEXT.HOLD_FOUND }]);
    expect(BULK_SKIP_TEXT.HOLD_FOUND).toContain("a hold was found after this page loaded");
    expect(await approvalsOf(held.hash)).toEqual([]);
    expect(await statusOf(held.id)).toBe("AWAITING_APPROVAL");
    expect(await statusOf(first.id)).toBe("APPROVED"); expect(await statusOf(last.id)).toBe("APPROVED");
  });
  it("AS-04: a claim whose checks have not run is skipped as NOT_CHECKED and stores no approval", async () => {
    await setModes(ctx.db, ALL_ASSISTED);
    const unchecked = await clean("As unchecked shop");
    const body = await answer(await send([entry(unchecked)]));
    expect(body.skipped).toEqual([{ claimId: unchecked.id, reason: "NOT_CHECKED", text: BULK_SKIP_TEXT.NOT_CHECKED }]);
    expect(await approvalsOf(unchecked.hash)).toEqual([]);
  });
});

describe("AS-05 a Manual claim in the list is refused", () => {
  it("AS-05: a claim frozen under Manual funds is skipped as NOT_ASSISTED even with clean stored runs, and the Assisted claim beside it is approved", async () => {
    const manual = await clean("As manual shop"); await runChecks(manual.hash);
    await setModes(ctx.db, ALL_ASSISTED);
    const assisted = await assistedClean("As assisted shop");
    const body = await answer(await send([entry(manual), entry(assisted)]));
    expect(body.skipped).toEqual([{ claimId: manual.id, reason: "NOT_ASSISTED", text: BULK_SKIP_TEXT.NOT_ASSISTED }]);
    expect(body.approved).toEqual([assisted.id]);
    expect(await approvalsOf(manual.hash)).toEqual([]);
    expect(await statusOf(manual.id)).toBe("AWAITING_APPROVAL");
  });
  it("AS-05: a split that includes one Manual fund is Manual, and a fund moved to Manual after freeze tightens the claim at once", async () => {
    await setModes(ctx.db, ALL_ASSISTED);
    const claim = await assistedClean("As tightened shop");
    await setMode(ctx.db, "fund_b", "MANUAL");
    const body = await answer(await send([entry(claim)]));
    expect(body.skipped.map(item => item.reason)).toEqual(["NOT_ASSISTED"]);
    expect(await approvalsOf(claim.hash)).toEqual([]);
  });
});

describe("AS-06 the size of one request", () => {
  it("AS-06: 26 claims are refused whole with 400 and nothing is read or written", async () => {
    await setModes(ctx.db, ALL_ASSISTED);
    const real = await assistedClean("As twenty six shop");
    const ids = [entry(real), ...Array.from({ length: 25 }, (_, index) => `R-nothing-${index}:1`)];
    expect(ids).toHaveLength(26);
    await unchanged(async () => { const response = await send(ids); expect(response.status).toBe(400); expect(await response.text()).toBe("At most 25 claims at a time"); });
    expect(await approvalsOf(real.hash)).toEqual([]);
  });
  it("AS-06: exactly 25 claims are accepted, and unknown ones are skipped as NOT_FOUND", async () => {
    await setModes(ctx.db, ALL_ASSISTED);
    const real = await assistedClean("As twenty five shop");
    const ids = [entry(real), ...Array.from({ length: 24 }, (_, index) => `R-nothing-${index}:1`)];
    const body = await answer(await send(ids));
    expect(body.approved).toEqual([real.id]);
    expect(body.skipped).toHaveLength(24);
    expect(new Set(body.skipped.map(item => item.reason))).toEqual(new Set(["NOT_FOUND"]));
  });
});

describe("AS-07 the flag comes first", () => {
  it("AS-07: with the flag off or not exactly true the route answers 404 before the method, origin, session, role, type and body are read", async () => {
    for (const env of [{}, { FUND_MODES_ENABLED: "false" }, { FUND_MODES_ENABLED: "TRUE" }, { FUND_MODES_ENABLED: " true" }]) {
      for (const init of [{ method: "GET" }, { origin: "http://evil.example" }, { user: null }, { user: "maria" }, { type: "application/json" }, { body: "x".repeat(BULK_BODY_LIMIT + 1) }, { method: "DELETE" }] as Init[]) {
        const response = await send(["R-nothing:1"], init, env);
        expect(response.status, JSON.stringify([env, init])).toBe(404);
        expect(await response.text()).toBe("Not found");
      }
    }
  });
});

describe("AS-08 the method, origin, session and role", () => {
  it("AS-08: a wrong method is 405, a foreign or missing origin is 403, no session or a bad cookie is 401 and a claimant is 403, in that order", async () => {
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      const response = await send(["R-nothing:1"], { method }); expect(response.status, method).toBe(405); expect(response.headers.get("allow")).toBe("POST");
    }
    expect((await send(["R-nothing:1"], { origin: "http://evil.example" })).status).toBe(403);
    expect((await send(["R-nothing:1"], { origin: null })).status).toBe(403);
    expect((await send(["R-nothing:1"], { user: null })).status).toBe(401);
    expect((await send(["R-nothing:1"], { user: null, cookie: `${SESSION_COOKIE}=${"0".repeat(64)}` })).status).toBe(401);
    expect((await send(["R-nothing:1"], { user: "maria" })).status).toBe(403);
    // The origin is checked before the session, and the method before the origin.
    expect((await send(["R-nothing:1"], { user: null, origin: "http://evil.example" })).status).toBe(403);
    expect((await send(["R-nothing:1"], { method: "GET", origin: "http://evil.example" })).status).toBe(405);
  });
});

describe("AS-09 the body", () => {
  it("AS-09: a body that is not a form is 415, and a declared or streamed oversized body is 413 or 400", async () => {
    expect((await send(["R-nothing:1"], { type: "application/json", body: JSON.stringify({ claim: ["R-nothing:1"] }) })).status).toBe(415);
    expect((await send(["R-nothing:1"], { type: null })).status).toBe(415);
    expect((await send(["R-nothing:1"], { type: "multipart/form-data; boundary=x" })).status).toBe(415);
    expect((await send(["R-nothing:1"], { length: String(BULK_BODY_LIMIT + 1) })).status).toBe(413);
    expect((await send(["R-nothing:1"], { length: "not-a-number" })).status).toBe(400);
    expect((await handleBulkApprove(await build({ body: `claim=${"a".repeat(BULK_BODY_LIMIT + 10)}` }), { db: ctx.db, env: FLAG_ON })).status).toBe(413);
    expect((await handleBulkApprove(await build({ body: null }), { db: ctx.db, env: FLAG_ON })).status).toBe(400);
    expect((await handleBulkApprove(await build({ body: "claim=%FF%FE" }), { db: ctx.db, env: FLAG_ON })).status).toBe(400);
    // A form type with a charset parameter is still a form.
    expect((await handleBulkApprove(await build({ type: `${FORM}; charset=utf-8`, body: form({ claim: "R-nothing:1" }) }), { db: ctx.db, env: FLAG_ON })).status).toBe(200);
  });
});

describe("AS-10 exact fields", () => {
  it("AS-10: any field but claim is refused, as are an empty list, a malformed entry and a repeated claim, and nothing is stored", async () => {
    await setModes(ctx.db, ALL_ASSISTED);
    const claim = await assistedClean("As fields shop");
    const bad: string[] = [
      form({ claim: entry(claim), extra: "1" }), form({ claim: entry(claim), action: "approve" }), form({ claim: entry(claim), mode: "ASSISTED" }), form({ extra: "1" }), "", "claim=",
      form({ claim: claim.id }), form({ claim: `${claim.id}:0` }), form({ claim: `${claim.id}:1.5` }), form({ claim: `${claim.id}:-1` }), form({ claim: `${claim.id}:1234567` }), form({ claim: `../${claim.id}:1` }),
      form({ claim: [entry(claim), entry(claim)] }), form({ claim: [entry(claim), `${claim.id}:2`] }), form({ claim: `${claim.id}:1 ` }),
    ];
    await unchanged(async () => { for (const body of bad) { const response = await handleBulkApprove(await build({ body }), { db: ctx.db, env: FLAG_ON }); expect(response.status, body).toBe(400); } });
    expect(await approvalsOf(claim.hash)).toEqual([]);
  });
});

describe("AS-11 a hash in the body is refused and no hash comes back", () => {
  it("AS-11: decisionHash and decisionId fields are refused (AQ-08), and a successful answer holds neither", async () => {
    await setModes(ctx.db, ALL_ASSISTED);
    const claim = await assistedClean("As hash shop");
    await unchanged(async () => {
      for (const field of ["decisionHash", "decisionId", "hash"]) expect((await handleBulkApprove(await build({ body: form({ claim: entry(claim), [field]: claim.hash }) }), { db: ctx.db, env: FLAG_ON })).status, field).toBe(400);
      expect((await handleBulkApprove(await build({ body: form({ claim: `${claim.id}:1`, decisionHash: "0".repeat(64) }) }), { db: ctx.db, env: FLAG_ON })).status).toBe(400);
    });
    const text = await (await send([entry(claim)])).text();
    expect(text).not.toContain(claim.hash); expect(text).not.toContain(claim.decisionId);
    expect(JSON.parse(text)).toEqual({ approved: [claim.id], saved: [], skipped: [] });
    expect(await statusOf(claim.id)).toBe("APPROVED");
  });
});

describe("AS-12 a hold that appears between page load and submit is skipped", () => {
  it("AS-12: the page reads No holds found, a hold is then stored for that hash, and the route skips the claim and approves the other", async () => {
    await setModes(ctx.db, ALL_ASSISTED);
    const claim = await assistedClean("As late hold shop"); const other = await assistedClean("As steady shop");
    const loaded = await loadAssistedChecks(ctx.db, "tara", [claim.id, other.id]);
    expect(loaded.get(claim.id)).toMatchObject({ claimVersion: 1, checks: "No holds found", selectable: true });
    // Test only: the insert guard refuses a result row after a run ended, so it is switched off in this throwaway database to store the later hold the way a later run state would read.
    const [rules] = await ctx.client`select id from policy_check_runs where decision_hash = ${claim.hash} and kind = 'RULES'`;
    await ctx.client`alter table policy_check_results disable trigger policy_result_insert_guard`;
    await ctx.client`insert into policy_check_results (run_id, sequence, entry, rule_id, severity, flag_text, inputs) values (${rules!.id}, 900, 'FLAG', 'P4', 'HOLD', 'A hold stored after the page loaded', '{}'::jsonb)`;
    await ctx.client`alter table policy_check_results enable trigger policy_result_insert_guard`;
    const body = await answer(await send([entry(claim), entry(other)]));
    expect(body.skipped).toEqual([{ claimId: claim.id, reason: "HOLD_FOUND", text: BULK_SKIP_TEXT.HOLD_FOUND }]);
    expect(body.approved).toEqual([other.id]);
    expect(await approvalsOf(claim.hash)).toEqual([]);
    expect(await statusOf(claim.id)).toBe("AWAITING_APPROVAL");
  });
});

describe("AS-13 two concurrent requests over the same claim", () => {
  it("AS-13: give one approval and one recognition, and the loser is skipped, never an error", async () => {
    await setModes(ctx.db, ALL_ASSISTED);
    const claim = await assistedClean("As race shop");
    const before = await recognitionEntries();
    const [a, b] = await Promise.all([send([entry(claim)]), send([entry(claim)])]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const bodies = [await answer(a), await answer(b)];
    expect(bodies.flatMap(item => item.approved)).toEqual([claim.id]);
    const skipped = bodies.flatMap(item => item.skipped);
    expect(skipped).toHaveLength(1);
    expect(["ALREADY_APPROVED", "NOT_WAITING"]).toContain(skipped[0]!.reason);
    expect(await approvalsOf(claim.hash)).toHaveLength(1);
    expect(await automatedOf(claim.hash)).toHaveLength(1);
    expect(await recognitionEntries()).toBe(before + 1);
    expect(await statusOf(claim.id)).toBe("APPROVED");
  });
});

describe("AS-14 the Checks column and selection are absent with the flag off and on Manual funds", () => {
  it("AS-14: the read answers nothing with the flag off or not exactly true, and nothing for a Manual claim with the flag on", async () => {
    const manual = await clean("As manual column shop"); await runChecks(manual.hash);
    for (const env of [{}, { FUND_MODES_ENABLED: "false" }, { FUND_MODES_ENABLED: "TRUE" }]) expect((await loadAssistedChecks(ctx.db, "tara", [manual.id], { env })).size, JSON.stringify(env)).toBe(0);
    expect((await loadAssistedChecks(ctx.db, "tara", [manual.id], { env: FLAG_ON })).size).toBe(0);
    await setModes(ctx.db, ALL_ASSISTED);
    const assisted = await assistedClean("As assisted column shop");
    // The flag off still answers nothing for a claim frozen as Assisted, and a claimant reads nothing.
    expect((await loadAssistedChecks(ctx.db, "tara", [assisted.id], { env: {} })).size).toBe(0);
    expect((await loadAssistedChecks(ctx.db, "maria", [assisted.id], { env: FLAG_ON })).size).toBe(0);
    const both = await loadAssistedChecks(ctx.db, "tara", [manual.id, assisted.id], { env: FLAG_ON });
    expect([...both.keys()]).toEqual([assisted.id]);
  });
});

describe("AS-15 the three Checks words", () => {
  it("AS-15: No holds found, a count of holds and Not checked yet, each from the stored runs, and only a clean claim the approver may approve is selectable", async () => {
    await setModes(ctx.db, ALL_ASSISTED);
    const cleanOne = await assistedClean("As words clean shop");
    const held = await clean("As words held shop", { source: GIFT_CARD_SOURCE }); await runChecks(held.hash);
    const unchecked = await clean("As words unchecked shop");
    const [rulesRun] = await ctx.client`select id from policy_check_runs where decision_hash = ${held.hash} and kind = 'RULES'`;
    const [flags] = await ctx.client`select count(*)::int as n from policy_check_results where run_id = ${rulesRun!.id} and (entry = 'NOT_CHECKED' or (entry = 'FLAG' and severity = 'HOLD'))`;
    expect(flags!.n).toBeGreaterThan(0);
    const read = await loadAssistedChecks(ctx.db, "tara", [cleanOne.id, held.id, unchecked.id], { env: FLAG_ON });
    expect(read.get(cleanOne.id)).toEqual({ claimVersion: 1, checks: "No holds found", selectable: true, approvals: "Approvals: 0 of 1" });
    expect(read.get(held.id)).toEqual({ claimVersion: 1, checks: holdsLabel(flags!.n), selectable: false, approvals: null });
    expect(read.get(unchecked.id)).toEqual({ claimVersion: 1, checks: "Not checked yet", selectable: false, approvals: null });
    expect(holdsLabel(1)).toBe("1 hold"); expect(holdsLabel(2)).toBe("2 holds");
  });
  it("AS-15: a clean claim another approver already approved is still selectable and keeps its approvals words, and one this approver approved is not selectable", async () => {
    await setModes(ctx.db, ALL_ASSISTED);
    const claim = await assistedClean("As other approver shop");
    // With clean runs one approval recognizes, so an unrecognized claim with one approval is planted by tightening a fund, approving once and loosening it again.
    await setMode(ctx.db, "fund_b", "MANUAL");
    await approveDecision(ctx.db, claim.decisionId, "ben", claim.hash);
    await setMode(ctx.db, "fund_b", "ASSISTED");
    expect(await statusOf(claim.id)).toBe("AWAITING_APPROVAL");
    expect((await loadAssistedChecks(ctx.db, "tara", [claim.id], { env: FLAG_ON })).get(claim.id)).toEqual({ claimVersion: 1, checks: "No holds found", selectable: true, approvals: null });
    expect((await loadAssistedChecks(ctx.db, "ben", [claim.id], { env: FLAG_ON })).get(claim.id)).toMatchObject({ checks: "No holds found", selectable: false });
  });
});

describe("AS-16 the claim page line in all three states", () => {
  it("AS-16: Manual and flag off read n of 2, an Assisted claim with no holds reads Assisted with no holds found, and one with a hold reads n of 2", async () => {
    const manual = await clean("As line manual shop"); await runChecks(manual.hash);
    expect((await loadClaimView(ctx.db, manual.id, "tara")).reviewMode).toBe("MANUAL");
    await setModes(ctx.db, ALL_ASSISTED);
    const cleanOne = await assistedClean("As line clean shop");
    const held = await clean("As line held shop", { source: GIFT_CARD_SOURCE }); await runChecks(held.hash);
    const unchecked = await clean("As line unchecked shop");
    expect((await loadClaimView(ctx.db, cleanOne.id, "tara")).reviewMode).toBe("ASSISTED_NO_HOLDS");
    expect((await loadClaimView(ctx.db, held.id, "tara")).reviewMode).toBe("ASSISTED_HOLD");
    expect((await loadClaimView(ctx.db, unchecked.id, "tara")).reviewMode).toBe("ASSISTED_HOLD");
    // The claimant reads a waiting claim as the line always was, because live hold facts are for approvers.
    expect((await loadClaimView(ctx.db, cleanOne.id, "maria")).reviewMode).toBe("MANUAL");
    // The flag off reads Manual for every claim.
    vi.stubEnv("FUND_MODES_ENABLED", "false");
    expect((await loadClaimView(ctx.db, cleanOne.id, "tara")).reviewMode).toBe("MANUAL");
  });
  it("AS-16: a recognized Assisted claim keeps its line for everyone, and a Manual claim recognized by two approvals stays n of 2", async () => {
    await setModes(ctx.db, ALL_ASSISTED);
    const claim = await assistedClean("As line recognized shop");
    await send([entry(claim)]);
    expect(await statusOf(claim.id)).toBe("APPROVED");
    for (const viewer of ["tara", "ben", "maria"]) expect((await loadClaimView(ctx.db, claim.id, viewer)).reviewMode, viewer).toBe("ASSISTED_NO_HOLDS");
    expect((await loadClaimView(ctx.db, claim.id, "tara")).approvals).toHaveLength(1);
    vi.stubEnv("FUND_MODES_ENABLED", "false");
    expect((await loadClaimView(ctx.db, claim.id, "tara")).reviewMode).toBe("MANUAL");
  });
});

describe("AS-17 a hold keeps its two approvals through the ordinary path", () => {
  it("AS-17: after a skipped bulk request the held claim still needs two approvals one at a time and the second recognizes it", async () => {
    await setModes(ctx.db, ALL_ASSISTED);
    const held = await clean("As two approvals shop", { source: GIFT_CARD_SOURCE }); await runChecks(held.hash);
    await send([entry(held)]);
    expect(await approveDecision(ctx.db, held.decisionId, "tara", held.hash)).toMatchObject({ status: "AWAITING_APPROVAL", approvalCount: 1 });
    expect(await approveDecision(ctx.db, held.decisionId, "ben", held.hash)).toMatchObject({ status: "APPROVED", approvalCount: 2 });
    expect(await automatedOf(held.hash)).toEqual([]);
  });
});

describe("AS-18 the answer never carries request text or an error", () => {
  it("AS-18: every sentence comes from the fixed table, and a ledger refusal is read by meaning only", async () => {
    await setModes(ctx.db, ALL_ASSISTED);
    const claim = await assistedClean("As sentences shop");
    const first = await answer(await send([entry(claim)]));
    expect(first.approved).toEqual([claim.id]);
    // The same claim again: already recognized, so it is skipped with a table sentence, and no database or ledger text comes back.
    const again = await send([entry(claim)]);
    const text = await again.text();
    expect(JSON.parse(text).skipped).toEqual([{ claimId: claim.id, reason: "NOT_WAITING", text: BULK_SKIP_TEXT.NOT_WAITING }]);
    expect(text).not.toMatch(/Error|error|postgres|violates|constraint|stack|SELECT|select |cannot approve twice/);
    for (const sentence of Object.values(BULK_SKIP_TEXT)) expect(sentence).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("AS-19 no send and no ledger side effects beyond the approval", () => {
  it("AS-19: a bulk request writes no disbursement, attempt or retry row, and a skipped claim writes no journal entry", async () => {
    await setModes(ctx.db, ALL_ASSISTED);
    const held = await clean("As no send shop", { source: GIFT_CARD_SOURCE }); await runChecks(held.hash);
    await unchanged(async () => { await send([entry(held)]); });
    const good = await assistedClean("As no send good shop");
    await send([entry(good)]);
    for (const table of ["disbursements", "disbursement_attempts", "retry_authorizations", "provider_events"]) expect((await ctx.client`select count(*)::int as n from ${ctx.client(table)}`)[0]!.n, table).toBe(0);
  });
});
