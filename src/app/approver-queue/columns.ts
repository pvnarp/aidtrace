import type { ApproverQueueRow } from '../../server/approver-queue';
import { centsColumn, dateColumn, textColumn, type ColumnMeta, type GridColumn } from '../grid/columns';
import { ProgressCell, ReviewCell, VendorCell } from './cells';
import { progressText, queueSteps } from './progress';

/** Phone layout keeps these fields in the table; the rest move to the details list under it (docs/plans/GRID_SURFACES_SCOPE.md section 2.8).
 * The Review link stays in the table on a phone so a row can always be opened. */
export const QUEUE_PHONE_COLUMNS = ['vendor', 'amountCents', 'href'] as const;

const noText: ColumnMeta<ApproverQueueRow> = { kind: 'text', text: () => '' };

/**
 * The columns of IAC-414 Q1 (docs/plans/GRID_SURFACES_SCOPE.md section 3.2 step A): Claimant, Vendor with its fund beneath, the approval
 * count, Amount, a six-step Progress trace, Age and a Review link. Every column is read only. Amount is the shared string-cents BigInt
 * column. Progress and Review are display only: no sort, no filter. Age sorts on the frozen-at timestamp and shows the elapsed time.
 */
export function queueColumns(): GridColumn<ApproverQueueRow>[] {
  const age = dateColumn<ApproverQueueRow>({ field: 'waitingSince', headerName: 'Age', width: 110, filter: false, floatingFilter: false, tip: row => (row.waitingSince ? `Frozen ${row.waitingSince}` : undefined) });
  return [
    textColumn<ApproverQueueRow>({ field: 'claimant', headerName: 'Claimant', flex: 1, minWidth: 130 }),
    textColumn<ApproverQueueRow>({
      field: 'vendor', headerName: 'Vendor', flex: 1.6, minWidth: 140, cellRenderer: VendorCell, cellClass: 'aq-cell',
      tip: row => `${row.vendor}\n${row.fund}`,
      getQuickFilterText: params => `${params.value ?? ''} ${params.data?.fund ?? ''}`,
    }),
    textColumn<ApproverQueueRow>({ field: 'approvals', headerName: 'Status', width: 175 }),
    centsColumn<ApproverQueueRow>({ field: 'amountCents', headerName: 'Amount', width: 120 }),
    {
      field: 'approvalCount', headerName: 'Progress', width: 150, sortable: false, filter: false, floatingFilter: false,
      cellRenderer: ProgressCell, cellClass: 'aq-cell', getQuickFilterText: () => '',
      context: { kind: 'text', text: row => progressText(queueSteps(row.approvalCount)) } satisfies ColumnMeta<ApproverQueueRow>,
    },
    {
      ...age,
      valueFormatter: params => (params.data ? params.data.age : ''),
      getQuickFilterText: params => params.data?.age ?? '',
      context: { kind: 'date', text: row => row.age } satisfies ColumnMeta<ApproverQueueRow>,
    },
    {
      field: 'href', headerName: 'Review', width: 80, sortable: false, filter: false, floatingFilter: false,
      cellRenderer: ReviewCell, cellClass: 'aq-cell', getQuickFilterText: () => '', context: noText,
    },
  ];
}
