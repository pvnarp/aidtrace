import { getDatabase } from "../../../../../../server/db";
import { handleNoteDownload } from "../../../../../../server/gift-note-download";

export async function GET(request: Request, context: { params: Promise<{ claimId: string; noteId: string }> }) {
  const { claimId, noteId } = await context.params;
  return handleNoteDownload(request, claimId, noteId, { db: getDatabase() });
}
