# AidTrace: Gate A Build Specification v0.2.1

| | |
|---|---|
| Status | Implementation contract for a coding agent. Technical feasibility of PayPal sandbox Payouts still unproven. |
| Supersedes | Gate A Build Spec v0.2 (and v0.1) |
| Checkpoints | **Gate A: Tuesday, Oct 20, 2026.** **Gate A+: Saturday, Oct 24, 2026.** |
| Submission deadline | Thursday, Nov 12, 2026, 12:00 p.m. Pacific (2:00 p.m. Central). Official. |
| Scope | Only what this document names. Strategy documents and reviews are not requirements. |

### What changed in v0.2.1

1. **Reservation contradiction fixed.** Policy checks and capacity checks are now separate (Section 4.1). Recognition rechecks policy only and consumes the decision's own reservations; it never counts them against the decision (Section 6).
2. **Budget-line caps get their own solver node** so a shared cap limits several categories together (Section 4.3). New test SOL-07.
3. **Claim approval and payout-retry authorization are separate records** (Sections 8.3, 8.4). The approval uniqueness rule no longer blocks a legitimate retry.
4. **PayPal status mapping corrected.** `DENIED` and `CANCELED` are batch statuses; `REFUNDED` and `REVERSED` item statuses go to manual review; no retry from `UNCLAIMED`, `ONHOLD`, or `UNKNOWN` (Sections 9.3, 9.4).
5. **Payout fee source:** read `payout_item_fee` from the status response, not the create response (Section 7.5).
6. **No double counting:** a workspace's opening credits come from exactly one source type, fixture or real captures, never both (Sections 5.2, 12.1). The provider balance stays separate from internal fund balances (Section 9.1).
7. **Gate result definitions** added (Section 11.4). SOL-06 now also asserts the minimum unrestricted spend. LED-01 and LED-02 sharpened. Feasibility questions 8 and 9 added (Section 14).

### What changed from v0.1 (in v0.2)

1. Solver priority policy v1 is now concrete (Section 4). Under v0.1's rules, 71 different allocations tied for the minimum unrestricted spend, so the expected SOL-01 result was not reproducible.
2. The naive baseline is defined step by step (Section 4.4).
3. Recognition and restriction release are decidable rules, not open-ended conditions (Section 6).
4. The fixture carries every field the invariants check: program, period, budget lines, users, payee (Section 3).
5. A chart of accounts and exact journal entries, including the opening-balance cash entry (Section 7).
6. Fund reservations and their timing are defined (Section 5.3).
7. The decision hash is SHA-256 over RFC 8785 canonical JSON (Section 8).
8. Work splits into Gate A and Gate A+ (Section 11). Human-only tasks moved out of agent tickets (Section 12).
9. Agent operating rules added (Section 13).

---

## 1. Product contract

**One sentence.** AidTrace helps a small nonprofit decide which donor-restricted funds may cover an expense, shows the reasoning behind every allocation, and marks a reimbursement paid only after PayPal confirms the individual payout item.

**User story.** Maria, a volunteer, submits a $500 reimbursement claim for the robotics program. The organization holds two donor-restricted funds and one unrestricted general fund. AidTrace computes an allocation that never spends restricted money on refreshments and spends as little unrestricted money as possible. Two approvers, neither of them Maria, approve the exact allocation and payee. PayPal sandbox sends the payout. The claim shows `Paid` only after a successful item-level result.

**Out of Gate A and A+:** AI extraction of any kind, receipt upload, OCR, Venmo, AG Studio or any trial-licensed runtime tool, funder reports, refunds, disputes, multiple organizations, user signup, production endpoints, real money, deployment to a public host.

---

## 2. Stack and repository

| Item | Choice |
|---|---|
| Runtime | Node.js 22 LTS, pnpm |
| App | Next.js (App Router), TypeScript `strict: true` |
| Database | PostgreSQL 16 via `docker compose` (Colima on macOS) |
| ORM and migrations | Drizzle ORM, drizzle-kit |
| Tests | Vitest; fast-check for property tests; Playwright for UX-01 (Gate A+) |
| Canonical JSON | An RFC 8785 implementation (for example the `canonicalize` package) |
| Password hashing | argon2id or bcrypt |
| License | MIT, committed in the first commit |

Repository layout (minimum):

```
LICENSE
README.md                 # stub: run instructions only
docs/SPEC.md              # this file
docs/ASSUMPTIONS.md       # every assumption the agent makes
docs/FEASIBILITY.md       # observed PayPal behavior, redacted
docs/GATE_REPORT.md       # which tests ran, results, open unknowns
.env.example              # names only, no values
src/domain/allocate.ts    # pure solver, no I/O
src/domain/naive.ts       # pure naive baseline, no I/O
src/domain/hash.ts        # decision payload and hash
src/ledger/               # journal, fund subledger, reservations
src/paypal/adapter.ts     # the only module allowed to call PayPal
src/app/                  # pages and route handlers
db/migrations/
tests/
```

