'use client';
import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import './ledger.css';
import { GridSkeleton } from '../grid-skeleton';
import { usd } from '../../analytics/model';
import type { LedgerRow, LedgerView } from '../../ledger/view';
import type { DataGrid as DataGridComponent } from '../grid/grid';
import { WRAP_MODULES } from '../grid/modules';
import { ledgerColumns, ledgerTotalLabel, LEDGER_PHONE_COLUMNS, LEDGER_TOTAL_FIELDS } from './columns';

// A grid cannot render on the server in this setup, so it loads in the browser only.
const DataGrid = dynamic(() => import('../grid/grid'), { ssr: false, loading: () => <GridSkeleton label="Loading ledger table..." /> }) as unknown as typeof DataGridComponent;

const TOTALS = { label: ledgerTotalLabel, fields: LEDGER_TOTAL_FIELDS };
const rowId = (row: LedgerRow) => row.id;
const rowClass = (row: LedgerRow) => (row.verify ? 'gx-row-verify' : undefined);
const EMPTY = { none: 'No postings yet.', filtered: 'No postings match this search or filter.' };

export function LedgerClient({ view, userId }: { view: LedgerView; userId: string }) {
  const columns = useMemo(() => ledgerColumns(), []);
  const capped = view.total > view.rows.length;
  return <>
    <section className="gx-root" aria-label="Server totals for every posting" data-testid="ledger-server-totals">
      <dl className="ledger-totals">
        <div><dt>Debits, every posting</dt><dd data-testid="ledger-total-debits">{usd(view.totals.debitCents)}</dd></div>
        <div><dt>Credits, every posting</dt><dd data-testid="ledger-total-credits">{usd(view.totals.creditCents)}</dd></div>
        <div><dt>Postings recorded</dt><dd data-testid="ledger-total-count">{view.total}</dd></div>
      </dl>
    </section>
    {capped && <p className="ledger-cap" data-testid="ledger-cap">Showing newest {view.rows.length} of {view.total}. The server totals above cover every posting.</p>}
    <DataGrid<LedgerRow>
      gridId="ledger"
      userId={userId}
      ariaLabel="Ledger postings, newest first"
      observedAt={view.observedAt}
      rows={view.rows}
      getRowId={rowId}
      columns={columns}
      phoneColumns={LEDGER_PHONE_COLUMNS}
      csv={{ fileBase: 'ledger' }}
      totals={TOTALS}
      getRowClass={rowClass}
      emptyMessages={EMPTY}
      extraModules={WRAP_MODULES}
    />
  </>;
}
