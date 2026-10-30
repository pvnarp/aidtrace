import type { AppDatabase } from "./db";
import { eq } from "drizzle-orm";
import { users } from "../../db/schema";
import { findSession, sessionToken } from "./auth";
import { readGiftNoteById, TEMPLATE_LABEL } from "../donation/note";

// IAC-379 step 3b: a plain-text download of one approved donor impact note. Read only. Signed-in users of the claim's
// organization only (a claimant only for their own claim, as on the claim page). Anyone else gets the same 404 as a missing
// note, so the response does not reveal that a note exists. The body is the stored, hashed text. The label and the out of date
// marker are added around it, never inside it.
export async function handleNoteDownload(request: Request, claimId: string, noteId: string, dependencies: { db: AppDatabase }) {
  const user = await findSession(sessionToken(request), dependencies.db);
  if (!user) return new Response("Sign in first", { status: 401, headers: { "Cache-Control": "no-store" } });
  const notFound = () => new Response("Note not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(claimId) || !/^[a-f0-9-]{36}$/.test(noteId)) return notFound();
  const found = await readGiftNoteById(dependencies.db, noteId);
  const [actor] = await dependencies.db.select({ organizationId: users.organizationId }).from(users).where(eq(users.id, user.id));
  if (!found || found.note.claimId !== claimId || !actor || actor.organizationId !== found.organizationId || (user.role === "CLAIMANT" && user.id !== found.claimantId)) return notFound();
  const { note } = found;
  const lines = [note.renderedText, "", note.mode === "TEMPLATE" ? TEMPLATE_LABEL : "AI selected from verified facts"];
  if (note.stale) lines.push("Out of date: needs a new approval");
  return new Response(`${lines.join("\n")}\n`, { status: 200, headers: {
    "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="aidtrace-impact-note-${note.id.slice(0, 8)}.txt"`,
    "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
  } });
}