---

## 3. Fixture (seed data, all labeled as fixtures)

### 3.1 Organization and users

| Key | Value |
|---|---|
| Organization | Cedar Hollow Youth Robotics (fictional) |
| Program | `robotics` |
| Users | `maria` (role CLAIMANT), `tara` (role APPROVER, treasurer), `ben` (role APPROVER, board member) |
| Passwords | Read from `SEED_PASSWORD_MARIA`, `SEED_PASSWORD_TARA`, `SEED_PASSWORD_BEN`. Never committed. |
| Payee | Maria's PayPal sandbox Personal account email, read from `PAYPAL_SANDBOX_PAYEE_EMAIL`. Must also appear in `PAYEE_ALLOWLIST`. |

### 3.2 Funds and policy versions

All amounts in integer cents.

| Fund ID | Name | Class | Opening balance | Programs | Allowed categories | Period | Budget line caps | Breadth |
|---|---|---|---:|---|---|---|---|---:|
| `fund_a` | Education A | donor-restricted | 30000 | `robotics` | `science_kits`, `notebooks` | 2026-09-01 to 2027-06-30 | `supplies`: 30000 | 2 |
| `fund_b` | STEM B | donor-restricted | 20000 | `robotics` | `science_kits` | 2026-10-01 to 2026-12-31 | `supplies`: 20000 | 1 |
| `fund_g` | General | unrestricted | 100000 | any | any category not in the org prohibited list | none | none | n/a |

- Org prohibited categories: `alcohol`.
- Category to budget line mapping: `science_kits` and `notebooks` map to `supplies`; `hospitality` maps to `hospitality`.
- Budget caps equal opening balances in this fixture, so they never bind in Gate A. The schema must still store and check them.
- Breadth = number of allowed categories. Unrestricted funds have no breadth value.
- Each fund has `FundPolicyVersion` 1, `approvedBy: tara`, with a plain-text policy summary used in reason strings.

### 3.3 Claim

| Field | Value |
|---|---|
| Claim ID | `C-104`, version 1 |
| Claimant | `maria` |
| Program | `robotics` |
| Vendor | Brightbench Supply Co. (fictional) |
| Incurred on | 2026-10-14 |

| Line ID | Description | Category | Amount (cents) |
|---|---|---|---:|
| `L1` | Science kits | `science_kits` | 28000 |
| `L2` | Notebooks | `notebooks` | 15000 |
| `L3` | Refreshments | `hospitality` | 7000 |
| | **Total** | | **50000** |

Line categories are trusted fixture values in Gate A. A later issue replaces them with AI proposals that require source-quote verification and human confirmation.

---

## 4. Allocation solver

### 4.1 Policy eligibility and capacity (hard constraints)

**Policy eligibility.** An edge `fund -> line` may exist only if all hold:

- P1. The line's category is allowed by the fund's current approved policy version, and is not org-prohibited.
- P2. The claim's program is in the fund's programs (General accepts any program).
- P3. The line's `incurredOn` date falls inside the fund's period (General has no period).

**Capacity.** Across all edges of one decision:

- C1. Total drawn from a fund does not exceed the fund's available balance **excluding reservations that belong to this same decision**.
- C2. Total drawn against a fund's budget line (all categories mapped to it) does not exceed that line's remaining cap. Remaining cap = cap minus prior `FundDebit` rows on that budget line minus other decisions' active reservations on it.

Policy-ineligible edges never appear. Priorities never relax policy or capacity.

### 4.2 Priority policy v1 (`SolverPriorityVersion` 1, approved by `tara`)

Integer cost per cent allocated:

| Fund type | Cost per cent |
|---|---|
| Unrestricted | 1,000,000 |
| Restricted | 1,000 × breadth + fund order index |

Fund order index: position in fund ID ascending order, starting at 0 (`fund_a` = 0, `fund_b` = 1). Resulting costs: `fund_b` = 1,001; `fund_a` = 2,000; `fund_g` = 1,000,000.

Meaning, in order: (1) spend as little unrestricted money as possible; (2) among restricted funds, use the narrowest fund first, keeping flexible money for later; (3) break remaining ties by fund ID. Ties that remain between lines drawing on the same fund need no particular rule in Gate A, but the implementation must be deterministic: identical input always yields identical output.

