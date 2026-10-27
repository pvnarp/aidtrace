# Scope agent-prepared expense proposals

## 1. Strengthen AidTrace: audience, outcome and status

Prepare one nonprofit reimbursement expense for human review. A claimant starts a bounded
preparation run on an owned fictional receipt draft. AI proposes source-grounded categories.
Server code checks completeness and previews eligible funding with the existing solver.
The claimant reviews and confirms categories before the existing freeze, two-approver and
explicit sandbox-payment workflow can begin.

Pavan requested this scope on October 23, 2026: "scope that bounded expense proposal extension,
keep human approvals intact, update Linear and timelines". This document completes planning.
Pavan subsequently adopted this addendum on October 23: "yeah adopt the scope and keep going
with IAC-244". Pavan subsequently authorized IAC-245: "build the review interface, keep
human approvals intact". Backend and interface implementation are authorized. No new payment, publication, recording
or contact is authorized. AGENTS.md includes this addendum. No new gate verdict is assigned.

The recipient is the AidTrace owner and implementing engineer. The decision is to prepare
this bounded extension instead of pivoting into compute procurement. The existing Gate A,
A+ and B PASS evidence and paid/unpaid owner fixtures remain valid for their original scope.
New functionality needs new evidence before any submission claim changes.

## 2. Reuse the verified foundations: code and incremental work

Inspection at baseline 3d3ae8bf4868b405a3a465698ded52928bfdb37d found:

- src/receipt/service.ts already creates owned DRAFT claims, checks review/source hashes,
  deduplicates category requests and requires explicit claimant category confirmation.
- src/ai/receipt.ts permits only category IDs and exact source quotes. It rejects tool calls,
  extra fields and invalid quotes. Its receipt inference deadline is 60 seconds.
- src/receipt/guard.ts prevents freezing an unconfirmed or changed receipt.
- src/ledger/snapshot.ts supplies current policies, capacities and reservations.
- src/domain/allocate.ts computes allocation using integer cents and approved priorities.
- src/server/claim-actions.ts remains the human financial-action boundary.

The extension adds an orchestrated preparation run, an advisory policy preview and a visible
step trace. It does not merely rename the existing Request AI action. The model remains a
bounded proposal component. Server code selects and sequences the allowed operations;
the model does not dynamically select tools or choose financial authority.

## 3. Bound the journey: one goal and one receipt

Use the existing manually entered vendor, program, expense date, exact USD amounts and
invented receipt text. Keep 1 to 12 lines, 16 KiB source text and USD 500 total limits.
Do not add free-form goals, uploads, OCR, merchant browsing or invented financial fields.

1. The owning claimant selects Prepare expense proposal on an editable receipt. Explain
   that the action prepares suggestions and a provisional preview, with no reservation.
2. Authenticate and authorize the owner before any data read or inference. Validate the
   current draft and review hashes. Create a nonfinancial preparation-run record.
3. Reuse a valid READY suggestion for that exact review or invoke the existing receipt
   categorizer once. Duplicate clicks reuse the active/completed run; they do not enqueue
   another model call. A failed run requires an explicit new preparation request.
4. Validate every proposed line/category/quote. Treat source instructions as data. Unknown
   or invalid results produce Needs review without guessing a category or funding result.
5. If every category is valid, overlay proposals on an in-memory copy of claim lines.
   Read one authorized, consistent policy/capacity snapshot and call the existing solver.
   Do not update claim-line categories, confirmations or financial tables for this preview.
6. Display categories, quotes, server-formatted amounts, policy reasons and unresolved
   items. Label a feasible preview Provisional funding available, human review required.
   A blocked preview lists deterministic reasons and the relevant lines. No Approved label.
7. The claimant accepts or corrects every category through the existing explicit
   confirmation service. Manual corrections retain human provenance and reasons. Recompute
   the ordinary preview from confirmed categories; a proposal preview is never authoritative.
8. The claimant separately freezes the current allocation. Tara and Ben separately approve
   the exact terms. Only the existing explicit human payment action may request a payout.

Preparation itself may write only its run/audit records and existing receipt-suggestion
records. Claim creation remains the existing explicit draft action. Confirmation and
freezing remain separate requests. There is no background preparation on page load.

## 4. Preserve authority: limits, policy and concurrency

