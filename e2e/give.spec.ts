import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { connectDatabase } from '../src/server/db';
import { seedFixture } from '../db/fixture';
import { ensureFixtureOpening } from '../src/ledger/opening';

// IAC-379 step 3a, DON-10. The real server, real database and real route run here. The PayPal SDK is a LOCAL STUB that
// only drives the same callbacks the real buttons call, and the donation API answers are CANNED where a scenario needs a
// provider result. This is stubbed wiring evidence, not a PayPal result: no PayPal URL is ever reached, no popup, no
// sandbox buyer, and `actions.restart()` is a counter here.
const ORIGIN = 'http://127.0.0.1:3100';
const KEYLESS_ENV = { PAYPAL_BASE_URL: '', PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '' };
const KEYED_ENV = { PAYPAL_BASE_URL: 'https://api-m.sandbox.paypal.com', PAYPAL_CLIENT_ID: 'e2e-fake-client-id', PAYPAL_CLIENT_SECRET: 'e2e-fake-secret' };
const FUND = 'Ashmere County Afterschool STEM Subgrant';
const ROW = '11111111-2222-4333-8444-555555555555';
const SDK_STUB = `window.paypal = { Buttons(config) { return {
  async render(el) {
    const button = document.createElement('button'); button.type = 'button'; button.id = 'stub-pay'; button.textContent = 'Stub PayPal button';
    button.addEventListener('click', async () => {
      try { await config.onClick({}, { resolve: () => Promise.resolve(), reject: () => Promise.reject(new Error('rejected')) }); } catch { return; }
      let orderID;
      try { orderID = await config.createOrder(); } catch (error) { config.onError(error); return; }
      await config.onApprove({ orderID }, { restart: async () => { window.__restarts = (window.__restarts || 0) + 1; } });
    });
    el.appendChild(button);
  },
  async close() {},
}; } };`;

let admin: ReturnType<typeof postgres>; let connection: ReturnType<typeof connectDatabase>; let name: string; let url: URL;
let server: ChildProcess | undefined; let userPasswords: Record<string, string> = {};
async function stopServer() {
  if (!server?.pid) return;
  const child = server; server = undefined;
  try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ }
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
}
async function startServer(extra: Record<string, string>) {
  await stopServer();
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3100'], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: url.toString(), APP_ORIGIN: ORIGIN, AIDTRACE_JUDGE_SESSION: '', AI_ANALYTICS_ENABLED: 'false', PAYPAL_PRODUCT_WEBHOOK_ENABLED: 'false', ...extra },
  });
  server = child;
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* not up yet */ }
    if (child.exitCode !== null) throw Error('Isolated server exited');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error('Server readiness timeout');
}
test.beforeAll(async () => {
  if (process.env.UI_TEST_CONTAINER !== 'true') throw Error('OrbStack UI service required');
  url = new URL(process.env.DATABASE_URL!); url.pathname = '/postgres'; admin = postgres(url.toString(), { max: 1 });
  name = `aidtrace_give_ui_${randomBytes(6).toString('hex')}`; await admin`create database ${admin(name)}`; url.pathname = '/' + name;
  connection = connectDatabase(url.toString());
  await migrate(connection.db, { migrationsFolder: 'db/migrations' });
  const passwords = Object.fromEntries(['maria', 'tara', 'ben'].map(user => [user, randomBytes(18).toString('hex')]));
  userPasswords = passwords as Record<string, string>;
  await seedFixture(connection.db, { passwords: passwords as Record<'maria' | 'tara' | 'ben', string>, payeeEmail: 'synthetic-ui@personal.example.com', payeeAllowlist: ['synthetic-ui@personal.example.com'] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, 'cedar-hollow'));
});
test.afterAll(async () => {
  await stopServer(); await connection?.client.end();
  if (admin && /^aidtrace_give_ui_[a-f0-9]{12}$/.test(name)) { await admin`drop database ${admin(name)} with (force)`; await admin.end(); }
});
const orderRows = async () => Number((await connection.client`select count(*)::int as n from donation_orders`)[0]!.n);
async function contained(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const width = await page.evaluate(() => innerWidth);
  for (const control of await page.locator('main select, main input:visible, main button:visible, main details, main pre').all()) {
    const rect = await control.boundingBox(); if (!rect) continue;
    expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.x + rect.width).toBeLessThanOrEqual(width + 0.5);
  }
}
// Counts every request that leaves localhost and watches for page errors and CSP violations.
async function watch(page: Page) {
  const watched = { external: [] as string[], errors: [] as string[], allowedHits: [] as string[] };
  page.on('pageerror', error => watched.errors.push(error.message));
  await page.addInitScript(() => { (window as unknown as { __csp: string[] }).__csp = []; document.addEventListener('securitypolicyviolation', event => (window as unknown as { __csp: string[] }).__csp.push(`${event.violatedDirective} ${event.blockedURI}`), true); });
  await page.route('**/*', route => {
    const target = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(target.hostname)) return route.continue();
    watched.external.push(target.toString()); return route.abort();
  });
  return watched;
}
const violations = (page: Page) => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