Objective: minimize total cost subject to Section 4.1 (policy and capacity) and full funding of every line. If any line cannot be fully funded, return `INFEASIBLE` with the unfunded amount per line, and allocate nothing.

### 4.3 Implementation requirement

Use an exact integer algorithm. A successive-shortest-path min-cost flow on integer cents is the recommended approach, with this network:

```
source -> fund                 capacity = C1 available, cost 0
fund -> fund budget line       capacity = C2 remaining cap, cost 0   (restricted funds)
fund budget line -> line       one arc per policy-eligible line mapped to that budget line,
                               cost = the fund's priority cost (Section 4.2)
fund -> line                   unrestricted funds only (no budget lines), cost = 1,000,000
line -> sink                   capacity = line amount
```

The budget-line node makes a shared cap limit several categories together. Example: if `fund_a` had 30000 available but only 10000 left on `supplies`, kits and notebooks together could draw at most 10000 from `fund_a` (test SOL-07). Floating-point LP solvers are not allowed unless their output is proven integral and exact for every test.

These weights are sized for small instances. SOL-06 asserts that the unrestricted total always equals the brute-force minimum; if that assertion ever fails, switch to a two-stage solve (first minimize unrestricted cents, then minimize restricted cost with unrestricted fixed).

**Expected result for the fixture** (verified by brute force; it is the unique optimum under v1 costs):

| Edge | Cents |
|---|---:|
| `fund_b -> L1` | 20000 |
| `fund_a -> L1` | 8000 |
| `fund_a -> L2` | 15000 |
| `fund_g -> L3` | 7000 |

Remaining available: `fund_a` 7000, `fund_b` 0, `fund_g` 93000. Unrestricted spent: 7000.

Reason strings (exact text not required, content required):
- `fund_b -> L1`: STEM B used first for science kits because it allows only science kits (narrowest eligible fund).
- `fund_a -> L1`: Education A covers the remaining science kits.
- `fund_a -> L2`: Education A covers notebooks; no other restricted fund allows notebooks.
- `fund_g -> L3`: General covers refreshments; no restricted fund allows hospitality.

Every edge stores `solverPriorityVersion`, the fund's `policyVersion`, and its reason.

### 4.4 Naive baseline (comparison only, never used for payment)

For each line in line ID order, for each fund in fund ID order (`fund_a`, `fund_b`, `fund_g`): if the edge is policy-eligible (P1 to P3), take the minimum of the remaining line amount, the remaining fund balance, and the remaining budget-line cap. Continue until the line is funded.

**Expected naive result:**

| Edge | Cents |
|---|---:|
| `fund_a -> L1` | 28000 |
| `fund_a -> L2` | 2000 |
| `fund_g -> L2` | 13000 |
| `fund_g -> L3` | 7000 |

Unrestricted spent: 20000. `fund_b` untouched at 20000.

**UI copy:** "AidTrace preserves $130 of unrestricted money compared with a first-eligible-fund split." Never claim this baseline matches what any particular nonprofit does.

---

## 5. Domain model

### 5.1 Entities

`Organization`, `User` (role), `Fund`, `FundPolicyVersion`, `SolverPriorityVersion`, `Claim` (versioned), `ClaimLine`, `AllocationDecision` (frozen solver output plus hash), `AllocationEdge`, `FundReservation`, `Approval` (claim approval), `FundCredit`, `FundDebit`, `JournalEntry`, `JournalPosting`, `Disbursement`, `DisbursementAttempt`, `RetryAuthorization` (Section 8.4), `ProviderEvent`.

### 5.2 Provenance

Every `FundCredit`, `FundDebit`, and `JournalEntry` carries `sourceType`, `sourceId`, `effectiveOn`, `recordedAt`. Allowed `sourceType` values in Gate A and A+: `fixture_opening_balance`, `claim_recognition`, `paypal_capture`, `paypal_payout_item`. The UI labels fixture-sourced amounts as fixtures.

**One opening source per workspace.** A workspace's opening fund credits come either from `fixture_opening_balance` rows (local development and tests) or from real `paypal_capture` rows (the hosted demo seed template), never both. A real capture made later as a genuinely new donation is an ordinary additional credit. Replacing fixture openings with real captures happens only by reseeding a fresh workspace, never by adding captures on top of fixtures.

### 5.3 Reservations

- **Created** when a decision is frozen for approval: one `FundReservation` per fund, status `ACTIVE`, amount = sum of that fund's edges.
- **Fund available** = sum(credits) minus sum(debits) minus sum(ACTIVE reservations). When checking capacity for a specific decision, exclude that decision's own reservations (Section 4.1, C1).
- **Released** (status `RELEASED`) when the decision is invalidated (Section 8.3) or the claim is rejected.
- **Consumed** (status `CONSUMED`) at recognition, when matching `FundDebit` rows replace it.
- Reservation creation runs in a `SERIALIZABLE` transaction that rechecks availability, retrying on serialization failure (SQLSTATE 40001) up to 3 times.

