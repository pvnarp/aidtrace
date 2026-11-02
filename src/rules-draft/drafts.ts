// IAC-440 Package A (docs/plans/AI_DRAFTED_RULES_SCOPE.md sections 3 to 5; docs/ASSUMPTIONS.md section 70). The AI-drafted fund rules service.
// The model drafts text and values; people approve; only the second distinct approval binds. Nothing here lets a model write a binding row:
// createDraft stores a validated draft (or a refusal) and nothing else, and every path that writes fund_policy_versions, fund_budget_lines,
// fund_check_settings, fund_policy_clauses or funds goes through bind(), which runs inside approveDraft's single transaction after a human
// approval event. It never writes a claim, an approval of a claim, a reservation, a journal entry or anything of PayPal itself. The one ledger call is
// the existing solver priority revision (advanceSolverPriorityInTransaction), made inside bind() when the bind changes the pay order (finding A).
//
// Every entry point first requires an APPROVER of the fund's organization. A claimant, an approver of another organization and a missing
// user are refused before anything is read or sent. Approvals belong to one immutable draft row, so a human edit is a new row that needs its
// own two approvals. Status is derived from policy_draft_events, never stored. No database guard is weakened: the bind writes through the
// guards of each table (approver of the fund organization, check settings in order, clauses of an existing version) and migration 0018 adds
// guards of its own, including a stale-version guard and a distinct-approver backstop.
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import { SELECTABLE, type BudgetLine } from "../ai/categories";
import type { AiOffReason } from "../ai/provider";
import { priorityCostsFor } from "../domain/model";
import { advanceSolverPriorityInTransaction, serializable } from "../ledger/service";
import type { AppDatabase } from "../server/db";
import { DRAFT_DEFAULT_ARM, choosableCategories, requestDraft, type DraftArm, type DraftRequestDeps } from "./draft-request";
import {
  BUDGET_LINES, PROGRAM_ID, THRESHOLD_KEYS, analyze, applyEdit, toPolicy, validInputText, validateDraft,
  type Analysis, type BindablePolicy, type DraftClause, type GrantInput, type RulesDraft, type ThresholdKey,
} from "./draft-validate";
import { sha256 } from "../policy/compliance";
import { sqlState } from "../policy/service";

type Tx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type DraftActor = { id: string };
// Refusals that name a rule of this service. Nothing carries database text.
export type DraftServiceRefusal =
  | "INVALID_REQUEST" | "APPROVER_REQUIRED" | "NOT_FOUND" | "FUND_NOT_RESTRICTED" | "STALE_BASE" | "NOT_DRAFTED" | "WITHDRAWN" | "BOUND"
  | "INCOMPLETE" | "THRESHOLDS_INCOMPLETE" | "SAME_APPROVER" | "DRAFT_INVALID" | "GUARD_REFUSED" | "MALFORMED_TEXT";
export type Refused = { status: "REFUSED"; reason: DraftServiceRefusal; missing?: string[]; detail?: string };
const refuse = (reason: DraftServiceRefusal, extra: Partial<Omit<Refused, "status" | "reason">> = {}): Refused => ({ status: "REFUSED", reason, ...extra });

// Test seams for the one model call. Production passes none.
export type DraftServiceDeps = DraftRequestDeps & { arm?: DraftArm };

export type CreateDraftResult =
  | Refused
  // No draft exists: AI is off or keyless, the request budget is spent, or the call timed out or failed. Nothing is stored.
  | { status: "UNAVAILABLE"; reason: AiOffReason | "TIMEOUT" | "ERROR" }
  | { status: "DRAFTED"; draftId: string; complete: boolean; missing: string[]; quoteUnsupported: string[] }
  // The model answered and the answer broke a rule. The refusal is stored as a REFUSED row and no value of it is ever shown as a draft.
  | { status: "DRAFT_REFUSED"; draftId: string; reason: string; path: string };
export type EditDraftResult =
  | Refused
  | { status: "EDITED"; draftId: string; changedFields: string[]; complete: boolean; missing: string[]; quoteUnsupported: string[] }
  // The edit broke a rule. Nothing is stored: the approver fixes the field and tries again.
  | { status: "INVALID_EDIT"; reason: string; path: string };
// priorityVersion is the solver priority version the bind wrote because it changed the pay order, or null when the order did not change.
// invalidatedDecisions counts the frozen, not yet fully approved decisions of the organization that went back to draft with it (zero when null).
export type ApproveDraftResult = Refused | { status: "APPROVED"; approvals: 1 } | { status: "BOUND"; approvals: 2; policyVersion: number; priorityVersion: number | null; invalidatedDecisions: number };
export type WithdrawDraftResult = Refused | { status: "WITHDRAWN" };

