import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { connectDatabase } from '../src/server/db';
import { seedFixture } from '../db/fixture';
import * as s from '../db/schema';
import { ensureFixtureOpening } from '../src/ledger/opening';
import { recordDesignatedDonation } from '../src/ledger/donation';
import { sendClaimPayout } from '../src/ledger/payout';
import { approveDecision, freezeDecision } from '../src/ledger/service';
import { loadDonationsGrid, type DonationRow } from '../src/donation/donations-grid';
import { usd } from '../src/analytics/model';
import { createPayPalAdapter, type DonationObservation, type PayoutTransport } from '../src/paypal/adapter';
import { financialHash, tableHash } from '../tests/support/policy-db';
import { centerOverflow, EDGE_TOLERANCE, measureEdge, measureFilters, measureLongCell, measureWrap, MIN_FILTER_INPUT, rowOverlaps, scrollSideways } from './grid-edge';

// IAC-413 PR B: the approver-only /donations grid in a real browser against a real isolated PostgreSQL and a production build
// (GT-27, GT-31 and the grid part of GT-32). Every provider is a scripted stand-in written
// in this file: gifts are stubbed provider observations recorded through the existing ledger path, and the one payout is a stubbed
// transport whose send never answers, so its outcome is UNKNOWN. No PayPal request is made and nothing below is a provider result.
// Each test starts a fresh browser context, so saved grid state never leaks.
const ORIGIN = 'http://127.0.0.1:3100';
const PAYEE = 'donations-ui@personal.example.com';
const STATE_KEY = 'aidtrace.grid.v1.tara.donations';
const BIG = 9007199254740993n;
const BIG_TEXT = '$90,071,992,547,409.93';
const OTHER_ORG = 'Quillmoor Private Organization'; const OTHER_FUND = 'Quillmoor Restricted Fund'; const OTHER_DONOR = 'Quill Other Donor';
const OTHER_ORDER = 'DG_OTHER_ORDER_Q7'; const OTHER_CAPTURE = 'DG_OTHER_CAPTURE_Q7'; const OTHER_CENTS = 424242n;
const FULL_IDS = ['ORDER_DG_APPLIED', 'CAPTURE_DG_APPLIED_01', 'CAPTURE_DG_W1', 'CAPTURE_DG_W2', 'CAPTURE_DG_W3', 'CAPTURE_DG_W4', 'CAPTURE_DG_W5', 'CAPTURE_DG_W6', 'DG_BIG_CAPTURE_1', 'DG_TAB_CAPTURE', 'DG_CR_CAPTURE', 'ORDER_DG_W1'];
const HEADERS = ['Received', 'Donor', 'Amount', 'Fund', 'Capture', 'State', 'Matched', 'Waiting', 'Lines', 'Vendor', 'Status', 'PayPal reference'];
// Tab and carriage return are JSON-escaped inside the page's flight payload, so only printable tails can be searched for in the raw HTML.
const PRINTABLE_TAIL = /^[\x20-\x7e]{6}$/;
const FIELDS = ['received', 'donor', 'amountCents', 'fund', 'capture', 'state', 'matchedCents', 'waitingCents', 'lines', 'vendor', 'payoutStatus', 'paypalReference'];
const PHONE_COLUMNS = ['received', 'amountCents', 'state', 'payoutStatus'];

let admin: ReturnType<typeof postgres>; let connection: ReturnType<typeof connectDatabase>; let name: string; let url: URL;
let server: ChildProcess | undefined; let passwords: Record<string, string>; let baseline: string; let linksBaseline: { count: number; hash: string };
test.use({ isMobile: false, hasTouch: false });

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function stopServer() {
  if (!server?.pid) return;
  const child = server; server = undefined;
  try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ }
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
}
// A transport whose send never answers: the payout outcome is UNKNOWN, never paid and never failed.
function unknownTransport(): PayoutTransport {
  const validatePayout = createPayPalAdapter({ baseUrl: 'https://api-m.sandbox.paypal.com', clientId: 'synthetic', clientSecret: 'synthetic', payeeAllowlist: [PAYEE], maxDemoPayoutCents: 50000n },
    (async () => { throw new Error('No network in this test'); }) as unknown as typeof fetch).validatePayout;
  const refuse = async () => { throw new Error('synthetic network timeout'); };
  return { validatePayout, balance: async () => ({ readable: false }), send: refuse, batch: refuse, item: refuse };
}
const observation = (orderId: string, captureId: string, fundId: string, cents: bigint, effectiveOn: string): DonationObservation => {
  const fee = cents >= 1000n ? 120n : 0n;
  return { httpStatus: 200, orderId, intent: 'CAPTURE', status: 'COMPLETED', units: [{ fundId, amountCents: cents }],
    captures: [{ captureId, status: 'COMPLETED', amountCents: cents, grossCents: cents, feeCents: fee, netCents: cents - fee, effectiveOn }] };
};
// A donor name goes on a CREATED order row first (the order guard only lets a row start as CREATED), then the provider order id is attached.
async function nameDonor(orderId: string, fundId: string, cents: bigint, displayName: string) {
  const createRequestId = randomUUID();
  await connection.db.insert(s.donationOrders).values({ fundId, expectedAmountCents: cents, createRequestId, captureRequestId: randomUUID(), displayName });
  await connection.client`update donation_orders set order_id = ${orderId} where create_request_id = ${createRequestId}`;
}
async function gift(key: string, fundId: string, cents: bigint, effectiveOn: string, donor?: string) {
  const orderId = `ORDER_DG_${key}`; const captureId = `CAPTURE_DG_${key}`;
  await recordDesignatedDonation(connection.db, 'tara', { orderId, captureId, fundId, amountCents: cents }, { donationOrder: async () => observation(orderId, captureId, fundId, cents, effectiveOn) });
  if (donor) await nameDonor(orderId, fundId, cents, donor);
  await pause(30); // distinct recorded_at values keep the order of the gifts stable
}
// Direct receipt rows in a throwaway database: an amount past 2^53, and two capture IDs whose last 6 characters begin with a tab and a carriage return.
// Fund names, donor names and vendors are cleaned of control characters before they reach a row, so the masked capture tail is the one text cell
// where a tab or carriage return can still start a value (GT-31).
async function directReceipt(orderId: string, captureId: string, fundId: string, cents: bigint, effectiveOn: string) {
  await connection.client`insert into donation_receipts (order_id, organization_id, fund_id, expected_amount_cents, capture_id, status, provider_status, gross_cents, fee_cents, net_cents, effective_on, recorded_by)
    values (${orderId}, 'cedar-hollow', ${fundId}, ${cents.toString()}, ${captureId}, 'COMPLETED', 'COMPLETED', ${cents.toString()}, 0, ${cents.toString()}, ${effectiveOn}::date, 'tara')`;
}

