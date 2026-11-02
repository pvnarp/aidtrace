'use client';
import dynamic from 'next/dynamic';
import { useMemo, type CSSProperties } from 'react';
import './approver-queue.css';
import type { ApproverQueueRow } from '../../server/approver-queue';
import type { DataGrid as DataGridComponent } from '../grid/grid';
import { queueColumns, QUEUE_PHONE_COLUMNS } from './columns';

// A grid cannot render on the server in this setup, so it loads in the browser only.
const DataGrid = dynamic(() => import('../grid/grid'), { ssr: false, loading: () => <p role="status">Loading approval queue...</p> }) as unknown as typeof DataGridComponent;

const rowId = (row: ApproverQueueRow) => row.id;
/** Rows the frame is sized for: at least two so a filter that hides the only row still leaves room for the empty message, at most twelve, then the grid scrolls. */
export const frameRows = (count: number) => Math.max(2, Math.min(count, 12));

export function ApproverQueueClient({ rows, observedAt, userId }: { rows: ApproverQueueRow[]; observedAt: string; userId: string }) {
  const columns = useMemo(() => queueColumns(), []);
  return <section className="aq-queue" aria-labelledby="aq-heading" style={{ '--aq-rows': frameRows(rows.length) } as CSSProperties} data-testid="aq-queue">
    <h2 id="aq-heading">Awaiting your approval</h2>
    <p className="aq-note">A claim you approved waits for the second approver and is not listed.</p>
    <DataGrid<ApproverQueueRow>
      gridId="approver-queue"
      userId={userId}
      ariaLabel="Expenses awaiting your approval"
      observedAt={observedAt}
      rows={rows}
      getRowId={rowId}
      columns={columns}
      phoneColumns={QUEUE_PHONE_COLUMNS}
    />
  </section>;
}