### 5.4 Claim status

`DRAFT -> AWAITING_APPROVAL -> APPROVED -> PAYOUT_PROCESSING -> PAID`, plus `REJECTED`, `PAYOUT_ISSUE` (payable open; see Section 9.4).

UI labels: `Awaiting approval`, `Approved`, `Payout processing`, `Paid`, `Payout issue`. No `Paid` label before item-level success.

---

## 6. Recognition and restriction release (decidable rules)

These rules are an accounting-inspired model for the demo, pending review by a nonprofit accountant. Label them that way in code comments and the README. Never describe them as GAAP compliant.

**Recognition** of the reimbursement obligation happens in one transaction when all hold:
1. Two `Approval` rows exist for the current decision hash, from two distinct users with role APPROVER, neither equal to the claimant.
2. Every edge still passes the **policy** rules P1 to P3 against the policy versions recorded in the hash, and those versions are still the current approved versions.
3. The decision's reservations exist, are `ACTIVE`, belong to this decision ID, and their per-fund amounts equal the sum of the decision's edges per fund.

Recognition does **not** recheck capacity against fund available balances: the decision's own reservations already hold that capacity, and counting them again would reject the decision's own valid allocation. Condition 3 is the capacity guarantee.

On recognition, atomically: post the recognition entry (Section 7.3); mark the reservations `CONSUMED` and insert matching `FundDebit` rows; set claim status `APPROVED`. If any condition fails, nothing posts and the reason is shown.

**Release from restriction** posts in the same transaction as recognition, for each restricted fund with edges, amount = sum of that fund's edges. Purpose and time conditions are guaranteed by condition 2, so no further check runs. Release never depends on payout status.

**Dates:** `effectiveOn` = the claim's `incurredOn` (2026-10-14). `recordedAt` = recognition time. Approval timestamps stay on `Approval` rows.

---

## 7. General ledger (double entry)

### 7.1 Chart of accounts

| Code | Name | Type | Sub-key |
|---|---|---|---|
| 1010 | PayPal cash | Asset | none |
| 2010 | Reimbursements payable | Liability | claimant |
| 3100 | Net assets with donor restrictions | Net assets | fund |
| 3200 | Net assets without donor restrictions | Net assets | none |
| 4100 | Contributions with donor restrictions | Revenue | fund |
| 5100 | Program expense: supplies | Expense | claim line |
| 5200 | Program expense: hospitality | Expense | claim line |
| 5900 | Payment processing fees | Expense | source |

Rules: every `JournalEntry` balances (debits = credits, integer cents), enforced by a deferred database constraint or trigger and by tests. Entries are immutable; corrections are new entries. Each entry has a unique `(sourceType, sourceId, purpose)` key so replays cannot double-post.

### 7.2 Opening balances (fixture)

`sourceType: fixture_opening_balance`

| Account | Debit | Credit |
|---|---:|---:|
| 1010 PayPal cash | 150000 | |
| 3100 Net assets with donor restrictions: `fund_a` | | 30000 |
| 3100 Net assets with donor restrictions: `fund_b` | | 20000 |
| 3200 Net assets without donor restrictions | | 100000 |

The reconciliation view shows 1010's balance split into fixture and provider-backed portions. Internal fund balances are never presented as actual PayPal available cash.

### 7.3 Recognition of claim C-104

`sourceType: claim_recognition`, `effectiveOn: 2026-10-14`

| Account | Debit | Credit |
|---|---:|---:|
| 5100 Program expense: supplies, `L1` | 28000 | |
| 5100 Program expense: supplies, `L2` | 15000 | |
| 5200 Program expense: hospitality, `L3` | 7000 | |
| 2010 Reimbursements payable: `maria` | | 50000 |

### 7.4 Release from restriction (same transaction)

| Account | Debit | Credit |
|---|---:|---:|
| 3100 Net assets with donor restrictions: `fund_b` | 20000 | |
| 3100 Net assets with donor restrictions: `fund_a` | 23000 | |
| 3200 Net assets without donor restrictions | | 43000 |

### 7.5 Settlement on payout item success

`sourceType: paypal_payout_item`, `sourceId`: payout item ID

| Account | Debit | Credit |
|---|---:|---:|
| 2010 Reimbursements payable: `maria` | 50000 | |
| 1010 PayPal cash | | 50000 |

