# Scope the AG Grid ledger view: one read-only Community grid for the fund ledger and audit trail

Status: proposed October 29, 2026. Decisions 1 to 7 were adopted October 31, 2026 under the overnight delegation
(docs/decisions.md, "AG Grid ledger scope decisions 1 to 7 adopted under the overnight delegation: October 31 IAC-380"),
and decision 4 was amended for the transitive `ag-charts-types` package and vendor help text (docs/decisions.md,
"AG Grid guard amendment for the transitive types package and vendor help text: October 31 IAC-380"). Decision 8 is open.
Step 1 (the `STUDIO_FREE_COMMUNITY_GRID` guard variant, the exact pins and the refreshed notices) is built on branch
feat/iac380-grid-deps; its evidence is docs/GATE_REPORT.md section 42. The view, route and grid are not built.
Owner decision October 29: yes to one AG Grid ledger view, Community edition. Binding inputs:
AGENTS.md sections 1 to 4, the locked docs/DESIGN_LANGUAGE.md, and the parallel donation package.

## 1. Restrict the audience: approvers only, on a new route
Recommendation: serve `/ledger` to approvers only, copying `/analytics`. The page calls
`findSession`, redirects anonymous users to `/login`, and shows "Approver access required." to claimants.
The data loader runs in a `set transaction read only` transaction and rechecks `role === 'APPROVER'`
and the single-organization invariant, as `loadAnalyticsSnapshot` does.
Layout: the locked three-column shape, with the grid in the fluid center and the summary column
holding the server totals. The real app has no rail or summary column yet (DESIGN_LANGUAGE section 4).
Build the page as a standalone route using the grid theme, so the hybrid shell wraps it later.
Cost: one new route, one nav link beside "View funding and cash". Claimants lose nothing.

## 2. Choose rows and columns: one row per journal posting
Recommendation: one row per `journal_postings` row joined to `journal_entries`. A posting carries the
debit or credit, so the row answers "which side" without inference.

| Column | Source | Note |
| --- | --- | --- |
| Recorded (UTC) | `journal_entries.recorded_at` | formatted by `reviewTime` |
| Effective on | `effective_on` | date only |
| Entry type | `source_type` and `purpose` | for example donation, settlement, payout_fee |
| Account | `account_code` | 1010 cash, 2010 payable, 3100 restricted, 5100 supplies |
| Fund | `sub_key` for 3100 and 4100 only | other accounts show General or blank, never guessed |
| Side and amount | `debit_cents` or `credit_cents` | cent strings, `usd()` formatter, tabular figures |
| Claim | `source_id` mapped to claim | see assumption below |
| Approvals | `approvals` through `allocation_decisions.decision_hash` | "2 of 2" or "n of 2" |
| PayPal reference | `disbursement_attempts` and `donation_receipts` | payout item id, capture id, honest status |

Rules: an `UNKNOWN` payout state renders as UNKNOWN, never as paid or failed. A missing reference
renders "No PayPal reference", never a blank that reads as success.
Assumption to verify in implementation: `claim_recognition` source ids resolve to a claim id and
`paypal_payout_item` source ids resolve through `disbursement_attempts.payout_item_id`. The ledger source
read for this scope did not trace every join. A claim line link needs `budget_line` subKeys on 5100 and 5200.
Audit trail: keep it in the same grid as a second dataset behind a two-option control, "Ledger postings"
and "Audit events". Events are approvals, rejections, retry authorizations and verified provider events
(`approvals`, `claim_rejections`, `retry_authorizations`, `provider_events`). Cut line: events are the
first thing dropped (section 9). Donations need no change: capture journals (`paypal_capture`, purposes
`donation` and `donation_fee`) already post through `src/ledger/donation.ts` and appear automatically.
`donation_receipts` rows with status PENDING have no journal and stay out of the ledger dataset.

