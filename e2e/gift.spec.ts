import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { connectDatabase } from '../src/server/db';
import { seedFixture } from '../db/fixture';
import * as s from '../db/schema';
import { ensureFixtureOpening } from '../src/ledger/opening';
import { recordDesignatedDonation } from '../src/ledger/donation';
import { refreshClaimPayout, sendClaimPayout } from '../src/ledger/payout';
import { approveDecision, freezeDecision } from '../src/ledger/service';
import { issueGiftLink } from '../src/donation/gift-link';
import { createPayPalAdapter, type DonationObservation, type PayoutTransport, type PersistedPayout } from '../src/paypal/adapter';
import { financialHash } from '../tests/support/policy-db';

// IAC-413 PR A: the public gift trail page (docs/plans/DONOR_TRAIL_SCOPE.md section 6, GT-19 to GT-23 and the page part of GT-32).
// The real server and the real database run here. The gifts are stubbed provider observations recorded through the existing ledger
// path before the server starts, and the payout is a stubbed transport: no PayPal URL is reached. Every identifying value below is a
// distinct SENTINEL, so a leak anywhere in a response body shows up as a plain string match.
const ORIGIN = 'http://127.0.0.1:3100';
const PAYEE = 'sentinel-payee@personal.example.com';
const CLAIMANT_NAME = 'SENTINEL_CLAIMANT_Zq81'; const CLAIMANT_USER = 'sentinelclaimantuser';
const APPROVER_ONE = 'SENTINEL_APPROVER_One_7Kd'; const APPROVER_TWO = 'SENTINEL_APPROVER_Two_Hf2';
const DONOR_NAME = 'SENTINEL_DONOR_Pat_X9'; const ORDER_A = 'ORDER_SENTINEL_GIFT_A1'; const CAPTURE_A = 'CAPTURE_SENTINEL_GIFT_A1';
const ORDER_B = 'ORDER_SENTINEL_GIFT_B1'; const CAPTURE_B = 'CAPTURE_SENTINEL_GIFT_B1'; const BATCH = 'BATCHSENTINEL4D7E91C2';
const UNKNOWN_TOKEN = 'U'.repeat(43); const OTHER_UNKNOWN_TOKEN = 'V'.repeat(43);

let admin: ReturnType<typeof postgres>; let connection: ReturnType<typeof connectDatabase>; let name: string; let url: URL;
let server: ChildProcess | undefined;
let tokenA = ''; let tokenB = ''; let decisionHash = ''; let lineIds: string[] = [];
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
async function stopServer() {
  if (!server?.pid) return;
  const child = server; server = undefined;
  try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ }
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
}
function payoutTransport(): PayoutTransport {
  let sent: PersistedPayout | undefined;
  const validatePayout = createPayPalAdapter({ baseUrl: 'https://api-m.sandbox.paypal.com', clientId: 'synthetic', clientSecret: 'synthetic', payeeAllowlist: [PAYEE], maxDemoPayoutCents: 50000n },
    (async () => { throw new Error('No network in this test'); }) as unknown as typeof fetch).validatePayout;
  return {
    validatePayout, balance: async () => ({ readable: false }),
    send: async payout => { sent = payout; return { httpStatus: 201, batchId: BATCH, batchStatus: 'PENDING' }; },
    batch: async () => ({ httpStatus: 200, batchId: BATCH, senderBatchId: sent?.senderBatchId, batchStatus: 'SUCCESS', itemIds: ['ITEM_SENTINEL_1'] }),
    item: async () => ({ httpStatus: 200, itemId: 'ITEM_SENTINEL_1', batchId: BATCH, senderBatchId: sent?.senderBatchId, senderItemId: sent?.senderItemId, payeeEmail: sent?.payeeEmail, amountCents: sent?.amountCents, itemStatus: 'SUCCESS', feeCents: 25n, processedOn: '2026-10-22' }),
  };
}
const observation = (orderId: string, captureId: string, fundId: string, cents: bigint): DonationObservation => ({ httpStatus: 200, orderId, intent: 'CAPTURE', status: 'COMPLETED', units: [{ fundId, amountCents: cents }],
  captures: [{ captureId, status: 'COMPLETED', amountCents: cents, grossCents: cents, feeCents: 120n, netCents: cents - 120n, effectiveOn: '2026-10-22' }] });