test.beforeAll(async () => {
  if (process.env.UI_TEST_CONTAINER !== 'true') throw Error('OrbStack UI service required');
  url = new URL(process.env.DATABASE_URL!); url.pathname = '/postgres'; admin = postgres(url.toString(), { max: 1 });
  name = `aidtrace_donations_ui_${randomBytes(6).toString('hex')}`; await admin`create database ${admin(name)}`; url.pathname = '/' + name;
  connection = connectDatabase(url.toString());
  const { db, client } = connection;
  await migrate(db, { migrationsFolder: 'db/migrations' });
  passwords = Object.fromEntries(['maria', 'tara', 'ben'].map(user => [user, randomBytes(18).toString('hex')]));
  await seedFixture(db, { passwords: passwords as Record<'maria' | 'tara' | 'ben', string>, payeeEmail: PAYEE, payeeAllowlist: [PAYEE] });
  await db.transaction(tx => ensureFixtureOpening(tx, 'cedar-hollow'));
  // One gift is recorded before recognition, so the USD 500 claim applies it. The claim is approved twice and its payout send never answers.
  await gift('APPLIED', 'fund_b', 2500n, '2026-10-22', 'Pat Rivera');
  const frozen = await freezeDecision(db, 'C-104', 'maria');
  if (frozen.status !== 'AWAITING_APPROVAL') throw Error('Expected a funded decision');
  await approveDecision(db, frozen.decisionId, 'tara', frozen.decisionHash); await approveDecision(db, frozen.decisionId, 'ben', frozen.decisionHash);
  await sendClaimPayout(db, 'C-104', 'tara', frozen.decisionHash, unknownTransport());
  await pause(30);
  // Gifts that arrive after recognition wait for a receipt. Four donor names begin with the characters a spreadsheet reads as a formula.
  await gift('W1', 'fund_a', 1000n, '2026-10-24', '=1+1');
  await gift('W2', 'fund_b', 1250n, '2026-10-26', '+1');
  await gift('W3', 'fund_a', 99n, '2026-10-27', '-1');
  await gift('W4', 'fund_b', 40000n, '2026-10-28', '@x');
  await gift('W5', 'fund_a', 15075n, '2026-10-29', 'Zoe Quinn');
  await gift('W6', 'fund_b', 700n, '2026-10-30');
  await directReceipt('DG_BIG_ORDER_1', 'DG_BIG_CAPTURE_1', 'fund_b', BIG, '2026-10-31');
  await directReceipt('DG_TAB_ORDER_1', 'DG_TAB_CAPTURE\t=SUM1', 'fund_b', 3300n, '2026-10-21');
  await directReceipt('DG_CR_ORDER_1', 'DG_CR_CAPTURE\r@x123', 'fund_a', 4400n, '2026-10-20');
  // A second organization with its own approver, fund and gift. It goes in last: the ledger reconcile assumes one organization.
  await db.insert(s.organizations).values({ id: 'dg-other', name: OTHER_ORG, prohibitedCategories: [], openingSourceType: 'fixture_opening_balance' });
  await db.insert(s.users).values({ id: 'dg-approver', organizationId: 'dg-other', username: 'dg-approver', displayName: 'Other Approver', role: 'APPROVER', passwordHash: 'not-a-real-hash' });
  await db.insert(s.funds).values({ id: 'dg_fund_x', organizationId: 'dg-other', name: OTHER_FUND, fundClass: 'RESTRICTED', currentPolicyVersion: 1 });
  await client`insert into donation_receipts (order_id, organization_id, fund_id, expected_amount_cents, capture_id, status, provider_status, gross_cents, fee_cents, net_cents, effective_on, recorded_by)
    values (${OTHER_ORDER}, 'dg-other', 'dg_fund_x', ${OTHER_CENTS.toString()}, ${OTHER_CAPTURE}, 'COMPLETED', 'COMPLETED', ${OTHER_CENTS.toString()}, 0, ${OTHER_CENTS.toString()}, date '2026-10-22', 'dg-approver')`;
  await nameDonor(OTHER_ORDER, 'dg_fund_x', OTHER_CENTS, OTHER_DONOR);
  // A third organization with an approver and no gift at all, for the empty grid copy (GE-10).
  await db.insert(s.organizations).values({ id: 'dg-empty', name: 'Hollowmere Private Organization', prohibitedCategories: [], openingSourceType: 'fixture_opening_balance' });
  await db.insert(s.users).values({ id: 'dg-empty-approver', organizationId: 'dg-empty', username: 'dg-empty-approver', displayName: 'Empty Approver', role: 'APPROVER', passwordHash: 'not-a-real-hash' });
  baseline = await financialHash(client); linksBaseline = await tableHash(client, 'gift_links');
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3100'], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: url.toString(), APP_ORIGIN: ORIGIN, AIDTRACE_JUDGE_SESSION: '', AI_RECEIPT_ENABLED: 'false', AI_ANALYTICS_ENABLED: 'false', AI_EXPENSE_PROPOSALS_ENABLED: 'false',
      PAYPAL_PRODUCT_WEBHOOK_ENABLED: 'false', PAYPAL_BASE_URL: '', PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '', PAYPAL_SANDBOX_PAYEE_EMAIL: PAYEE, PAYEE_ALLOWLIST: PAYEE },
  });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* not up yet */ }
    if (server.exitCode !== null) throw Error('Isolated server exited');
    await pause(500);
  }
  throw Error('Server readiness timeout');
});
test.afterAll(async () => {
  await stopServer(); await connection?.client.end();
  if (admin && /^aidtrace_donations_ui_[a-f0-9]{12}$/.test(name)) { await admin`drop database ${admin(name)} with (force)`; await admin.end(); }
});
test.describe.configure({ mode: 'serial' });

