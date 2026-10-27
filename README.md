# AidTrace: private judge-source candidate

For prerequisites, generated-role access, no-payment review and recovery without resetting
data, use [the access guide](docs/ACCESS.md). These are prepared instructions for a later
cleared candidate. Local template checks do not establish independent judge access.

## 1. Review the boundary: unpublished source

AidTrace suggests receipt categories with exact source quotes, requires a human to confirm
them, allocates expenses across restricted funds with deterministic rules, and requires two
independent approvals before an explicitly requested PayPal sandbox reimbursement. The
application records payment only after independently fetching a successful payout item.
This package contains invented fixtures, not the owner's paid database, credentials,
recipient, Git history or original project archive. It is prepared for private review.
The existing application MIT license is included in LICENSE and package metadata. It is
the owner-approved release choice; final candidate, ownership, privacy, destination and
publication approval remain with the owner. This candidate has not been published.
Dependency/model licenses remain separate. See NOTICE, THIRD_PARTY_NOTICES.txt,
DEPENDENCY_LICENSES.json, UPSTREAM_LICENSE_SOURCES.json and docs/LICENSING.md.

The accepted AI scope uses pasted invented text and manually entered USD amounts. It does
not include OCR, autonomous approval/payment or general receipt extraction accuracy claims.
The accounting-inspired demo awaits nonprofit accountant review. Physical Safari is untested.

The optional approver dashboard uses ordinary React for funding/cash widgets and direct
same-origin requests to the existing bounded fact-selection endpoint. The fallback contains
no named AG Studio, Grid or Charts dependency in its lockfile or installed package inventory.
Its scoped removal check is not an exhaustive provenance or legal compatibility audit.
The original Studio evaluation remains separately preserved. This variant makes no AG
sponsor-use claim and does not assert a Studio license grant. See release/variant.json.

## 2. Start the fictional demo: OrbStack only

Requires OrbStack and its Docker CLI on macOS, plus internet access for pinned container,
package and model downloads. The tested model image is Linux ARM64. Other architectures
are unverified. Run these from this extracted folder:

```sh
sh scripts/aidtrace setup
sh scripts/aidtrace configure
sh scripts/aidtrace pnpm db:migrate
sh scripts/aidtrace pnpm db:seed
sh scripts/aidtrace receipt-ai-up
sh scripts/aidtrace review-up
```

No native Node, pnpm, Python or Postgres install is needed. Configure generates three
distinct passwords privately in local/.env and an explicitly non-payable recipient ending
in example.invalid. It refuses to overwrite an existing file. Read the password values in
your editor; do not paste the file into chat. PayPal client credentials are empty. The
fictional demo cannot send a payment with this configuration. It needs no PayPal login.

review-up builds into a separate named volume and serves a stable production review runtime.
It stops only the app while rebuilding. Database, model and existing data remain intact.
Source changes need another explicit review-up; development live reload is absent. This is
a local loopback review mode, not a public deployment. receipt-ai-up alone is development
mode; use review-up afterwards for the documented walkthrough.

The included .npmrc directs the package cache to /pnpm/store in its named volume. Do not
remove it. Next regenerates next-env.d.ts when switching development/production modes;
that generated type file may appear changed after a build. Keep it separate from authored
application changes when reviewing the working tree. Never publish a working folder with
generated local data; use the reviewed release source and manifest.

Open http://127.0.0.1:3100/login. If another app already uses port 3100, stop that app yourself
or use a separate machine. This package uses its own aidtrace-judge container namespace and
does not replace another AidTrace database. Local Docker administrators can access volumes.

## 3. Demonstrate AI review: no payment needed

