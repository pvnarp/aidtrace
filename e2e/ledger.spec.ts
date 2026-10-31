import { createHash, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { connectDatabase } from '../src/server/db';
import { seedFixture } from '../db/fixture';
import { ensureFixtureOpening } from '../src/ledger/opening';
import { postJournal } from '../src/ledger/journal';
import { recordDesignatedDonation } from '../src/ledger/donation';
import { loadLedgerView, type LedgerRow } from '../src/ledger/view';
import { usd } from '../src/analytics/model';
import type { DonationObservation, DonationReader } from '../src/paypal/adapter';

// IAC-380 step 2, the read-only /ledger view in a real browser against a real isolated PostgreSQL and a production build.
// LG-03 to LG-08, LG-10 and GS-13 to GS-17 live here. Every provider is a scripted stand-in written in this file. No PayPal
// request is made and nothing below is a provider result. Each test starts a fresh browser context, so saved grid state never leaks.
const PHONE_COLUMNS = ['recordedAt', 'entryType', 'debitCents', 'creditCents'];
const BIG = 9007199254740993n;
const BIG_TEXT = '$90,071,992,547,409.93';
const STATE_KEY = 'aidtrace.grid.v1.tara.ledger';
const FINANCIAL_TABLES = ['claims', 'claim_lines', 'allocation_decisions', 'allocation_edges', 'approvals', 'fund_reservations', 'reservation_budget_lines', 'fund_credits', 'fund_debits', 'journal_entries', 'journal_postings', 'disbursements', 'disbursement_attempts', 'donation_receipts', 'retry_authorizations', 'provider_events'];

let admin: ReturnType<typeof postgres>; let connection: ReturnType<typeof connectDatabase>; let name: string;
let server: ChildProcess; let passwords: Record<string, string>; let baseline: string;
test.use({ isMobile: false, hasTouch: false });

async function financialHash() {
  const rows = [];
  for (const table of FINANCIAL_TABLES) rows.push(await connection.client`select to_jsonb(r)::text as v from ${connection.client(table)} r order by (to_jsonb(r)::text) collate "C"`);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
async function postingCount() { const [row] = await connection.client`select count(*)::int as n from journal_postings`; return Number(row!.n); }
async function sums() { const [row] = await connection.client`select coalesce(sum(debit_cents),0)::text as debit, coalesce(sum(credit_cents),0)::text as credit from journal_postings`; return { debit: BigInt(row!.debit as string), credit: BigInt(row!.credit as string) }; }
const sumOf = (rows: LedgerRow[], field: 'debitCents' | 'creditCents') => rows.reduce((total, row) => total + (row[field] === '' ? 0n : BigInt(row[field])), 0n);

test.beforeAll(async () => {
  if (process.env.UI_TEST_CONTAINER !== 'true') throw Error('OrbStack UI service required');
  const url = new URL(process.env.DATABASE_URL!); url.pathname = '/postgres'; admin = postgres(url.toString(), { max: 1 });
  name = `aidtrace_ledger_ui_${randomBytes(6).toString('hex')}`; await admin`create database ${admin(name)}`; url.pathname = '/' + name;
  connection = connectDatabase(url.toString()); await migrate(connection.db, { migrationsFolder: 'db/migrations' });
  passwords = Object.fromEntries(['maria', 'tara', 'ben'].map(user => [user, randomBytes(18).toString('hex')]));
  await seedFixture(connection.db, { passwords: passwords as Record<'maria' | 'tara' | 'ben', string>, payeeEmail: 'ledger-ui@personal.example.com', payeeAllowlist: ['ledger-ui@personal.example.com'] });
  await connection.db.transaction(tx => ensureFixtureOpening(tx, 'cedar-hollow'));
  baseline = await financialHash();
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3100'], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: url.toString(), APP_ORIGIN: 'http://127.0.0.1:3100', AI_ANALYTICS_ENABLED: 'false', PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '', PAYPAL_PRODUCT_WEBHOOK_ENABLED: 'false' },
  });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch('http://127.0.0.1:3100/api/health', { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* wait */ }
    if (server.exitCode !== null) throw Error('Isolated server exited');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error('Server readiness timeout');
});
test.afterAll(async () => {
  if (server?.pid) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ }
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  await connection?.client.end();
  if (admin && /^aidtrace_ledger_ui_[a-f0-9]{12}$/.test(name)) { await admin`drop database ${admin(name)} with (force)`; await admin.end(); }
});

