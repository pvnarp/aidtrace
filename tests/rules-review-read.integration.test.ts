import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "../db/schema";
import { approveDraft, createDraft, DRAFT_LIST_LIMIT, editDraft, readDraftReview, readFundRules, withdrawDraft, type DraftServiceDeps } from "../src/rules-draft/drafts";
import { stubClient } from "./support/claude-stub";
import { createPolicyDatabase, tableHash, type PolicyDatabase } from "./support/policy-db";
import { AGREEMENT, RULE_ENV, draftMessage, goodAnswer, unsureList } from "./support/rules-draft";

// IAC-440 Package B, DR-118: the two read-only loaders behind the review screen and the fund rules page. Real Postgres, a stubbed model.
// Both run in a read-only transaction, refuse a claimant and a signed-out caller, and read another organization's fund or draft as not found.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
let ctx: PolicyDatabase;
const open: PolicyDatabase[] = [];
beforeEach(async () => { ctx = await createPolicyDatabase("aidtrace_rread"); open.push(ctx); }, 60_000);
afterEach(async () => { while (open.length) await open.pop()!.close(); }, 60_000);

const TARA = { id: "tara" }, BEN = { id: "ben" }, MARIA = { id: "maria" }, OLGA = { id: "olga" };
const FUND = "fund_a";
const deps = (answer: unknown = goodAnswer()): DraftServiceDeps => ({ env: RULE_ENV, client: stubClient(() => draftMessage(answer)).client });
async function drafted(answer: unknown = goodAnswer(), actor = TARA): Promise<string> {
  const result = await createDraft(ctx.db, actor, FUND, AGREEMENT, deps(answer));
  if (result.status !== "DRAFTED") throw new Error(`Expected a drafted rule set, got ${JSON.stringify(result)}`);
  return result.draftId;
}
async function addOtherOrganization() {
  await ctx.db.insert(s.organizations).values({ id: "other-org", name: "Other Org", prohibitedCategories: [], openingSourceType: "fixture_opening_balance" });
  await ctx.db.insert(s.users).values({ id: "olga", organizationId: "other-org", username: "olga", displayName: "Olga", role: "APPROVER", passwordHash: "not-a-real-hash", isFixture: false });
}
const nameOf = async (id: string) => String((await ctx.client`select display_name from users where id = ${id}`)[0]!.display_name);
const TABLES = ["policy_drafts", "policy_draft_events", "funds", "fund_policy_versions", "fund_budget_lines", "fund_check_settings", "fund_policy_clauses", "sessions", "users"];
const hashes = async () => Object.fromEntries(await Promise.all(TABLES.map(async table => [table, await tableHash(ctx.client, table)])));