## 3. Build the data path: server query, string cents, client grid, no write path
1. A new read function `src/ledger/view.ts` runs the join in one read-only transaction and returns plain
   rows with every cent value as a decimal string, matching `AnalyticsSnapshot`.
2. The server page passes rows and server totals to one `'use client'` component, loaded with
   `next/dynamic` as `/analytics` does. A grid cannot render on the server in this setup.
3. The grid is given `rowData` and no edit options. No column is `editable`. No route, action or API is added.
4. Cap the query at 2000 rows with newest first and show "Showing newest 2000 of N" when it trips.
   The cap is a guess sized for the demo fixture. The actual fixture row count is not measured here.
5. Money never becomes a JavaScript number. Amount sort uses a `BigInt` comparator. The vendor page
   for the BigInt Filter (version 36.2.0) exists, so a precision-safe amount filter is possible.

Boundary: only the ledger module writes journal entries and only `src/paypal/adapter.ts` calls PayPal.
The new module imports neither. A test hashes the financial tables before and after (section 8).

## 4. Pick features: five, all Community
| Feature | Why an approver needs it | Community status |
| --- | --- | --- |
| Column sort | order by time or amount to find the large postings | Community per vendor page |
| Text filter on Fund and Entry type | isolate one grant or one kind of entry | Community text filter |
| Quick filter | find a claim id or PayPal reference fast | Community, vendor page fetched |
| Server totals in a pinned bottom row | debits equal credits, shown without client arithmetic | Row Pinning module, Community status not confirmed |
| Visible-total status line | total of what the filter leaves visible | BigInt sum, as the Funding widget does |

Not used: Set Filter, row grouping, pivot, charts, Excel export, server-side row model, master detail,
integrated charts. The vendor comparison page lists server-side row model, Excel export, charts,
master/detail and row grouping as Enterprise. Set Filter as Enterprise is from memory and not confirmed
from the page text. Use the text filter for Fund and Type, which avoids the question.
Confirmation method: register only named Community modules, not `AllCommunityModule`, so any Enterprise
need fails at development time. Cost: a short module list to maintain.

## 5. Handle phone width: contained grid with fewer columns
Recommendation: at 390 px show Recorded, Entry and Amount. The other columns move into a native
`<details>` list under the grid, fed by the same rows. The grid sits in a fixed-height container with
`overflow: hidden` on the page and its own internal scroll only. The page body never scrolls sideways;
the existing `contained()` assertion (`scrollWidth <= innerWidth`) enforces this at 1280 and 390.
Fallback if the grid proves unstable at 390: render the same rows as a native card list below 640 px
and keep the grid for wider screens. Cost: a second rendering path and a wording note in the video.

## 6. Theme to the locked tokens: parameters, not new colors
The Theming API takes parameters such as `accentColor`, `spacing` and `fontFamily`, and
`{ ref, mix, onto }` color expressions (vendor Theme Parameters page).
Plan: start from the built-in light theme, then set these from the lock:

| Grid parameter | Locked token |
| --- | --- |
| foreground and header text | ink `#142b3d`, muted `#506579` |
| border and dividers | line `#d6e1eb` |
| background | paper `#ffffff`, header and pinned row soft `#f3f6fa` |
| accent, selection | accent `#076d65`, tint `#e9f5f2` |
| font | the pinned Inter 4.1 asset with tabular numerals |
| container radius | 10 px, 1 px border, no shadow |

Remaining deviations: AG Grid icons, menu popups, filter inputs and focus rings keep vendor shapes
and radii. Header weight and row height follow the grid defaults unless tuned. The theme injects a
`<style>` element at runtime; `next.config.ts` sets no CSP today, so this works, but a future CSP
would need a nonce or the `themeStyleContainer` option. The app stylesheet still holds the older
green palette, so the grid will look blue-slate until the hybrid shell lands. Any amendment to the
locked tokens is Pavan's alone; this scope proposes none.

## 7. Add the dependency: two packages, a guard change, and a notice refresh
Verified registry facts, fetched October 29, 2026:

| Package | Version | License | Peer dependencies | Unpacked size |
| --- | --- | --- | --- | --- |
| ag-grid-community | 36.2.0 | MIT | none declared | 21,636,306 bytes, 680 files |
| ag-grid-react | 36.2.0 | MIT | react and react-dom, ^16.8 to ^19 | 842,430 bytes, 67 files |
| ag-stack (dependency of community) | 36.2.0 | MIT | not checked | 2,092,170 bytes |

The repository LICENSE.txt lists ag-grid-community and ag-grid-react as MIT and ag-grid-enterprise as
Commercial. React is 19.3.1 and Next is 16.4.2 here, inside the peer range. Whether 36.2.0 runs
cleanly under Next 16.4.2 is not tested. Unpacked npm size is not bundle size; the browser bundle effect
is not measured and needs `next build` in the container.
Path: all inside OrbStack, never on macOS.
1. `sh scripts/aidtrace pnpm add ag-grid-community@36.2.0 ag-grid-react@36.2.0` with exact pins.
2. The lockfile changes; judges run `pnpm install --frozen-lockfile` in the bootstrap container,
   which uses `network_mode: bridge`, so the packages reach the named `node_modules` and `pnpm_store` volumes.
   Runtime containers stay on internal networks. Volume cost is about 25 MB.
3. Regenerate `DEPENDENCY_LICENSES.json`, `THIRD_PARTY_NOTICES.txt` and `UPSTREAM_LICENSE_SOURCES.json`
   with the existing collector scripts, and retain the MIT text for all three packages.
4. Amend `scripts/assert-studio-free.mjs`. Its pattern `ag-(studio|grid|charts)` rejects any AG
   package in `package.json`, the lockfile, `src`, the inventory and browser assets. `release/variant.json`
   is `STUDIO_FREE_FALLBACK` with `sponsorUseClaimed: false`. Add a new variant kind that allows exactly
   `ag-grid-community` and `ag-grid-react` and still rejects ag-studio, ag-grid-enterprise and ag-charts.
   This is a guard change and needs an explicit owner decision (item 4 below).
No Studio, no Enterprise key, no trial and no vendor contact are involved. docs/plans/AG_STUDIO_INQUIRY.md
stays unsent and concerns Studio only.

## 8. Test it: unit, end-to-end and GATE_REPORT IDs
Proposed IDs, continuing the AN series style. Real IDs are assigned when the package starts.

| ID | Layer | Assertion |
| --- | --- | --- |
| LG-01 | unit | row mapper: cents stay strings, debit xor credit, UNKNOWN passes through |
| LG-02 | unit | totals: debits equal credits in BigInt, reconcile tie-out unchanged |
| LG-03 | e2e | anonymous redirected, claimant denied (page and any data route), approver sees grid |
| LG-04 | e2e | row count equals a server query count at 1280 and 390 |
| LG-05 | e2e | fund filter, type filter and quick filter change visible rows and visible total |
| LG-06 | e2e | zero external requests, using the `page.route` abort counter from AN-07 |
| LG-07 | e2e | no page-level horizontal scroll and controls inside the viewport at 1280 and 390 |
| LG-08 | e2e | `financialHash` of all ledger tables identical before and after the view |
| LG-09 | script | modified guard passes the grid variant and fails on ag-studio or enterprise |
| LG-10 | e2e | donation capture entries appear after a stubbed donation post, mock labeled |

Run in OrbStack, report actual results and the dirty or commit state. Add the IDs to `docs/GATE_REPORT.md`
with no gate verdict; only Pavan decides gates. Existing suites must still pass unchanged.

## 9. Sequence and size: about 5 working days, with cut lines
| Step | Days |
| --- | --- |
| Owner decisions, dependency add, guard amendment, notices | 1.0 |
| View module, route, authorization, row mapper, unit tests | 1.5 |
| Grid component, modules, theme, 390 px behavior | 1.5 |
| End-to-end tests, GATE_REPORT, README and video wording | 1.0 |