test.beforeAll(async () => {
  if (process.env.UI_TEST_CONTAINER !== 'true') throw Error('OrbStack UI service required');
  url = new URL(process.env.DATABASE_URL!); url.pathname = '/postgres'; admin = postgres(url.toString(), { max: 1 });
  name = `aidtrace_gift_ui_${randomBytes(6).toString('hex')}`; await admin`create database ${admin(name)}`; url.pathname = '/' + name;
  connection = connectDatabase(url.toString());
  const { db, client } = connection;
  await migrate(db, { migrationsFolder: 'db/migrations' });
  const passwords = Object.fromEntries(['maria', 'tara', 'ben'].map(user => [user, randomBytes(18).toString('hex')]));
  await seedFixture(db, { passwords: passwords as Record<'maria' | 'tara' | 'ben', string>, payeeEmail: PAYEE, payeeAllowlist: [PAYEE] });
  await db.transaction(tx => ensureFixtureOpening(tx, 'cedar-hollow'));
  // Distinct sentinel names. The users keep their ids, so nothing that works by id changes.
  await client`update users set display_name = ${CLAIMANT_NAME}, username = ${CLAIMANT_USER} where id = 'maria'`;
  await client`update users set display_name = ${APPROVER_ONE} where id = 'tara'`;
  await client`update users set display_name = ${APPROVER_TWO} where id = 'ben'`;
  // Gift A is recorded before recognition so the USD 500 claim applies it, then the claim is approved twice and paid by a stubbed transport.
  await recordDesignatedDonation(db, 'tara', { orderId: ORDER_A, captureId: CAPTURE_A, fundId: 'fund_b', amountCents: 2500n }, { donationOrder: async () => observation(ORDER_A, CAPTURE_A, 'fund_b', 2500n) });
  // The order guard only lets a row start as CREATED, so the donor name sits on a CREATED order that carries Gift A's provider order ID. The page never reads this table.
  await db.insert(s.donationOrders).values({ fundId: 'fund_b', expectedAmountCents: 2500n, createRequestId: randomUUID(), captureRequestId: randomUUID(), displayName: DONOR_NAME });
  await client`update donation_orders set order_id = ${ORDER_A} where display_name = ${DONOR_NAME}`;
  await new Promise(resolve => setTimeout(resolve, 50));
  const frozen = await freezeDecision(db, 'C-104', 'maria');
  if (frozen.status !== 'AWAITING_APPROVAL') throw Error('Expected a funded decision');
  await approveDecision(db, frozen.decisionId, 'tara', frozen.decisionHash); await approveDecision(db, frozen.decisionId, 'ben', frozen.decisionHash);
  decisionHash = frozen.decisionHash;
  const transport = payoutTransport();
  await sendClaimPayout(db, 'C-104', 'tara', decisionHash, transport); await refreshClaimPayout(db, 'C-104', 'tara', transport);
  // Gift B arrives after recognition, so nothing applies it yet.
  await new Promise(resolve => setTimeout(resolve, 50));
  await recordDesignatedDonation(db, 'tara', { orderId: ORDER_B, captureId: CAPTURE_B, fundId: 'fund_a', amountCents: 1000n }, { donationOrder: async () => observation(ORDER_B, CAPTURE_B, 'fund_a', 1000n) });
  const a = await issueGiftLink(db, CAPTURE_A); const b = await issueGiftLink(db, CAPTURE_B);
  if (a?.state !== 'ISSUED' || b?.state !== 'ISSUED') throw Error('Expected two issued links');
  tokenA = a.token; tokenB = b.token;
  lineIds = (await client`select id from claim_lines where claim_id = 'C-104'`).map(row => row.id as string);
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3100'], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: url.toString(), APP_ORIGIN: ORIGIN, AIDTRACE_JUDGE_SESSION: '', AI_RECEIPT_ENABLED: 'false', AI_ANALYTICS_ENABLED: 'false', AI_EXPENSE_PROPOSALS_ENABLED: 'false',
      PAYPAL_PRODUCT_WEBHOOK_ENABLED: 'false', PAYPAL_BASE_URL: '', PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '', PAYPAL_SANDBOX_PAYEE_EMAIL: PAYEE, PAYEE_ALLOWLIST: PAYEE },
  });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* not up yet */ }
    if (server.exitCode !== null) throw Error('Isolated server exited');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error('Server readiness timeout');
});
test.afterAll(async () => {
  await stopServer(); await connection?.client.end();
  if (admin && /^aidtrace_gift_ui_[a-f0-9]{12}$/.test(name)) { await admin`drop database ${admin(name)} with (force)`; await admin.end(); }
});
test.describe.configure({ mode: 'serial' });

