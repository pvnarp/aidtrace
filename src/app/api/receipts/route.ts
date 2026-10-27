import { getDatabase } from "../../../server/db";
import { handleReceiptAction } from "../../../server/receipt-actions";
export async function POST(request: Request) { return handleReceiptAction(request, null, { db: getDatabase() }); }