async function login(page: Page, user: string) {
  await page.goto('/login'); await page.getByLabel('Username').fill(user); await page.getByLabel('Password').fill(passwords[user]!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.waitForURL(url => url.pathname === '/');
}
/** A real session row for a user, as e2e/gift.spec.ts makes one. Returns the cookie value. */
async function sessionFor(userId: string) {
  const token = randomBytes(32).toString('hex');
  await connection.db.insert(s.sessions).values({ tokenHash: digest(token), userId, expiresAt: new Date(Date.now() + 3_600_000) });
  return token;
}
/** Counts console errors, page errors and every request that leaves the container's loopback. */
function watch(page: Page) {
  const seen = { errors: [] as string[], external: 0 };
  page.on('pageerror', error => seen.errors.push(`pageerror ${error.message}`));
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') seen.errors.push(`${message.type()} ${message.text()}`); });
  void page.route('**/*', route => { const host = new URL(route.request().url()).hostname; if (['127.0.0.1', 'localhost'].includes(host)) return route.continue(); seen.external++; return route.abort(); });
  return seen;
}
async function openDonations(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 }); await page.goto('/donations'); await page.waitForSelector('[role="grid"]');
}
const status = (page: Page) => page.getByTestId('gx-status');
const dataRows = (page: Page) => page.locator('.ag-row[row-id]:not(.ag-row-pinned)');
// The grid keeps its DOM nodes after a sort, so the first node in the page is not the top row. The row index is.
const topRow = (page: Page) => page.locator('.ag-row[row-index="0"]:not(.ag-row-pinned)');
const pinned = (page: Page, field: string) => page.locator(`.gx-row-total [col-id="${field}"]`);
const scrollGrid = (page: Page, side: 'left' | 'right') => page.locator('.ag-body-horizontal-scroll-viewport').evaluate((element, where) => { element.scrollLeft = where === 'right' ? element.scrollWidth : 0; }, side);
const headerIds = (page: Page) => page.evaluate(() => [...document.querySelectorAll('[role="columnheader"][col-id]')].map(element => element.getAttribute('col-id')!).filter(id => !/^\d+_\d+$/.test(id)));
const sumOf = (rows: DonationRow[], field: 'amountCents' | 'matchedCents' | 'waitingCents') => rows.reduce((total, row) => total + BigInt(row[field]), 0n);
const sqlSum = async (where: string) => { const [row] = await connection.client.unsafe(`select coalesce(sum(r.gross_cents), 0)::text as total, count(*)::int as n from donation_receipts r join funds f on f.id = r.fund_id where r.organization_id = 'cedar-hollow' and r.status = 'COMPLETED' and ${where}`); return { total: BigInt(row!.total as string), count: Number(row!.n) }; };
async function contained(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const width = await page.evaluate(() => innerWidth);
  for (const control of [page.getByLabel('Search this table'), page.getByRole('button', { name: 'Export CSV' }), page.getByRole('button', { name: 'Reset view' })]) {
    await expect(control).toBeVisible(); const box = await control.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  }
  for (const tile of await page.getByTestId('donations-server-totals').locator('dl > div').all()) {
    const box = await tile.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
  }
}
/** The visible rows, the status line, the pinned label and the three pinned sums all agree with an expected list of server rows. */
async function expectVisible(page: Page, expected: DonationRow[], all: number) {
  await expect(status(page)).toHaveText(`Showing ${expected.length} of ${all}`);
  await scrollGrid(page, 'left'); // the pinned cells of the first and last columns exist only while those columns are on screen
  await expect(pinned(page, 'received')).toHaveText(`Total of ${expected.length} ${expected.length === 1 ? 'gift' : 'gifts'} shown`);
  await expect(pinned(page, 'amountCents')).toHaveText(usd(sumOf(expected, 'amountCents')));
  await expect(pinned(page, 'matchedCents')).toHaveText(usd(sumOf(expected, 'matchedCents')));
  await expect(pinned(page, 'waitingCents')).toHaveText(usd(sumOf(expected, 'waitingCents')));
}
// A small RFC 4180 reader: quoted cells may hold commas, doubled quotes, tabs and line breaks.
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) { if (char === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += char; }
    else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else if (char === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += char;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function exportCsv(page: Page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
  return { name: download.suggestedFilename(), rows: parseCsv(readFileSync((await download.path())!, 'utf8').replace(/^\uFEFF/, '')) }; // the grid starts its file with a byte order mark
}
const requestAs = async (page: Page, userId: string) => `aidtrace_session=${await sessionFor(userId)}`;

test('GT-27: anonymous is redirected to /login, a claimant is denied with no data in the page, and the nav link is for approvers only', async ({ page }) => {
  const anonymous = await page.request.get('/donations', { maxRedirects: 0 });
  expect([302, 303, 307, 308]).toContain(anonymous.status()); expect(new URL(anonymous.headers().location!, ORIGIN).pathname).toBe('/login');
  expect(await anonymous.text()).not.toMatch(/Pat Rivera|Tallow Creek|CAPTURE_DG|amountCents/);
  await page.goto('/donations'); await expect(page).toHaveURL(/\/login$/);
  // The page has no data route of its own. (The existing /api/donations is the POST that creates a donation order.)
  for (const path of ['/api/donations/rows', '/api/donations/list', '/api/donations-grid']) expect((await page.request.get(path)).status(), path).toBe(404);
  await login(page, 'maria');
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Expenses', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Donations', exact: true })).toHaveCount(0);
  await page.goto('/donations'); await expect(page.getByRole('heading', { name: 'Approver access required.' })).toBeVisible();
  await expect(page.locator('[role="grid"]')).toHaveCount(0);
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/\$\d/);
  for (const secret of ['Pat Rivera', 'Zoe Quinn', 'Tallow Creek', 'Ashmere', 'Brightbench', 'Being verified', OTHER_FUND, OTHER_DONOR]) expect(text, secret).not.toContain(secret);
  // The raw HTML, including Next's own serialized payload, carries none of it either.
  const body = await (await page.request.get('/donations', { maxRedirects: 0, headers: { cookie: await requestAs(page, 'maria') } })).text();
  for (const secret of ['Pat Rivera', 'Zoe Quinn', 'Tallow Creek', 'Ashmere', 'Brightbench', 'Being verified', '=1+1', 'CAPTURE_DG', 'DG_BIG', 'amountCents', 'payoutStatus', '9007199254740993', OTHER_FUND, OTHER_DONOR, OTHER_CAPTURE, OTHER_ORG]) expect(body, secret).not.toContain(secret);
  await page.goto('/'); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await login(page, 'tara'); await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Donations', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/donations');
  await expect(page.getByRole('region', { name: 'Donations, newest first' })).toBeVisible();
  await expect(page.locator('[role="grid"]')).toHaveCount(1);
});

