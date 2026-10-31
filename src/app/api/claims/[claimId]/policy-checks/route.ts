import { getDatabase } from "../../../../../server/db";
import { handlePolicyChecks } from "../../../../../server/policy-actions";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function action(request: Request, context: { params: Promise<{ claimId: string }> }) {
  return handlePolicyChecks(request, (await context.params).claimId, { db: getDatabase() });
}
// Every method reaches the handler so a wrong method gets a 405 from the same place as every other check.
export { action as GET, action as POST, action as PUT, action as PATCH, action as DELETE };
