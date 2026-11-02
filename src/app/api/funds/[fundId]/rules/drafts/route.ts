import { getDatabase } from "../../../../../../server/db";
import { handleCreateDraft } from "../../../../../../server/rules-draft-actions";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function action(request: Request, context: { params: Promise<{ fundId: string }> }) {
  return handleCreateDraft(request, (await context.params).fundId, { db: getDatabase() });
}
// Every method reaches the handler so a wrong method gets a 405 from the same place as every other check.
export { action as GET, action as POST, action as PUT, action as PATCH, action as DELETE };