test('GT-27: an approver of another organization sees none of this organization\'s gifts, and this approver sees none of theirs', async ({ page }) => {
  const view = await loadDonationsGrid(connection.db, 'tara');
  const mine = (await (await page.request.get('/donations', { maxRedirects: 0, headers: { cookie: await requestAs(page, 'tara') } })).text());
  const theirsToken = await sessionFor('dg-approver');
  const theirs = await (await page.request.get('/donations', { maxRedirects: 0, headers: { cookie: `aidtrace_session=${theirsToken}` } })).text();
  // Raw HTML: the other organization's page carries its own gift and nothing of this organization.
  expect(theirs).toContain(OTHER_FUND); expect(theirs).toContain(OTHER_DONOR); expect(theirs).toContain(OTHER_CAPTURE.slice(-6)); expect(theirs).toContain(OTHER_ORG);
  for (const secret of ['Pat Rivera', 'Zoe Quinn', 'Tallow Creek', 'Ashmere', 'Brightbench', '=1+1', '9007199254740993', ...view.rows.map(row => row.capture).filter(tail => PRINTABLE_TAIL.test(tail) && !OTHER_CAPTURE.endsWith(tail))]) expect(theirs, secret).not.toContain(secret);
  for (const secret of [OTHER_FUND, OTHER_DONOR, OTHER_CAPTURE, OTHER_ORG, '424242', '4,242.42']) expect(mine, secret).not.toContain(secret);
  // In the browser, with a session cookie for the other approver: one row, their own gift, a total of their own gift.
  await page.context().addCookies([{ name: 'aidtrace_session', value: theirsToken, url: ORIGIN }]);
  await openDonations(page, 1440);
  await expect(status(page)).toHaveText('Showing 1 of 1');
  await expect(page.getByTestId('donations-total-count')).toHaveText('1');
  await expect(page.getByTestId('donations-total-amount')).toHaveText(usd(OTHER_CENTS));
  await expect(dataRows(page)).toHaveCount(1);
  await expect(dataRows(page).first().locator('[col-id="fund"]')).toHaveText(OTHER_FUND);
  await expect(dataRows(page).first().locator('[col-id="donor"]')).toHaveText(OTHER_DONOR);
  await expect(pinned(page, 'amountCents')).toHaveText(usd(OTHER_CENTS));
  const rendered = await page.locator('body').innerText();
  for (const secret of ['Pat Rivera', 'Tallow Creek', 'Ashmere', 'Brightbench', 'Being verified', '$25.00']) expect(rendered, secret).not.toContain(secret);
});

test('GT-27: no full capture ID, order ID, payee, batch ID or donor link field reaches an approver\'s page', async ({ page }) => {
  const body = await (await page.request.get('/donations', { maxRedirects: 0, headers: { cookie: await requestAs(page, 'tara') } })).text();
  for (const secret of [...FULL_IDS, PAYEE, 'sentinel', 'gift_links', 'giftLinks', 'tokenHash', 'decisionHash', 'maria', 'C-104', 'cedar-hollow']) expect(body.includes(secret), secret).toBe(false);
  // The masked tails are present, because the grid shows them, and each is only the last 6 characters.
  const view = await loadDonationsGrid(connection.db, 'tara');
  for (const row of view.rows) { expect(row.capture).toHaveLength(6); if (PRINTABLE_TAIL.test(row.capture)) expect(body).toContain(row.capture); }
});

test('GT-31 columns: three groups and twelve columns in the order of the scope, both ends of the grid', async ({ page }) => {
  const seen = watch(page); await login(page, 'tara'); await openDonations(page, 1440);
  expect(await page.getByRole('grid').getAttribute('aria-colcount')).toBe('12');
  const read = async () => ({ ids: await headerIds(page), names: await page.locator('[role="columnheader"][col-id]').evaluateAll(elements => elements.map(element => [element.getAttribute('col-id')!, (element.querySelector('.ag-header-cell-text')?.textContent ?? '').trim()] as const)),
    groups: await page.locator('.ag-header-group-cell').evaluateAll(elements => elements.map(element => (element.textContent ?? '').trim()).filter(Boolean)) });
  const left = await read(); await scrollGrid(page, 'right'); await expect.poll(async () => (await headerIds(page)).includes('paypalReference')).toBe(true); const right = await read();
  const ids = FIELDS.filter(field => [...left.ids, ...right.ids].includes(field)); expect(ids).toEqual(FIELDS);
  const names = new Map([...left.names, ...right.names].filter(([id]) => /^[a-zA-Z]+$/.test(id)));
  expect(FIELDS.map(field => names.get(field))).toEqual(HEADERS);
  expect([...new Set([...left.groups, ...right.groups])].sort()).toEqual(['Gift', 'Payout', 'Trail']);
  // Each text, date and money column has a floating filter.
  await scrollGrid(page, 'left');
  for (const header of ['Received', 'Donor', 'Amount', 'Fund', 'Capture', 'State', 'Matched', 'Waiting']) await expect(page.getByLabel(`${header} Filter Input`)).toBeVisible();
  await scrollGrid(page, 'right');
  for (const header of ['Lines', 'Vendor', 'Status', 'PayPal reference']) await expect(page.getByLabel(`${header} Filter Input`)).toBeVisible();
  expect(seen.errors).toEqual([]); expect(seen.external).toBe(0);
});