test.describe.configure({ mode: 'serial' });

test('DON-10 keyless: /give shows the read-only panel at 375 and 1280, loads no SDK, refuses actions, creates nothing', async ({ page }) => {
  await startServer(KEYLESS_ENV);
  const watched = await watch(page);
  const response = await page.goto('/give');
  expect(response!.status()).toBe(200);
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const panel = page.getByTestId('give-keyless-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'No order created, nothing captured' })).toBeVisible();
    await expect(panel).toContainText('Not started'); await expect(panel).toContainText(FUND);
    await expect(panel).toContainText('$5.00, $10.00, $25.00, Other amount');
    await expect(panel.locator('dd', { hasText: 'Unassigned' })).toHaveCount(2);
    await expect(panel.locator('pre')).toContainText('"value": "25.00"');
    await contained(page);
  }
  await expect(page.getByTestId('give-keyed')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /paypal|pay|give|donate/i })).toHaveCount(0);
  expect(await page.locator('script[data-give-sdk]').count()).toBe(0);
  expect(await page.evaluate(() => [...document.scripts].some(script => /paypal/i.test(script.src)))).toBe(false);
  expect(await page.content()).not.toMatch(/paypal\.com\/sdk|e2e-fake/);
  expect(await page.getByText(/Paid\b|Capture ID ending/).count()).toBe(0);
  // CSP is route-scoped: present on /give with a nonce, absent on the home page.
  expect(response!.headers()['content-security-policy']).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{16,}'/);
  expect((await page.request.get('/')).headers()['content-security-policy']).toBeUndefined();
  // Every action is refused before any provider path.
  const create = { action: 'create', fundId: 'fund_a', amountCents: '500' };
  const refused = await page.request.post('/api/donations', { data: create, headers: { origin: ORIGIN } });
  expect(refused.status()).toBe(403); expect(await refused.json()).toEqual({ error: 'Donations are not available in this session. No order was created, nothing was captured.' });
  expect((await page.request.post('/api/donations', { data: create })).status()).toBe(403);
  expect((await page.request.post('/api/donations', { data: create, headers: { origin: 'https://evil.example' } })).status()).toBe(403);
  expect((await page.request.post('/api/donations', { data: { action: 'capture', id: ROW, orderId: 'X' }, headers: { origin: ORIGIN } })).status()).toBe(403);
  expect(await orderRows()).toBe(0);
  expect(await violations(page)).toEqual([]); expect(watched.errors).toEqual([]); expect(watched.external).toEqual([]);
});

type Canned = { status?: number; json?: unknown; abort?: boolean; raw?: string; contentType?: string };
async function keyedPage(page: Page) {
  const watched = await watch(page);
  const posts: Record<string, string>[] = []; const api: Record<string, (body: Record<string, string>) => Canned> = {};
  // Routes registered later run first, so this one answers the SDK URL and the catch-all in watch() never sees it.
  await page.route(/^https:\/\/www\.paypal\.com\/sdk\/js\?/, route => { watched.allowedHits.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'text/javascript', body: SDK_STUB }); });
  await page.route('**/api/donations', route => {
    const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, string>; posts.push(body);
    const canned = api[body.action ?? '']?.(body); if (!canned) return route.fulfill({ status: 500, body: 'unscripted' });
    if (canned.abort) return route.abort('failed');
    if (canned.raw !== undefined) return route.fulfill({ status: canned.status ?? 200, contentType: canned.contentType ?? 'text/plain', body: canned.raw });
    return route.fulfill({ status: canned.status ?? 200, contentType: 'application/json', body: JSON.stringify(canned.json) });
  });
  const response = await page.goto('/give');
  await expect(page.getByTestId('give-keyed')).toBeVisible(); await expect(page.locator('#stub-pay')).toBeVisible();
  return { watched, posts, api, response: response! };
}
const created = (extra: Record<string, unknown> = {}) => ({ id: ROW, status: 'CREATED', messageKey: 'CREATED', message: 'Your order is ready. Approve it with PayPal to continue. Nothing is charged until you approve.', orderId: 'E2E-ORDER-1', ...extra });
const status = (page: Page) => page.getByTestId('give-status');
const restarts = (page: Page) => page.evaluate(() => (window as unknown as { __restarts?: number }).__restarts ?? 0);

