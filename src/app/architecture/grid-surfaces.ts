/** The four tables built on AG Grid Community, for the "Where AG Grid works" section of How it works. All four are approver pages: an approver gets a link, a claimant reads plain text. */
export interface GridSurface { name: string; href: string; does: string; value: string }

export const GRID_SURFACES: readonly GridSurface[] = [
  { name: 'Awaiting your approval', href: '/', does: 'Frozen claims waiting on you, with their age and approval progress.', value: 'An approver scans, sorts and filters many claims at once instead of opening them one by one.' },
  { name: 'Awaiting your approval, with tick boxes', href: '/', does: 'The same list when bulk approval is on, with a tick box on each claim that has no holds so several can be approved in one step. Each tick is still a human approval.', value: 'The clean claims clear together and the held ones stay visible for a closer look.' },
  { name: 'Ledger', href: '/ledger', does: 'Every journal posting with its fund, claim, approvals and PayPal reference. A total row sums only the rows the filter leaves.', value: 'Postings tie out to the cent, and CSV export hands a funder or an auditor the same rows.' },
  { name: 'Donations', href: '/donations', does: 'Completed gifts, the receipt lines each gift matched and the payout that followed. Totals cover the filtered gifts.', value: 'Filter to the gifts you care about, read the total, then export CSV.' },
];