test('GT-31 filters: the BigInt, date, text and quick filters change the visible rows and the pinned totals', async ({ page }) => {
  const seen = watch(page); await login(page, 'tara'); await openDonations(page, 1440);
  const view = await loadDonationsGrid(connection.db, 'tara'); const all = view.rows.length;
  // GV-06: the caption names AG Grid and this grid's abilities.
  await expect(page.getByTestId('gx-caption')).toHaveText('Table by AG Grid Community, read only: search, sort and filter any column, export CSV. The total row follows the filter. Your column layout is kept for you.');
  expect(all).toBe(10); expect(view.total).toBe(10);
  await expectVisible(page, view.rows, all);
  await expect(pinned(page, 'amountCents')).toHaveText(usd(BigInt(view.totals.amountCents)));
  await expect(page.getByTestId('donations-total-amount')).toHaveText(usd(view.totals.amountCents));
  // BigInt filter, typed in dollars. 400 dollars is exactly one gift. One cent either side of 2^53 + 1 cents splits one row from none.
  const amount = page.getByLabel('Amount Filter Input');
  await amount.fill('400'); await expectVisible(page, view.rows.filter(row => row.amountCents === '40000'), all);
  expect(view.rows.filter(row => row.amountCents === '40000')).toHaveLength(1);
  await amount.fill('90071992547409.93'); await expectVisible(page, view.rows.filter(row => BigInt(row.amountCents) === BIG), all);
  await expect(pinned(page, 'amountCents')).toHaveText(BIG_TEXT); await expect(dataRows(page).locator('[col-id="amountCents"]', { hasText: BIG_TEXT })).toHaveCount(1);
  await amount.fill('90071992547409.92'); await expectVisible(page, [], all);
  await amount.fill(''); await expectVisible(page, view.rows, all);
  // The pinned total of a filtered set equals a server BigInt sum of the same set (a SQL sum, not the grid's rows).
  await page.getByLabel('Fund Filter Input').fill('Ashmere');
  const ashmere = await sqlSum(`f.name ilike '%ashmere%'`);
  await expectVisible(page, view.rows.filter(row => row.fund.toLowerCase().includes('ashmere')), all);
  expect(ashmere.count).toBe(4); await expect(pinned(page, 'amountCents')).toHaveText(usd(ashmere.total));
  await page.getByLabel('Fund Filter Input').fill('');
  // Date filter: a day compared by year, month and day. The default type is equals.
  const received = page.getByLabel('Received Filter Input');
  await received.fill('2026-10-26'); await expectVisible(page, view.rows.filter(row => row.received === '2026-10-26'), all);
  expect(view.rows.filter(row => row.received === '2026-10-26')).toHaveLength(1);
  const onDay = await sqlSum(`r.effective_on = date '2026-10-26'`); await expect(pinned(page, 'amountCents')).toHaveText(usd(onDay.total)); expect(onDay.count).toBe(1);
  await received.fill(''); await expectVisible(page, view.rows, all);
  // Text filters: donor, capture tail, state.
  await page.getByLabel('Donor Filter Input').fill('Zoe'); await expectVisible(page, view.rows.filter(row => row.donor.includes('Zoe')), all);
  await page.getByLabel('Donor Filter Input').fill('');
  await page.getByLabel('Capture Filter Input').fill('_W4'); await expectVisible(page, view.rows.filter(row => row.capture.includes('_W4')), all);
  expect(view.rows.filter(row => row.capture.includes('_W4'))).toHaveLength(1);
  await page.getByLabel('Capture Filter Input').fill('');
  await page.getByLabel('State Filter Input').fill('Waiting'); const waiting = view.rows.filter(row => row.state.toLowerCase().includes('waiting'));
  await expectVisible(page, waiting, all); expect(waiting.length).toBeGreaterThan(5); expect(waiting.length).toBeLessThan(all);
  await page.getByLabel('State Filter Input').fill('');
  await expectVisible(page, view.rows, all);
  // The Payout columns sit off screen at 1440, so the grid scrolls to them.
  await scrollGrid(page, 'right');
  await page.getByLabel('Status Filter Input').fill('verified'); const verifying = view.rows.filter(row => row.payoutStatus.toLowerCase().includes('verified'));
  expect(verifying).toHaveLength(1); await expectVisible(page, verifying, all);
  await scrollGrid(page, 'right'); await page.getByLabel('Status Filter Input').fill('');
  await page.getByLabel('Status Filter Input').fill('No payment'); await expectVisible(page, view.rows.filter(row => row.payoutStatus.includes('No payment')), all);
  await scrollGrid(page, 'right'); await page.getByLabel('Status Filter Input').fill('');
  // Quick filter: a fund name, a vendor that exists only inside the Vendor column, and a line description that exists only in a tooltip.
  const search = page.getByLabel('Search this table');
  await search.fill('Ashmere'); await expectVisible(page, view.rows.filter(row => row.fund.toLowerCase().includes('ashmere')), all);
  await search.fill('Brightbench'); const vendor = view.rows.filter(row => `${row.vendor} ${row.vendorTip}`.toLowerCase().includes('brightbench'));
  expect(vendor).toHaveLength(1); await expectVisible(page, vendor, all);
  const description = view.rows.find(row => row.linesTip.includes(':'))!.linesTip.split(':')[0]!;
  await search.fill(description); const described = view.rows.filter(row => row.linesTip.toLowerCase().includes(description.toLowerCase()));
  expect(described).toHaveLength(1); await expectVisible(page, described, all);
  await page.getByRole('button', { name: 'Reset view' }).click();
  await expectVisible(page, view.rows, all); await expect(search).toHaveValue('');
  expect(seen.errors).toEqual([]); expect(seen.external).toBe(0);
});

