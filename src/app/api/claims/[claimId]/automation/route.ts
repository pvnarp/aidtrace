import { getDatabase } from "../../../../../server/db";
import { handleClaimDisagree } from "../../../../../server/automation-actions";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function action(request: Request, context: { params: Promise<{ claimId: string }> }) {
  return handleClaimDisagree(request, (await context.params).claimId, { db: getDatabase() });
}
export { action as GET, action as POST, action as PUT, action as PATCH, action as DELETE };
