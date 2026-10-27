import { getDatabase } from "../../../../server/db";
import { getPayments } from "../../../../server/payments";
import { handlePayPalWebhook } from "../../../../server/webhook-handler";

export async function POST(request: Request) {
  if (process.env.PAYPAL_PRODUCT_WEBHOOK_ENABLED !== "true") return new Response("Webhook disabled", { status: 503 });
  return handlePayPalWebhook(request, { db: getDatabase(), provider: getPayments, webhookId: process.env.PAYPAL_PRODUCT_WEBHOOK_ID });
}