// Everything that legitimately differs between two responses of the same page: the per-request nonce, and the requested token.
const normalize = (body: string, token?: string) => (token ? body.split(token).join('TOKEN') : body).replace(/nonce="[^"]*"/g, 'nonce="N"').replace(/nonce-[A-Za-z0-9+/=]+/g, 'nonce-N')
  // The same nonce also appears inside Next's escaped flight payload, as nonce\":\"VALUE\" (found by the first GT-19 run).
  .replace(/nonce(\\*"):(\\*")[A-Za-z0-9+/=]+/g, 'nonce$1:$2N');
const SECURITY = ['referrer-policy', 'x-robots-tag', 'cache-control', 'x-content-type-options', 'content-type'];
const securityHeaders = (headers: Record<string, string>) => ({ ...Object.fromEntries(SECURITY.map(key => [key, headers[key]])), csp: normalize(headers['content-security-policy'] ?? '') });
const windowAttempts = async () => Number((await connection.client`select coalesce(max(attempts), 0)::int as n from login_windows where username = 'gift-page'`)[0]!.n);
async function cookieFor(userId: string) {
  const token = randomBytes(32).toString('hex');
  await connection.db.insert(s.sessions).values({ tokenHash: digest(token), userId, expiresAt: new Date(Date.now() + 3_600_000) });
  return `aidtrace_session=${token}`;
}
async function contained(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const width = await page.evaluate(() => innerWidth);
  for (const control of await page.locator('main a:visible, main input:visible, main button:visible, main ol, main li, main .gift-card, main .gift-panel, main .gift-footer').all()) {
    const rect = await control.boundingBox(); if (!rect) continue;
    expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.x + rect.width).toBeLessThanOrEqual(width + 0.5);
  }
}
// The app's trace stepper hides its step text at 900 px and below (the orchestrator found this after the merge with Trust v2), and the
// gift trail must not: every step title and detail keeps a real box and no clip at every width. The page stylesheet must also have
// applied, or unstyled text passes the clip check trivially: the list is a flex row above 640 px and a column at 640 and below, and
// the gift panel carries its card shadow.
async function readable(page: Page, width: number) {
  const layout = await page.getByTestId('gift-trace').evaluate(element => { const style = getComputedStyle(element); return `${style.display} ${style.flexDirection}`; });
  expect(layout).toBe(width > 640 ? 'flex row' : 'flex column');
  expect(await page.getByTestId('gift-panel').evaluate(element => getComputedStyle(element).boxShadow)).not.toBe('none');
  const texts = await page.getByTestId('gift-trace').locator('.t, .d').all();
  expect(texts.length).toBeGreaterThan(0);
  for (const text of texts) {
    const box = await text.boundingBox();
    expect(box !== null && box.width > 1 && box.height > 1).toBe(true);
    expect(await text.evaluate(element => getComputedStyle(element).clipPath)).toBe('none');
  }
}

