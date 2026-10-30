import { and, eq } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import { serializable } from "../ledger/service";
import { GIFT_ATTRIBUTION_POLICY } from "./attribution";
import { buildNoteFacts, DEFAULT_SELECTION, factDigest, noteTextHash, NOTE_FACT_SET, renderTemplateNote, validateSelection, type NoteRefusal, type NoteSelection } from "./note";

// IAC-379 step 3b (docs/plans/DONATION_LOOP_SCOPE.md section 6, owner decision 10): a person who is not the claimant approves
// the donor impact note. The approval stores the note, its facts digest and the gift applications as immutable rows (migration
// 0014). It moves no money, posts nothing, changes no allocation or approval of the claim, and sends nothing to anyone.
export interface ApproveNoteInput { captureId: string; claimId: string; claimVersion: number; factDigest: string; selection?: NoteSelection }
export type ApproveNoteResult =
  | { status: "APPROVED"; noteId: string }
  | { status: "ALREADY_APPROVED"; noteId: string }
  | { status: "STALE" }
  | { status: "REFUSED"; reason: "INVALID_REQUEST" | "APPROVER_REQUIRED" | NoteRefusal };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const refused = (reason: Extract<ApproveNoteResult, { status: "REFUSED" }>["reason"]): ApproveNoteResult => ({ status: "REFUSED", reason });

export async function approveGiftNote(db: AppDatabase, approverId: string, input: ApproveNoteInput): Promise<ApproveNoteResult> {
  const selection = input?.selection ?? DEFAULT_SELECTION;
  try { validateSelection(selection); } catch { return refused("INVALID_REQUEST"); }
  if (!input || !ID.test(input.captureId ?? "") || !ID.test(input.claimId ?? "") || !Number.isSafeInteger(input.claimVersion) || input.claimVersion < 1 || !/^[a-f0-9]{64}$/.test(input.factDigest ?? "")) return refused("INVALID_REQUEST");
  return serializable(db, async (tx): Promise<ApproveNoteResult> => {
    const [claim] = await tx.select().from(s.claims).where(and(eq(s.claims.id, input.claimId), eq(s.claims.version, input.claimVersion)));
    const [approver] = await tx.select().from(s.users).where(eq(s.users.id, approverId));
    // Same message for every cause: an APPROVER of the claim's organization who is not the claimant.
    if (!claim || !approver || approver.role !== "APPROVER" || approver.organizationId !== claim.organizationId || approver.id === claim.claimantId) return refused("APPROVER_REQUIRED");
    const built = await buildNoteFacts(tx, claim.organizationId, input.captureId, input.claimId, input.claimVersion);
    if (!built.ok) return refused(built.refusal);
    // The note is approved for exactly the facts the approver saw. Any change since then (a payout status, a name, an amount) is STALE and writes nothing.
    const digest = factDigest(built.facts);
    if (digest !== input.factDigest) return { status: "STALE" };
    const [existing] = await tx.select({ id: s.giftNotes.id }).from(s.giftNotes).where(and(eq(s.giftNotes.captureId, input.captureId), eq(s.giftNotes.claimId, input.claimId), eq(s.giftNotes.claimVersion, input.claimVersion), eq(s.giftNotes.factDigest, digest)));
    if (existing) return { status: "ALREADY_APPROVED", noteId: existing.id };
    const text = renderTemplateNote(built.facts, selection);
    const [note] = await tx.insert(s.giftNotes).values({
      captureId: input.captureId, claimId: input.claimId, claimVersion: input.claimVersion, decisionHash: built.decisionHash, factSetVersion: NOTE_FACT_SET, factDigest: digest,
      templateId: selection.templateId, optionalFactIds: [...selection.optional], renderedText: text, textHash: noteTextHash(text), mode: "TEMPLATE", modelMetadata: null,
      approverId, payoutStatus: built.facts.payout.status, policyVersion: GIFT_ATTRIBUTION_POLICY,
    }).onConflictDoNothing({ target: [s.giftNotes.captureId, s.giftNotes.claimId, s.giftNotes.claimVersion, s.giftNotes.factDigest] }).returning({ id: s.giftNotes.id });
    if (!note) {
      const [winner] = await tx.select({ id: s.giftNotes.id }).from(s.giftNotes).where(and(eq(s.giftNotes.captureId, input.captureId), eq(s.giftNotes.claimId, input.claimId), eq(s.giftNotes.claimVersion, input.claimVersion), eq(s.giftNotes.factDigest, digest)));
      if (!winner) throw new Error("Donor note conflict without an existing note");
      return { status: "ALREADY_APPROVED", noteId: winner.id };
    }
    // The applications are exactly the GIFT_ATTRIBUTION_V1 result for this gift and claim version, written once with the note.
    await tx.insert(s.giftApplications).values(built.applications.map(row => ({ noteId: note.id, captureId: row.captureId, claimId: row.claimId, claimVersion: row.claimVersion, lineId: row.lineId, fundId: row.fundId, appliedCents: row.appliedCents, policyVersion: GIFT_ATTRIBUTION_POLICY })));
    return { status: "APPROVED", noteId: note.id };
  });
}