Sign in as maria with SEED_PASSWORD_MARIA. Choose Create a synthetic receipt draft. Keep the
fictional USD 6.00 example, attest it is invented and create it. Select Prepare expense
proposal once. Review the bounded preparation steps, provisional funding and every category
and exact supporting quote. This preview reserves no funds and is not PayPal cash.
Correct or manually choose any category
with a reason, explicitly confirm, then View allocation. Stop before freezing or approvals.
The AI adapter receives bounded source text and descriptions, not money, payees or funds.
It has no tools or financial authority. Repeat requests reuse existing work. UNKNOWN stays
unresolved until human review; alcohol remains prohibited. Editing requires a new review.

The fresh C-104 allocation fixture separately shows USD 430 restricted and USD 70 General,
versus USD 200 General from its simple comparison. It is an unpaid fictional claim in this
package. It is separate from the owner's historical paid acceptance fixture, which is not
included. Never describe a synthetic test or invented opening balance as a real payment.

Sign out and sign in as tara or ben with the corresponding generated demo password.
Open the funding and cash dashboard at /analytics. Filter Restricted and General, ask
"How does book cash relate to recorded activity?", then open "Read all snapshot facts
without AI". These fresh fixtures differ from the owner's historical paid database.
The page reads local journals and fund records; it does not query PayPal balances.
AI can select only validated, exact server facts for three fixed questions. The manual
facts remain available without the model. Maria is denied this organization-wide page.

## 4. Check and stop the demo: preserve volumes

```sh
sh scripts/aidtrace check
sh scripts/aidtrace ui-check
sh scripts/aidtrace receipt-ai-down
sh scripts/aidtrace down
```

Tests create uniquely named temporary databases. Browser checks run the receipt/phone,
proposal and analytics suites in separate processes on an isolated network. Their model/provider
responses are synthetic; real model evidence is separate. Screenshots, video and traces
are disabled even on failures. All build, dependency,
database, model and browser execution stays in containers. Models, dependencies, build
output and database data stay in named volumes. Source/context stay in this readable folder.
Stop commands preserve volumes. Never prune volumes to reset a demonstration.

The model is private, with no published port, two CPU cores and a 4 GiB combined RAM/swap
ceiling. Pinned weights are approximately 1.83 GB and the model image is approximately
1.20 GB; package installation and browser images consume additional space. Stopping the
model leaves manual category review available. First download/startup is excluded from
reported inference timings. See docs/THIRD_PARTY_MODELS.md for license and artifact pins.

## 5. Assess evidence: scoped acceptance

The owner assigned Gate A, Gate A+ and Gate B PASS on October 22, 2026. The implemented
receipt checkpoint passed 220 tests, TypeScript, production build and six Chromium checks
at 375 by 812. The later private analytics implementation passed 229 tests across 24 files,
types/build and desktop/phone Chromium checks. The owner accepted its private interface
on October 23. This template update is not fresh exact-candidate setup/runtime evidence;
that must be recorded separately before release. Prior gate verdicts stay unchanged.
The later expense-proposal interface also has the owner's October 23 no-payment walkthrough:
preparation, source-quote review, explicit category confirmation and allocation, stopping
before Freeze. Preparation has no confirmation, approval or payment authority. New exact
candidate evidence must include this adopted scope and its additive migration.
The fixed invented 24-case single-line model evaluation matched 23 validated expected
outcomes, including seven UNKNOWN abstentions and one rejected quote counted incorrect.
This does not establish general accuracy. Source dataset/prompt/model pins are included.

PayPal sandbox payouts, captures and webhook replay were separately observed in the private
owner workspace. Their identifiers, credentials, database and evidence files are deliberately
excluded here. Reporting access was unavailable there; the approved fallback handles a
provider insufficient-funds response and refuses a readable short balance. UNKNOWN outcomes
require manual reconciliation, with no automatic new send. Real PayPal testing requires
separate owner setup/authorization and is outside these judge instructions.

SOURCE_MANIFEST.json records included file hashes and export transformations. No .git,
local configuration, backup, payment identifiers, historical project assets or model weights
are distributed. The original repository and history remain privately preserved.