If the item status response reports `payout_item_fee` with a value above zero, post it as a separate entry: debit 5900, credit 1010, charged to General under the default fee policy. The fee appears in the status response, not the create response. Record the reported fee exactly; never compute it. A fee of `0.00` posts nothing.

### 7.6 Donation capture (Gate A+)

`sourceType: paypal_capture`, `sourceId`: capture ID. Default fee policy v1: gross to the designated restricted fund, fee to General.

| Account | Debit | Credit |
|---|---:|---:|
| 1010 PayPal cash | gross | |
| 4100 Contributions with donor restrictions: fund | | gross |
| 5900 Payment processing fees | fee | |
| 1010 PayPal cash | | fee |

Subledger: `FundCredit` of gross to the fund; `FundDebit` of fee to `fund_g`. If the capture status is not `COMPLETED`, record it as pending and post nothing until it completes.

### 7.7 Tie-out invariant (test LED-04)

After any sequence of entries, computed as a virtual close (credit-normal balances for 3100, 3200, 4100):
- Sum of restricted fund subledger balances = 3100 balance + 4100 balance. (3100 already reflects releases, because Section 7.4 debits it.)
- `fund_g` subledger balance = 3200 balance minus all expenses (5100, 5200, 5900). (3200 already includes releases, because Section 7.4 credits it.)

For the fixture after recognition and settlement: 3100 = 50000 minus 43000 = 7000, matching `fund_a` 7000 plus `fund_b` 0. 3200 = 100000 plus 43000 = 143000; minus expenses of 50000 gives 93000, matching `fund_g`.

---

## 8. Decision hash and approvals

### 8.1 Payload

```json
{
  "claimId": "C-104",
  "claimVersion": 1,
  "program": "robotics",
  "incurredOn": "2026-10-14",
  "lines": [{"id": "L1", "category": "science_kits", "amountCents": "28000"}],
  "edges": [{"fundId": "fund_b", "lineId": "L1", "amountCents": "20000"}],
  "fundPolicyVersions": {"fund_a": 1, "fund_b": 1, "fund_g": 1},
  "solverPriorityVersion": 1,
  "payee": {"wallet": "PAYPAL", "recipientType": "EMAIL", "receiver": "<payee email>"}
}
```

(Shortened; the real payload includes all lines and edges.) Amounts are decimal strings of integer cents. Arrays are sorted by ID before canonicalization.

### 8.2 Hash

`decisionHash = hex(SHA-256(RFC 8785 canonical JSON of the payload))`. No separate cryptographic signature in Gate A; the approver's identity comes from the authenticated server session.

### 8.3 Claim approval rules

A claim approval authorizes the allocation and creates the reimbursement obligation. It happens once per decision.

- An `Approval` stores `decisionHash`, `approverId`, `approvedAt`. Unique on `(decisionHash, approverId)`.
- Rejected: approver equals claimant; approver lacks role APPROVER; same approver twice; hash does not match the current recomputed payload.
- Any change to claim, lines, edges, policy versions, solver priority version, or payee produces a new hash. Existing approvals then no longer count, and the old decision's reservations are released. This applies only **before** recognition; after recognition the decision is immutable.
- Each user has a real authenticated session (seeded credentials, httpOnly cookie). No role toggle.

### 8.4 Payout retry authorization

A retry authorization authorizes one specific new payout attempt against an obligation that already exists. It never re-approves the claim and never touches the allocation or the recognition entries.

- A `RetryAuthorization` stores `claimId`, `decisionHash`, `attemptNumber` (the new attempt), `payee` (must equal the payee in the decision hash), `amountCents` (must equal the open payable), `authorizedBy`, `authorizedAt`. Unique on `(claimId, attemptNumber)`.
- Allowed only when the latest attempt reached a **retryable terminal outcome** (Section 9.4) and no attempt is `UNKNOWN`, pending, `UNCLAIMED`, or `ONHOLD`.
- Authorized by one user with role APPROVER who is not the claimant.
- A different payee or amount is not a retry: it requires reversing the obligation (out of scope for Gate A and A+) or a new claim.
- The new attempt uses a new `sender_batch_id` built from the new attempt number (Section 9.2).

---

## 9. PayPal sandbox adapter

### 9.1 Safety

- Base URL must equal `https://api-m.sandbox.paypal.com`. Any other value, or missing credentials, throws before any network call (SEC-01).
- Receiver must be in `PAYEE_ALLOWLIST`. Amount must be at most `MAX_DEMO_PAYOUT_CENTS` (default 50000).
- **Provider funding gate.** Internal fund balances and ledger account 1010 are never evidence that the PayPal sandbox account can pay. If the feasibility lab confirms the app can read the real sandbox balance, check it before sending and refuse when it is short. If not, rely on the insufficient-funds outcome (Section 9.4). Show the provider balance, when known, separately from internal balances.
- Never log tokens, client secrets, or full request headers. Redact emails in logs.
- OAuth client-credentials token cached in memory; on HTTP 401, refresh once and retry once.

