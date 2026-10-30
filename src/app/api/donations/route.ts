import { getDatabase } from "../../../server/db";
import { handleDonationAction } from "../../../server/donation-actions";
import { donationMode } from "../../../server/donation-mode";
import { getPayments } from "../../../server/payments";

// One thin route: the mode is read from server configuration on every request and never from the request.
export async function POST(request: Request) {
  return handleDonationAction(request, { db: getDatabase(), payments: getPayments, mode: donationMode() });
}
