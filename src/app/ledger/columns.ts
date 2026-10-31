import type { LedgerRow } from '../../ledger/view';
import { centsColumn, dateColumn, textColumn, type GridColumn } from '../grid/columns';

/** Phone layout keeps these fields in the table; the rest move to the details list under it (docs/plans/GRID_SURFACES_SCOPE.md section 3.1). */
export const LEDGER_PHONE_COLUMNS = ['recordedAt', 'entryType', 'debitCents', 'creditCents'] as const;
/** The pinned bottom row sums these two fields over the rows the filter leaves visible. */
export const LEDGER_TOTAL_FIELDS = ['debitCents', 'creditCents'] as const;
export const ledgerTotalLabel = (shown: number) => `Total of ${shown} shown`;

/** Column groups read as one sentence per row: Entry, then Money, then Source. The Entry and Money widths sum to 1120 px so Debit and
 * Credit sit fully inside the grid frame at a 1280 px viewport (about 1172 px wide); Source scrolls in from the right. Recorded is
 * wide enough for its full UTC time and Effective on for a full date. Long account and fund names truncate, so their tooltips carry
 * the full text. */
export function ledgerColumns(): GridColumn<LedgerRow>[] {
  return [
    { headerName: 'Entry', children: [
      dateColumn<LedgerRow>({ field: 'recordedAt', headerName: 'Recorded (UTC)', withTime: true, width: 235 }),
      dateColumn<LedgerRow>({ field: 'effectiveOn', headerName: 'Effective on', width: 130 }),
      textColumn<LedgerRow>({ field: 'entryType', headerName: 'Type', width: 150, tip: row => row.entryTypeTip }),
    ] },
    { headerName: 'Money', children: [
      textColumn<LedgerRow>({ field: 'account', headerName: 'Account', width: 200, tip: row => row.account }),
      textColumn<LedgerRow>({ field: 'fund', headerName: 'Fund', width: 165, tip: row => (row.fund ? `${row.fund}. ${row.fundTip}` : row.fundTip) }),
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