test('DON-10 keyed (stubbed SDK): form, nonce CSP, hydration and layout at 375 and 1280', async ({ page }) => {
  await startServer(KEYED_ENV);
  const { watched, posts, response } = await keyedPage(page);
  const csp = response.headers()['content-security-policy']!; const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
  expect(csp).toContain("object-src 'none'"); expect(csp).toContain("frame-ancestors 'none'");
  // The SDK request is the only external one, with the sandbox client ID and no secret anywhere.
  expect(watched.allowedHits).toHaveLength(1);
  const sdk = new URL(watched.allowedHits[0]!);
  expect(Object.fromEntries(sdk.searchParams)).toEqual({ 'client-id': 'e2e-fake-client-id', components: 'buttons', currency: 'USD', intent: 'capture' });
  expect(await page.content()).not.toContain('e2e-fake-secret');
  // The page script carries the request nonce, and so do Next's own scripts (hydration under the policy).
  expect(await page.locator('script[data-give-sdk]').getAttribute('data-csp-nonce')).toBe(nonce);
  expect(await page.evaluate(expected => document.querySelector<HTMLScriptElement>('script[data-give-sdk]')!.nonce === expected, nonce)).toBe(true);
  expect(await page.evaluate(expected => [...document.scripts].filter(script => !script.hasAttribute('data-give-sdk')).some(script => script.nonce === expected), nonce)).toBe(true);
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const summary = page.getByTestId('give-summary');
    await expect(summary).toHaveText(`You are giving $25.00 to ${FUND}.`);
    await page.getByLabel('$10.00').check(); await expect(summary).toHaveText(`You are giving $10.00 to ${FUND}.`);
    await page.getByLabel('Other amount', { exact: true }).check();
    const custom = page.getByLabel('Other amount in USD');
    await custom.fill('abc'); await expect(summary).toHaveText('Choose a fund and an amount greater than zero.');
    await custom.fill('0.00'); await expect(summary).toHaveText('Choose a fund and an amount greater than zero.');
    await custom.fill('12.5'); await expect(summary).toHaveText(`You are giving $12.50 to ${FUND}.`);
    await page.getByLabel('Fund').selectOption({ label: 'Tallow Creek Robot Kit Initiative' }); await expect(summary).toHaveText('You are giving $12.50 to Tallow Creek Robot Kit Initiative.');
    await page.getByLabel('$25.00').check(); await page.getByLabel('Fund').selectOption({ label: FUND });
    await expect(page.locator('#stub-pay')).toBeVisible(); await contained(page);
  }
  // An unusable amount stops the button before any request is sent.
  await page.getByLabel('Other amount', { exact: true }).check(); await page.getByLabel('Other amount in USD').fill('0');
  await page.locator('#stub-pay').click();
  await expect(status(page)).toHaveText('Choose a fund and an amount greater than zero first.'); expect(posts).toEqual([]);
  // Real route, real database, nothing created: a same-origin malformed body is refused before any provider path.
  expect((await page.request.post('/api/donations', { data: { action: 'bogus' }, headers: { origin: ORIGIN } })).status()).toBe(400);
  expect((await page.request.post('/api/donations', { data: { action: 'create', fundId: 'fund_a', amountCents: '500' }, headers: { origin: 'https://evil.example' } })).status()).toBe(403);
  expect(await orderRows()).toBe(0);
  expect(await violations(page)).toEqual([]); expect(watched.errors).toEqual([]); expect(watched.external).toEqual([]);
});

