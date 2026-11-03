import { getDatabase } from "../../../../server/db";
import { handlePhotoText } from "../../../../server/receipt-photo-actions";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function action(request: Request) {
  return handlePhotoText(request, { db: getDatabase() });
}
// Every method reaches the handler so a wrong method gets a 405 (or a 404 with the flag off) from the same place as every other check.
export { action as GET, action as POST, action as PUT, action as PATCH, action as DELETE };
