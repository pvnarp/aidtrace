import { getDatabase } from "../../../../../server/db";
import { handleExpenseProposal } from "../../../../../server/proposal-actions";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function action(request: Request, context: { params: Promise<{ claimId: string }> }) {
  const { claimId } = await context.params;
  return handleExpenseProposal(request, claimId, { db: getDatabase() });
}
export { action as GET, action as POST };