### 9.2 Payout request

- `POST /v1/payments/payouts`, one item.
- `sender_batch_id = "AT-" + disbursementId + "-" + attemptNumber`; `sender_item_id = sender_batch_id + "-1"`. Persist both **before** sending.
- Item: `recipient_type: EMAIL`, `receiver`: payee email, `amount: {value: "500.00", currency: "USD"}` (decimal string produced only in the adapter), a short note.
- Store `payout_batch_id`, `batch_status`, and the item's `payout_item_id` when returned.

### 9.3 Status retrieval

- `GET` the batch, then the item. The item's `transaction_status` decides the outcome for a processed batch. Batch status alone never marks a claim paid.
- **Batch statuses** (documented by PayPal): `SUCCESS`, `PENDING`, `PROCESSING`, `DENIED`, `CANCELED`. `DENIED` and `CANCELED` are batch-level outcomes, not item statuses.
- **Item statuses:** use the enum observed in the feasibility lab and the API reference, recorded in `docs/FEASIBILITY.md`. The mapping below names the values expected; any value not in it becomes `UNKNOWN_STATUS`, is logged, and the claim stays `PAYOUT_PROCESSING`.

### 9.4 Outcome mapping

| Outcome | Claim status | Ledger | Payable | Retry allowed? |
|---|---|---|---|---|
| Item `SUCCESS` | `PAID` | Post Section 7.5 once (plus fee if reported) | Cleared | n/a |
| Item `PENDING`, or batch `PENDING` / `PROCESSING` | `PAYOUT_PROCESSING` | Nothing | Open | No |
| Item `UNCLAIMED` or `ONHOLD` | `PAYOUT_ISSUE` (may still change) | Nothing | Open | **No**; keep polling |
| Item `FAILED`, `RETURNED`, or `BLOCKED` | `PAYOUT_ISSUE` | Nothing | Open | Yes, with a `RetryAuthorization` (Section 8.4) |
| Batch `DENIED` or `CANCELED` | `PAYOUT_ISSUE` | Nothing | Open | Yes, with a `RetryAuthorization` |
| Item `REFUNDED` or `REVERSED` | `PAYOUT_ISSUE` flagged for manual review | Nothing automatic | Unchanged until a human resolves it | No |
| Request timed out after sending | `PAYOUT_PROCESSING`, attempt `UNKNOWN` | Nothing | Open | **No**; reconcile first (Section 9.5) |
| Insufficient-funds error (request rejected, nothing created) | `PAYOUT_ISSUE` (funding) | Nothing | Open | Yes, after funding, with a `RetryAuthorization` |
| Unmapped status | `PAYOUT_PROCESSING`, `UNKNOWN_STATUS` | Nothing | Open | No |

### 9.5 Unknown outcomes

Never treat a timeout as failure. Never send a new `sender_batch_id` while an attempt is `UNKNOWN`. The recovery method (for example, how PayPal responds to a repeated `sender_batch_id`, and how to retrieve the batch afterward) must be observed in the feasibility lab and written in `docs/FEASIBILITY.md` before it is implemented. Until then, `UNKNOWN` attempts require manual resolution.

### 9.6 Webhooks (Gate A+)

- Verify every event with PayPal's verify-webhook-signature API using the configured webhook ID.
- Deduplicate by event ID (unique constraint on `ProviderEvent.eventId`).
- A verified event triggers a status fetch (Section 9.3); the ledger posts from the fetched state, never from the event payload alone.
- Unverified, duplicate, or simulator events never change the ledger.
- Local development uses a stable tunnel hostname so the sandbox webhook registration survives restarts.

### 9.7 Donation capture (Gate A+)

Orders v2, `intent: CAPTURE`, one purchase unit, `custom_id` = fund ID. A human approves as the sandbox buyer in the browser. After capture, read `seller_receivable_breakdown` (gross, PayPal fee, net). Post Section 7.6. No raw card data anywhere; no server-side card submission.

---

## 10. User interface (one responsive page plus login)

- `/login`: seeded users only.
- `/claims/C-104`, readable on a 375-pixel-wide viewport with no horizontal scroll:
  - Headline: "$430 from two restricted funds, $70 from General."
  - Side by side (stacked on phones): naive split and AidTrace split, with unrestricted totals ($200 vs $70) and the preserved $130.
  - Edge list with reason strings and policy versions.
  - Fixture labels on fixture-sourced balances.
  - Approval panel: current hash (short form), who has approved, Approve and Reject controls for the signed-in approver. Reject requires a reason.
  - Payout panel: claim status, attempt state, batch and item IDs once known, a "Refresh status" control.