test('DON-10 keyed, WD-03 (stubbed SDK, canned API): completed gift shows only the recorded capture tail and offers Give again', async ({ page }) => {
  await startServer(KEYED_ENV);
  const { watched, posts, api } = await keyedPage(page);
  api.create = () => ({ json: created() });
  api.capture = () => ({ json: { id: ROW, status: 'COMPLETED', messageKey: 'COMPLETED', message: 'Thank you. Your gift is recorded.', captureTail: 'ABC123' } });
  await page.getByLabel('$10.00').check(); await page.getByLabel('Your first name, to address your thank-you note (optional)').fill('Pat Example');
  await expect(page.getByLabel('Your first name, to address your thank-you note (optional)')).toHaveAccessibleDescription(/This is not a message/); // WD-03
  await page.locator('#stub-pay').click();
  await expect(page.getByTestId('give-done')).toContainText('Capture ID ending in ABC123.');
  await expect(status(page)).toHaveText('Thank you. Your gift is recorded.');
  expect(posts).toEqual([{ action: 'create', fundId: 'fund_a', amountCents: '1000', displayName: 'Pat Example' }, { action: 'capture', id: ROW, orderId: 'E2E-ORDER-1' }]);
  await expect(page.locator('#stub-pay')).toHaveCount(0);
  await page.getByRole('button', { name: 'Give again' }).click();
  await expect(page.locator('#stub-pay')).toBeVisible(); await expect(page.getByTestId('give-done')).toHaveCount(0); await expect(status(page)).toHaveText('');
  await contained(page);
  expect(await orderRows()).toBe(0); expect(await violations(page)).toEqual([]); expect(watched.errors).toEqual([]); expect(watched.external).toEqual([]);
});

test('DON-10 keyed (stubbed SDK, canned API): a declined capture shows the owner wording and restarts the PayPal flow', async ({ page }) => {
  await startServer(KEYED_ENV);
  const { watched, api } = await keyedPage(page);
  api.create = () => ({ json: created() });
  api.capture = () => ({ json: { id: ROW, status: 'DECLINED', messageKey: 'DECLINED', message: 'PayPal declined this payment, so it did not go through. You can try again, or use a different card or PayPal account. 1 attempt left.', attemptsLeft: 1, restart: true } });
  await page.locator('#stub-pay').click();
  await expect(status(page)).toContainText('1 attempt left.'); await expect.poll(() => restarts(page)).toBe(1);
  await expect(page.getByTestId('give-done')).toHaveCount(0); await expect(status(page)).not.toContainText(/Thank you|recorded|Capture ID/);
  expect(await orderRows()).toBe(0); expect(await violations(page)).toEqual([]); expect(watched.errors).toEqual([]); expect(watched.external).toEqual([]);
});

test('DON-10 keyed (stubbed SDK, canned API): an unconfirmed create offers Try again, resumes the same row and never creates a second order', async ({ page }) => {
  await startServer(KEYED_ENV);
  const { watched, posts, api } = await keyedPage(page);
  let resumed = false;
  api.create = () => ({ json: { id: ROW, status: 'CREATED', messageKey: 'CREATE_UNCONFIRMED', message: 'We could not confirm the order with PayPal yet.', retry: true } });
  api.resume = () => { resumed = true; return { json: created() }; };
  api.capture = () => ({ json: { id: ROW, status: 'COMPLETED', messageKey: 'COMPLETED', message: 'Thank you. Your gift is recorded.', captureTail: 'ZZ9988' } });
  await page.locator('#stub-pay').click();
  await expect(status(page)).toHaveText('We could not confirm the order with PayPal yet.'); // onError stays quiet after createOrder spoke
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(status(page)).toContainText('We confirmed your order with PayPal. Choose a PayPal button to continue.'); expect(resumed).toBe(true);
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await page.locator('#stub-pay').click();
  await expect(page.getByTestId('give-done')).toContainText('Capture ID ending in ZZ9988.');
  expect(posts.map(post => post.action)).toEqual(['create', 'resume', 'capture']); // the confirmed order was reused, no second create
  expect(posts[1]).toEqual({ action: 'resume', id: ROW }); expect(posts[2]).toEqual({ action: 'capture', id: ROW, orderId: 'E2E-ORDER-1' });
  expect(await orderRows()).toBe(0); expect(await violations(page)).toEqual([]); expect(watched.errors).toEqual([]); expect(watched.external).toEqual([]);
});

