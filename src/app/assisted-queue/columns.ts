import type { ApproverQueueRow } from '../../server/approver-queue';
import { textColumn, type ColumnMeta, type GridColumn } from '../grid/columns';
import { queueColumns } from '../approver-queue/columns';
import { ChecksCell } from './cells';

/** A queue row with the Assisted facts the server read for it. A Manual claim has none of the three fields, so its Checks cell is empty and it cannot be selected. */
export type AssistedQueueRow = ApproverQueueRow & { claimVersion?: number; checks?: string; selectable?: boolean };

/**
 * The approver queue columns with one more, Checks, directly after Status (IAC-405 PR A). The seven columns of the queue are the same objects the queue
 * uses on its own, so nothing else about them changes. The Checks column filters and exports as plain text: "No holds found", "N holds" or "Not checked yet".
 */
export function assistedColumns(): GridColumn<AssistedQueueRow>[] {
  const base = queueColumns() as GridColumn<AssistedQueueRow>[];
  const checks = { ...textColumn<AssistedQueueRow>({ field: 'checks', headerName: 'Checks', width: 160, cellRenderer: ChecksCell, cellClass: 'aq-cell' }), context: { kind: 'text', text: (row: AssistedQueueRow) => row.checks ?? '' } satisfies ColumnMeta<AssistedQueueRow> };
  const at = base.findIndex(column => 'field' in column && column.field === 'approvals');
  return [...base.slice(0, at + 1), checks, ...base.slice(at + 1)];
}
