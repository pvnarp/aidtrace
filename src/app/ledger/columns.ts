import type { LedgerRow } from '../../ledger/view';
import { centsColumn, dateColumn, textColumn, type GridColumn } from '../grid/columns';

/** Phone layout keeps these fields in the table; the rest move to the details list under it (docs/plans/GRID_SURFACES_SCOPE.md section 3.1). */
export const LEDGER_PHONE_COLUMNS = ['recordedAt', 'entryType', 'debitCents', 'creditCents'] as const;
/** The pinned bottom row sums these two fields over the rows the filter leaves visible. */
export const LEDGER_TOTAL_FIELDS = ['debitCents', 'creditCents'] as const;
export const ledgerTotalLabel = (shown: number) => `Total of ${shown} shown`;

/** Column groups read as one sentence per row: Entry, then Money, then Source. The Entry and Money widths sum to 1170 px, the inner width
 * of the grid frame at 1280 and 1440 px viewports, so the frame's right edge falls on the Credit and Source boundary and no column is cut
 * there; Source scrolls in from the right and the status line says so. Recorded fits its widest full UTC time (240 px: "May 28, 2026, 12:58 PM UTC" needs 230 px with padding; 226 px overflowed from 10:00 UTC on two-digit days), Effective on a date filter
 * with its whole mm/dd/yyyy placeholder (220 px: the input needs about 177 to 184 px plus the 32 px cell padding), and Type its longest label.
 * Long account and fund names wrap onto more lines and the row grows, so the name is read whole; the tooltips still carry the full text. Claim ids are 38 characters, so Claim stays in Source. */
export function ledgerColumns(): GridColumn<LedgerRow>[] {
  return [
    { headerName: 'Entry', children: [
      dateColumn<LedgerRow>({ field: 'recordedAt', headerName: 'Recorded (UTC)', withTime: true, width: 240 }),
      dateColumn<LedgerRow>({ field: 'effectiveOn', headerName: 'Effective on', width: 220 }),
      textColumn<LedgerRow>({ field: 'entryType', headerName: 'Type', width: 184, tip: row => row.entryTypeTip }),
    ] },
    { headerName: 'Money', children: [
      textColumn<LedgerRow>({ field: 'account', headerName: 'Account', width: 164, wrap: true, tip: row => row.account }),
      textColumn<LedgerRow>({ field: 'fund', headerName: 'Fund', width: 122, wrap: true, tip: row => (row.fund ? `${row.fund}. ${row.fundTip}` : row.fundTip) }),
      centsColumn<LedgerRow>({ field: 'debitCents', headerName: 'Debit', width: 120 }),
      centsColumn<LedgerRow>({ field: 'creditCents', headerName: 'Credit', width: 120 }),
    ] },
    { headerName: 'Source', children: [
      textColumn<LedgerRow>({ field: 'claim', headerName: 'Claim', width: 190 }),
      textColumn<LedgerRow>({ field: 'approvals', headerName: 'Approvals', width: 150 }),
      textColumn<LedgerRow>({ field: 'paypalReference', headerName: 'PayPal reference', width: 260, tip: row => row.paypalTip }),
    ] },
  ];
}
