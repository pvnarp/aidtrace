'use client';
import dynamic from 'next/dynamic';
import { useMemo, type CSSProperties } from 'react';
import './approver-queue.css';
import type { ApproverQueueRow } from '../../server/approver-queue';
import type { DataGrid as DataGridComponent } from '../grid/grid';
import { queueColumns, QUEUE_PHONE_COLUMNS } from './columns';
import type { AssistedChecks } from '../../server/assisted-checks';
import { AssistedQueueClient } from '../assisted-queue/client';

// A grid cannot render on the server in this setup, so it loads in the browser only.
const DataGrid = dynamic(() => import('../grid/grid'), { ssr: false, loading: () => <p role="status">Loading approval queue...</p> }) as unknown as typeof DataGridComponent;

const rowId = (row: ApproverQueueRow) => row.id;
/** Only the filtered copy: an empty queue has its own home on the page and keeps it. */
const EMPTY = { filtered: 'No queued claims match this search or filter.' };
/** Rows the frame is sized for: at least one, at most twelve, then the grid scrolls. A filter that hides the only row shows the grid's empty message in that one row of room (HP-10). */
export const frameRows = (count: number) => Math.max(1, Math.min(count, 12));

/** The optional assisted prop is set only when the fund modes flag is on and a waiting claim is Assisted (IAC-405 PR A). Without it this is the queue as it always was. */
export function ApproverQueueClient({ rows, observedAt, userId, assisted }: { rows: ApproverQueueRow[]; observedAt: string; userId: string; assisted?: Record<string, AssistedChecks> }) {
  const columns = useMemo(() => queueColumns(), []);
  if (assisted) return <AssistedQueueClient rows={rows} observedAt={observedAt} userId={userId} assisted={assisted} />;
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
      emptyMessages={EMPTY}
    />
  </section>;
}