test('GT-19: a malformed token and an unknown well-formed token give the same 404, and a malformed one never reaches the database', async ({ request }) => {
  const before = await windowAttempts();
  const malformed = await request.get('/gift/not-a-real-token', { maxRedirects: 0 });
  const shortOne = await request.get('/gift/short', { maxRedirects: 0 });
  const long = await request.get(`/gift/${'A'.repeat(44)}`, { maxRedirects: 0 });
  expect(await windowAttempts()).toBe(before); // malformed tokens take no slot and the page read no database row for them
  const unknown = await request.get(`/gift/${UNKNOWN_TOKEN}`, { maxRedirects: 0 });
  const otherUnknown = await request.get(`/gift/${OTHER_UNKNOWN_TOKEN}`, { maxRedirects: 0 });
  expect(await windowAttempts()).toBe(before + 2); // each well-formed request takes one slot
  // reached: the page awaited a database lookup before notFound(). Next streams its flight rows in an order that depends on that, so
  // one row (the 404 digest) sits at a different position (found by the first GT-19 runs). Within a class the bodies must be
  // byte-identical; across the two classes they must hold exactly the same rows. Nothing else differs.
  const responses = [[malformed, 'not-a-real-token', false], [shortOne, 'short', false], [long, 'A'.repeat(44), false], [unknown, UNKNOWN_TOKEN, true], [otherUnknown, OTHER_UNKNOWN_TOKEN, true]] as const;
  const rows = (text: string) => text.split('\\n').sort();
  const reference = normalize(await malformed.text(), 'not-a-real-token');
  const reachedReference = normalize(await unknown.text(), UNKNOWN_TOKEN);
  const referenceHeaders = securityHeaders(malformed.headers());
  for (const [response, token, reached] of responses) {
    expect(response.status(), token).toBe(404);
    const body = normalize(await response.text(), token);
    expect(body, token).toBe(reached ? reachedReference : reference);
    expect(rows(body), token).toEqual(rows(reference));
    expect(securityHeaders(response.headers()), token).toEqual(referenceHeaders);
    expect(Object.keys(response.headers()).sort(), token).toEqual(Object.keys(malformed.headers()).sort());
    expect(response.headers()['set-cookie'], token).toBeUndefined();
  }
  expect(reference).toContain('This link does not match a gift.');
  expect(reference).toContain('Gift link not found | AidTrace');
  // The page's fixed metadata title travels in Next's flight payload even on a 404, so the check is on what the trail renders, not on that title.
  for (const rendered of ['data-testid="gift-page"', 'Where your gift went', 'gift-state', 'gift-amount']) expect(reference).not.toContain(rendered);
});

test('GT-20 and GT-21: no identifying value appears in the page, and every visitor gets the identical 200 page with no cookie', async ({ request }) => {
  const claimant = await cookieFor('maria'); const approver = await cookieFor('tara');
  for (const [token, label] of [[tokenA, 'gift A (paid)'], [tokenB, 'gift B (not yet applied)']] as const) {
    const anonymous = await request.get(`/gift/${token}`, { maxRedirects: 0 });
    expect(anonymous.status(), label).toBe(200);
    const body = await anonymous.text();
    const secrets = [CLAIMANT_NAME, CLAIMANT_USER, PAYEE, 'sentinel-payee', APPROVER_ONE, APPROVER_TWO, DONOR_NAME, ORDER_A, ORDER_B, CAPTURE_A, CAPTURE_B, BATCH, decisionHash, decisionHash.slice(0, 16),
      'C-104', 'cedar-hollow', 'SENTINEL'];
    for (const secret of secrets) expect(body.includes(secret), `${label}: ${secret}`).toBe(false);
    // Found by the first GT-20 run: Next echoes the requested path segment into its own router payload, as "gift","TOKEN" and "k":"TOKEN"
    // (escaped inside the inline script). The visitor already holds that value in the URL. Nothing else may carry it.
    const withoutRouterEcho = body.replace(new RegExp(`(\\\\*"gift\\\\*",\\\\*")${token}`, 'g'), '$1T').replace(new RegExp(`(\\\\*"k\\\\*":\\\\*")${token}`, 'g'), '$1T');
    expect(body.includes(token), `${label}: the router echo is present`).toBe(true);
    expect(withoutRouterEcho.includes(token), `${label}: the token appears outside Next's router payload`).toBe(false);
    expect(body).not.toMatch(/\b(tara|ben|maria|carl)\b/i);
    for (const key of ['lineId', 'claimId', 'decisionHash', 'captureId', 'orderId', 'organizationId', 'approverName', 'displayName', 'payeeEmail', 'username', 'batchId', 'giftLinks', 'tokenHash']) expect(body.includes(key), `${label}: key ${key}`).toBe(false);
    // The same link read by the claimant, an approver, a visitor with a bogus session cookie and an anonymous visitor.
    for (const [who, cookie] of [['claimant', claimant], ['approver', approver], ['bogus cookie', 'aidtrace_session=' + 'f'.repeat(64)]] as const) {
      const other = await request.get(`/gift/${token}`, { maxRedirects: 0, headers: { cookie } });
      expect(other.status(), `${label} ${who}`).toBe(200);
      expect(normalize(await other.text()), `${label} ${who}`).toBe(normalize(body));
      expect(other.headers()['set-cookie'], `${label} ${who}`).toBeUndefined();
      expect(securityHeaders(other.headers())).toEqual(securityHeaders(anonymous.headers()));
    }
    expect(anonymous.headers()['set-cookie']).toBeUndefined();
  }
});

