import type { DonationRow } from '../../donation/donations-grid';
import { centsColumn, dateColumn, textColumn, type GridColumn } from '../grid/columns';

/** Phone layout keeps these fields in the table; the rest move to the details list under it (docs/plans/GRID_SURFACES_SCOPE.md section 2.8). */
export const DONATIONS_PHONE_COLUMNS = ['received', 'amountCents', 'state', 'payoutStatus'] as const;
/** The pinned bottom row sums these three fields over the rows the filter leaves visible. */
export const DONATIONS_TOTAL_FIELDS = ['amountCents', 'matchedCents', 'waitingCents'] as const;
export const donationsTotalLabel = (shown: number) => `Total of ${shown} ${shown === 1 ? 'gift' : 'gifts'} shown`;

/** Column groups read as one sentence per gift: the Gift, its Trail, then its Payout (docs/plans/DONOR_TRAIL_SCOPE.md section 4). Received is
 * wide enough for the pinned total label. The Line and Vendor summaries stay searchable through their tooltips as well as their cells. */
export function donationsColumns(): GridColumn<DonationRow>[] {
  return [
    { headerName: 'Gift', children: [
      dateColumn<DonationRow>({ field: 'received', headerName: 'Received', width: 190, sort: 'desc' }),
      textColumn<DonationRow>({ field: 'donor', headerName: 'Donor', width: 150, tip: row => row.donor }),
      centsColumn<DonationRow>({ field: 'amountCents', headerName: 'Amount', width: 125 }),
      textColumn<DonationRow>({ field: 'fund', headerName: 'Fund', width: 215, tip: row => row.fund }),
      textColumn<DonationRow>({ field: 'capture', headerName: 'Capture', width: 120, tip: () => 'Only the last 6 characters of the capture ID are shown.' }),
    ] },
    { headerName: 'Trail', children: [
      textColumn<DonationRow>({ field: 'state', headerName: 'State', width: 175 }),
      centsColumn<DonationRow>({ field: 'matchedCents', headerName: 'Matched', width: 125 }),
      centsColumn<DonationRow>({ field: 'waitingCents', headerName: 'Waiting', width: 125 }),
      textColumn<DonationRow>({ field: 'lines', headerName: 'Lines', width: 110, tip: row => row.linesTip, getQuickFilterText: params => `${params.value ?? ''} ${params.data?.linesTip ?? ''}` }),
      textColumn<DonationRow>({ field: 'vendor', headerName: 'Vendor', width: 170, tip: row => row.vendorTip, getQuickFilterText: params => `${params.value ?? ''} ${params.data?.vendorTip ?? ''}` }),
    ] },
    { headerName: 'Payout', children: [
      textColumn<DonationRow>({
        field: 'payoutStatus', headerName: 'Status', width: 240, tip: row => row.payoutTip,
        cellClass: params => (params.node?.rowPinned || !params.data ? undefined : ['gx-status', params.data.payoutDot]),
      }),
      textColumn<DonationRow>({ field: 'paypalReference', headerName: 'PayPal reference', width: 160, tip: row => row.paypalTip }),
    ] },
  ];
}