// The transaction lock of the ledger: the same key, taken the same way, so a bind and a receipt decision of one organization never interleave.
// It is the first statement of the transaction and is taken only for an approver, so a claimant or an unknown user waits behind nothing and holds nothing.
async function lockOrganization(tx: Tx, actorId: unknown): Promise<void> {
  if (typeof actorId !== "string" || actorId.length < 1 || actorId.length > 100) return;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${s.users.organizationId})::bigint) from ${s.users} where ${s.users.id} = ${actorId} and ${s.users.role} = 'APPROVER'`);
}

type Context = { actorOrganizationId: string; fund: typeof s.funds.$inferSelect; organization: typeof s.organizations.$inferSelect };
type Gate = { ok: true; context: Context } | { ok: false; refusal: Refused };

// The actor must be an approver. A fund outside the actor's organization reads as not found, so one organization cannot probe another's fund ids.
async function gate(tx: Tx, actorId: unknown, fundId: string, options: { lock?: boolean } = {}): Promise<Gate> {
  if (typeof actorId !== "string" || actorId.length < 1 || actorId.length > 100) return { ok: false, refusal: refuse("APPROVER_REQUIRED") };
  const [actor] = await tx.select({ role: s.users.role, organizationId: s.users.organizationId }).from(s.users).where(eq(s.users.id, actorId));
  if (!actor || actor.role !== "APPROVER") return { ok: false, refusal: refuse("APPROVER_REQUIRED") };
  const query = tx.select().from(s.funds).where(and(eq(s.funds.id, fundId), eq(s.funds.organizationId, actor.organizationId)));
  const [fund] = options.lock ? await query.for("update") : await query;
  if (!fund) return { ok: false, refusal: refuse("NOT_FOUND") };
  const [organization] = await tx.select().from(s.organizations).where(eq(s.organizations.id, actor.organizationId));
  if (!organization) return { ok: false, refusal: refuse("NOT_FOUND") };
  return { ok: true, context: { actorOrganizationId: actor.organizationId, fund, organization } };
}

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
// The catalogs the model is shown and the validator checks against: every selectable category, the organization's prohibited list, and the
// program ids the organization's funds already use in any policy version. There is no program table, so that union is the only catalog (assumption).
async function grantInput(tx: Tx, context: Context, text: string): Promise<GrantInput> {
  const rows = await tx.select({ programs: s.fundPolicyVersions.programs }).from(s.fundPolicyVersions).innerJoin(s.funds, eq(s.funds.id, s.fundPolicyVersions.fundId))
    .where(eq(s.funds.organizationId, context.actorOrganizationId));
  const programs = [...new Set(rows.flatMap(row => stringList(row.programs)).filter(program => PROGRAM_ID.test(program)))].sort();
  return { text, categories: [...SELECTABLE], programs, prohibited: stringList(context.organization.prohibitedCategories) };
}

// Reads the draft and its fund in the actor's organization. The fund row is locked when the caller writes events, so approvals, edits and
// withdrawals of one fund are serialized and the stale check below cannot race a bind.
async function loadDraft(tx: Tx, actorId: unknown, draftId: unknown, options: { lock?: boolean } = {}) {
  if (typeof draftId !== "string" || !UUID.test(draftId)) return { ok: false as const, refusal: refuse("INVALID_REQUEST") };
  const [probe] = await tx.select({ fundId: s.policyDrafts.fundId }).from(s.policyDrafts).where(eq(s.policyDrafts.id, draftId));
  if (!probe) {
    // Authorization comes first even for a missing draft, so a claimant learns nothing about draft ids.
    const denied = await gate(tx, actorId, "", options);
    return { ok: false as const, refusal: denied.ok ? refuse("NOT_FOUND") : denied.refusal };
  }
  const granted = await gate(tx, actorId, probe.fundId, options);
  if (!granted.ok) return { ok: false as const, refusal: granted.refusal };
  const [draft] = await tx.select().from(s.policyDrafts).where(eq(s.policyDrafts.id, draftId));
  const events = await tx.select().from(s.policyDraftEvents).where(eq(s.policyDraftEvents.draftId, draftId)).orderBy(asc(s.policyDraftEvents.recordedAt), asc(s.policyDraftEvents.id));
  return { ok: true as const, context: granted.context, draft: draft!, events };
}

type Resolution = { settings: { version: number; values: Record<ThresholdKey, bigint | number> } | null };
// Thresholds are optional. When the draft sets none, no settings version is written. When it sets any, all six must resolve, each from the draft or
// from the fund's latest settings version, because the settings table has no null columns. Otherwise the draft cannot bind: a person completes it.
async function resolveThresholds(tx: Tx, fundId: string, draft: RulesDraft): Promise<Resolution | null> {
  if (!THRESHOLD_KEYS.some(key => draft.thresholds[key].value !== null)) return { settings: null };
  const [previous] = await tx.select().from(s.fundCheckSettings).where(eq(s.fundCheckSettings.fundId, fundId)).orderBy(desc(s.fundCheckSettings.version)).limit(1);
  const values = {} as Record<ThresholdKey, bigint | number>;
  for (const key of THRESHOLD_KEYS) {
    const drafted = draft.thresholds[key].value;
    const carried = previous ? previous[key] : null;
    if (drafted !== null) values[key] = key.endsWith("Cents") ? BigInt(drafted) : drafted;
    else if (carried !== null && carried !== undefined) values[key] = carried;
    else return null;
  }
  return { settings: { version: (previous?.version ?? 0) + 1, values } };
}

// The pay order: the existing v1 formula (priorityCostsFor, 1000 * breadth + position by fund id for a restricted fund) over the organization's funds at
// their current approved versions, compared with the latest stored solver priority exactly as the receipt path does (same key count, same per-fund
// string). `projected` swaps one fund's breadth for the breadth a draft would bind, to answer before the bind. Nothing here writes. An organization with
// no stored priority has no receipt path to break, so it reports no difference.
type PayOrder = { latestVersion: number | null; differs: boolean };
async function payOrderOf(tx: Tx, organizationId: string, projected?: { fundId: string; breadth: number }): Promise<PayOrder> {
  const [latest] = await tx.select().from(s.solverPriorityVersions).where(eq(s.solverPriorityVersions.organizationId, organizationId)).orderBy(desc(s.solverPriorityVersions.version)).limit(1);
  if (!latest) return { latestVersion: null, differs: false };
  const funds = await tx.select().from(s.funds).where(eq(s.funds.organizationId, organizationId));
  if (!funds.length) return { latestVersion: latest.version, differs: Object.keys(latest.costsPerCent).length !== 0 };
  const policies = await tx.select({ fundId: s.fundPolicyVersions.fundId, version: s.fundPolicyVersions.version, breadth: s.fundPolicyVersions.breadth })
    .from(s.fundPolicyVersions).where(inArray(s.fundPolicyVersions.fundId, funds.map(fund => fund.id)));
  const costs = priorityCostsFor(funds.map(fund => {
    const breadth = projected?.fundId === fund.id ? projected.breadth : policies.find(policy => policy.fundId === fund.id && policy.version === fund.currentPolicyVersion)?.breadth ?? null;
    if (fund.fundClass === "RESTRICTED" && !breadth) throw new Error("Current approved policy required to compare the pay order");
    return { id: fund.id, fundClass: fund.fundClass, policy: { breadth } };
  }));
  const stored = latest.costsPerCent;
  return { latestVersion: latest.version, differs: Object.keys(stored).length !== costs.size || [...costs].some(([fundId, cost]) => stored[fundId] !== cost.toString()) };
}

// changesPayOrder is the early warning: true when binding this open draft would change the pay order, which sends frozen decisions back to draft. Null when it is
// not known (a draft that is not open, or one whose categories are UNSURE). It is shown before the second approval and never blocks one.
export type DraftAnalysis = Analysis & { changesPayOrder: boolean | null };
const viewAnalysis = (draft: RulesDraft | null, changesPayOrder: boolean | null): DraftAnalysis | null => (draft ? { ...analyze(draft), changesPayOrder } : null);

// Paste, request, validate, store. One hosted AI request per draft, none when AI is unavailable. A refused answer is stored with its reason.
export async function createDraft(db: AppDatabase, actor: DraftActor, fundId: string, text: string, deps: DraftServiceDeps = {}): Promise<CreateDraftResult> {
  if (typeof fundId !== "string" || fundId.length < 1 || fundId.length > 100 || !validInputText(text)) {
    // Authorization still comes first, so the refusal does not tell a claimant whether the input was acceptable.
    const denied = await db.transaction(tx => gate(tx, actor?.id, "no-such-fund"));
    if (!denied.ok && denied.refusal.reason === "APPROVER_REQUIRED") return denied.refusal;
    // Text with a lone surrogate is named, so an approver knows to re-copy it. Blank, NUL and oversize text stay INVALID_REQUEST. Nothing was sent to the model.
    return refuse(typeof text === "string" && !text.isWellFormed() ? "MALFORMED_TEXT" : "INVALID_REQUEST");
  }
  const read = await db.transaction(async tx => {
    const granted = await gate(tx, actor?.id, fundId);
    if (!granted.ok) return granted;
    if (granted.context.fund.fundClass !== "RESTRICTED") return { ok: false as const, refusal: refuse("FUND_NOT_RESTRICTED") };
    return { ok: true as const, context: granted.context, input: await grantInput(tx, granted.context, text) };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
  if (!read.ok) return read.refusal;

  // The model call runs outside any transaction. The base version is the one read above: a draft whose base moves before it is stored is refused by the guard.
  const arm = deps.arm ?? DRAFT_DEFAULT_ARM;
  const answer = await requestDraft(read.input, arm, deps);
  if (answer.status === "UNAVAILABLE") return answer;

  const base = {
    fundId, basePolicyVersion: read.context.fund.currentPolicyVersion, inputSha256: sha256(text), inputText: text, draftedBy: actor.id,
    model: answer.meta.model, effort: answer.meta.effort, promptVersion: answer.meta.promptVersion, schemaVersion: answer.meta.schemaVersion,
    requestDigest: answer.meta.requestDigest, stopReason: answer.meta.stopReason, inputTokens: answer.meta.inputTokens, outputTokens: answer.meta.outputTokens,
  };
  let row: typeof s.policyDrafts.$inferInsert;
  let analysis: Analysis | null = null;
  if (answer.status === "REFUSED") row = { ...base, outcome: "REFUSED", refusalReason: answer.code, refusalPath: "response" };
  else {
    const checked = validateDraft(answer.raw, read.input, "MODEL");
    if (!checked.ok) row = { ...base, outcome: "REFUSED", refusalReason: checked.reason, refusalPath: checked.path.replace(/[^A-Za-z0-9_.]/g, "_").slice(0, 80) || "draft" };
    else { row = { ...base, outcome: "DRAFTED", draft: checked.draft }; analysis = checked.analysis; }
  }
  try {
    const [stored] = await db.insert(s.policyDrafts).values(row).returning({ id: s.policyDrafts.id });
    if (!stored) throw new Error("Draft was not stored");
    if (row.outcome === "REFUSED") return { status: "DRAFT_REFUSED", draftId: stored.id, reason: row.refusalReason!, path: row.refusalPath! };
    return { status: "DRAFTED", draftId: stored.id, complete: analysis!.complete, missing: analysis!.missing, quoteUnsupported: analysis!.quoteUnsupported };
  } catch (error) {
    if (sqlState(error) !== "23514") throw error;
    // A guard refused: the policy version moved while the request ran, or the actor lost the role. Say which, without database text.
    const [fund] = await db.select({ current: s.funds.currentPolicyVersion }).from(s.funds).where(eq(s.funds.id, fundId));
    return refuse(fund && fund.current !== base.basePolicyVersion ? "STALE_BASE" : "APPROVER_REQUIRED");
  }
}

// A human edit is a new row that names its parent and the fields a person changed. The whole document is revalidated, so an edit cannot skip a rule.
export async function editDraft(db: AppDatabase, actor: DraftActor, parentDraftId: string, fields: unknown): Promise<EditDraftResult> {
  const read = await db.transaction(async tx => {
    const loaded = await loadDraft(tx, actor?.id, parentDraftId);
    if (!loaded.ok) return loaded;
    const { draft, events } = loaded;
    if (draft.outcome !== "DRAFTED" || !draft.draft) return { ok: false as const, refusal: refuse("NOT_DRAFTED") };
    if (events.some(event => event.kind === "WITHDRAWN")) return { ok: false as const, refusal: refuse("WITHDRAWN") };
    if (events.some(event => event.kind === "BOUND")) return { ok: false as const, refusal: refuse("BOUND") };
    if (draft.basePolicyVersion !== loaded.context.fund.currentPolicyVersion) return { ok: false as const, refusal: refuse("STALE_BASE") };
    return { ok: true as const, context: loaded.context, draft, input: await grantInput(tx, loaded.context, draft.inputText) };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
  if (!read.ok) return read.refusal;

  const edited = applyEdit(read.draft.draft as RulesDraft, fields, read.input);
  if (!edited.ok) return { status: "INVALID_EDIT", reason: edited.reason, path: edited.path };
  try {
    const [stored] = await db.insert(s.policyDrafts).values({
      fundId: read.draft.fundId, basePolicyVersion: read.draft.basePolicyVersion, parentDraftId: read.draft.id, inputSha256: read.draft.inputSha256, inputText: read.draft.inputText,
      outcome: "DRAFTED", draft: edited.draft, changedFields: edited.changed, draftedBy: actor.id,
    }).returning({ id: s.policyDrafts.id });
    if (!stored) throw new Error("Edit was not stored");
    return { status: "EDITED", draftId: stored.id, changedFields: edited.changed, complete: edited.analysis.complete, missing: edited.analysis.missing, quoteUnsupported: edited.analysis.quoteUnsupported };
  } catch (error) {
    if (sqlState(error) !== "23514") throw error;
    return refuse("GUARD_REFUSED");
  }
}

// One approval of one draft row. The first records an event. The second, from a different approver, records its event and binds, in one transaction.
// The transaction is serializable with the organization advisory lock first, like the freeze, approve and payout paths of the ledger. Every refusal
// below returns before a write, so a serialization retry runs the same checks again and gives the same answer.
export async function approveDraft(db: AppDatabase, actor: DraftActor, draftId: string): Promise<ApproveDraftResult> {
  try {
    return await serializable(db, async tx => {
      await lockOrganization(tx, actor?.id);
      // The fund row stays locked after the authorization read, so two approvals of one fund also run one after the other.
      const loaded = await loadDraft(tx, actor?.id, draftId, { lock: true });
      if (!loaded.ok) return loaded.refusal;
      const { context, draft, events } = loaded;
      if (draft.outcome !== "DRAFTED" || !draft.draft) return refuse("NOT_DRAFTED");
      if (events.some(event => event.kind === "WITHDRAWN")) return refuse("WITHDRAWN");
      if (events.some(event => event.kind === "BOUND")) return refuse("BOUND");
      if (context.fund.currentPolicyVersion !== draft.basePolicyVersion) return refuse("STALE_BASE");

      // The stored draft is checked again against the catalogs as they are now: a prohibited list that grew since the draft was made refuses it here.
      const input = await grantInput(tx, context, draft.inputText);
      const checked = validateDraft(draft.draft, input, "EDIT");
      if (!checked.ok) return refuse("DRAFT_INVALID", { detail: checked.reason });
      if (!checked.analysis.complete) return refuse("INCOMPLETE", { missing: checked.analysis.missing });
      const policy = toPolicy(checked.draft);
      if (!policy) return refuse("INCOMPLETE", { missing: checked.analysis.missing });
      const thresholds = await resolveThresholds(tx, draft.fundId, checked.draft);
      if (!thresholds) return refuse("THRESHOLDS_INCOMPLETE");

      if (events.some(event => event.kind === "APPROVED" && event.actorId === actor.id)) return refuse("SAME_APPROVER");
      await tx.insert(s.policyDraftEvents).values({ draftId: draft.id, kind: "APPROVED", actorId: actor.id });
      const approvers = await tx.select({ actorId: s.policyDraftEvents.actorId }).from(s.policyDraftEvents).where(and(eq(s.policyDraftEvents.draftId, draft.id), eq(s.policyDraftEvents.kind, "APPROVED")));
      if (new Set(approvers.map(row => row.actorId)).size < 2) return { status: "APPROVED" as const, approvals: 1 as const };

      const bound = await bind(tx, actor.id, context.actorOrganizationId, draft, checked.draft, policy, thresholds);
      return { status: "BOUND" as const, approvals: 2 as const, ...bound };
    });
  } catch (error) {
    // A database guard refused inside the transaction, which has rolled back whole. The refusal carries no database text.
    if (sqlState(error) === "23514") return refuse("GUARD_REFUSED");
    throw error;
  }
}

// The whole bind. Runs only inside approveDraft's transaction, after the second distinct approval event and with the organization lock held. In order:
// the policy version, its budget lines, a check settings version when the draft sets thresholds, the clauses, the current-version pointer, then the
// pay order, then the BOUND event. A bind that changes a fund's breadth changes the order the funds pay in, and the receipt path refuses every receipt
// while the stored order differs from the formula. So when the recomputed order differs from the latest stored one, the existing ledger revision runs here,
// signed by the binding approver: it writes the next solver priority version and sends every frozen, not yet fully approved decision of the organization
// back to draft (Pavan's choice, November 1). Paid claims are untouched. No new formula is applied: it is the one src/domain/model.ts already defines.
// Any failure throws and the transaction rolls every row back, the priority row included.
type Bound = { policyVersion: number; priorityVersion: number | null; invalidatedDecisions: number };
async function bind(tx: Tx, actorId: string, organizationId: string, draft: typeof s.policyDrafts.$inferSelect, rules: RulesDraft, policy: BindablePolicy, thresholds: Resolution): Promise<Bound> {
  const version = draft.basePolicyVersion + 1;
  await tx.insert(s.fundPolicyVersions).values({
    fundId: draft.fundId, version, approvedBy: actorId, programs: policy.programs, allowedCategories: policy.allowedCategories,
    periodStart: policy.periodStart, periodEnd: policy.periodEnd, breadth: policy.breadth, summary: policy.summary,
  });
  if (policy.budgetLines.length) await tx.insert(s.fundBudgetLines).values(policy.budgetLines.map(line => ({ fundId: draft.fundId, policyVersion: version, budgetLine: line.budgetLine, capCents: line.capCents })));
  if (thresholds.settings) {
    const values = thresholds.settings.values;
    await tx.insert(s.fundCheckSettings).values({
      fundId: draft.fundId, version: thresholds.settings.version, approvedBy: actorId,
      suppliesLimitCents: BigInt(values.suppliesLimitCents), equipmentLimitCents: BigInt(values.equipmentLimitCents), claimLimitCents: BigInt(values.claimLimitCents),
      staleReceiptDays: Number(values.staleReceiptDays), duplicateWindowDays: Number(values.duplicateWindowDays), splitWindowDays: Number(values.splitWindowDays),
    });
  }
  await tx.insert(s.fundPolicyClauses).values(rules.clauses.map(clause => ({ fundId: draft.fundId, policyVersion: version, clauseId: clause.id, text: clause.text })));
  const moved = await tx.update(s.funds).set({ currentPolicyVersion: version }).where(and(eq(s.funds.id, draft.fundId), eq(s.funds.currentPolicyVersion, draft.basePolicyVersion))).returning({ id: s.funds.id });
  if (moved.length !== 1) throw new Error("The current policy version moved during the bind");
  const order = await payOrderOf(tx, organizationId);
  let priorityVersion: number | null = null, invalidatedDecisions = 0;
  if (order.differs) {
    const advanced = await advanceSolverPriorityInTransaction(tx, organizationId, actorId, order.latestVersion!);
    priorityVersion = advanced.version; invalidatedDecisions = advanced.invalidatedDecisions;
  }
  await tx.insert(s.policyDraftEvents).values({ draftId: draft.id, kind: "BOUND", actorId, boundPolicyVersion: version });
  return { policyVersion: version, priorityVersion, invalidatedDecisions };
}

// Any approver of the organization may withdraw an open draft, including one that has gone stale. A withdrawn draft takes no more approvals.
export async function withdrawDraft(db: AppDatabase, actor: DraftActor, draftId: string): Promise<WithdrawDraftResult> {
  try {
    return await serializable(db, async tx => {
      await lockOrganization(tx, actor?.id);
      const loaded = await loadDraft(tx, actor?.id, draftId, { lock: true });
      if (!loaded.ok) return loaded.refusal;
      if (loaded.draft.outcome !== "DRAFTED") return refuse("NOT_DRAFTED");
      if (loaded.events.some(event => event.kind === "WITHDRAWN")) return refuse("WITHDRAWN");
      if (loaded.events.some(event => event.kind === "BOUND")) return refuse("BOUND");
      await tx.insert(s.policyDraftEvents).values({ draftId: loaded.draft.id, kind: "WITHDRAWN", actorId: actor.id });
      return { status: "WITHDRAWN" as const };
    });
  } catch (error) {
    if (sqlState(error) === "23514") return refuse("GUARD_REFUSED");
    throw error;
  }
}

export type DraftState = "REFUSED" | "OPEN" | "STALE" | "WITHDRAWN" | "BOUND";
export type DraftView = {
  id: string; fundId: string; fundName: string; basePolicyVersion: number; currentPolicyVersion: number; parentDraftId: string | null;
  state: DraftState; outcome: "DRAFTED" | "REFUSED"; draft: RulesDraft | null; analysis: DraftAnalysis | null; refusal: { reason: string; path: string } | null;
  changedFields: string[] | null; inputText: string; inputSha256: string; draftedBy: string; createdAt: Date;
  model: { model: string; effort: string; promptVersion: string; schemaVersion: string; requestDigest: string; stopReason: string | null; inputTokens: number | null; outputTokens: number | null } | null;
  approvals: { actorId: string; recordedAt: Date }[]; boundPolicyVersion: number | null;
};
export type ReadDraftResult = Refused | { status: "OK"; view: DraftView };

// What a review screen needs, derived from the immutable rows. Approver only: the grant text and the drafted rules are not shown to a claimant.
export async function readDraft(db: AppDatabase, actor: DraftActor, draftId: string): Promise<ReadDraftResult> {
  return db.transaction(async tx => {
    const loaded = await loadDraft(tx, actor?.id, draftId);
    if (!loaded.ok) return loaded.refusal;
    const { context, draft, events } = loaded;
    const bound = events.find(event => event.kind === "BOUND");
    const state: DraftState = draft.outcome === "REFUSED" ? "REFUSED" : bound ? "BOUND" : events.some(event => event.kind === "WITHDRAWN") ? "WITHDRAWN"
      : draft.basePolicyVersion !== context.fund.currentPolicyVersion ? "STALE" : "OPEN";
    const rules = draft.draft as RulesDraft | null;
    let changesPayOrder: boolean | null = null;
    const categories = rules?.allowedCategories.value ?? null;
    if (state === "OPEN" && categories) {
      // Read only. A fund whose current policy cannot be compared leaves the flag unknown rather than failing the review screen.
      try { changesPayOrder = (await payOrderOf(tx, context.actorOrganizationId, { fundId: draft.fundId, breadth: categories.length })).differs; } catch { changesPayOrder = null; }
    }
    return {
      status: "OK" as const,
      view: {
        id: draft.id, fundId: draft.fundId, fundName: context.fund.name, basePolicyVersion: draft.basePolicyVersion, currentPolicyVersion: context.fund.currentPolicyVersion,
        parentDraftId: draft.parentDraftId, state, outcome: draft.outcome, draft: rules, analysis: viewAnalysis(rules, changesPayOrder),
        refusal: draft.refusalReason ? { reason: draft.refusalReason, path: draft.refusalPath ?? "draft" } : null, changedFields: draft.changedFields,
        inputText: draft.inputText, inputSha256: draft.inputSha256, draftedBy: draft.draftedBy, createdAt: draft.createdAt,
        model: draft.model ? { model: draft.model, effort: draft.effort!, promptVersion: draft.promptVersion!, schemaVersion: draft.schemaVersion!, requestDigest: draft.requestDigest!,
          stopReason: draft.stopReason, inputTokens: draft.inputTokens, outputTokens: draft.outputTokens } : null,
        approvals: events.filter(event => event.kind === "APPROVED").map(event => ({ actorId: event.actorId, recordedAt: event.recordedAt })),
        boundPolicyVersion: bound?.boundPolicyVersion ?? null,
      },
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

// ---- IAC-440 Package B (docs/ASSUMPTIONS.md section 72): read-only loaders for the review screen and the fund rules page. ----
// Nothing below writes a row, takes a lock or calls a model. Each one starts at gate(), so a claimant, a signed-out user and an approver of another
// organization are refused before anything is read, and another organization's fund or draft reads as not found, exactly as readDraft does.
export type CurrentRules = {
  version: number; summary: string; programs: string[] | null; allowedCategories: string[] | null; periodStart: string | null; periodEnd: string | null;
  // Cents as decimal strings. A budget line with no row is absent, and a fund with no check settings row has none.
  caps: Partial<Record<BudgetLine, string>>;
  thresholds: { version: number; values: Record<ThresholdKey, string> } | null;
  clauses: DraftClause[];
};
// The choices the edit form may offer, the same two lists the model was shown: the categories the organization allows and the known program ids.
export type DraftCatalogs = { categories: string[]; programs: string[] };

const clauseOrder = (a: string, b: string): number => {
  const [aw = 0, af = 0] = a.split(".").map(Number), [bw = 0, bf = 0] = b.split(".").map(Number);
  return aw - bw || af - bf;
};
async function currentRulesOf(tx: Tx, fundId: string, version: number): Promise<CurrentRules> {
  const [policy] = await tx.select().from(s.fundPolicyVersions).where(and(eq(s.fundPolicyVersions.fundId, fundId), eq(s.fundPolicyVersions.version, version)));
  if (!policy) throw new Error("Current approved policy required");
  const lines = await tx.select().from(s.fundBudgetLines).where(and(eq(s.fundBudgetLines.fundId, fundId), eq(s.fundBudgetLines.policyVersion, version)));
  const [settings] = await tx.select().from(s.fundCheckSettings).where(eq(s.fundCheckSettings.fundId, fundId)).orderBy(desc(s.fundCheckSettings.version)).limit(1);
  const clauses = await tx.select({ id: s.fundPolicyClauses.clauseId, text: s.fundPolicyClauses.text }).from(s.fundPolicyClauses)
    .where(and(eq(s.fundPolicyClauses.fundId, fundId), eq(s.fundPolicyClauses.policyVersion, version)));
  const caps: Partial<Record<BudgetLine, string>> = {};
  for (const line of lines) if (BUDGET_LINES.includes(line.budgetLine as BudgetLine)) caps[line.budgetLine as BudgetLine] = line.capCents.toString();
  return {
    version, summary: policy.summary, programs: policy.programs, allowedCategories: policy.allowedCategories, periodStart: policy.periodStart, periodEnd: policy.periodEnd,
    caps, clauses: clauses.sort((a, b) => clauseOrder(a.id, b.id)),
    thresholds: settings ? { version: settings.version, values: Object.fromEntries(THRESHOLD_KEYS.map(key => [key, settings[key].toString()])) as Record<ThresholdKey, string> } : null,
  };
}
async function catalogsOf(tx: Tx, context: Context): Promise<DraftCatalogs> {
  const input = await grantInput(tx, context, "");
  return { categories: choosableCategories(input), programs: [...input.programs] };
}
async function namesOf(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await tx.select({ id: s.users.id, displayName: s.users.displayName }).from(s.users).where(inArray(s.users.id, unique));
  return new Map(rows.map(row => [row.id, row.displayName]));
}
// The same state rule readDraft applies, for the rows of the list.
const draftStateOf = (draft: typeof s.policyDrafts.$inferSelect, events: (typeof s.policyDraftEvents.$inferSelect)[], currentPolicyVersion: number): DraftState =>
  draft.outcome === "REFUSED" ? "REFUSED" : events.some(event => event.kind === "BOUND") ? "BOUND" : events.some(event => event.kind === "WITHDRAWN") ? "WITHDRAWN"
    : draft.basePolicyVersion !== currentPolicyVersion ? "STALE" : "OPEN";

export const DRAFT_LIST_LIMIT = 20;
export type DraftListItem = {
  id: string; state: DraftState; parentDraftId: string | null; createdAt: Date; createdByName: string; basePolicyVersion: number; boundPolicyVersion: number | null;
  approvals: number; refusalReason: string | null; changedFields: string[] | null;
};
export type FundRulesView = {
  fundId: string; fundName: string; fundClass: "RESTRICTED" | "UNRESTRICTED"; current: CurrentRules; catalogs: DraftCatalogs;
  // The model and effort a new draft would use: the arm the create route runs, shown on the form's disclosure line.
  arm: DraftArm; drafts: DraftListItem[];
};
export type ReadFundRulesResult = Refused | { status: "OK"; view: FundRulesView };

// What the fund rules page shows: the current approved rules, the catalogs and the fund's newest drafts (at most twenty, newest first).
export async function readFundRules(db: AppDatabase, actor: DraftActor, fundId: string): Promise<ReadFundRulesResult> {
  return db.transaction(async tx => {
    const granted = await gate(tx, actor?.id, fundId);
    if (!granted.ok) return granted.refusal;
    const { fund } = granted.context;
    const rows = await tx.select().from(s.policyDrafts).where(eq(s.policyDrafts.fundId, fund.id)).orderBy(desc(s.policyDrafts.createdAt), desc(s.policyDrafts.id)).limit(DRAFT_LIST_LIMIT);
    const events = rows.length ? await tx.select().from(s.policyDraftEvents).where(inArray(s.policyDraftEvents.draftId, rows.map(row => row.id))) : [];
    const names = await namesOf(tx, rows.map(row => row.draftedBy));
    const drafts: DraftListItem[] = rows.map(row => {
      const own = events.filter(event => event.draftId === row.id);
      return {
        id: row.id, state: draftStateOf(row, own, fund.currentPolicyVersion), parentDraftId: row.parentDraftId, createdAt: row.createdAt, createdByName: names.get(row.draftedBy) ?? "An approver",
        basePolicyVersion: row.basePolicyVersion, boundPolicyVersion: own.find(event => event.kind === "BOUND")?.boundPolicyVersion ?? null,
        approvals: new Set(own.filter(event => event.kind === "APPROVED").map(event => event.actorId)).size, refusalReason: row.refusalReason, changedFields: row.changedFields,
      };
    });
    return {
      status: "OK" as const,
      view: { fundId: fund.id, fundName: fund.name, fundClass: fund.fundClass, current: await currentRulesOf(tx, fund.id, fund.currentPolicyVersion), catalogs: await catalogsOf(tx, granted.context), arm: DRAFT_DEFAULT_ARM, drafts },
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export type DraftReview = {
  view: DraftView; current: CurrentRules; catalogs: DraftCatalogs;
  // The names of the person who made the draft and of each approver, so the screen says who approved and when.
  draftedByName: string; approvers: { actorId: string; displayName: string; recordedAt: Date }[];
};
export type ReadDraftReviewResult = Refused | { status: "OK"; review: DraftReview };

// readDraft plus what the review table compares it with: the fund's current approved rules, the catalogs for the edit form and the approvers' names.
// readDraft decides authorization and not found first, so its refusal is returned as it is.
export async function readDraftReview(db: AppDatabase, actor: DraftActor, draftId: string): Promise<ReadDraftReviewResult> {
  const read = await readDraft(db, actor, draftId);
  if (read.status !== "OK") return read;
  const { view } = read;
  return db.transaction(async tx => {
    const granted = await gate(tx, actor?.id, view.fundId);
    if (!granted.ok) return granted.refusal;
    const names = await namesOf(tx, [view.draftedBy, ...view.approvals.map(approval => approval.actorId)]);
    return {
      status: "OK" as const,
      review: {
        view, current: await currentRulesOf(tx, view.fundId, granted.context.fund.currentPolicyVersion), catalogs: await catalogsOf(tx, granted.context),
        draftedByName: names.get(view.draftedBy) ?? "An approver",
        approvers: view.approvals.map(approval => ({ actorId: approval.actorId, displayName: names.get(approval.actorId) ?? "An approver", recordedAt: approval.recordedAt })),
      },
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
