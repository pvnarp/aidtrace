'use client';
import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import './donations.css';
import { GridSkeleton } from '../grid-skeleton';
import { usd } from '../../analytics/model';
import type { DonationRow, DonationsGrid } from '../../donation/donations-grid';
import type { DataGrid as DataGridComponent } from '../grid/grid';
import { WRAP_MODULES } from '../grid/modules';
import { donationsColumns, donationsTotalLabel, DONATIONS_PHONE_COLUMNS, DONATIONS_TOTAL_FIELDS } from './columns';

// A grid cannot render on the server in this setup, so it loads in the browser only.
const DataGrid = dynamic(() => import('../grid/grid'), { ssr: false, loading: () => <GridSkeleton label="Loading donations table..." /> }) as unknown as typeof DataGridComponent;

const TOTALS = { label: donationsTotalLabel, fields: DONATIONS_TOTAL_FIELDS };
const rowId = (row: DonationRow) => row.id;
const rowClass = (row: DonationRow) => (row.verify ? 'gx-row-verify' : undefined);
const EMPTY = { none: 'No gifts yet. A completed PayPal gift shows here with its receipt match.', filtered: 'No gifts match this search or filter.' };
const grouped = (count: number) => String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function DonationsClient({ view, userId }: { view: DonationsGrid; userId: string }) {
  const columns = useMemo(() => donationsColumns(), []);
  return <>
    <section className="gx-root" aria-label="Server totals for every gift" data-testid="donations-server-totals">
      <dl className="donations-totals">
        <div><dt>Gifts received</dt><dd data-testid="donations-total-count">{grouped(view.total)}</dd></div>
        <div><dt>Amount, every gift</dt><dd data-testid="donations-total-amount">{usd(view.totals.amountCents)}</dd></div>
        <div><dt>Matched to receipts</dt><dd data-testid="donations-total-matched">{usd(view.totals.matchedCents)}</dd></div>
        <div><dt>Still waiting</dt><dd data-testid="donations-total-waiting">{usd(view.totals.waitingCents)}</dd></div>
      </dl>
    </section>
    {view.capped && <p className="donations-cap" data-testid="donations-cap">Showing the newest {grouped(view.rows.length)} of {grouped(view.total)} gifts. The totals above cover every gift.</p>}
    <DataGrid<DonationRow>
      gridId="donations"
      userId={userId}
      ariaLabel="Donations, newest first"
      observedAt={view.observedAt}
      rows={view.rows}
      getRowId={rowId}
      columns={columns}
      phoneColumns={DONATIONS_PHONE_COLUMNS}
      csv={{ fileBase: 'donations' }}
      totals={TOTALS}
      getRowClass={rowClass}
      emptyMessages={EMPTY}
      extraModules={WRAP_MODULES}
    />
  </>;
}
