const SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";
export interface PayPalConfig {
  baseUrl?: string; clientId?: string; clientSecret?: string;
  payeeAllowlist: readonly string[]; maxDemoPayoutCents: bigint;
  // IAC-379: donation ceiling in integer cents. Omitted means DEFAULT_MAX_DEMO_DONATION_CENTS.
  maxDemoDonationCents?: bigint;
}
export const DEFAULT_MAX_DEMO_DONATION_CENTS = 5000n;
export function payPalConfigFromEnvironment(env: Readonly<Record<string, string | undefined>>): PayPalConfig {
  const maximum = env.MAX_DEMO_PAYOUT_CENTS || "50000";
  if (!/^[1-9][0-9]*$/.test(maximum)) throw new Error("MAX_DEMO_PAYOUT_CENTS must be a positive integer");
  const donationMaximum = env.MAX_DEMO_DONATION_CENTS || DEFAULT_MAX_DEMO_DONATION_CENTS.toString();
  if (!/^[1-9][0-9]{0,15}$/.test(donationMaximum)) throw new Error("MAX_DEMO_DONATION_CENTS must be a positive integer");
  return {
    baseUrl: env.PAYPAL_BASE_URL, clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET,
    payeeAllowlist: (env.PAYEE_ALLOWLIST ?? "").split(",").map(v => v.trim()).filter(Boolean), maxDemoPayoutCents: BigInt(maximum),
    maxDemoDonationCents: BigInt(donationMaximum),
  };
}
export function createPayPalAdapter(config: PayPalConfig, request: typeof fetch = fetch) {
  if (config.baseUrl !== SANDBOX_BASE_URL) throw new Error("PayPal sandbox URL required");
  if (!config.clientId?.trim() || !config.clientSecret?.trim()) throw new Error("PayPal credentials required");
  if (config.maxDemoPayoutCents <= 0n) throw new Error("Positive payout ceiling required");
  return {
    validatePayout(payee: string, amountCents: bigint) {
      if (!config.payeeAllowlist.includes(payee)) throw new Error("Payee is not allowlisted");
      if (payee.endsWith(".invalid")) throw new Error("Non-payable fixture recipient");
      if (amountCents <= 0n || amountCents > config.maxDemoPayoutCents) throw new Error("Payout outside demo ceiling");
    },
    // Human-only IAC-132 probe. Product methods are defined separately below.
    async probeAuthentication() {
      const response = await request(`${SANDBOX_BASE_URL}/v1/oauth2/token`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      });
      if (!response.ok) throw new Error(`PayPal OAuth rejected the request (HTTP ${response.status}); response body withheld`);
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("access_token" in result) || typeof result.access_token !== "string" || !result.access_token) throw new Error("PayPal did not return an access token");
      return { authenticated: true, httpStatus: response.status, expiresInSeconds: "expires_in" in result && typeof result.expires_in === "number" ? result.expires_in : null };
    },
  };
}

