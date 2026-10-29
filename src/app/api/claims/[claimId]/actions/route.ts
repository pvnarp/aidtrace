import { getDatabase } from "../../../../../server/db";
import { getPayments } from "../../../../../server/payments";
import { handleClaimAction } from "../../../../../server/claim-actions";
import { judgeSession } from "../../../../../server/judge-mode";

export async function POST(request: Request, context: { params: Promise<{ claimId: string }> }) {
  return handleClaimAction(request, (await context.params).claimId, { db: getDatabase(), provider: getPayments, judgeSession: judgeSession() });
}