Sequencing: all new code is in new files (`src/app/ledger`, `src/ledger/view.ts`). Only the nav link
touches `src/app/page.tsx`, which `feat/hybrid-app-shell` also changed (it touches `page.tsx`,
`style.css` and four other UI files). Branch from main now, merge the hybrid shell first or rebase over
it, and take the one-line link conflict last. Do not edit `style.css`; scope grid CSS to its own file.
Cut lines, in order: (1) audit events dataset, (2) the card-list fallback and 390 px details list,
(3) pinned row, keeping the status line, (4) custom theme parameters beyond color and font.
Never cut: read-only enforcement, approver check, string cents, zero-external-request test.
Donation timing: this scope needs no donation code. Do not block on that package.

## 10. Present it honestly: Community, one view, no prize claim
Say: "The approver ledger view uses AG Grid Community (MIT) to display read-only journal postings
and audit events." Show it for under ten seconds in the video, with the label "Sandbox fixture".
Do not say: Enterprise, Studio, charts, "powered by AG Grid", or that the prize is won, likely
or confirmed eligible. The rules text reads "All Eligible Submissions that use any AG Grid tools",
so Community use plausibly qualifies. The "Best Use" judging criteria were not located in the rules text
read for this scope. Do not claim a quality ranking. README states the package versions, the MIT
license, the one view and the read-only boundary. `sponsorUseClaimed` flips to true only by owner
decision after the grid passes its tests. No publication, recording, contact or payment follows.

## Owner decisions to adopt
1. Adopt `/ledger` for approvers only, one row per journal posting, with audit events as a second dataset. Recommended: yes; events are the first cut.
2. Adopt string cents, the existing `usd()` formatter, a BigInt sort comparator and no amount filter. Recommended: yes.
3. Adopt Community modules registered by name, not `AllCommunityModule`. Recommended: yes.
4. Authorize amending `scripts/assert-studio-free.mjs` and `release/variant.json` for a new Community-grid variant that still bans ag-studio, ag-grid-enterprise and ag-charts. Recommended: yes, as its own reviewed commit.
5. Authorize adding exact pins `ag-grid-community@36.2.0` and `ag-grid-react@36.2.0` through the OrbStack toolchain, with refreshed notices. Recommended: yes after items 3 and 4.
6. Choose the phone behavior: reduced columns in the grid, or a card list below 640 px. Recommended: reduced columns first, card list as fallback.
7. Choose sequencing: branch from main now and take the nav-link conflict after the hybrid shell, or wait for the shell. Recommended: branch now.
8. Approve the video and README wording in section 10 and state when `sponsorUseClaimed` may flip. Recommended: approve; flip after tests pass.

## Sources
- https://raw.githubusercontent.com/ag-grid/ag-grid/latest/LICENSE.txt (MIT and Commercial package lists)
- https://registry.npmjs.org/ag-grid-community/latest and https://registry.npmjs.org/ag-grid-react/latest
- https://registry.npmjs.org/ag-stack/36.2.0
- https://www.ag-grid.com/javascript-data-grid/community-vs-enterprise/
- https://www.ag-grid.com/react-data-grid/getting-started/ , /modules/ , /theming/ , /theming-parameters/
- https://www.ag-grid.com/react-data-grid/row-pinning/ , /filter-quick/ , /filter-bigint/ , /accessibility/ , /keyboard-navigation/
- Rules text, scratchpad devpost/rules.txt: "All Eligible Submissions that use any AG Grid tools" (1st, 2nd, 3rd place, USD 5,000, 2,000, 1,000)
- Repo: AGENTS.md, docs/DESIGN_LANGUAGE.md, db/schema.ts, src/ledger/*, src/analytics/snapshot.ts, src/app/analytics/*, e2e/analytics.spec.ts, scripts/assert-studio-free.mjs, release/variant.json, release/judge/*, docs/plans/AG_STUDIO_INQUIRY.md