test('GT-22 and GT-23: privacy headers and both meta tags on the 200 page, nothing leaves the origin, no CSP violation, and the paid trail reads correctly', async ({ page }) => {
  const requested: string[] = []; const errors: string[] = [];
  page.on('request', request => requested.push(request.url()));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => { (window as unknown as { __csp: string[] }).__csp = []; document.addEventListener('securitypolicyviolation', event => (window as unknown as { __csp: string[] }).__csp.push(`${event.violatedDirective} ${event.blockedURI}`), true); });
  const response = (await page.goto(`/gift/${tokenA}`))!;
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers['referrer-policy']).toBe('no-referrer'); expect(headers['x-robots-tag']).toBe('noindex, nofollow'); expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['cache-control']).toContain('no-store');
  const csp = headers['content-security-policy']!; const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
  expect(csp).toContain("default-src 'none'"); expect(csp).toContain("style-src 'self'"); expect(csp).not.toContain('unsafe-inline'); expect(csp).not.toContain('paypal');
  expect(await page.locator('meta[name="robots"]').getAttribute('content')).toBe('noindex, nofollow');
  expect(await page.locator('meta[name="referrer"]').getAttribute('content')).toBe('no-referrer');
  expect(await page.title()).toBe('Your gift, step by step | AidTrace');
  // Every inline script carries the request nonce (the Next payload under the policy).
  expect(await page.evaluate(expected => [...document.scripts].filter(script => !script.src).every(script => script.nonce === expected), nonce)).toBe(true);
  await page.waitForLoadState('networkidle');
  // The trail: gift A was applied, approved twice and settled by the stubbed transport.
  await expect(page.getByRole('heading', { name: 'Your gift, step by step.', level: 1 })).toBeVisible();
  await expect(page.getByTestId('gift-state')).toHaveText('Your gift was applied, approved by two people and paid through PayPal.');
  await expect(page.getByTestId('gift-amount')).toHaveText('$25.00 to Tallow Creek Robot Kit Initiative');
  await expect(page.getByTestId('gift-step-1')).toContainText('Gift received');
  await expect(page.getByTestId('gift-step-2')).toContainText('1 receipt line from');
  await expect(page.getByTestId('gift-step-3')).toContainText('Two people approved');
  await expect(page.getByTestId('gift-step-4')).toContainText('Paid, batch ending 7E91C2');
  await expect(page.getByTestId('gift-trace').locator('li.done')).toHaveCount(4);
  await expect(page.getByTestId('gift-line')).toHaveCount(1);
  await expect(page.getByTestId('gift-line')).toContainText('Your $25.00 of the $280.00 line');
  await expect(page.getByTestId('gift-line')).toContainText('Paid. PayPal payout batch ending 7E91C2.');
  await expect(page.getByTestId('gift-waiting')).toHaveCount(0);
  await expect(page.getByTestId('gift-note')).toHaveCount(0);
  await expect(page.getByTestId('gift-footer')).not.toContainText('Test payments only.');
  await expect(page.getByTestId('gift-footer')).toContainText('This page shows no names or contact details. Anyone who has this link can see it.');
  await expect(page.getByTestId('gift-footer')).toContainText('Gifts are applied to approved lines oldest first. This is a narrative, not a trace of a specific purchase.');
  // No line ID is visible as a whole word anywhere on the rendered page, in text or in any attribute value.
  const rendered = await page.evaluate(() => ({ text: document.body.innerText, attributes: [...document.body.querySelectorAll('*')].flatMap(element => [...element.attributes].map(attribute => attribute.value)) }));
  for (const id of lineIds) { expect(rendered.text).not.toMatch(new RegExp(`\\b${id}\\b`)); expect(rendered.attributes).not.toContain(id); }
  expect(rendered.text).not.toContain(BATCH);
  const allowed = (target: string) => target.startsWith(`${ORIGIN}/`) || target.startsWith('data:');
  expect(requested.filter(target => !allowed(target)), 'requests outside the app origin').toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  expect(errors).toEqual([]);
  // The 404 page carries the same headers and the same two meta tags are not needed there, but the policy is.
  const missing = await page.request.get(`/gift/${UNKNOWN_TOKEN}`);
  expect(missing.status()).toBe(404);
  expect(missing.headers()['referrer-policy']).toBe('no-referrer'); expect(missing.headers()['x-robots-tag']).toBe('noindex, nofollow'); expect(missing.headers()['x-content-type-options']).toBe('nosniff');
  expect(missing.headers()['cache-control']).toContain('no-store'); expect(missing.headers()['content-security-policy']).toContain("default-src 'none'");
});