export interface PersistedPayout { senderBatchId: string; senderItemId: string; payeeEmail: string; amountCents: bigint; }
export interface PayoutCreateResult { httpStatus: number; batchId?: string; itemId?: string; batchStatus?: string; errorCode?: string; }
export interface PayoutBatchResult { httpStatus: number; batchId?: string; batchStatus?: string; senderBatchId?: string; itemIds: string[]; errorCode?: string; }
export interface PayoutItemResult { httpStatus: number; itemId?: string; batchId?: string; senderBatchId?: string; senderItemId?: string; payeeEmail?: string; amountCents?: bigint; itemStatus?: string; feeCents?: bigint; processedOn?: string; errorCode?: string; }
export interface ProviderBalance { readable: boolean; availableCents?: bigint; asOf?: string; }
export interface PayoutTransport {
  validatePayout(payee: string, cents: bigint): void;
  balance(): Promise<ProviderBalance>;
  send(payout: PersistedPayout): Promise<PayoutCreateResult>;
  batch(id: string): Promise<PayoutBatchResult>;
  item(id: string): Promise<PayoutItemResult>;
}
export interface WebhookVerifier { verifyWebhook(webhookId: string, headers: Readonly<Record<string, string>>, event: unknown): Promise<{ httpStatus: number; verificationStatus?: string }>; }
export interface WebhookRegistration { httpStatus: number; id?: string; url?: string; eventTypes: string[]; errorCode?: string; }
export interface WebhookRegistrationReader {
  webhookRegistration(id: string): Promise<WebhookRegistration>;
  resendWebhookEvent(eventId: string, webhookId: string): Promise<{ httpStatus: number; errorCode?: string }>;
}
export interface DonationObservation {
  httpStatus: number; orderId?: string; intent?: string; status?: string;
  units: { fundId?: string; amountCents?: bigint }[];
  captures: { captureId?: string; status?: string; amountCents?: bigint; grossCents?: bigint; feeCents?: bigint; netCents?: bigint; effectiveOn?: string }[];
}
export interface DonationReader { donationOrder(orderId: string): Promise<DonationObservation>; }
// IAC-379 Orders v2 writer. Inputs are persisted by the caller first. Responses keep only allowlisted fields:
// never payer email, payer ID, address, card data, links or free text.
export interface PersistedDonationOrder { requestId: string; fundId: string; amountCents: bigint; }
export interface DonationOrderCreateResult { httpStatus: number; orderId?: string; status?: string; errorCode?: string; errorIssues: string[]; }
export interface DonationCaptureResult extends DonationObservation { errorCode?: string; errorIssues: string[]; }
export interface DonationOrderWriter {
  createDonationOrder(order: PersistedDonationOrder): Promise<DonationOrderCreateResult>;
  captureDonationOrder(orderId: string, captureRequestId: string): Promise<DonationCaptureResult>;
}
// Application requests stay in this file. Manual lab methods never enter the web workflow.
export function createApplicationSandboxPayments(config: PayPalConfig, balanceReadable = false, request: typeof fetch = fetch): PayoutTransport & WebhookVerifier & DonationReader & DonationOrderWriter & WebhookRegistrationReader {
  const guard = createPayPalAdapter(config, request);
  const donationCeilingCents = config.maxDemoDonationCents ?? DEFAULT_MAX_DEMO_DONATION_CENTS;
  if (donationCeilingCents <= 0n) throw new Error("Positive donation ceiling required");
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const identifier = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
  const code = (value: unknown) => typeof value === "string" && /^[A-Z0-9_]{1,100}$/.test(value) ? value : undefined;
  const money = (value: unknown, currencyField = "currency") => {
    const data = object(value);
    if (data[currencyField] !== "USD" || typeof data.value !== "string" || !/^-?[0-9]{1,16}\.[0-9]{2}$/.test(data.value)) return undefined;
    const negative = data.value.startsWith("-"); const [whole, fraction] = data.value.replace(/^-/, "").split(".");
    return (BigInt(whole!) * 100n + BigInt(fraction!)) * (negative ? -1n : 1n);
  };
  const decimal = (cents: bigint) => `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  let token: string | undefined; let expiresAt = 0;
  async function authenticate() {
    const response = await request(`${SANDBOX_BASE_URL}/v1/oauth2/token`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
    if (!response.ok) throw new Error("Sandbox authentication failed; private response withheld");
    const data = object(await response.json());
    if (typeof data.access_token !== "string" || !data.access_token) throw new Error("Sandbox authentication returned no token");
    token = data.access_token;
    const lifetime = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) ? Math.max(0, data.expires_in - 60) : 0;
    expiresAt = Date.now() + lifetime * 1000;
  }
  async function call(path: string, body?: unknown, extraHeaders: Readonly<Record<string, string>> = {}) {
    if (!token || Date.now() >= expiresAt) await authenticate();
    for (let retry = 0; ; retry++) {
      const response = await request(`${SANDBOX_BASE_URL}${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.status === 401 && retry === 0) { await authenticate(); continue; }
      let data: Record<string, unknown>;
      try { data = object(await response.json()); } catch { data = {}; }
      return { httpStatus: response.status, data, errorCode: code(data.name) };
    }
  }
  const validId = (id: string) => { if (!identifier(id)) throw new Error("Invalid persisted provider ID"); };
  const requestUuid = (value: string) => { if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw new Error("Persist a valid request UUID before sending"); };
  const issues = (data: Record<string, unknown>) => Array.isArray(data.details) ? data.details.map(object).map(detail => code(detail.issue)).filter((issue): issue is string => Boolean(issue)) : [];
  // Shared allowlist parse for an order representation. Payer, address, card and link fields are never read.
  function observeOrder(result: { httpStatus: number; data: Record<string, unknown> }): DonationObservation {
    const units = Array.isArray(result.data.purchase_units) ? result.data.purchase_units.map(object) : [];
    return { httpStatus: result.httpStatus, orderId: identifier(result.data.id), intent: code(result.data.intent), status: code(result.data.status),
      units: units.map(unit => ({ fundId: typeof unit.custom_id === "string" && /^[a-z0-9_-]{1,64}$/.test(unit.custom_id) ? unit.custom_id : undefined, amountCents: money(unit.amount, "currency_code") })),
      captures: units.flatMap(unit => {
        const payments = object(unit.payments);
        return (Array.isArray(payments.captures) ? payments.captures.map(object) : []).map(capture => {
          const breakdown = object(capture.seller_receivable_breakdown);
          const time = capture.update_time ?? capture.create_time;
          const effectiveOn = typeof time === "string" && /^\d{4}-\d{2}-\d{2}T/.test(time) && time.length <= 64 && Number.isFinite(Date.parse(time)) ? new Date(time).toISOString().slice(0, 10) : undefined;
          return { captureId: identifier(capture.id), status: code(capture.status), amountCents: money(capture.amount, "currency_code"), grossCents: money(breakdown.gross_amount, "currency_code"), feeCents: money(breakdown.paypal_fee, "currency_code"), netCents: money(breakdown.net_amount, "currency_code"), effectiveOn };
        });
      }) };
  }
  return {
    async resendWebhookEvent(eventId, webhookId) {
      validId(webhookId);
      if (!/^WH-[A-Za-z0-9-]{1,125}$/.test(eventId) || eventId.includes("SIMULATOR")) throw new Error("Persisted real webhook event required");
      const result = await call(`/v1/notifications/webhooks-events/${eventId}/resend`, { webhook_ids: [webhookId] });
      return { httpStatus: result.httpStatus, errorCode: result.errorCode };
    },
    async webhookRegistration(id) {
      validId(id); const result = await call(`/v1/notifications/webhooks/${id}`);
      return { httpStatus: result.httpStatus, id: identifier(result.data.id), url: typeof result.data.url === "string" && result.data.url.length <= 2048 ? result.data.url : undefined,
        eventTypes: Array.isArray(result.data.event_types) ? result.data.event_types.map(object).map(value => value.name).filter((name): name is string => typeof name === "string" && /^[A-Z0-9.*_-]{1,100}$/.test(name)) : [], errorCode: result.errorCode };
    },
    validatePayout: guard.validatePayout,
    async donationOrder(orderId) {
      validId(orderId);
      return observeOrder(await call(`/v2/checkout/orders/${orderId}`));
    },
    // IAC-379. One CAPTURE unit, custom_id is the fund ID, the amount string is built here from integer cents.
    // The request ID is the caller's persisted create UUID. This POST is not repeated here, except for the
    // single re-send in call() after a 401 (authentication rejected, so nothing was processed), same body and ID.
    async createDonationOrder(order) {
      requestUuid(order.requestId);
      if (typeof order.fundId !== "string" || !/^[a-z0-9_-]{1,64}$/.test(order.fundId)) throw new Error("Valid fund ID required");
      if (typeof order.amountCents !== "bigint" || order.amountCents <= 0n || order.amountCents > donationCeilingCents) throw new Error("Donation outside demo ceiling");
      const result = await call("/v2/checkout/orders", { intent: "CAPTURE", purchase_units: [{ custom_id: order.fundId, amount: { currency_code: "USD", value: decimal(order.amountCents) } }] }, { "PayPal-Request-Id": order.requestId });
      return { httpStatus: result.httpStatus, orderId: identifier(result.data.id), status: code(result.data.status), errorCode: result.errorCode, errorIssues: issues(result.data) };
    },
    // IAC-379. Capture uses the caller's persisted capture UUID. Callers read the order first and never
    // re-capture blindly after a timeout.
    async captureDonationOrder(orderId, captureRequestId) {
      validId(orderId); requestUuid(captureRequestId);
      const result = await call(`/v2/checkout/orders/${orderId}/capture`, {}, { "PayPal-Request-Id": captureRequestId, Prefer: "return=representation" });
      return { ...observeOrder(result), errorCode: result.errorCode, errorIssues: issues(result.data) };
    },
    async verifyWebhook(webhookId, headers, event) {
      if (!/^[A-Za-z0-9]{1,50}$/.test(webhookId) || webhookId === "WEBHOOK_ID") throw new Error("Registered sandbox webhook ID required");
      const cert = new URL(headers["paypal-cert-url"] ?? "");
      if (!["https://api-m.sandbox.paypal.com", "https://api.sandbox.paypal.com"].includes(cert.origin) || cert.username || cert.password || cert.search || cert.hash || !/^\/v1\/notifications\/certs\/CERT-[A-Za-z0-9-]+$/.test(cert.pathname)) throw new Error("Sandbox PayPal certificate URL required");
      if (headers["paypal-auth-algo"] !== "SHA256withRSA" || !/^[A-Za-z0-9_-]{1,50}$/.test(headers["paypal-transmission-id"] ?? "") || !/^[A-Za-z0-9+/=]{1,500}$/.test(headers["paypal-transmission-sig"] ?? "") || (headers["paypal-transmission-time"]?.length ?? 101) > 100 || !Number.isFinite(Date.parse(headers["paypal-transmission-time"] ?? ""))) throw new Error("Valid signature metadata required");
      const notification = object(event);
      if (typeof notification.id !== "string" || !/^WH-[A-Za-z0-9-]{1,125}$/.test(notification.id)) throw new Error("Real sandbox event ID required");
      const result = await call("/v1/notifications/verify-webhook-signature", { webhook_id: webhookId, auth_algo: headers["paypal-auth-algo"], cert_url: cert.href, transmission_id: headers["paypal-transmission-id"], transmission_sig: headers["paypal-transmission-sig"], transmission_time: headers["paypal-transmission-time"], webhook_event: notification });
      return { httpStatus: result.httpStatus, verificationStatus: result.data.verification_status === "SUCCESS" || result.data.verification_status === "FAILURE" ? result.data.verification_status : undefined };
    },
    async balance() {
      // The lab could not read balance scopes. Enabling this flag requires owner confirmation.
      if (!balanceReadable) return { readable: false };
      const result = await call("/v1/reporting/balances?currency_code=USD");
      const rows = Array.isArray(result.data.balances) ? result.data.balances.map(object).filter(row => row.currency === "USD") : [];
      if (result.httpStatus !== 200 || rows.length !== 1) return { readable: false };
      const availableCents = money(rows[0]!.available_balance, "currency_code");
      const rawTime = result.data.last_refresh_time ?? result.data.as_of_time;
      const asOf = typeof rawTime === "string" && rawTime.length <= 64 && Number.isFinite(Date.parse(rawTime)) ? rawTime : undefined;
      return availableCents === undefined ? { readable: false } : { readable: true, availableCents, asOf };
    },
    async send(payout) {
      guard.validatePayout(payout.payeeEmail, payout.amountCents);
      if (!/^AT-[a-f0-9-]{36}-[1-9][0-9]*$/.test(payout.senderBatchId) || payout.senderItemId !== `${payout.senderBatchId}-1` || payout.senderItemId.length > 63) throw new Error("Persist application sender IDs before sending");
      const result = await call("/v1/payments/payouts", { sender_batch_header: { sender_batch_id: payout.senderBatchId, email_subject: "AidTrace sandbox reimbursement" }, items: [{ recipient_type: "EMAIL", recipient_wallet: "PAYPAL", receiver: payout.payeeEmail, amount: { value: decimal(payout.amountCents), currency: "USD" }, note: "AidTrace sandbox reimbursement", sender_item_id: payout.senderItemId }] });
      const header = object(result.data.batch_header);
      const items = Array.isArray(result.data.items) ? result.data.items.map(object) : [];
      return { httpStatus: result.httpStatus, batchId: identifier(header.payout_batch_id), itemId: items.length === 1 ? identifier(items[0]!.payout_item_id) : undefined, batchStatus: code(header.batch_status), errorCode: result.errorCode };
    },
    async batch(id) {
      validId(id); const result = await call(`/v1/payments/payouts/${id}`); const header = object(result.data.batch_header);
      const sender = object(header.sender_batch_header); const items = Array.isArray(result.data.items) ? result.data.items.map(object) : [];
      return { httpStatus: result.httpStatus, batchId: identifier(header.payout_batch_id), batchStatus: code(header.batch_status), senderBatchId: identifier(sender.sender_batch_id), itemIds: items.map(item => identifier(item.payout_item_id)).filter((id): id is string => Boolean(id)), errorCode: result.errorCode };
    },
    async item(id) {
      validId(id); const result = await call(`/v1/payments/payouts-item/${id}`); const payout = object(result.data.payout_item); const fee = money(result.data.payout_item_fee);
      const feePresent = result.data.payout_item_fee !== undefined;
      const rawTime = result.data.time_processed;
      const processedOn = typeof rawTime === "string" && /^\d{4}-\d{2}-\d{2}T/.test(rawTime) && rawTime.length <= 64 && Number.isFinite(Date.parse(rawTime)) ? new Date(rawTime).toISOString().slice(0, 10) : undefined;
      return { httpStatus: result.httpStatus, itemId: identifier(result.data.payout_item_id), batchId: identifier(result.data.payout_batch_id), senderBatchId: identifier(result.data.sender_batch_id), senderItemId: identifier(payout.sender_item_id), payeeEmail: typeof payout.receiver === "string" && payout.recipient_type === "EMAIL" && (!payout.recipient_wallet || payout.recipient_wallet === "PAYPAL") ? payout.receiver : undefined, amountCents: money(payout.amount), itemStatus: code(result.data.transaction_status), feeCents: fee !== undefined && fee >= 0n ? fee : undefined, processedOn, errorCode: feePresent && (fee === undefined || fee < 0n) ? "INVALID_PROVIDER_FEE" : result.errorCode };
    },
  };
}