test('GT-31 CSV: a cell that starts with = + - @ tab or carriage return is exported with a leading quote, money exports as plain decimals', async ({ page }) => {
  const seen = watch(page); await login(page, 'tara'); await openDonations(page, 1440);
  const view = await loadDonationsGrid(connection.db, 'tara');
  const { name: file, rows } = await exportCsv(page);
  expect(file).toMatch(/^aidtrace-donations-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(rows[0]).toEqual(HEADERS); expect(rows).toHaveLength(view.rows.length + 1);
  const body = rows.slice(1);
  for (const row of body) expect(row).toHaveLength(12);
  const column = (field: string) => body.map(row => row[FIELDS.indexOf(field)]!);
  // The four formula starters that survive donor cleaning, and the tab and carriage return starters, which can only come in through the masked capture tail.
  for (const cell of ["'=1+1", "'+1", "'-1", "'@x"]) expect(column('donor'), cell).toContain(cell);
  expect(column('capture')).toContain("'\t=SUM1"); expect(column('capture')).toContain("'\r@x123");
  // No text cell anywhere reads as a formula, and a spreadsheet would show the donor's own characters after the quote.
  for (const field of ['donor', 'fund', 'capture', 'state', 'lines', 'vendor', 'payoutStatus', 'paypalReference']) for (const cell of column(field)) expect(cell, `${field}: ${JSON.stringify(cell)}`).not.toMatch(/^ *[=+\-@\t\r]/);
  // Money is a plain decimal in dollars with two places, with no currency symbol, comma or quote, and 2^53 + 1 cents is exact.
  const cents = (cell: string) => BigInt(cell.replace('.', ''));
  for (const field of ['amountCents', 'matchedCents', 'waitingCents']) for (const cell of column(field)) expect(cell, field).toMatch(/^\d+\.\d{2}$/);
  expect(column('amountCents')).toContain('90071992547409.93'); expect(column('amountCents').map(cents)).toContain(BIG);
  expect(body.reduce((total, row) => total + cents(row[FIELDS.indexOf('amountCents')]!), 0n)).toBe(BigInt(view.totals.amountCents));
  for (const cell of column('received')) expect(cell).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  // Words, never color alone: the UNKNOWN payout exports as words.
  expect(column('payoutStatus').filter(cell => cell === 'Being verified')).toHaveLength(1);
  expect(rows.flat().join('\n')).not.toMatch(/CAPTURE_DG_APPLIED|ORDER_DG_|BATCH/);
  // A filter narrows the file: the export follows the filtered and sorted rows, and leaves out the pinned total.
  await page.getByLabel('Donor Filter Input').fill('Zoe');
  await expect(status(page)).toHaveText(`Showing 1 of ${view.rows.length}`);
  const filtered = await exportCsv(page);
  expect(filtered.rows).toHaveLength(2); expect(filtered.rows[1]![FIELDS.indexOf('donor')]).toBe('Zoe Quinn'); expect(filtered.rows[1]![FIELDS.indexOf('amountCents')]).toBe('150.75');
  expect(filtered.rows.flat().join('\n')).not.toContain('Total of');
  expect(seen.errors).toEqual([]); expect(seen.external).toBe(0);
});

test('GT-31 UNKNOWN: the payout whose outcome is unknown has the row class and the words, and is never shown as paid or failed', async ({ page }) => {
  await login(page, 'tara'); await openDonations(page, 1440);
  const view = await loadDonationsGrid(connection.db, 'tara');
  const unknown = view.rows.filter(row => row.verify); expect(unknown).toHaveLength(1);
  const verify = page.locator('.ag-row.gx-row-verify'); await expect(verify).toHaveCount(1);
  await scrollGrid(page, 'right');
  const cell = verify.locator('[col-id="payoutStatus"]');
  await expect(cell).toHaveText('Being verified'); await expect(cell).toHaveClass(/gx-dot-hold/); await expect(cell).toHaveClass(/gx-status/);
  await expect(verify.locator('[col-id="paypalReference"]')).toHaveText('None yet');
  await expect(verify.locator('[col-id="payoutStatus"]')).not.toHaveText(/paid|failed/i);
  // Every other row reads No payment and carries neither the row class nor a hold dot.
  const others = dataRows(page).locator('[col-id="payoutStatus"]');
  expect(await others.count()).toBe(view.rows.length);
  expect(await others.evaluateAll(cells => cells.filter(element => !element.closest('.gx-row-verify')).map(element => element.textContent))).toEqual(Array(view.rows.length - 1).fill('No payment'));
  // The class is styled, so it is not the only signal and it is not nothing either: a hold bar on the row and a dot on the status.
  const shadow = (locator: ReturnType<Page['locator']>) => locator.evaluate(element => getComputedStyle(element).boxShadow);
  expect(await shadow(verify)).not.toBe('none'); expect(await shadow(page.locator('.ag-row[row-id]:not(.ag-row-pinned):not(.gx-row-verify)').first())).toBe('none');
  expect(await cell.evaluate(element => getComputedStyle(element, '::before').backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  // The phone list says it in words too.
  await openDonations(page, 390);
  await expect(page.getByRole('grid').locator('[col-id="payoutStatus"]', { hasText: 'Being verified' })).toHaveCount(1);
  await expect(page.locator('.ag-row.gx-row-verify')).toHaveCount(1);
});

test('GT-32 (grid part) and GS-14/GS-15: the page is contained at 1280 and at 390, the phone keeps four columns and lists the rest', async ({ page }) => {
  const seen = watch(page); await login(page, 'tara');
  const view = await loadDonationsGrid(connection.db, 'tara'); const all = view.rows.length;
  for (const width of [1280, 390]) {
    await openDonations(page, width);
    await expect(status(page)).toHaveText(`Showing ${all} of ${all}`);
    await expect(page.getByTestId('donations-total-count')).toHaveText(String(all));
    await expect(page.getByTestId('donations-total-amount')).toHaveText(usd(view.totals.amountCents));
    await expect(page.getByTestId('donations-total-matched')).toHaveText(usd(view.totals.matchedCents));
    await expect(page.getByTestId('donations-total-waiting')).toHaveText(usd(view.totals.waitingCents));
    await expect(page.getByRole('region', { name: 'Donations, newest first' })).toBeVisible(); await expect(page.getByRole('grid')).toHaveCount(1);
    await contained(page);
    if (width === 390) {
      expect(await headerIds(page)).toEqual(PHONE_COLUMNS);
      const extras = page.getByTestId('gx-phone-extras'); await expect(extras).toBeVisible();
      const text = await extras.evaluate(element => element.textContent ?? '');
      for (const row of view.rows) for (const part of [row.fund, row.donor, row.capture]) expect(text, part).toContain(part);
      expect(await extras.locator('details').count()).toBe(all);
    } else {
      expect(await page.getByRole('grid').getAttribute('aria-colcount')).toBe('12'); await expect(page.getByTestId('gx-phone-extras')).toHaveCount(0);
    }
    // Keyboard: Tab from the search box reaches the grid, and the arrow keys then move header, filter row, first data cell.
    await page.getByLabel('Search this table').focus();
    let reached = false;
    for (let step = 0; step < 16 && !reached; step++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => !!document.activeElement?.closest('[role="grid"]')); }
    expect(reached).toBe(true);
    await page.locator('[role="columnheader"][col-id="received"]').focus();
    const where = () => page.evaluate(() => { const active = document.activeElement as HTMLElement; return `${active.getAttribute('role')}:${active.getAttribute('col-id')}:${active.closest('.ag-floating-filter') ? 'filter' : active.closest('.ag-row') ? 'row' : 'header'}`; });
    expect(await where()).toBe('columnheader:received:header');
    await page.keyboard.press('ArrowDown'); expect(await where()).toBe('gridcell:received:filter');
    await page.keyboard.press('ArrowDown'); expect(await where()).toBe('gridcell:received:row');
  }
  expect(seen.errors).toEqual([]); expect(seen.external).toBe(0);
});

test('GS-12, GS-16: saved state holds no row data and Reset view clears it, and a data cell opens no editor', async ({ page }) => {
  await login(page, 'tara'); await openDonations(page, 1440);
  // The default view is newest first: the rows read by row index are in descending date order, and the first is 2026-10-31.
  const dates = await page.locator('.ag-row[row-index]:not(.ag-row-pinned)').evaluateAll(rows => rows
    .map(row => [Number(row.getAttribute('row-index')), row.querySelector('[col-id="received"]')?.textContent ?? ''] as const).sort((a, b) => a[0] - b[0]).map(pair => pair[1]));
  expect(dates).toHaveLength(10); expect(dates[0]).toBe('2026-10-31'); expect(dates).toEqual([...dates].sort().reverse());
  await page.locator('[role="columnheader"][col-id="amountCents"]').click();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), STATE_KEY)).not.toBeNull();
  const saved = await page.evaluate(key => localStorage.getItem(key)!, STATE_KEY);
  expect(Object.keys(JSON.parse(saved).state).sort()).toEqual(expect.arrayContaining(['columnOrder', 'columnSizing', 'sort']));
  for (const secret of ['Pat Rivera', 'Zoe Quinn', 'Tallow', 'CAPTURE_DG', '9007199254740993', '=1+1']) expect(saved, secret).not.toContain(secret);
  // One click sorts Amount ascending (99 cents first), a second click descending (2^53 + 1 cents first).
  await expect(topRow(page).locator('[col-id="amountCents"]')).toHaveText('$0.99');
  await page.locator('[role="columnheader"][col-id="amountCents"]').click();
  await expect(topRow(page).locator('[col-id="amountCents"]')).toHaveText(BIG_TEXT);
  const cell = topRow(page).locator('[col-id="donor"]');
  const editors = page.locator('.ag-cell-inline-editing, .ag-popup-editor, .ag-row input, .ag-row textarea, .ag-row select');
  await cell.dblclick(); await expect(editors).toHaveCount(0);
  await cell.click(); await page.keyboard.press('Enter'); await expect(editors).toHaveCount(0);
  await page.keyboard.press('Escape'); await page.keyboard.press('F2'); await expect(editors).toHaveCount(0);
  await page.getByRole('button', { name: 'Reset view' }).click();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), STATE_KEY)).toBeNull();
});