test('DON-10 keyed (stubbed SDK, canned API): a lost capture answer is never reported as recorded or as not paid', async ({ page }) => {
  await startServer(KEYED_ENV);
  const { watched, posts, api } = await keyedPage(page);
  api.create = () => ({ json: created() });
  api.capture = () => ({ abort: true });
  await page.locator('#stub-pay').click();
  await expect(status(page)).toHaveText('We could not confirm this payment. Please do not pay again. Reload this page later to check.');
  await expect(page.getByTestId('give-done')).toHaveCount(0); await expect(status(page)).not.toContainText(/Thank you|recorded|Capture ID/);
  expect(posts.map(post => post.action)).toEqual(['create', 'capture']);
  expect(await orderRows()).toBe(0); expect(await violations(page)).toEqual([]); expect(watched.errors).toEqual([]); expect(watched.external).toEqual([]);
});

// IAC-396 run 4 question: a capture answer that is not the server's JSON (a proxy 502 page, an empty 500) arrives after the
// donor approved, so the capture may already have happened. It must stay unknown and never invite a second payment.
const UNCERTAIN = 'We could not confirm this payment. Please do not pay again. Reload this page later to check.';
test('DON-10 keyed (stubbed SDK, canned API): a capture answer without the server JSON stays unknown and never says nothing was recorded', async ({ page }) => {
  await startServer(KEYED_ENV);
  const { watched, posts, api } = await keyedPage(page);
  api.create = () => ({ json: created() });
  const scenarios: { label: string; canned: Canned; text: string }[] = [
    { label: '502 HTML', canned: { status: 502, contentType: 'text/html', raw: '<html><body><h1>502 Bad Gateway</h1></body></html>' }, text: UNCERTAIN },
    { label: '500 empty', canned: { status: 500, raw: '' }, text: UNCERTAIN },
    { label: '200 empty', canned: { status: 200, raw: '' }, text: UNCERTAIN },
    { label: '500 server error string', canned: { status: 500, json: { error: 'We could not complete this payment. If you already approved a payment in PayPal, please do not pay again.' } }, text: 'We could not complete this payment. If you already approved a payment in PayPal, please do not pay again.' },
  ];
  for (const scenario of scenarios) {
    api.capture = () => scenario.canned;
    await page.locator('#stub-pay').click();
    await expect(status(page), scenario.label).toHaveText(scenario.text);
    await expect(status(page), scenario.label).not.toContainText(/Nothing was recorded|try again/i);
    await expect(page.getByTestId('give-done')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  }
  expect(posts.map(post => post.action)).toEqual(['create', 'capture', 'create', 'capture', 'create', 'capture', 'create', 'capture']);
  expect(await orderRows()).toBe(0); expect(await violations(page)).toEqual([]); expect(watched.errors).toEqual([]); expect(watched.external).toEqual([]);
});

// The pre-approval paths keep their text: a create answer without the server JSON still says nothing was recorded.
test('DON-10 keyed (stubbed SDK, canned API): a create answer without the server JSON keeps the nothing-recorded wording', async ({ page }) => {
  await startServer(KEYED_ENV);
  const { watched, posts, api } = await keyedPage(page);
  api.create = () => ({ status: 502, contentType: 'text/html', raw: '<html>502</html>' });
  await page.locator('#stub-pay').click();
  await expect(status(page)).toHaveText('Something went wrong. Nothing was recorded. Please try again.');
  expect(posts.map(post => post.action)).toEqual(['create']);
  expect(await orderRows()).toBe(0); expect(await violations(page)).toEqual([]); expect(watched.errors).toEqual([]); expect(watched.external).toEqual([]);
});

// IAC-413 PR A, thank-you part of GT-32 (docs/plans/DONOR_TRAIL_SCOPE.md section 3.7). The capture answer is CANNED here and carries the
// one-time token the real route issues (tests/donation-routes.integration.test.ts proves the real route does). This is stubbed wiring
// evidence for the panel, not a PayPal result.
test('IAC-413: the one-time private link shows once, copies, sits in no storage, cookie or URL, and Give again clears it', async ({ page, context }) => {
  await startServer(KEYED_ENV);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const { watched, api } = await keyedPage(page);
  const TOKEN = `Zk3_-${'a'.repeat(38)}`;
  let answer: Record<string, unknown> = { giftLinkState: 'ISSUED', giftToken: TOKEN };
  api.create = () => ({ json: created() });
  api.capture = () => ({ json: { id: ROW, status: 'COMPLETED', messageKey: 'COMPLETED', message: 'Thank you. Your gift is recorded.', captureTail: 'ABC123', ...answer } });
  await page.locator('#stub-pay').click();
  const panel = page.getByTestId('gift-link-panel');
  await expect(page.getByTestId('give-done')).toContainText('Capture ID ending in ABC123.');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Your private link', level: 2 })).toBeVisible();
  await expect(panel).toContainText('It is shown only once and we do not keep it, so save it now.');
  await expect(page.getByTestId('gift-link-field')).toHaveValue(`${ORIGIN}/gift/${TOKEN}`);
  await expect(page.getByTestId('gift-link-field')).toHaveAttribute('readonly', '');
  const open = page.getByTestId('gift-link-open');
  await expect(open).toHaveAttribute('href', `${ORIGIN}/gift/${TOKEN}`); await expect(open).toHaveAttribute('target', '_blank'); await expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 }); await contained(page);
    const rect = (await open.boundingBox())!; expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.x + rect.width).toBeLessThanOrEqual(width + 0.5);
  }
  // Copy: the status line announces it and the clipboard holds exactly the link.
  await expect(page.getByTestId('gift-link-status')).toHaveText('');
  await page.getByTestId('gift-link-copy').click();
  await expect(page.getByTestId('gift-link-status')).toHaveText('Link copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${ORIGIN}/gift/${TOKEN}`);
  // The token lives in component state only: not in any storage, cookie or the page URL.
  const holds = async () => ({
    local: await page.evaluate(() => JSON.stringify({ ...localStorage })), session: await page.evaluate(() => JSON.stringify({ ...sessionStorage })),
    cookie: await page.evaluate(() => document.cookie), jar: JSON.stringify(await context.cookies()), url: page.url(),
  });
  for (const [where, value] of Object.entries(await holds())) expect(value.includes(TOKEN), where).toBe(false);
  // Give again clears it from the page.
  await page.getByRole('button', { name: 'Give again' }).click();
  await expect(panel).toHaveCount(0); await expect(page.getByTestId('gift-link-field')).toHaveCount(0);
  expect((await page.content()).includes(TOKEN)).toBe(false);
  for (const [where, value] of Object.entries(await holds())) expect(value.includes(TOKEN), where).toBe(false);
  // A later completion that reports the link was shown before offers no link and no token.
  answer = { giftLinkState: 'SHOWN_BEFORE' };
  await page.locator('#stub-pay').click();
  await expect(page.getByTestId('gift-link-shown-before')).toHaveText('A private link for this gift was shown earlier. It cannot be shown again.');
  await expect(page.getByTestId('gift-link-field')).toHaveCount(0); await expect(page.getByTestId('gift-link-copy')).toHaveCount(0);
  await contained(page);
  expect(await orderRows()).toBe(0); expect(await violations(page)).toEqual([]); expect(watched.errors).toEqual([]); expect(watched.external).toEqual([]);
});