// Separate from the product adapter: human-invoked IAC-132 experiments only.
// Never imported by web routes, never writes the application ledger, never retries a POST.
export function createManualSandboxLab(config: PayPalConfig, request: typeof fetch = fetch) {
  const guard = createPayPalAdapter(config, request);
  let token: string | undefined;
  let tokenScopes: Set<string> | undefined;
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const identifier = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
  const code = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : undefined;
  const providerErrors = (data: Record<string, unknown>) => {
    const raw = data.errors ?? data.error;
    const errors = Array.isArray(raw) ? raw.map(object) : [object(raw)];
    return errors.map(error => ({ name: code(error.name), debugId: code(error.debug_id),
      issues: Array.isArray(error.details) ? error.details.map(object).map(detail => code(detail.issue)).filter(Boolean) : [],
    })).filter(error => error.name || error.debugId || error.issues.length);
  };
  async function call(path: string, method = "GET", body?: unknown, requestId?: string) {
    if (!token) {
      const auth = await request(`${SANDBOX_BASE_URL}/v1/oauth2/token`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials",
      });
      if (!auth.ok) throw new Error(`Sandbox OAuth failed (HTTP ${auth.status}); response withheld`);
      const result = object(await auth.json());
      if (typeof result.access_token !== "string" || !result.access_token) throw new Error("Sandbox OAuth returned no token");
      token = result.access_token;
      tokenScopes = typeof result.scope === "string" ? new Set(result.scope.split(/\s+/).filter(Boolean)) : undefined;
    }
    const response = await request(`${SANDBOX_BASE_URL}${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(requestId ? { "PayPal-Request-Id": requestId, Prefer: "return=representation" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { httpStatus: response.status, data: object(await response.json()) };
  }
  const orderId = (value: unknown) => typeof value === "string" && /^[A-Z0-9]{1,36}$/.test(value) ? value : undefined;
  const requestId = (value: string) => { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw new Error("Persist a valid lab request UUID before sending"); };
  const usd = (value: unknown) => { const entry = object(value); return entry.currency_code === "USD" && typeof entry.value === "string" && /^[0-9]+\.[0-9]{2}$/.test(entry.value) ? { currency: "USD", value: entry.value } : undefined; };
  function donationResult(result: { httpStatus: number; data: Record<string, unknown> }) {
    const id = orderId(result.data.id);
    const units = Array.isArray(result.data.purchase_units) ? result.data.purchase_units.map(object) : [];
    const links = Array.isArray(result.data.links) ? result.data.links.map(object) : [];
    let approvalUrl: string | undefined;
    for (const link of links.filter(link => link.rel === "approve" || link.rel === "payer-action")) {
      if (typeof link.href !== "string") continue;
      try {
        const url = new URL(link.href);
        if (id && url.origin === "https://www.sandbox.paypal.com" && !url.username && !url.password && url.pathname === "/checkoutnow" && url.searchParams.get("token") === id) approvalUrl = url.href;
      } catch { /* Ignore malformed provider links; never navigate to arbitrary hosts. */ }
    }
    const captures = units.flatMap(unit => {
      const payments = object(unit.payments);
      return (Array.isArray(payments.captures) ? payments.captures.map(object) : []).map(capture => {
        const breakdown = object(capture.seller_receivable_breakdown);
        return { captureId: orderId(capture.id), status: code(capture.status), amount: usd(capture.amount), gross: usd(breakdown.gross_amount), fee: usd(breakdown.paypal_fee), net: usd(breakdown.net_amount) };
      });
    });
    return { httpStatus: result.httpStatus, orderId: id, status: code(result.data.status), intent: code(result.data.intent), approvalUrl,
      purchaseUnits: units.map(unit => ({ customId: unit.custom_id === "fund_b" ? "fund_b" : undefined, amount: usd(unit.amount) })), captures,
      errorName: code(result.data.name), debugId: code(result.data.debug_id), issues: Array.isArray(result.data.details) ? result.data.details.map(object).map(detail => code(detail.issue)).filter(Boolean) : [] };
  }
  return {
    async verifyLabWebhook(webhookId: string, headers: Readonly<Record<string, string>>, event: unknown) {
      if (!/^[A-Za-z0-9]{1,50}$/.test(webhookId)) throw new Error("A registered sandbox webhook ID is required");
      const cert = new URL(headers["paypal-cert-url"] ?? "");
      if (!["https://api-m.sandbox.paypal.com", "https://api.sandbox.paypal.com"].includes(cert.origin) || cert.username || cert.password || cert.search || cert.hash || !/^\/v1\/notifications\/certs\/CERT-[A-Za-z0-9-]+$/.test(cert.pathname)) throw new Error("Sandbox PayPal certificate URL required");
      if (headers["paypal-auth-algo"] !== "SHA256withRSA" || !/^[A-Za-z0-9_-]{1,50}$/.test(headers["paypal-transmission-id"] ?? "") || !/^[A-Za-z0-9+/=]{1,500}$/.test(headers["paypal-transmission-sig"] ?? "") || (headers["paypal-transmission-time"]?.length ?? 101) > 100 || !Number.isFinite(Date.parse(headers["paypal-transmission-time"] ?? ""))) throw new Error("Valid PayPal signature metadata required");
      const notification = object(event);
      if (typeof notification.id !== "string" || !/^WH-[A-Za-z0-9-]{1,125}$/.test(notification.id) || notification.event_type !== "PAYMENT.CAPTURE.COMPLETED") throw new Error("This lab verifies real PAYMENT.CAPTURE.COMPLETED events only");
      const result = await call("/v1/notifications/verify-webhook-signature", "POST", { webhook_id: webhookId, auth_algo: headers["paypal-auth-algo"], cert_url: cert.href, transmission_id: headers["paypal-transmission-id"], transmission_sig: headers["paypal-transmission-sig"], transmission_time: headers["paypal-transmission-time"], webhook_event: notification });
      return { httpStatus: result.httpStatus, verificationStatus: result.data.verification_status === "SUCCESS" || result.data.verification_status === "FAILURE" ? result.data.verification_status : undefined, errorName: code(result.data.name), debugId: code(result.data.debug_id) };
    },
    async createOneDollarDonation(persistedRequestId: string) {
      requestId(persistedRequestId);
      if (config.maxDemoPayoutCents < 100n) throw new Error("Lab donation exceeds configured demo ceiling");
      return donationResult(await call("/v2/checkout/orders", "POST", {
        intent: "CAPTURE", purchase_units: [{ reference_id: "aidtrace-lab-fund-b", custom_id: "fund_b", description: "AidTrace sandbox feasibility donation", amount: { currency_code: "USD", value: "1.00" } }],
        payment_source: { paypal: { experience_context: { shipping_preference: "NO_SHIPPING", user_action: "CONTINUE", return_url: "http://127.0.0.1:3100/lab/paypal-return", cancel_url: "http://127.0.0.1:3100/lab/paypal-return?cancelled=1" } } },
      }, persistedRequestId));
    },
    async getDonationOrder(id: string) {
      if (!orderId(id)) throw new Error("Invalid lab order ID");
      return donationResult(await call(`/v2/checkout/orders/${id}`));
    },
    async captureOneDollarDonation(id: string, persistedRequestId: string) {
      requestId(persistedRequestId);
      if (!orderId(id)) throw new Error("Invalid lab order ID");
      if (config.maxDemoPayoutCents < 100n) throw new Error("Lab donation exceeds configured demo ceiling");
      const order = donationResult(await call(`/v2/checkout/orders/${id}`));
      if (order.httpStatus !== 200 || order.orderId !== id || order.status !== "APPROVED" || order.intent !== "CAPTURE" || order.purchaseUnits.length !== 1 || order.purchaseUnits[0]?.customId !== "fund_b" || order.purchaseUnits[0]?.amount?.currency !== "USD" || order.purchaseUnits[0]?.amount?.value !== "1.00" || order.captures.length) throw new Error("Capture requires the approved, uncaptured one-dollar fund_b lab order");
      return donationResult(await call(`/v2/checkout/orders/${id}/capture`, "POST", {}, persistedRequestId));
    },
    async getUsdBalance() {
      const result = await call("/v1/reporting/balances?currency_code=USD");
      const timestamp = (value: unknown) => typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : undefined;
      const money = (value: unknown) => {
        const entry = object(value);
        return entry.currency_code === "USD" && typeof entry.value === "string" && /^-?[0-9]+\.[0-9]{2}$/.test(entry.value) ? { currency: "USD", value: entry.value } : undefined;
      };
      const balances = Array.isArray(result.data.balances) ? result.data.balances.map(object).filter(entry => entry.currency === "USD").map(entry => ({ total: money(entry.total_balance), available: money(entry.available_balance), withheld: money(entry.withheld_balance) })) : [];
      const tokenPermissions = { balanceRead: tokenScopes?.has("https://uri.paypal.com/services/reporting/balances/read") ?? null, transactionSearchRead: tokenScopes?.has("https://uri.paypal.com/services/reporting/search/read") ?? null };
      return { httpStatus: result.httpStatus, errorName: code(result.data.name), debugId: code(result.data.debug_id), tokenPermissions, asOfTime: timestamp(result.data.as_of_time), lastRefreshTime: timestamp(result.data.last_refresh_time), balances };
    },
    async sendFiveDollarPayout(senderBatchId: string, senderItemId: string, payee: string) {
      guard.validatePayout(payee, 500n);
      if (!/^AT-LAB-[a-f0-9]{16}$/.test(senderBatchId) || senderItemId !== `${senderBatchId}-1`) throw new Error("Invalid persisted lab sender IDs");
      const result = await call("/v1/payments/payouts", "POST", {
        sender_batch_header: { sender_batch_id: senderBatchId, email_subject: "AidTrace sandbox feasibility test" },
        items: [{ recipient_type: "EMAIL", receiver: payee, amount: { value: "5.00", currency: "USD" }, note: "Sandbox lab only", sender_item_id: senderItemId }],
      });
      const header = object(result.data.batch_header);
      return { httpStatus: result.httpStatus, batchId: identifier(header.payout_batch_id), batchStatus: code(header.batch_status), errorName: code(result.data.name), debugId: code(result.data.debug_id) };
    },
    async getPayoutBatch(batchId: string) {
      if (!identifier(batchId)) throw new Error("Invalid lab batch ID");
      const result = await call(`/v1/payments/payouts/${batchId}`);
      const header = object(result.data.batch_header);
      const items = Array.isArray(result.data.items) ? result.data.items.map(object) : [];
      return { httpStatus: result.httpStatus, batchId: identifier(header.payout_batch_id), batchStatus: code(header.batch_status), itemIds: items.map(v => identifier(v.payout_item_id)).filter((v): v is string => Boolean(v)), errorName: code(result.data.name), providerErrors: providerErrors(result.data) };
    },
    async getPayoutItem(itemId: string) {
      if (!identifier(itemId)) throw new Error("Invalid lab item ID");
      const result = await call(`/v1/payments/payouts-item/${itemId}`);
      const fee = object(result.data.payout_item_fee);
      return { httpStatus: result.httpStatus, itemId: identifier(result.data.payout_item_id), itemStatus: code(result.data.transaction_status),
        fee: typeof fee.value === "string" && /^[0-9]+\.[0-9]{2}$/.test(fee.value) && typeof fee.currency === "string" && /^[A-Z]{3}$/.test(fee.currency) ? { value: fee.value, currency: fee.currency } : undefined,
        errorName: code(result.data.name), providerErrors: providerErrors(result.data) };
    },
  };
}
