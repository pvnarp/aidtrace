import { getDatabase } from "../../../../server/db";
import { handleBulkApprove } from "../../../../server/bulk-approve-actions";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function action(request: Request) {
  return handleBulkApprove(request, { db: getDatabase() });
}
// Every method reaches the handler so a wrong method gets a 405 from the same place as every other check.
export { action as GET, action as POST, action as PUT, action as PATCH, action as DELETE };
