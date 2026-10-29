# Guide the expense journey: IAC-350

## 1. Apply the owner feedback

On October 27 Pavan said the screenshot flow required explanation and asked for the
interactive architecture view. This presentation follow-up to IAC-348 starts at private
PR #5 head f2775f31699d6aea849d4bcc51dc5deb3bdb0da3. It supersedes only the earlier
static-overview-only choice. Live tracing remains deferred. Private still review is
authorized; video, publication, contact, payment and merge remain unapproved.

## 2. Guide one expense without changing authority

Lead claimants to the prefilled fictional $6 receipt. Distinguish it from the separate
preclassified $500 C-104 example. Show five consistent stages and the next action from
authorized saved state: receipt, categories, funding, two approvals, payment. Explain the
role handoff after freeze and the first approval. Approved must never be presented as paid.
Links may move to existing review sections; they cannot execute financial actions. Existing
form guards, confirmations, hashes, approval counts and explicit Send stay unchanged.

## 3. Explain the architecture honestly

Add authenticated /architecture with a clickable six-stage illustration and a prohibited
item example. Include input, output, authority boundary and selected request path. State
clearly that interaction executes no model, provider or financial request and reads no
claim data. It is an explanation, not observed telemetry. Show rule/auth/approval/adapter/
ledger modules inside the same app container, separate model and Postgres containers, the
user's browser and external PayPal Sandbox. Do not turn logical modules into invented
services. Illustrative fund amounts are not current balance or transaction evidence.

## 4. Verify and keep owner acceptance open

Use a new isolated OrbStack build volume so the current preview stays intact during checks.
Verify role handoffs, stale receipt-history guidance, authentication, keyboard interaction,
phone layout, no requests from explorer interactions and no payout attempts from the
walkthrough. Existing provider-state browser tests remain explicitly synthetic. Package
the same explorer code into a private offline owner review file with no external assets.
Use a focused private draft PR. Do not reissue immutable RC3 or select the release variant.

Cost: persistent guidance takes screen space, and the architecture explanation must be
maintained as behavior changes. Recheck it on changes to auth, model, allocation, ledger,
deployment or payout semantics. Browser checks do not prove unprompted owner/judge
comprehension; that review remains open.