test('the unapplied gift reads as waiting, with the exact remainder and the method sentence', async ({ page }) => {
  await page.goto(`/gift/${tokenB}`);
  await expect(page.getByTestId('gift-state')).toHaveText('Your gift has arrived. It is waiting for a matching receipt.');
  await expect(page.getByTestId('gift-amount')).toHaveText('$10.00 to Ashmere County Afterschool STEM Subgrant');
  await expect(page.getByTestId('gift-waiting')).toContainText('Still waiting: $10.00 of your gift has no matching receipt yet.');
  await expect(page.getByTestId('gift-step-2')).toHaveClass(/cur/); await expect(page.getByTestId('gift-step-3')).toHaveClass(/fut/); await expect(page.getByTestId('gift-step-4')).toHaveClass(/fut/);
  await expect(page.getByTestId('gift-step-4')).toContainText('Not sent yet');
  await expect(page.getByTestId('gift-line')).toHaveCount(0);
});

test('GT-32 (gift page): no horizontal scroll and every control inside the viewport at 390, 800 and 1280, readable steps, and a full visit changes no financial table', async ({ page }) => {
  const before = await financialHash(connection.client);
  const links = await connection.client`select count(*)::int as n from gift_links`; const notes = await connection.client`select count(*)::int as n from gift_notes`;
  for (const token of [tokenA, tokenB, UNKNOWN_TOKEN, 'short']) {
    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/gift/${token}`);
      await expect(page.locator('main')).toBeVisible();
      await contained(page);
      if (token === tokenA || token === tokenB) await readable(page, width);
    }
  }
  expect(await financialHash(connection.client)).toBe(before);
  expect((await connection.client`select count(*)::int as n from gift_links`)[0]!.n).toBe(links[0]!.n);
  expect((await connection.client`select count(*)::int as n from gift_notes`)[0]!.n).toBe(notes[0]!.n);
});

// Last on purpose: it fills the shared window, then restores service by moving resets_at into the past.
test('GT-22 and GT-24: the 121st well-formed request in a minute is a real 429 with Retry-After and the privacy headers, and service returns after the window', async ({ request }) => {
  await connection.client`delete from login_windows where username = 'gift-page'`;
  const statuses: number[] = [];
  for (let i = 0; i < 120; i++) statuses.push((await request.get(`/gift/${UNKNOWN_TOKEN}`, { maxRedirects: 0 })).status());
  expect(statuses.every(code => code === 404)).toBe(true);
  const refused = await request.get(`/gift/${tokenA}`, { maxRedirects: 0 });
  expect(refused.status()).toBe(429);
  const body = await refused.text();
  expect(body).toBe('Too many requests. Try again in a minute.');
  expect(refused.headers()['retry-after']).toBe('60');
  expect(refused.headers()['referrer-policy']).toBe('no-referrer'); expect(refused.headers()['x-robots-tag']).toBe('noindex, nofollow'); expect(refused.headers()['x-content-type-options']).toBe('nosniff');
  expect(refused.headers()['cache-control']).toContain('no-store'); expect(refused.headers()['content-security-policy']).toContain("default-src 'none'");
  for (const secret of ['Tallow Creek', '$25.00', 'Paid', 'SENTINEL', tokenA]) expect(body.includes(secret), secret).toBe(false);
  // Malformed tokens take no slot and are still answered while the window is full.
  expect((await request.get('/gift/short', { maxRedirects: 0 })).status()).toBe(404);
  expect(await windowAttempts()).toBe(121);
  await connection.client`update login_windows set resets_at = now() - interval '1 second' where username = 'gift-page'`;
  expect((await request.get(`/gift/${tokenA}`, { maxRedirects: 0 })).status()).toBe(200);
  expect(await windowAttempts()).toBe(1);
});