The new orchestration layer may call only category suggestion and read-only policy preview.
It must not import or dispatch freeze, approval, recognition, journal, retry, donation or
payout actions. Do not expose a generic tool dispatcher, arbitrary URL or agent API key.
Keep authenticated same-origin form actions, current body limits and strict field allowlists.

The model receives only the existing source/line description payload and taxonomy. No
fund balances, policies, payee, actor/session details, credentials or provider IDs enter its
prompt. Do not send the policy result back for model-generated explanations or repairs.
Render the preview and preparation trace from server-authored result codes and exact cents.
Do not retain or display hidden model reasoning.

Bind a run to organization, claimant, claim version, review ID, source/draft hashes,
validated suggestion digest and the current policy/capacity snapshot digest. The latter
includes policy/priority versions, relevant fund balances, shared-cap usage and active
reservations. Store an opaque digest of server-side payee terms, never a display recipient
editable by the agent. Authorize the claim before loading its snapshot.

Use a repeatable read-only transaction for preview calculation and a fresh current-state
check before recording its result. A changed draft, confirmation or financial lifecycle
causes STALE. A later capacity/policy change marks the displayed preview stale and requires
an explicit refresh. Preview is not a reservation; freeze always recomputes and validates
current capacity through existing transaction/locking behavior. Do not keep locks open
during inference. One active run per current review, enforced in storage across app processes.

Proposed run states are RUNNING, READY_FOR_REVIEW, NEEDS_REVIEW, POLICY_BLOCKED, UNAVAILABLE
and STALE. They are preparation states, not new Claim or Disbursement states. Record actor,
timestamps, source/model/prompt identities, existing suggestion reference, snapshot digest,
step outcomes and a bounded deterministic summary. Reuse existing suggestions; do not store
raw prompts/responses twice. Add at most one nonfinancial proposal-run table if needed.
No existing financial table/schema migration, policy-rule change or history backfill belongs
in this extension. Validate any additive migration on isolated data before owner data.

Keep one inference call per explicit run, no automatic retry, no recursive planning and no
automatic category repair. Reuse the existing 60-second receipt inference deadline and
64 KiB model-response cap. Set a 65-second overall preparation deadline, including validation
and preview; stop with a clear manual path when exhausted. Do not add an unbounded queue.
Reject concurrent preparation while the configured model slot is occupied. Test interaction
with legacy receipt and analytics requests; document that a process-local guard alone does
not provide cross-process exclusion. No global performance guarantee is assumed.

## 5. Demonstrate controls: fixtures and acceptance

Use isolated fictional data and non-payable recipients. A science-kit/notebook/hospitality
receipt should show restricted funding only where permitted and General for hospitality.
An alcohol line should show a policy block. Exhausted shared caps should reduce eligible
restricted capacity; General may cover a line if its policy and balance permit it. Only
insufficient total eligible capacity is an allocation infeasibility. Never manufacture a
block or bypass a rule to improve the demonstration.

- AP-01: a real pinned-model run returns validated quotes, a deterministic provisional
  preview and an accurate step trace. Distinguish new behavior from reused categorization.
- AP-02: injected instructions, tool calls, extra amounts/payees/fund IDs and malformed
  results cannot invoke financial actions. Valid source quotes do not prove semantic
  correctness; claimant review remains mandatory.
- AP-03: UNKNOWN and absent/ambiguous quotes require review. Alcohol blocks funding.
  Shared caps, reservations, exhausted capacity and General eligibility match existing
  solver semantics. Test factual blocker messages rather than model-written reasons.
- AP-04: changed receipt/review/payee/policy/priority/capacity invalidates the applicable
  preview. Test edit during inference and capacity change between preview and freeze.
- AP-05: anonymous, other claimant, other organization, approver-write, cross-origin and
  extra/repeated fields fail before inference or writes. No multi-organization support is
  inferred from scoped proposal authorization.
- AP-06: duplicate/concurrent requests, two app processes and late model completion retain
  one active run and no duplicate inference from replay. Busy, crash and deadline outcomes
  remain recoverable through explicit manual review or a separate user request.
- AP-07: preparation leaves reservations, decisions, approvals, recognition, fund credits/
  debits, journals, disbursements and provider events unchanged. Assert zero provider calls
  separately from DB equality. Allow only run/suggestion records and documented test sessions.
- AP-08: claimant category correction invalidates provisional output. Confirmation, freeze,
  two distinct non-claimant approvals and changed-term invalidation remain mandatory.
  Existing synthetic provider tests prove routing boundaries; no new real payment is needed.