async function login(page: Page, user: string) {
  await page.goto('/login'); await page.getByLabel('Username').fill(user); await page.getByLabel('Password').fill(passwords[user]!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.waitForURL(url => url.pathname === '/');
}
/** Counts console errors, page errors and every request that leaves the container's loopback. */
function watch(page: Page) {
  const seen = { errors: [] as string[], external: 0 };
  page.on('pageerror', error => seen.errors.push(`pageerror ${error.message}`));
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') seen.errors.push(`${message.type()} ${message.text()}`); });
  void page.route('**/*', route => { const host = new URL(route.request().url()).hostname; if (['127.0.0.1', 'localhost'].includes(host)) return route.continue(); seen.external++; return route.abort(); });
  return seen;
}
async function openLedger(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 }); await page.goto('/ledger'); await page.waitForSelector('[role="grid"]');
}
const status = (page: Page) => page.getByTestId('gx-status');
const headerIds = (page: Page) => page.evaluate(() => [...document.querySelectorAll('[role="columnheader"][col-id]')].map(element => element.getAttribute('col-id')!).filter(id => !/^\d+_\d+$/.test(id)));
const dataRows = (page: Page) => page.locator('.ag-row[row-id]:not(.ag-row-pinned)');
const pinned = (page: Page, field: 'debitCents' | 'creditCents') => page.locator(`.gx-row-total [col-id="${field}"]`);
async function contained(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const width = await page.evaluate(() => innerWidth);
  for (const control of [page.getByLabel('Search this table'), page.getByRole('button', { name: 'Export CSV' }), page.getByRole('button', { name: 'Reset view' })]) {
    await expect(control).toBeVisible(); const box = await control.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  }
}

// Runs first so that every later test, and the final hash, start from the state this test leaves.
test('LG-10 (scripted donation stand-in, not a PayPal result): capture entries appear after a stubbed donation post', async ({ page }) => {
  const seen = watch(page); await login(page, 'tara'); await openLedger(page, 1280);
  const before = await postingCount();
  await expect(status(page)).toHaveText(`Showing ${before} of ${before}`);
  const data: DonationObservation = { httpStatus: 200, orderId: 'E2E_STUB_ORDER_1', intent: 'CAPTURE', status: 'COMPLETED', units: [{ fundId: 'fund_b', amountCents: 100n }], captures: [{ captureId: 'E2E_STUB_CAPTURE_1', status: 'COMPLETED', amountCents: 100n, grossCents: 100n, feeCents: 52n, netCents: 48n, effectiveOn: '2026-10-30' }] };
  const provider: DonationReader = { donationOrder: async () => data };
  await recordDesignatedDonation(connection.db, 'tara', { orderId: 'E2E_STUB_ORDER_1', captureId: 'E2E_STUB_CAPTURE_1', fundId: 'fund_b', amountCents: 100n }, provider);
  const [{ added }] = await connection.client`select count(*)::int as added from journal_postings p join journal_entries e on e.id = p.entry_id where e.source_id = 'E2E_STUB_CAPTURE_1'` as unknown as [{ added: number }];
  expect(added).toBeGreaterThan(0);
  const after = await postingCount(); expect(after).toBe(before + added);
  await page.reload(); await page.waitForSelector('[role="grid"]');
  await expect(status(page)).toHaveText(`Showing ${after} of ${after}`);
  await page.getByLabel('Search this table').fill('E2E_STUB_CAPTURE_1');
  await expect(status(page)).toHaveText(`Showing ${added} of ${after}`);
  await expect(dataRows(page).first().locator('[col-id="entryType"]')).toHaveText(/Donation/);
  // The capture id is the PayPal reference. The phone list holds it as plain text for every row.
  await openLedger(page, 390);
  await expect(page.getByTestId('gx-phone-extras')).toContainText('E2E_STUB_CAPTURE_1');
  expect(seen.errors).toEqual([]); expect(seen.external).toBe(0);
  // GS-13: one balanced entry of 9,007,199,254,740,993 cents, posted only through the ledger module's own posting function. It goes in
  // after the donation, because the donation's own tie-out between the journal and the fund tables would refuse a journal-only entry.
  await connection.db.transaction(tx => postJournal(tx, {
    sourceType: 'paypal_capture', sourceId: 'E2E_BOUNDARY_ENTRY', purpose: 'donation', effectiveOn: '2026-10-30',
    postings: [{ accountCode: '1010', debitCents: BIG, creditCents: 0n }, { accountCode: '4100', subKey: 'fund_b', debitCents: 0n, creditCents: BIG }],
  }));
  baseline = await financialHash();
});