// Computed styles, not only green assertions: an unclosed comment once left a whole page unstyled with every test passing.
test('styled: the page and the grid carry their computed styles at 1440, and DONATIONS_STILLS writes a desktop still', async ({ page }) => {
  await login(page, 'tara'); await openDonations(page, 1440);
  const style = (selector: string, properties: string[]) => page.locator(selector).first().evaluate((element, names) => { const computed = getComputedStyle(element); return Object.fromEntries(names.map(key => [key, computed.getPropertyValue(key)])); }, properties);
  expect(await style('h1.screen-heading', ['font-size'])).toEqual({ 'font-size': '28px' });
  expect(await style('.donations-totals', ['display'])).toEqual({ display: 'grid' });
  expect(await style('.donations-totals > div', ['border-top-width', 'border-top-left-radius'])).toEqual({ 'border-top-width': '1px', 'border-top-left-radius': '10px' });
  expect(await style('.donations-totals dd', ['font-size', 'font-weight', 'font-variant-numeric'])).toEqual({ 'font-size': '20px', 'font-weight': '700', 'font-variant-numeric': 'tabular-nums' });
  expect(await style('.donations-totals dt', ['font-size'])).toEqual({ 'font-size': '14px' });
  expect(await style('.gx-row-total', ['font-weight'])).toEqual({ 'font-weight': '700' });
  const values = await page.evaluate(() => {
    const root = getComputedStyle(document.querySelector('.gx-root')!); const wrapper = getComputedStyle(document.querySelector('.ag-root-wrapper')!);
    const pick = (computed: CSSStyleDeclaration, key: string) => computed.getPropertyValue(key).trim().toLowerCase();
    return { ink: pick(root, '--gx-ink'), accent: pick(root, '--gx-accent'), foreground: pick(wrapper, '--ag-foreground-color'), gridAccent: pick(wrapper, '--ag-accent-color'), radius: pick(wrapper, '--ag-wrapper-border-radius') };
  });
  expect(values.ink).toMatch(/^#[0-9a-f]{6}$/); expect(values.foreground).toBe(values.ink); expect(values.gridAccent).toBe(values.accent); expect(values.radius).toBe('14px');
  // The tiles sit in one row at 1440 and the amounts align right in data rows and in the pinned total.
  const tops = await page.getByTestId('donations-server-totals').locator('dl > div').evaluateAll(tiles => tiles.map(tile => Math.round(tile.getBoundingClientRect().top))); expect(new Set(tops).size).toBe(1);
  const align = (cell: ReturnType<Page['locator']>) => cell.evaluate(element => getComputedStyle(element).textAlign);
  for (const field of ['amountCents', 'matchedCents', 'waitingCents']) { expect(await align(dataRows(page).first().locator(`[col-id="${field}"]`)), `data ${field}`).toBe('right'); expect(await align(pinned(page, field)), `pinned ${field}`).toBe('right'); }
  // The Received column shows its full date and the pinned label fits its cell.
  const fits = (cell: ReturnType<Page['locator']>) => cell.evaluate(element => [element, ...element.querySelectorAll('*')].filter(node => node.clientWidth > 0).every(node => node.scrollWidth <= node.clientWidth));
  expect(await fits(pinned(page, 'received')), 'pinned label fits').toBe(true); expect(await fits(dataRows(page).first().locator('[col-id="received"]')), 'received fits').toBe(true);
  if (process.env.DONATIONS_STILLS) {
    mkdirSync(process.env.DONATIONS_STILLS, { recursive: true });
    await page.screenshot({ path: `${process.env.DONATIONS_STILLS}/donations-1440-left.png`, fullPage: true });
    await scrollGrid(page, 'right'); await page.screenshot({ path: `${process.env.DONATIONS_STILLS}/donations-1440-right.png`, fullPage: true });
    await scrollGrid(page, 'left'); await page.getByLabel('Search this table').fill('Ashmere'); await expect(status(page)).toHaveText('Showing 4 of 10');
    await page.waitForTimeout(1000); await page.screenshot({ path: `${process.env.DONATIONS_STILLS}/donations-1440-filtered.png`, fullPage: true });
  }
});

// IAC-440 grid report polish, GE-07 to GE-10 on /donations: real gifts from this spec's database, a production build, no provider request.
const SIZES = [{ width: 1280, height: 800 }, { width: 1440, height: 900 }];
const FIRST_SCREEN = ['received', 'donor', 'amountCents', 'fund', 'capture', 'state', 'matchedCents', 'waitingCents'];
const cueText = 'Scroll sideways for more columns: Lines, Vendor, Status, PayPal reference.';
// GE_STILLS names a directory for the review stills. Unset, nothing is written.
const geStill = async (page: Page, name: string) => { if (process.env.GE_STILLS) { mkdirSync(process.env.GE_STILLS, { recursive: true }); await page.screenshot({ path: `${process.env.GE_STILLS}/${name}.png`, fullPage: true }); } };
async function openAt(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size); await page.goto('/donations'); await page.waitForSelector('[role="grid"]'); await page.waitForSelector('.ag-row[row-id]:not(.ag-row-pinned)');
}

test('GE-07: at 1280 x 800 and 1440 x 900 no donations header, group label, filter cell or cell crosses the grid right edge at scroll 0', async ({ page }) => {
  await login(page, 'tara');
  for (const size of SIZES) {
    await openAt(page, size);
    const rows = await dataRows(page).count(); expect(rows, 'real gifts are on screen').toBeGreaterThanOrEqual(8);
    const report = await measureEdge(page, FIELDS);
    await geStill(page, `donations-${size.width}`);
    expect(report.crossing, `${size.width} px`).toEqual([]);
    expect(report.checked.headers).toBe(8); expect(report.checked.groupLabels).toBe(2); expect(report.checked.filterCells).toBe(8); expect(report.checked.cells).toBeGreaterThanOrEqual(rows * 8);
    // Gift and the first three Trail columns fit: Waiting ends on the edge, so the cut "W" of the old layout is gone. Lines starts at the edge.
    expect(Math.abs(report.gap.waitingCents!), 'Waiting ends on the edge').toBeLessThanOrEqual(EDGE_TOLERANCE);
    for (const id of FIRST_SCREEN) expect(report.gap[id]!, id).toBeLessThanOrEqual(EDGE_TOLERANCE);
    // The pinned total label sits whole in the Received cell.
    const total = await pinned(page, 'received').evaluate(cell => [cell, ...cell.querySelectorAll('*')].every(node => node.scrollWidth <= node.clientWidth || node.clientWidth === 0));
    expect(total, 'the pinned total label is not truncated').toBe(true);
  }
});