- AP-09: actual unavailable transport and deadline preserve usable manual review. Measure
  each actual-model run and timeout explicitly; do not claim speed from synthetic responses.
- AP-10: full relevant regression, types, production build, 375-pixel Chromium interactions,
  additive migration/rollback strategy, fresh setup/restart and bounded privacy checks pass
  in OrbStack. No screenshots, traces or video. Compare main before/after evidence and
  immutable RC2 hashes. External judge access and physical Safari remain separate checks.

All AP checks started NOT RUN at IAC-243. IAC244_VERIFICATION.md now records observed backend
checks; complete UI/release/owner acceptance remains pending. Only Pavan can assign a new
owner acceptance verdict.

## 6. Limit the impact: dependencies, exclusions and tradeoffs

Reuse the existing pinned local model with its 4 GiB RAM/two-core cap, main app cap and
container isolation. No new weights, dependency, paid service, native installation or
resource-budget increase is planned. AG Studio is not an extension dependency. The current
workspace still contains its commercial packages; feature independence does not create a
cleared release or bypass the existing sponsor-inclusive export guard.

Do not add risk scores, compute/API procurement, merchant checkout, cloud provisioning,
external agent identities, mcp exposure, unattended execution, multi-organization support,
new policy compilers or another submission. Do not weaken human checks for prize positioning.
Do not claim autonomous purchasing or eligibility for an award from this scope alone.

Positive impact: users can inspect one bounded preparation workflow and see policy controls
before approval. Cost: another orchestration/state/audit surface, stale-preview handling,
concurrency tests and a shorter release contingency. The existing receipt path is simpler
and remains the fallback if this extension does not earn acceptance in time.

## 7. Schedule the work: estimates and stop conditions

Planning completes October 23. Working estimates after implementation authorization:
backend/orchestration October 26 to 27; claimant interface October 28 to 29; isolated
verification and owner walkthrough October 30 to November 2. Allow roughly five engineering
days plus owner review, with November 3 to 5 reserved for corrections. These are estimates,
not measured delivery promises. No implementation is reported complete by these targets.

Do not shift the November 6 feature/release freeze. Defer the extension if the boundary or
acceptance checks cannot settle by November 2. Keep the accepted receipt workflow and RC2
available. Later code requires a new exact sanitized release verification; passing the
private source-copy rehearsal does not cover this extension.

Retain recording near November 9, corrections November 10, final review November 11 and
submission deadline November 12 at 2 p.m. America/Chicago. Judging access through December
15 and independent access checks remain release obligations. Dates authorize no recording,
publication, trial activation, contact or submission. IAC-240 remains unresolved without
outreach, and IAC-242 remains conditional on applicable sponsor clearance.

## 8. Review the scope: unresolved evidence and next action

IAC-243 completes this scope. Planned packages are
[IAC-244](https://linear.app/pvnarp/issue/IAC-244/ap-1-implement-bounded-expense-preparation-and-provisional-policy)
for backend preparation, completed October 23 ahead of its October 27 target,
[IAC-245](https://linear.app/pvnarp/issue/IAC-245/ap-2-add-claimant-proposal-review-and-preserve-human-approval-handoff)
for claimant review, completed with the owner's no-payment walkthrough October 23 ahead
of its October 29 target, and
[IAC-246](https://linear.app/pvnarp/issue/IAC-246/ap-3-verify-agentic-proposal-boundaries-and-prepare-owner-walkthrough)
for local fresh verification/release-input preparation, completed October 23 ahead of its
November 2 target. IAC-245 and IAC-246 are complete for those observed scopes. No new owner
gate verdict or exact cleared candidate is implied. IAC-231 must reconcile accepted implementation
before freeze. IAC-242 remains the separate sponsor-inclusive exact-candidate check.

IAC245_VERIFICATION.md records the interface, controlled rollout and no-payment walkthrough.
IAC246_VERIFICATION.md records fresh technical evidence. Final submission claims and any new
owner gate verdict remain distinct from this completed local preparation package.
Existing private demo credentials suffice; do not collect credentials in chat.

The original planning self-review used inspected services, without an independent reader
agent or runtime check. Subsequent implementation observations are in IAC244_VERIFICATION.md
and IAC245_VERIFICATION.md. They do not establish a general accuracy or latency guarantee.