- No dashboards, charts libraries, or AG Studio.

---

## 11. Acceptance tests

### 11.1 Gate A (Tuesday, Oct 20)

| ID | Scenario | Required result |
|---|---|---|
| SOL-01 | Fixture allocation | Exactly the Section 4.3 edges, in cents |
| SOL-02 | Naive comparison | Exactly the Section 4.4 edges; unrestricted 20000 vs 7000; copy states $130 preserved |
| SOL-03 | Force `L3` (hospitality) onto `fund_b` | Rejected, citing the `fund_b` policy |
| APP-01 | Claimant approves; or one approver approves twice | Rejected |
| LED-01 | Recognition with the decision's own reservations active | Recognition succeeds (the `fund_b` reservation of 20000 is not counted against the decision); Sections 7.3 and 7.4 posted; reservations `CONSUMED`; all entries balance; payable 50000 open |
| LED-03 | Item success observed twice (status fetch repeated) | Settlement posted once; payable 0; ledger balances |
| LED-04 | Tie-out after recognition and settlement | Section 7.7 values hold |
| PAY-01 | Real sandbox payout | Real batch and item IDs, independently fetched item status; or an explicit `BLOCKED` entry in `GATE_REPORT.md` with the API error |
| SEC-01 | Production URL or missing credentials | Adapter throws; no network call (verified with a network stub) |

### 11.2 Gate A+ (Saturday, Oct 24)

| ID | Scenario | Required result |
|---|---|---|
| SOL-04 | Two claims reserve against `fund_b` concurrently | Never over-reserved; one retries or fails cleanly |
| SOL-05 | Solver priority version changes | Old approvals stop counting; reservations released; recomputation deterministic |
| SOL-06 | Property test: random small instances (up to 3 funds, 3 lines, whole-dollar amounts up to $20, optional budget-line caps) | Solver's weighted cost equals the brute-force minimum; **its unrestricted total equals the brute-force minimum unrestricted total**; conservation, policy, and capacity hold; output identical across runs |
| SOL-07 | Fixture, but `fund_a` has only 10000 remaining on `supplies` (30000 still available) | `fund_a` draws exactly 10000 in total across kits and notebooks; `fund_b` 20000; `fund_g` 20000 (the minimum possible); how `fund_a`'s 10000 splits between kits and notebooks may be any deterministic choice |
| APP-02 | Change line, edge, policy version, or payee after one approval | Hash changes; approval no longer counts |
| LED-02 | Payout outcomes failed, unclaimed, on hold, unknown, refunded | Payable stays open (refunded: flagged for review); no second payout while `UNKNOWN`, `UNCLAIMED`, or `ONHOLD`; a retry after `FAILED` requires a `RetryAuthorization` bound to the attempt, payee, and amount; claim approvals and recognition entries unchanged |
| PAY-02 | Real designated donation capture | Capture ID, status, gross, fee, net stored; Section 7.6 posted; fixture credits still labeled |
| PAY-03 | Unverified, replayed, or simulator webhook | Ledger unchanged |
| UX-01 | 375-pixel viewport (Playwright) | Decision and approval usable; no horizontal scroll |

### 11.3 Reporting

`docs/GATE_REPORT.md` lists every test ID with `PASS`, `FAIL`, `NOT RUN`, or `BLOCKED`, the commit hash, and the observed PayPal IDs (redacted where needed). A missing or failing PayPal capability is reported as such, never replaced by an unlabeled mock. Unit tests may use recorded responses only when labeled as recorded and stored under `tests/fixtures/recorded/`.

### 11.4 Gate results (decided by the human, never by the agent)

| Result | Meaning |
|---|---|
| **PASS** | Solver, approvals, ledger, and a real successful sandbox payout all work, with evidence |
| **CONDITIONAL** | Core logic works; an explicitly documented integration limitation remains (for example, Payouts access `BLOCKED` with the API error recorded) |
| **FAIL** | A core invariant or a payment-safety check fails |

A `BLOCKED` test is honest reporting, not a pass. Gate A cannot be PASS while PAY-01 is `BLOCKED`.

---

## 12. Work split

### 12.1 Human tasks (not for the agent)