test('LG-03: anonymous is redirected, a claimant is denied on the page and on any data route, an approver sees the grid', async ({ page }) => {
  await page.goto('/ledger'); await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get('/api/ledger')).status()).toBe(404);
  await login(page, 'maria');
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Expenses', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Ledger', exact: true })).toHaveCount(0);
  await page.goto('/ledger'); await expect(page.getByRole('heading', { name: 'Approver access required.' })).toBeVisible();
  await expect(page.locator('[role="grid"]')).toHaveCount(0);
  for (const path of ['/api/ledger', '/api/ledger/rows', '/api/analytics/ledger']) expect((await page.request.get(path)).status()).toBe(404);
  await page.goto('/'); await page.getByRole('button', { name: 'Sign out' }).click();
  await login(page, 'tara'); await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Ledger', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/ledger');
  await expect(page.getByRole('region', { name: 'Ledger postings, newest first' })).toBeVisible();
  await expect(page.locator('[role="grid"]')).toHaveCount(1);
});

test('LG-04, LG-06, LG-07, GS-14 and GS-15: the contract holds at 1280 and at 390', async ({ page }) => {
  const seen = watch(page); await login(page, 'tara');
  const view = await loadLedgerView(connection.db, 'tara'); const count = await postingCount();
  expect(view.rows.length).toBe(count);
  for (const width of [1280, 390]) {
    await openLedger(page, width);
    // LG-04 and the GS-14 count line: the visible line, the server tile and a server query all agree.
    await expect(status(page)).toHaveText(`Showing ${count} of ${count}`);
    await expect(page.getByTestId('ledger-total-count')).toHaveText(String(count));
    await expect(page.locator('.gx-row-total')).toContainText(`Total of ${count} shown`);
    // GS-14: a labeled region, and the table is a labeled grid.
    await expect(page.getByRole('region', { name: 'Ledger postings, newest first' })).toBeVisible();
    await expect(page.getByRole('grid')).toHaveCount(1);
    // LG-07
    await contained(page);
    // GS-15 columns.
    const ids = await headerIds(page);
    if (width === 390) {
      expect(ids).toEqual(PHONE_COLUMNS);
      const hidden = view.rows[0]!; const first = await page.getByTestId('gx-phone-extras').locator('details').first().evaluate(element => element.textContent ?? '');
      for (const text of [hidden.effectiveOn, hidden.account, hidden.fund || 'None', hidden.claim, hidden.approvals, hidden.paypalReference]) expect(first).toContain(text);
      // The summary line names the side of its amount (orchestrator addition).
      const summary = await page.getByTestId('gx-phone-extras').locator('summary').first().textContent();
      expect(summary).toContain(hidden.debitCents ? `Debit ${usd(hidden.debitCents)}` : `Credit ${usd(hidden.creditCents)}`);
    } else {
      for (const id of ['recordedAt', 'effectiveOn', 'entryType', 'account', 'fund', 'debitCents', 'creditCents']) expect(ids).toContain(id);
      await expect(page.getByTestId('gx-phone-extras')).toHaveCount(0);
      expect(await page.getByRole('grid').getAttribute('aria-colcount')).toBe('10');
      // The money columns sit fully inside the grid frame at 1280 before any horizontal scroll (orchestrator addition at the main merge).
      const frame = await page.locator('.ag-root-wrapper').boundingBox(); const credit = await page.locator('[role="columnheader"][col-id="creditCents"]').boundingBox();
      expect(credit!.x + credit!.width).toBeLessThanOrEqual(frame!.x + frame!.width);
      // Amounts align right in data rows and in the pinned total, and both date columns show their full text (orchestrator addition).
      const align = (cell: ReturnType<Page['locator']>) => cell.evaluate(element => getComputedStyle(element).textAlign);
      for (const id of ['debitCents', 'creditCents'] as const) {
        expect(await align(dataRows(page).first().locator(`[col-id="${id}"]`)), `data ${id}`).toBe('right');
        expect(await align(pinned(page, id)), `pinned ${id}`).toBe('right');
      }
      const fits = (cell: ReturnType<Page['locator']>) => cell.evaluate(element => [element, ...element.querySelectorAll('*')].filter(node => node.clientWidth > 0).every(node => node.scrollWidth <= node.clientWidth));
      const recorded = dataRows(page).first().locator('[col-id="recordedAt"]'); const effective = dataRows(page).first().locator('[col-id="effectiveOn"]');
      expect(await recorded.textContent()).toMatch(/UTC$/); expect(await effective.textContent()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(await fits(recorded), 'recordedAt fits').toBe(true); expect(await fits(effective), 'effectiveOn fits').toBe(true);
    }
    // GS-14 keyboard: Tab from the search box reaches the grid, and arrow keys then move focus header, filter row, first data cell, next cell.
    await page.getByLabel('Search this table').focus();
    let reached = false;
    for (let step = 0; step < 14 && !reached; step++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => !!document.activeElement?.closest('[role="grid"]')); }
    expect(reached).toBe(true);
    await page.locator('[role="columnheader"][col-id="recordedAt"]').focus();
    const where = () => page.evaluate(() => { const active = document.activeElement as HTMLElement; return `${active.getAttribute('role')}:${active.getAttribute('col-id')}:${active.closest('.ag-floating-filter') ? 'filter' : active.closest('.ag-row') ? 'row' : 'header'}`; });
    expect(await where()).toBe('columnheader:recordedAt:header');
    await page.keyboard.press('ArrowDown'); expect(await where()).toBe('gridcell:recordedAt:filter');
    await page.keyboard.press('ArrowDown'); expect(await where()).toBe('gridcell:recordedAt:row');
    await page.keyboard.press('ArrowRight'); expect(await where()).toBe(`gridcell:${width === 390 ? 'entryType' : 'effectiveOn'}:row`);
    // GS-14 keyboard: a header filter opens from the keyboard. Tab from a filter input reaches its menu button, and Enter opens the menu.
    await page.getByLabel('Type Filter Input').focus();
    let button = false;
    for (let step = 0; step < 4 && !button; step++) { await page.keyboard.press('Tab'); button = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Open Filter Menu'); }
    expect(button).toBe(true);
    await page.keyboard.press('Enter'); await expect(page.getByLabel('Column Filter')).toBeVisible();
    await page.keyboard.press('Escape');
  }
  expect(seen.errors).toEqual([]); expect(seen.external).toBe(0);
});

test('GS-03 and GS-04 in the browser: the grid theme carries the computed gx values and the page fonts', async ({ page }) => {
  await login(page, 'tara'); await openLedger(page, 1280);
  const values = await page.evaluate(() => {
    const root = getComputedStyle(document.querySelector('.gx-root')!); const wrapper = getComputedStyle(document.querySelector('.ag-root-wrapper')!);
    const pick = (style: CSSStyleDeclaration, key: string) => style.getPropertyValue(key).trim().toLowerCase();
    return { ink: pick(root, '--gx-ink'), accent: pick(root, '--gx-accent'), line: pick(root, '--gx-line'), font: root.fontFamily.trim(),
      foreground: pick(wrapper, '--ag-foreground-color'), gridAccent: pick(wrapper, '--ag-accent-color'), border: pick(wrapper, '--ag-border-color'), gridFont: pick(wrapper, '--ag-font-family'), radius: pick(wrapper, '--ag-wrapper-border-radius') };
  });
  expect(values.ink).toMatch(/^#[0-9a-f]{6}$/); expect(values.foreground).toBe(values.ink);
  expect(values.gridAccent).toBe(values.accent); expect(values.border).toBe(values.line);
  expect(values.gridFont).toBe(values.font.toLowerCase()); expect(values.radius).toBe('14px');
});

test('LG-05: the fund filter, the type filter and the quick filter change the visible rows and the visible total', async ({ page }) => {
  await login(page, 'tara'); await openLedger(page, 1280);
  const view = await loadLedgerView(connection.db, 'tara'); const all = view.rows.length;
  const expectVisible = async (rows: LedgerRow[]) => {
    expect(rows.length).toBeGreaterThan(0); expect(rows.length).toBeLessThan(all);
    await expect(status(page)).toHaveText(`Showing ${rows.length} of ${all}`);
    await expect(pinned(page, 'debitCents')).toHaveText(usd(sumOf(rows, 'debitCents')));
    await expect(pinned(page, 'creditCents')).toHaveText(usd(sumOf(rows, 'creditCents')));
  };
  await expect(pinned(page, 'debitCents')).toHaveText(usd(sumOf(view.rows, 'debitCents')));
  await page.getByLabel('Type Filter Input').fill('Donation');
  await expectVisible(view.rows.filter(row => row.entryType.toLowerCase().includes('donation')));
  await page.getByLabel('Type Filter Input').fill('');
  await expect(status(page)).toHaveText(`Showing ${all} of ${all}`);
  await page.getByLabel('Fund Filter Input').fill('Tallow');
  await expectVisible(view.rows.filter(row => row.fund.toLowerCase().includes('tallow')));
  await page.getByLabel('Fund Filter Input').fill('');
  await expect(status(page)).toHaveText(`Showing ${all} of ${all}`);
  const text = (row: LedgerRow) => [row.entryType, row.account, row.fund, row.claim, row.approvals, row.paypalReference].join(' ').toLowerCase();
  await page.getByLabel('Search this table').fill('opening');
  await expectVisible(view.rows.filter(row => text(row).includes('opening')));
  await page.getByRole('button', { name: 'Reset view' }).click();
  await expect(status(page)).toHaveText(`Showing ${all} of ${all}`); await expect(page.getByLabel('Search this table')).toHaveValue('');
});

// Orchestrator probe for the open LG-05 observation (GATE_REPORT section 45): a column filter cleared and a quick search typed
// at once, with no wait between them, must leave the column filter cleared. Read only.
test('LG-05b: a cleared column filter stays cleared when the quick search changes at once', async ({ page }) => {
  await login(page, 'tara'); await openLedger(page, 1280);
  const view = await loadLedgerView(connection.db, 'tara'); const all = view.rows.length;
  const text = (row: LedgerRow) => [row.entryType, row.account, row.fund, row.claim, row.approvals, row.paypalReference].join(' ').toLowerCase();
  const tallow = view.rows.filter(row => row.fund.toLowerCase().includes('tallow')).length;
  const opening = view.rows.filter(row => text(row).includes('opening')).length;
  const both = view.rows.filter(row => text(row).includes('opening') && row.fund.toLowerCase().includes('tallow')).length;
  expect(opening).toBeGreaterThan(both);
  await page.getByLabel('Fund Filter Input').fill('Tallow');
  await expect(status(page)).toHaveText(`Showing ${tallow} of ${all}`);
  await page.getByLabel('Fund Filter Input').fill('');
  await page.getByLabel('Search this table').fill('opening');
  await expect(status(page)).toHaveText(`Showing ${opening} of ${all}`);
  await expect(page.getByLabel('Fund Filter Input')).toHaveValue('');
});

test('GS-13: an amount of 2^53 plus one cents is exact in the cell, the filters, the totals and the server tiles', async ({ page }) => {
  await login(page, 'tara'); await openLedger(page, 1280);
  const view = await loadLedgerView(connection.db, 'tara'); const all = view.rows.length;
  const debits = view.rows.filter(row => row.debitCents !== ''); const below = debits.filter(row => BigInt(row.debitCents) < BIG).length;
  expect(debits.length - below).toBe(1);
  // The cell and the pinned and server totals read the exact value.
  await expect(dataRows(page).locator('[col-id="debitCents"]', { hasText: BIG_TEXT })).toHaveCount(1);
  await expect(dataRows(page).locator('[col-id="creditCents"]', { hasText: BIG_TEXT })).toHaveCount(1);
  const totals = await sums(); expect(totals.debit).toBe(totals.credit); expect(totals.debit > BIG).toBe(true);
  await expect(pinned(page, 'debitCents')).toHaveText(usd(totals.debit)); await expect(pinned(page, 'creditCents')).toHaveText(usd(totals.credit));
  await expect(page.getByTestId('ledger-total-debits')).toHaveText(usd(totals.debit)); await expect(page.getByTestId('ledger-total-credits')).toHaveText(usd(totals.credit));
  // Equals splits one cent apart. A floating point number cannot tell these two values apart.
  const debit = page.getByLabel('Debit Filter Input');
  await debit.fill('90071992547409.93'); await expect(status(page)).toHaveText(`Showing 1 of ${all}`);
  await expect(pinned(page, 'debitCents')).toHaveText(BIG_TEXT);
  await debit.fill('90071992547409.92'); await expect(status(page)).toHaveText(`Showing 0 of ${all}`);
  await debit.fill(''); await expect(status(page)).toHaveText(`Showing ${all} of ${all}`);
  // Greater than and less than split at the boundary through the filter menu.
  await page.locator('.ag-floating-filter[col-id="debitCents"] button[aria-label="Open Filter Menu"]').click();
  // A second condition row appears once the first holds a value, so every locator names the first condition of the open popup.
  const popup = page.getByLabel('Column Filter');
  const operator = popup.getByRole('combobox', { name: 'Filtering operator' }).first(); const value = popup.getByRole('textbox', { name: 'Filter Value', exact: true }).first();
  await operator.click(); await page.getByRole('option', { name: 'Greater than', exact: true }).click();
  await value.fill('90071992547409.92'); await expect(status(page)).toHaveText(`Showing 1 of ${all}`);
  await value.fill('90071992547409.93'); await expect(status(page)).toHaveText(`Showing 0 of ${all}`);
  await operator.click(); await page.getByRole('option', { name: 'Less than', exact: true }).click();
  await value.fill('90071992547409.93'); await expect(status(page)).toHaveText(`Showing ${below} of ${all}`);
  await value.fill('90071992547409.94'); await expect(status(page)).toHaveText(`Showing ${below + 1} of ${all}`);
  await page.keyboard.press('Escape');
});

test('GS-15 and GS-12 in the browser: saved state never brings phone-hidden columns back, and Reset view clears it', async ({ page }) => {
  await login(page, 'tara'); await openLedger(page, 1280);
  await page.locator('[role="columnheader"][col-id="debitCents"]').click();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), STATE_KEY)).not.toBeNull();
  const saved = await page.evaluate(key => localStorage.getItem(key)!, STATE_KEY);
  expect(Object.keys(JSON.parse(saved).state).sort()).toEqual(expect.arrayContaining(['columnOrder', 'columnSizing', 'sort']));
  expect(saved).not.toContain('E2E_'); expect(saved).not.toContain(BIG.toString());
  await openLedger(page, 390); expect(await headerIds(page)).toEqual(PHONE_COLUMNS);
  await page.setViewportSize({ width: 1280, height: 900 }); await expect.poll(() => headerIds(page)).toContain('effectiveOn');
  await page.setViewportSize({ width: 390, height: 844 }); await expect.poll(() => headerIds(page)).toEqual(PHONE_COLUMNS);
  await page.getByRole('button', { name: 'Reset view' }).click();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), STATE_KEY)).toBeNull();
  await expect.poll(() => headerIds(page)).toEqual(PHONE_COLUMNS);
});

test('GS-16: double click, Enter and F2 on a data cell open no editor', async ({ page }) => {
  await login(page, 'tara'); await openLedger(page, 1280);
  const cell = dataRows(page).first().locator('[col-id="account"]');
  const editors = page.locator('.ag-cell-inline-editing, .ag-popup-editor, .ag-row input, .ag-row textarea, .ag-row select');
  await cell.dblclick(); await expect(editors).toHaveCount(0);
  await cell.click(); await page.keyboard.press('Enter'); await expect(editors).toHaveCount(0);
  await page.keyboard.press('Escape'); await page.keyboard.press('F2'); await expect(editors).toHaveCount(0);
  await expect(cell).toContainText('1010');
});

// Runs last: every test above visited the view, filtered, sorted, searched and reset. None of it may touch a financial table.
test('LG-08 and GS-17: the financial hash over the 16 tables is identical after every visit of the view', async ({ page }) => {
  await login(page, 'tara'); await openLedger(page, 1280); await openLedger(page, 390);
  expect(await financialHash()).toBe(baseline);
});
