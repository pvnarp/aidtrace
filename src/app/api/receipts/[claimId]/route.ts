import { getDatabase } from "../../../../server/db";
import { handleReceiptAction } from "../../../../server/receipt-actions";
export async function POST(request: Request, { params }: { params: Promise<{ claimId: string }> }) { return handleReceiptAction(request, (await params).claimId, { db: getDatabase() }); }