- Feasibility lab in Postman with the official PayPal collection: OAuth; one payout to the sandbox Personal account; batch and item status; a repeated `sender_batch_id` to observe duplicate handling; webhook registration and one real delivery; one designated donation order approved in the browser and captured. Record redacted results in `docs/FEASIBILITY.md`.
- Buyer approvals in the browser for any donation capture.
- Before Gate B: optionally approve three sandbox checkouts ($300 to `fund_a`, $200 to `fund_b`, $1,000 to `fund_g`) and use them as the **hosted demo seed template's** opening credits, with no fixture rows in that template (Section 5.2). Local tests keep the fixture. Never add these captures on top of fixture openings in the same workspace.
- The 90-second screen recording at each gate.
- PayPal Discord questions: Payouts sandbox setup; AG Studio license through Dec 15.

### 12.2 Agent tickets

| Ticket | Linear | Gate | Scope | Tests |
|---|---|---|---|---|
| Lab (human) | IAC-132 | A | PayPal sandbox feasibility lab in Postman | Feeds PAY-01 |
| GA-1 | IAC-133 | A | Repository bootstrap, schema, seed, auth, sandbox guard | SEC-01 |
| GA-2 | IAC-134 | A | Solver v1 with budget-line node, and naive baseline | SOL-01, SOL-02, SOL-03 |
| GA-3 | IAC-135 | A | Ledger, reservations, approvals, recognition and release | APP-01, LED-01, LED-04 |
| GA-4 | IAC-136 | A | Payout adapter and walking skeleton page | PAY-01, LED-03 |
| Gate A review (human) | IAC-137 | A | Gate decision and 90-second recording | All Gate A |
| GA-5 | IAC-138 | A+ | Concurrency, versioning, property tests, budget-line cap test, hash invalidation | SOL-04, SOL-05, SOL-06, SOL-07, APP-02 |
| GA-6 | IAC-139 | A+ | Payout uncertainty, retry authorization, verified webhooks, replay protection | LED-02, PAY-03 |
| GA-7 | IAC-140 | A+ | Designated donation capture into the ledger | PAY-02 |
| GA-8 | IAC-141 | A+ | Phone viewport check | UX-01 |
| Gate A+ review (human) | IAC-142 | A+ | Gate decision | All Gate A+ |

Order: GA-1, then GA-2, GA-3, GA-4 in sequence. GA-4 also depends on the human feasibility lab. Gate A+ tickets start after the Gate A review.

---

## 13. Agent operating rules

1. Implement only what this document names. If a feature is not named here, do not build it.
2. Record every assumption in `docs/ASSUMPTIONS.md` with the section it relates to.
3. Stop and ask when an ambiguity affects money movement, ledger postings, approvals, or security. Elsewhere, choose the simplest option and record it.
4. Never fabricate PayPal results. Never present a mock as a real provider response.
5. Never mark a gate `PASS`. Report test results; the human decides the gate.
6. No secrets, tokens, or unredacted personal data in Git, logs, test snapshots, issue comments, or prompts.
7. Only `src/paypal/adapter.ts` may call PayPal. Only the ledger module may write journal entries.
8. All money in integer cents; decimal strings only at the PayPal boundary.

---

## 14. Feasibility questions (answers go in `docs/FEASIBILITY.md`)

1. Is Payouts enabled for the sandbox app, and does a single-item payout to the sandbox Personal account return batch and item IDs?
2. Which item statuses appear, and how quickly does the item reach success in sandbox?
3. What does the API return for a repeated `sender_batch_id`, and how is the original batch retrieved afterward?
4. Which payout webhook events arrive, and does signature verification succeed for them?
5. Does the item status response include `payout_item_fee`, and what value appears in sandbox?
6. Does the donation capture return `seller_receivable_breakdown` with fee and net, and is the capture `COMPLETED` or pending?
7. Does the sandbox business balance cover repeated demo payouts, and how is it topped up?
8. Can the app read the real sandbox account balance through an API, and with which permission? If not, the funding gate relies on the insufficient-funds outcome.
9. Which item `transaction_status` values actually appear, including any of `REFUNDED`, `REVERSED`, `BLOCKED`, `RETURNED`?
10. Is the recognition and release model appropriate for the demo's accounting basis? (For the nonprofit accountant, not the agent.)

---

## 15. References (verify before relying on any detail)

- PayPal Payouts API: https://developer.paypal.com/api/payouts/standard
- PayPal Payouts setup: https://developer.paypal.com/payouts/use-payouts/set-up
- PayPal REST webhooks: https://developer.paypal.com/api/rest/webhooks/rest/
- PayPal Postman collection: https://www.postman.com/paypal
- Render free-tier limits (for later deployment): https://render.com/docs/free
- RFC 8785, JSON Canonicalization Scheme: https://www.rfc-editor.org/rfc/rfc8785
