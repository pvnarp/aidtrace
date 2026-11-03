import { desc, eq } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import type { PhotoCallFacts, PhotoOutcome } from "../ai/claude-photo";

// Provenance of receipt photo reads (IAC-384, docs/ASSUMPTIONS.md section 83). One append-only row per model call, written here and nowhere else.
// A row holds the SHA-256 of the photo and the call facts. It never holds the photo, its base64, the transcript or an error message.
type Reader = Pick<AppDatabase, "select">;

export async function recordPhotoRead(db: AppDatabase, actor: { id: string; organizationId: string }, facts: PhotoCallFacts, outcome: PhotoOutcome, arithmeticOk: boolean | null, prefillSha256: string | null = null): Promise<string> {
  const [row] = await db.insert(s.receiptPhotoReads).values({ organizationId: actor.organizationId, userId: actor.id, photoSha256: facts.photoSha256, model: facts.model,
    promptVersion: facts.promptVersion, schemaVersion: facts.schemaVersion, outcome, stopReason: facts.stopReason, inputTokens: facts.inputTokens, outputTokens: facts.outputTokens,
    arithmeticOk: outcome === "READ" ? arithmeticOk ?? false : null, prefillSha256: outcome === "READ" ? prefillSha256 : null }).returning({ id: s.receiptPhotoReads.id });
  return row!.id;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The read id a new receipt may link to: the read exists, belongs to this user and organization, was READ, and is not already linked to another claim.
// Anything else returns null and the receipt is created without a link. A forged or foreign id never claims an AI read the person did not make.
export async function linkablePhotoRead(tx: Reader, readId: string | null | undefined, actor: { id: string; organizationId: string }): Promise<{ id: string; prefillSha256: string | null } | null> {
  if (!readId || !UUID.test(readId)) return null;
  const [read] = await tx.select().from(s.receiptPhotoReads).where(eq(s.receiptPhotoReads.id, readId));
  if (!read) return null;
  if (read.userId !== actor.id) return null;
  if (read.organizationId !== actor.organizationId || read.outcome !== "READ") return null;
  const [used] = await tx.select({ id: s.receiptReviews.id }).from(s.receiptReviews).where(eq(s.receiptReviews.photoReadId, readId));
  return used ? null : { id: readId, prefillSha256: read.prefillSha256 };
}

// The model of a linked read, for the claim page evidence line. Null when the read is missing.
export async function photoReadModel(db: AppDatabase, readId: string): Promise<string | null> {
  const [read] = await db.select({ model: s.receiptPhotoReads.model }).from(s.receiptPhotoReads).where(eq(s.receiptPhotoReads.id, readId));
  return read?.model ?? null;
}

// The prefill digest of a linked read, for the edit path. Null when the read is missing.
export async function photoReadDigest(tx: Reader, readId: string): Promise<string | null> {
  const [read] = await tx.select({ digest: s.receiptPhotoReads.prefillSha256 }).from(s.receiptPhotoReads).where(eq(s.receiptPhotoReads.id, readId));
  return read?.digest ?? null;
}
// The photo facts of the newest revision of a receipt claim, for the trace rail. No link: { linked: false }.
export async function currentPhotoLink(db: AppDatabase, claimId: string): Promise<{ linked: boolean; unchanged: boolean }> {
  const [row] = await db.select({ id: s.receiptReviews.photoReadId, unchanged: s.receiptReviews.photoUnchanged }).from(s.receiptReviews).where(eq(s.receiptReviews.claimId, claimId)).orderBy(desc(s.receiptReviews.revision)).limit(1);
  return { linked: Boolean(row?.id), unchanged: Boolean(row?.unchanged) };
}