// CL-E04 (November 10 calm cuts, docs/GATE_REPORT.md section 119). The keyless request shape is collapsed until opened, and the way back appears only for a visitor with a live session.
test('CL-E04 keyless give: the request shape starts collapsed, and Back to your workspace shows only for a signed-in visitor', async ({ page }) => {
  await startServer(KEYLESS_ENV);
  const panel = () => page.getByTestId('give-keyless-panel');
  await page.goto('/give'); await expect(panel()).toBeVisible();
  await expect(page.getByTestId('give-back')).toHaveCount(0);
  const shape = panel().locator('details'); await expect(shape).toHaveCount(1);
  expect(await shape.evaluate(node => (node as HTMLDetailsElement).open)).toBe(false); await expect(panel().locator('pre')).toBeHidden();
  await panel().getByText('Request shape the server would send').click(); await expect(panel().locator('pre')).toBeVisible(); await expect(panel().locator('pre')).toContainText('"value": "25.00"');
  await page.goto('/login'); await page.getByLabel('Username').fill('tara'); await page.getByLabel('Password').fill(userPasswords.tara!); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.waitForURL(target => target.pathname === '/');
  await page.goto('/give'); const back = page.getByTestId('give-back'); await expect(back).toHaveText('Back to your workspace');
  const box = (await back.boundingBox())!; expect(box.height).toBeGreaterThanOrEqual(44);
  await back.click(); await page.waitForURL(target => target.pathname === '/');
  expect(await orderRows()).toBe(0);
});