describe("DR-118 the review and rules page loaders are read only, gated, and complete", () => {
  it("reads one draft with the current rules, the catalogs and the names of the drafter and each approver, in approval order", async () => {
    const id = await drafted();
    const first = await readDraftReview(ctx.db, TARA, id);
    expect(first.status).toBe("OK");
    if (first.status !== "OK") return;
    expect(first.review.view.state).toBe("OPEN");
    expect(first.review.approvers).toEqual([]);
    expect(first.review.draftedByName).toBe(await nameOf("tara"));
    expect(first.review.current.version).toBe(1);
    expect(first.review.current.clauses.length).toBeGreaterThan(0);
    expect(first.review.catalogs.categories.length).toBeGreaterThan(0);
    expect(first.review.catalogs.categories).not.toContain("alcohol");
    expect(first.review.view.analysis?.changesPayOrder === null || typeof first.review.view.analysis?.changesPayOrder === "boolean").toBe(true);

    expect((await approveDraft(ctx.db, TARA, id)).status).toBe("APPROVED");
    const one = await readDraftReview(ctx.db, BEN, id);
    expect(one.status === "OK" && one.review.approvers.map(approver => [approver.actorId, approver.displayName])).toEqual([["tara", await nameOf("tara")]]);
    expect(one.status === "OK" && one.review.approvers[0]!.recordedAt).toBeInstanceOf(Date);
  });

  it("gives a bound draft its version, and a stale one the new current version", async () => {
    const bound = await drafted();
    const other = await drafted();
    await approveDraft(ctx.db, TARA, bound);
    const result = await approveDraft(ctx.db, BEN, bound);
    expect(result.status).toBe("BOUND");
    const read = await readDraftReview(ctx.db, TARA, bound);
    expect(read.status === "OK" && [read.review.view.state, read.review.view.boundPolicyVersion, read.review.current.version]).toEqual(["BOUND", 2, 2]);
    expect(read.status === "OK" && read.review.approvers.map(approver => approver.actorId).sort()).toEqual(["ben", "tara"]);
    const stale = await readDraftReview(ctx.db, TARA, other);
    expect(stale.status === "OK" && [stale.review.view.state, stale.review.view.basePolicyVersion, stale.review.current.version]).toEqual(["STALE", 1, 2]);
  });

  it("lists the fund's drafts newest first with each state, and at most twenty", async () => {
    const open1 = await drafted();
    const refusedAnswer = goodAnswer(); refusedAnswer.clauses[0].text = "A sentence that is not in the grant at all.";
    const refused = await createDraft(ctx.db, TARA, FUND, AGREEMENT, deps(refusedAnswer));
    expect(refused.status).toBe("DRAFT_REFUSED");
    const withdrawn = await drafted();
    expect((await withdrawDraft(ctx.db, BEN, withdrawn)).status).toBe("WITHDRAWN");
    const edited = await editDraft(ctx.db, TARA, open1, { summary: "A person wrote this summary." });
    expect(edited.status).toBe("EDITED");
    const read = await readFundRules(ctx.db, TARA, FUND);
    expect(read.status).toBe("OK");
    if (read.status !== "OK") return;
    expect(read.view.drafts.map(item => item.state)).toEqual(["OPEN", "WITHDRAWN", "REFUSED", "OPEN"]);
    expect(read.view.drafts[0]!.parentDraftId).toBe(open1);
    expect(read.view.drafts[0]!.changedFields).toEqual(["summary"]);
    expect(read.view.drafts[2]!.refusalReason).not.toBeNull();
    const tara = await nameOf("tara");
    expect(read.view.drafts.every(item => item.createdByName === tara)).toBe(true);
    expect(read.view.drafts[3]!.approvals).toBe(0);
    for (let index = 0; index < DRAFT_LIST_LIMIT; index++) await drafted();
    const many = await readFundRules(ctx.db, TARA, FUND);
    expect(many.status === "OK" && many.view.drafts).toHaveLength(DRAFT_LIST_LIMIT);
    expect(many.status === "OK" && many.view.drafts.map(item => item.createdAt.getTime())).toEqual(many.status === "OK" ? [...many.view.drafts.map(item => item.createdAt.getTime())].sort((a, b) => b - a) : []);
    expect(many.status === "OK" && many.view.drafts.some(item => item.id === open1)).toBe(false);
  });

  it("reads the current approved rules with caps as integer-cent strings, numeric clause order, and no check settings when the fund has none", async () => {
    const read = await readFundRules(ctx.db, TARA, FUND);
    expect(read.status).toBe("OK");
    if (read.status !== "OK") return;
    expect(read.view.fundId).toBe(FUND);
    expect(read.view.fundClass).toBe("RESTRICTED");
    expect(read.view.arm.model).toMatch(/^claude-/);
    expect(read.view.current.version).toBe(1);
    for (const value of Object.values(read.view.current.caps)) expect(value).toMatch(/^\d+$/);
    const ids = read.view.current.clauses.map(clause => clause.id);
    const numeric = [...ids].sort((a, b) => { const [aw = 0, af = 0] = a.split(".").map(Number), [bw = 0, bf = 0] = b.split(".").map(Number); return aw - bw || af - bf; });
    expect(ids).toEqual(numeric);
    expect(read.view.catalogs.programs.length).toBeGreaterThan(0);
  });

  it("reads an unrestricted fund's page data too, so the page can say it has no grant to draft from", async () => {
    const read = await readFundRules(ctx.db, TARA, "fund_g");
    expect(read.status === "OK" && read.view.fundClass).toBe("UNRESTRICTED");
  });

  it("refuses a claimant and a caller with no user before reading anything, and reads another organization's fund and draft as not found", async () => {
    await addOtherOrganization();
    const id = await drafted();
    for (const actor of [MARIA, { id: "" }, { id: "no_such_user" }]) {
      const fund = await readFundRules(ctx.db, actor, FUND);
      const review = await readDraftReview(ctx.db, actor, id);
      expect(fund.status, actor.id).toBe("REFUSED");
      expect(review.status, actor.id).toBe("REFUSED");
      expect(JSON.stringify([fund, review]), actor.id).not.toContain("Cedar Hollow");
    }
    expect(await readFundRules(ctx.db, MARIA, FUND)).toEqual({ status: "REFUSED", reason: "APPROVER_REQUIRED" });
    expect(await readFundRules(ctx.db, OLGA, FUND)).toEqual({ status: "REFUSED", reason: "NOT_FOUND" });
    expect(await readDraftReview(ctx.db, OLGA, id)).toEqual({ status: "REFUSED", reason: "NOT_FOUND" });
    expect(await readFundRules(ctx.db, TARA, "no_such_fund")).toEqual({ status: "REFUSED", reason: "NOT_FOUND" });
    expect(await readDraftReview(ctx.db, TARA, "00000000-0000-4000-8000-000000000000")).toEqual({ status: "REFUSED", reason: "NOT_FOUND" });
  });

  it("writes nothing: every table the screens read is byte for byte the same after the reads", async () => {
    const id = await drafted();
    await approveDraft(ctx.db, TARA, id);
    const before = await hashes();
    for (let round = 0; round < 3; round++) {
      await readFundRules(ctx.db, TARA, FUND);
      await readDraftReview(ctx.db, BEN, id);
      await readFundRules(ctx.db, MARIA, FUND);
      await readDraftReview(ctx.db, MARIA, id);
    }
    expect(await hashes()).toEqual(before);
  });

  it("a draft with an UNSURE field reads as incomplete and names the field, with the stored value null", async () => {
    const answer = goodAnswer(); answer.programs = unsureList();
    const read = await readDraftReview(ctx.db, TARA, await drafted(answer));
    expect(read.status === "OK" && read.review.view.analysis?.missing).toContain("programs");
    expect(read.status === "OK" && read.review.view.draft?.programs.value).toBeNull();
  });
});
