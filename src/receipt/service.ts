import { randomUUID } from "node:crypto";
import { and, desc, eq, like, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import type { LedgerTransaction } from "../ledger/journal";
import { serializable } from "../ledger/service";
import { ReceiptAiError, validateProposals } from "../ai/receipt";
import { receiptAuditColumns, storedReceiptAudit, type AnyReceiptCategorizer, type StoredReceiptAudit } from "../ai/audit";
import { screenReceiptText, unresolvedMatches } from "./prohibited-screen";
import { CLAIM_ID, digest, draftHash, budgetFor, normalizeDraft, type DraftInput } from "./terms";

async function actorFor(tx: LedgerTransaction, id: string) {
  const [actor] = await tx.select().from(s.users).where(eq(s.users.id, id));
  if (!actor) throw new Error("Receipt access denied"); return actor;
}
async function context(tx: LedgerTransaction, id: string, actorId: string, edit = false) {
  if (!CLAIM_ID.test(id)) throw new Error("Receipt not found");
  const [claim] = await tx.select().from(s.claims).where(eq(s.claims.id, id)).orderBy(desc(s.claims.version)).limit(1);
  const actor = await actorFor(tx, actorId);
  if (!claim || actor.organizationId !== claim.organizationId || (actor.role === "CLAIMANT" && actor.id !== claim.claimantId)) throw new Error("Receipt not found");
  if (edit) {
    if (actor.id !== claim.claimantId || actor.role !== "CLAIMANT") throw new Error("Claimant access required");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${claim.organizationId})::bigint)`);
    const [current] = await tx.select().from(s.claims).where(and(eq(s.claims.id, id), eq(s.claims.version, claim.version))).for("update");
    const activity = await tx.select({ id: s.allocationDecisions.id }).from(s.allocationDecisions).where(eq(s.allocationDecisions.claimId, id)).limit(1);
    const payments = await tx.select({ id: s.disbursements.id }).from(s.disbursements).where(eq(s.disbursements.claimId, id)).limit(1);
    if (current?.status !== "DRAFT" || activity.length || payments.length) throw new Error("Receipt is no longer editable");
  }
  const lines = await tx.select().from(s.claimLines).where(and(eq(s.claimLines.claimId, id), eq(s.claimLines.claimVersion, claim.version))).orderBy(s.claimLines.id);
  const [review] = await tx.select().from(s.receiptReviews).where(and(eq(s.receiptReviews.claimId, id), eq(s.receiptReviews.claimVersion, claim.version))).orderBy(desc(s.receiptReviews.revision)).limit(1);
  const [suggestion] = review ? await tx.select().from(s.receiptSuggestions).where(eq(s.receiptSuggestions.reviewId, review.id)).orderBy(desc(s.receiptSuggestions.attempt)).limit(1) : [];
  const [confirmation] = review ? await tx.select().from(s.receiptConfirmations).where(eq(s.receiptConfirmations.reviewId, review.id)) : [];
  if (!review) throw new Error("Receipt not found");
  const activity = await tx.select({ id: s.allocationDecisions.id }).from(s.allocationDecisions).where(eq(s.allocationDecisions.claimId, id)).limit(1);
  const payments = await tx.select({ id: s.disbursements.id }).from(s.disbursements).where(eq(s.disbursements.claimId, id)).limit(1);
  const canEdit = actor.role === "CLAIMANT" && actor.id === claim.claimantId && claim.status === "DRAFT" && !activity.length && !payments.length;
  return { actor, claim, lines, review, suggestion, confirmation, canEdit };
}
// Authorized context reused by the nonfinancial preparation service.
export { context as receiptContext };
function currentTerms(value: Awaited<ReturnType<typeof context>>, reviewId: string, expectedHash: string) {
  if (value.review.id !== reviewId || value.review.draftHash !== expectedHash || draftHash(value.claim, value.lines) !== expectedHash) throw new Error("Receipt review is stale");
}
export function configuredReceiptPayee(env: Record<string, string | undefined>) {
  const payee = env.PAYPAL_SANDBOX_PAYEE_EMAIL?.trim();
  const allowed = (env.PAYEE_ALLOWLIST ?? "").split(",").map(value => value.trim());
  if (!payee || !/^[^\s@]+@(?:personal\.example\.com|example\.invalid)$/.test(payee) || !allowed.includes(payee)) throw new Error("Configured sandbox recipient required");
  return payee;
}
export async function createReceiptDraft(db: AppDatabase, actorId: string, input: DraftInput, payee: string, singleSession = false) {
  const parsed = normalizeDraft(input); const id = `R-${randomUUID()}`;
  if (!/^[^\s@]+@(?:personal\.example\.com|example\.invalid)$/.test(payee)) throw new Error("Sandbox fixture recipient required");
  return serializable(db, async tx => {
    const actor = await actorFor(tx, actorId); if (actor.role !== "CLAIMANT") throw new Error("Claimant access required");
    if (singleSession) {
      const existing = await tx.select({ id: s.claims.id }).from(s.claims).where(and(eq(s.claims.organizationId, actor.organizationId), like(s.claims.id, "R-%"))).limit(1);
      if (existing.length) throw new Error("Judging session already has a receipt; preserve it and create a new separate session");
    }
    const [claim] = await tx.insert(s.claims).values({ id, version: 1, organizationId: actor.organizationId, claimantId: actor.id,
      vendor: parsed.vendor, program: parsed.program, incurredOn: parsed.incurredOn, payeeEmail: payee, payeeIsPlaceholder: payee.endsWith(".invalid"), isFixture: true }).returning();
    const lines = parsed.lines.map(line => ({ ...line, claimId: id, claimVersion: 1, category: "UNKNOWN", budgetLine: "unconfirmed" }));
    await tx.insert(s.claimLines).values(lines);
    await tx.insert(s.receiptReviews).values({ claimId: id, claimVersion: 1, revision: 1, source: parsed.source,
      sourceHash: digest(parsed.source), draftHash: draftHash(claim!, lines), createdBy: actor.id });
    return id;
  });
}
export const readReceiptView = (db: AppDatabase, id: string, actor: string) => db.transaction(tx => context(tx, id, actor), { isolationLevel: "repeatable read", accessMode: "read only" });
export function suggestionHash(suggestion: Awaited<ReturnType<typeof context>>["suggestion"] | undefined) {
  return digest(JSON.stringify(suggestion ? { id: suggestion.id, status: suggestion.status, proposals: suggestion.proposals, audit: suggestion.audit } : null));
}
export async function editReceiptDraft(db: AppDatabase, id: string, actor: string, reviewId: string, expectedHash: string, input: DraftInput) {
  const parsed = normalizeDraft(input);
  await serializable(db, async tx => {
    const value = await context(tx, id, actor, true); currentTerms(value, reviewId, expectedHash);
    const [claim] = await tx.update(s.claims).set({ vendor: parsed.vendor, program: parsed.program, incurredOn: parsed.incurredOn }).where(and(eq(s.claims.id, id), eq(s.claims.version, value.claim.version))).returning();
    await tx.delete(s.claimLines).where(and(eq(s.claimLines.claimId, id), eq(s.claimLines.claimVersion, claim!.version)));
    const lines = parsed.lines.map(line => ({ ...line, claimId: id, claimVersion: claim!.version, category: "UNKNOWN", budgetLine: "unconfirmed" }));
    await tx.insert(s.claimLines).values(lines);
    await tx.insert(s.receiptReviews).values({ claimId: id, claimVersion: claim!.version, revision: value.review.revision + 1, source: parsed.source,
      sourceHash: digest(parsed.source), draftHash: draftHash(claim!, lines), createdBy: actor });
  });
}
export async function suggestReceipt(db: AppDatabase, id: string, actor: string, reviewId: string, expectedHash: string, categorize: AnyReceiptCategorizer, expectedSuggestionHash: string) {
  const begin = () => serializable(db, async tx => {
    const value = await context(tx, id, actor, true); currentTerms(value, reviewId, expectedHash);
    if (value.confirmation) throw new Error("Edit the draft before requesting another review");
    // Replaying a request never discards a ready result or starts concurrent inference.
    if (value.suggestion?.status === "READY") return { reused: true as const, ready: true };
    if (value.suggestion?.status === "RUNNING" && Date.now() - value.suggestion.requestedAt.getTime() < 65000) return { reused: true as const, ready: null };
    if (suggestionHash(value.suggestion) !== expectedSuggestionHash) throw new Error("Receipt review is stale");
    const [attempt] = await tx.insert(s.receiptSuggestions).values({ reviewId, attempt: (value.suggestion?.attempt ?? 0) + 1, status: "RUNNING" }).returning();
    return { reused: false as const, attempt: attempt!, source: value.review.source, lines: value.lines.map(line => ({ id: line.id, description: line.description })) };
  });
  let start;
  try { start = await begin(); }
  catch (error) {
    // Concurrent serializable snapshots may meet the unique attempt constraint instead
    // of producing 40001. Re-read once in a fresh transaction, never retry the model.
    let current: unknown = error; let duplicate = false;
    for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
      if ("code" in current && current.code === "23505" && "constraint_name" in current && current.constraint_name === "receipt_suggestions_review_id_attempt_unique") duplicate = true;
      current = "cause" in current ? current.cause : undefined;
    }
    if (!duplicate) throw error;
    start = await begin();
  }
  if (start.reused) return start.ready;
  let result: Awaited<ReturnType<typeof categorize>> | undefined; let errorCode: string | undefined;
  try { result = await categorize({ source: start.source, lines: start.lines }); }
  catch (error) { errorCode = error instanceof ReceiptAiError ? error.code : "UNAVAILABLE"; }
  return serializable(db, async tx => {
    const value = await context(tx, id, actor);
    let valid = value.claim.status === "DRAFT" && value.review.id === reviewId && !value.confirmation && value.suggestion?.id === start.attempt.id && value.review.draftHash === draftHash(value.claim, value.lines);
    let proposals: ReturnType<typeof validateProposals> | undefined;
    // The categorizer's own audit is validated and stored under its own provider tag (see src/ai/audit.ts).
    let audit: StoredReceiptAudit | undefined;
    if (result && valid) {
      try {
        proposals = validateProposals({ source: start.source, lines: start.lines }, { proposals: result.proposals.map(p => ({ lineId: p.lineId, category: p.category, quote: p.quote })) });
        audit = storedReceiptAudit(result, start.source);
      } catch { proposals = undefined; audit = undefined; errorCode = "VALIDATION"; }
    }
    if (!valid) errorCode = "STALE";
    const ready = Boolean(result && proposals && audit && valid);
    await tx.update(s.receiptSuggestions).set({ status: ready ? "READY" : "FAILED", errorCode: ready ? null : errorCode ?? "UNAVAILABLE", proposals: ready ? proposals : null,
      audit: ready ? audit! : null, provider: ready ? receiptAuditColumns(audit!).provider : null, model: ready ? receiptAuditColumns(audit!).model : null }).where(and(eq(s.receiptSuggestions.id, start.attempt.id), eq(s.receiptSuggestions.status, "RUNNING")));
    return ready;
  });
}
// IAC-394: receipt text names alcohol or gift cards and no confirmed line carries that category.
export class ProhibitedAcknowledgementRequired extends Error {
  constructor() { super("Receipt mentions a possibly prohibited item; choose that category for the line or acknowledge it is not claimed"); this.name = "ProhibitedAcknowledgementRequired"; }
}
export async function confirmReceipt(db: AppDatabase, id: string, actor: string, reviewId: string, expectedHash: string, suggestionId: string | null, expectedSuggestionHash: string, selections: { lineId: string; category: string; reason: string }[], acknowledgeProhibited = false) {
  await serializable(db, async tx => {
    const value = await context(tx, id, actor, true); currentTerms(value, reviewId, expectedHash);
    if (value.confirmation || (value.suggestion?.id ?? null) !== suggestionId || suggestionHash(value.suggestion) !== expectedSuggestionHash || selections.length !== value.lines.length || new Set(selections.map(s => s.lineId)).size !== selections.length) throw new Error("Receipt confirmation is stale");
    const accepted = selections.map(selection => {
      if (!value.lines.some(line => line.id === selection.lineId) || typeof selection.reason !== "string" || selection.reason.length > 200) throw new Error("Invalid category selection");
      budgetFor(selection.category);
      const proposal = value.suggestion?.status === "READY" ? value.suggestion.proposals?.find(p => p.lineId === selection.lineId) : undefined;
      const aiAccepted = Boolean(proposal && proposal.category !== "UNKNOWN" && proposal.category === selection.category);
      if (!aiAccepted && selection.reason.trim().length < 3) throw new Error("Explain each manual category choice");
      return { lineId: selection.lineId, category: selection.category, provenance: aiAccepted ? "AI_ACCEPTED" as const : "HUMAN" as const, reason: selection.reason.trim() };
    });
    // Flag only: the screen never changes a category, a budget line or an amount. Nothing is written when acknowledgement is missing.
    const screen = screenReceiptText(value.review.source, value.lines.map(line => line.description));
    const unresolved = unresolvedMatches(screen.matches, accepted.map(selected => selected.category));
    if (unresolved.length && acknowledgeProhibited !== true) throw new ProhibitedAcknowledgementRequired();
    for (const selected of accepted) await tx.update(s.claimLines).set({ category: selected.category, budgetLine: budgetFor(selected.category) }).where(and(eq(s.claimLines.claimId, id), eq(s.claimLines.claimVersion, value.claim.version), eq(s.claimLines.id, selected.lineId)));
    const lines = value.lines.map(line => ({ ...line, category: accepted.find(s => s.lineId === line.id)!.category, budgetLine: budgetFor(accepted.find(s => s.lineId === line.id)!.category) }));
    await tx.insert(s.receiptConfirmations).values({ reviewId, suggestionId, confirmedBy: actor, termsHash: draftHash(value.claim, lines, true), selections: accepted,
      prohibitedScreen: { version: screen.version, matches: screen.matches, unresolved, acknowledged: unresolved.length > 0 } });
  });
}
