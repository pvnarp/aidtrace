import type { AppDatabase } from "./db";
import type { PayoutTransport, WebhookVerifier } from "../paypal/adapter";
import { refreshVerifiedPayoutEvent } from "../ledger/webhooks";

const events = new Set(["PAYMENT.PAYOUTSBATCH.DENIED", "PAYMENT.PAYOUTSBATCH.PROCESSING", "PAYMENT.PAYOUTSBATCH.SUCCESS", ...["BLOCKED", "CANCELED", "FAILED", "HELD", "REFUNDED", "RETURNED", "SUCCEEDED", "UNCLAIMED"].map(name => `PAYMENT.PAYOUTS-ITEM.${name}`)]);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const identifier = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
export async function handlePayPalWebhook(request: Request, dependencies: { db: AppDatabase; provider: () => PayoutTransport & WebhookVerifier; webhookId?: string }) {
  if (!dependencies.webhookId) return new Response("Webhook not configured", { status: 503 });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return new Response("JSON required", { status: 415 });
  const reader = request.body?.getReader(); if (!reader) return new Response("Event required", { status: 400 });
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 65536) { await reader.cancel(); return new Response("Event too large", { status: 413 }); } chunks.push(value); }
  let event: Record<string, unknown>;
  try { event = object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { return new Response("Invalid event", { status: 400 }); }
  if (typeof event.id !== "string" || !/^WH-[A-Za-z0-9-]{1,125}$/.test(event.id) || typeof event.event_type !== "string" || !events.has(event.event_type)) return new Response("Unsupported event", { status: 400 });
  // Simulator events cannot pass postback verification with a real registered ID.
  // An explicit simulator marker is rejected even when using injected test transports.
  if (event.simulator === true || event.id.includes("SIMULATOR")) return new Response("Simulator ignored", { status: 400 });
  const resource = object(event.resource); const batchHeader = object(resource.batch_header);
  const isBatch = event.event_type.startsWith("PAYMENT.PAYOUTSBATCH.");
  const batchId = identifier(resource.payout_batch_id) ?? identifier(batchHeader.payout_batch_id);
  const itemId = isBatch ? undefined : identifier(resource.payout_item_id);
  const resourceId = isBatch ? batchId : itemId;
  if (!resourceId || !batchId && !itemId) return new Response("Payout resource required", { status: 400 });
  const headers = Object.fromEntries(["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"].map(name => [name, request.headers.get(name) ?? ""]));
  try {
    const provider = dependencies.provider();
    const verification = await provider.verifyWebhook(dependencies.webhookId, headers, event);
    if (verification.httpStatus !== 200 || verification.verificationStatus !== "SUCCESS") return new Response("Signature rejected", { status: verification.httpStatus >= 500 ? 503 : 400 });
    await refreshVerifiedPayoutEvent(dependencies.db, { eventId: event.id, eventType: event.event_type, resourceId }, batchId, itemId, provider);
    return new Response(null, { status: 204 });
  } catch { return new Response("Webhook could not be verified or reconciled", { status: 503 }); }
}