test('GE-08: every donations date floating filter shows its whole mm/dd/yyyy and every text and money filter input is at least 64 px wide', async ({ page }) => {
  await login(page, 'tara');
  for (const size of SIZES) {
    await openAt(page, size);
    await expect(page.locator('.ag-floating-filter button[aria-label="Open Filter Menu"]:visible')).toHaveCount(0);
    const seen = new Map<string, Awaited<ReturnType<typeof measureFilters>>['inputs'][number]>();
    for (const side of ['left', 'right'] as const) { await scrollSideways(page, side); for (const item of (await measureFilters(page)).inputs) seen.set(item.id, item); }
    await scrollSideways(page, 'left');
    expect([...seen.keys()].sort(), 'every column was measured').toEqual([...FIELDS].sort());
    for (const item of seen.values()) {
      if (item.kind === 'date') { expect(item.needs, `${item.id} copy measured`).toBeGreaterThan(150); expect(item.width, `${item.id} date input ${item.width} of ${item.needs}`).toBeGreaterThanOrEqual(item.needs); }
      else expect(item.width, `${item.id} ${item.kind} input`).toBeGreaterThanOrEqual(MIN_FILTER_INPUT);
    }
    expect([...seen.values()].filter(item => item.kind === 'date').map(item => item.id)).toEqual(['received']);
  }
});

test('GE-09: the status line names the columns past the edge exactly when the center viewport scrolls sideways, and never on the phone layout', async ({ page }) => {
  await login(page, 'tara');
  const cue = page.getByTestId('gx-more-columns');
  for (const size of SIZES) {
    await openAt(page, size);
    // The grid sizes its horizontal scroll viewport after first paint, so a single read can see scrollWidth equal to clientWidth (1 in 3 on November 10).
    await expect.poll(async () => (await centerOverflow(page)).overflows, `${size.width} px: four columns are past the edge`).toBe(true);
    const overflow = await centerOverflow(page);
    await expect(cue).toHaveCount(overflow.overflows ? 1 : 0); await expect(cue).toHaveText(cueText);
    await expect(status(page)).toHaveText(/^Showing \d+ of \d+$/);
    expect(await cue.evaluate(element => getComputedStyle(element).fontSize)).toBe('14px');
    await scrollSideways(page, 'right'); await expect(cue).toHaveText(cueText); await scrollSideways(page, 'left');
  }
  await page.addStyleTag({ content: '.gx-root { zoom: 0.5; }' });
  await expect.poll(async () => (await centerOverflow(page)).overflows).toBe(false);
  await expect(cue).toHaveCount(0);
  await openDonations(page, 390); await expect(page.getByTestId('gx-phone-extras')).toBeVisible(); await expect(cue).toHaveCount(0);
});

test('GE-10: an approver with no gifts reads the none copy, and a search or filter that hides every gift reads the filtered copy', async ({ page }) => {
  const none = page.locator('.ag-overlay-no-rows-center'); const filtered = page.locator('.ag-overlay-no-matching-rows-center');
  // The real flow: an approver of an organization that has received no gift. The page shows its zero totals and the grid's own overlay.
  await page.context().addCookies([{ name: 'aidtrace_session', value: await sessionFor('dg-empty-approver'), url: ORIGIN }]);
  await openDonations(page, 1440);
  await expect(page.getByTestId('donations-total-count')).toHaveText('0');
  await expect(status(page)).toHaveText('Showing 0 of 0');
  await expect(none).toHaveText('No gifts yet. A completed PayPal gift shows here with its receipt match.');
  await expect(page.locator('.ag-overlay-wrapper')).not.toContainText('No Rows To Show');
  await geStill(page, 'donations-none-1440');
  // This organization's approver: a search and then a column filter that match nothing.
  await page.context().clearCookies(); await login(page, 'tara'); await openDonations(page, 1440);
  await expect(filtered).toHaveCount(0); await expect(none).toHaveCount(0);
  await page.getByLabel('Search this table').fill('zzzz-no-such-gift');
  await expect(status(page)).toHaveText('Showing 0 of 10');
  await expect(filtered).toHaveText('No gifts match this search or filter.'); await expect(none).toHaveCount(0);
  await page.getByLabel('Search this table').fill(''); await expect(status(page)).toHaveText('Showing 10 of 10'); await expect(filtered).toHaveCount(0);
  await page.getByLabel('Donor Filter Input').fill('zzzz-no-such-donor');
  await expect(status(page)).toHaveText('Showing 0 of 10');
  await expect(filtered).toHaveText('No gifts match this search or filter.');
  await page.getByLabel('Donor Filter Input').fill(''); await expect(status(page)).toHaveText('Showing 10 of 10'); await expect(filtered).toHaveCount(0);
});

// IAC-232 wrapped names. WR-05 and WR-06 on /donations: the Donor, Fund and Vendor cells show their whole text, sideways and vertically, no data row is
// shorter than 44 px, and the longest seeded fund name wraps and grows its row. The fixture has no donor name long enough to wrap.
test('WR-05 and WR-06: the donations Donor, Fund and Vendor cells wrap, nothing is cut at 1440 and 1280, and no data row is shorter than 44 px', async ({ page }, testInfo) => {
  await login(page, 'tara');
  for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 900 }]) {
    await openAt(page, size);
    await expect.poll(() => rowOverlaps(page), { message: `rows overlap after the layout settles at ${size.width} px`, timeout: 5000 }).toEqual([]);
    const report = await measureWrap(page, ['donor', 'fund']);
    expect(report.rows, 'data rows rendered').toBeGreaterThanOrEqual(4);
    expect(report.cells, 'Donor and Fund were measured on every row').toEqual({ donor: report.rows, fund: report.rows });
    expect(report.overflowing, `cut text at ${size.width} px`).toEqual([]);
    expect(report.short, `rows under 44 px at ${size.width} px`).toEqual([]);
    const long = await measureLongCell(page, 'fund', 'Ashmere County Afterschool STEM Subgrant');
    expect(long.found, 'the longest seeded fund name is in a Fund cell').toBe(true);
    expect(long.rowHeight, `its row grew at ${size.width} px`).toBeGreaterThan(44.5);
    expect(long.textHeight, `it shows on more than one line at ${size.width} px`).toBeGreaterThan(1.5 * long.lineHeight);
    // Vendor sits past the right edge, so the grid renders its cells only once scrolled into view.
    await scrollSideways(page, 'right');
    const vendor = await measureWrap(page, ['vendor']);
    expect(vendor.cells, 'Vendor was measured on every row').toEqual({ vendor: report.rows });
    expect(vendor.overflowing, `cut vendor text at ${size.width} px`).toEqual([]);
    await scrollSideways(page, 'left');
    if (size.width === 1440) await page.screenshot({ path: testInfo.outputPath('wr-donations-1440.png'), fullPage: true });
  }
});

// Runs last: every test above visited the view, filtered, sorted, searched, exported and reset. None of it may touch a financial table.
test('GT-32 (grid part) and the read-only promise: the financial hash and the donor link table are identical after every visit', async ({ page }) => {
  await login(page, 'tara'); await openDonations(page, 1280); await openDonations(page, 390);
  expect(await financialHash(connection.client)).toBe(baseline);
  expect(await tableHash(connection.client, 'gift_links')).toEqual(linksBaseline);
  expect(linksBaseline.count).toBe(0);
});
