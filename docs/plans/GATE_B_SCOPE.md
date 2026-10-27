# Build Gate B: grounded AI receipt review

## 1. Close the actual gap: application AI

Status: adopted and implemented; Pavan assigned Gate B PASS on October 22, 2026.
Adoption quote: "Adopt scope and test in OrbStack". Verdict quote: "yes Gate B Pass - move on
to next steps, update linear, timelines, readmes, docs etc". IAC-208 through IAC-214 are Done,
including isolated current recovery and the verified private judge archive. IAC-215 holds
source-license and exact public-release review by November 6; recording remains November 9.
This is the active bounded Gate B addendum. Gate A and Gate A+ remain
owner-assigned PASS. Their financial-core implementation is complete. Current SPEC Sections
1 and 3.3 deliberately defer AI extraction, so that passing work alone is not a complete
submission. A source/dependency search found no model runtime in the implemented application.

The [official rules](https://paypalaihackathon.devpost.com/rules), checked October 22, require
an application combining PayPal with an AI tool, model or platform. They permit runnable
repository instructions instead of public hosting. Public open-source code, an English
description and a public YouTube demonstration under three minutes remain final deliverables.
Judging access must last through December 15. Coding assistance is not claimed as a model
integration in the application. Sponsor tools are optional unless pursuing their specific prizes.

## 2. Adopt one useful feature: proposals before financial decisions

Recommend category proposals for manually entered receipt lines, grounded in pasted plain
text from a synthetic receipt. This extends SPEC Section 3.3 without asking a model to
allocate restricted funds or move money. One small reviewed workflow is the first package;
a restriction compiler, OCR/PDF ingestion, report writer and trial-licensed dashboard are
separate future scope, not implicit requirements of this proposal.

Proposed journey:

1. Maria enters a fictional vendor, expense date, program, line descriptions and exact
   decimal USD amounts into a new unpaid draft. The server parses cents exactly and requires
   the displayed total to match the sum. The recipient comes from server-side fixture
   configuration and cannot be supplied by the model or browser.
2. Maria pastes up to 16 KiB of synthetic receipt text and explicitly requests suggestions.
   The model sees line descriptions, the bounded receipt text and the approved taxonomy.
   It receives no sandbox credentials, recipient, sessions, payment identifiers or fund balances.
3. For each known line ID, the model may propose science_kits, notebooks, hospitality,
   alcohol, or UNKNOWN, plus one exact supporting quote. It cannot propose amounts, dates,
   budget lines, policies, fund IDs, payees or tool calls. Unsupported/ambiguous lines stay UNKNOWN.
4. The server rejects malformed/extra output fields and unknown or duplicate line IDs,
   checks the quote against the unmodified source and calculates offsets itself. A missing
   or non-unique quote cannot be accepted. Source text is data, including embedded instructions.
5. Maria reviews every quote and category, corrects or rejects proposals, and explicitly
   confirms all final categories. A server transaction binds confirmation to the source and
   draft hashes, actor and current draft version. UNKNOWN cannot reach allocation. Alcohol
   remains prohibited. Manual corrections remain marked as human input, not AI-backed facts.
6. Only confirmed terms reach the existing deterministic solver and ordinary freeze/approval
   workflow. No approval is inherited after changed terms. Money movement remains a separate
   explicit sandbox action, outside AI acceptance. The paid main C-104 is never edited.

Positive impact: AI removes category-entry work while exact policy, capacity, approvals and
accounting remain deterministic. Cost: a new draft/review screen, proposal provenance and
confirmation schema, authorization checks, model runtime and an evaluation set. Quote presence
does not prove a category is correct; human confirmation remains necessary.

## 3. Keep the implementation bounded: contract and isolation

The owner adopted this addendum to AGENTS.md's earlier SPEC-only scope. Keep original
SPEC.md unchanged as the passed baseline. The following boundaries govern Gate B:

- `src/ai/` owns the single model adapter, strict response schema and quote validation. Its
  interface returns proposals only. No PayPal/ledger imports or tools. Cap response size,
  timeout and concurrency; do not retry model calls automatically.
- New proposal/provenance records store source hash, prompt/schema version, exact model
  identity, accepted quotes/offsets and explicit human confirmation. Receipt retention and
  access are limited to the organization. First acceptance uses invented receipt data only.
- Claim creation and category confirmation are authenticated, same-origin, claimant-owned
  and organization-scoped. Server authority supplies actor, payee and organization. The
  claim page/action handlers currently accept only C-104; generalize them with ownership
  tests before showing any new draft. Use new stable IDs, not replacement C-104 rows.
- Confirmation applies only to a current unpaid DRAFT with no allocation, approvals,
  recognition or payout. If review has become stale, refuse and re-review. Do not add a
  generalized post-approval editing feature in this package. Changed frozen terms continue
  to require the existing invalidation and fresh-approval rules.
- Prototype and migration acceptance run in a separate private database/container first.
  Applying any new migration to the main workspace follows a fresh backup and verified
  migration tests; no financial record is reset or copied over.
- Tests use a model stub explicitly labeled synthetic. Only a separately recorded real
  inference run counts as runtime AI evidence. No new payout is needed to demonstrate the
  proposal/confirmation workflow. Existing real PayPal evidence remains independent.

## 4. Try a container model first: runtime decision

Recommend a short local CPU inference spike inside OrbStack, with model weights in a named
volume and no model port published to the Mac or tunnel. No native Ollama, GPU bridge or
Mac toolchain install is proposed. The initial proposal named Ollama as a candidate.
IAC-210 selected the smaller official llama.cpp CPU image and pinned Qwen3 weights within
the same adopted budget. The rationale and artifact identity are in plans/IAC210.md and
THIRD_PARTY_MODELS.md. Schema output does not establish factual correctness.

Before pulling weights, pin an image digest and exact model artifact, inspect its license
and download size, and record the chosen resource limits. Initial proposed ceilings are
4 GiB of model downloads plus up to 4 GiB for its container image, 4 GiB runtime RAM and two
CPU cores. These are budgets, not measured
requirements or a performance promise. The first model was downloaded and verified on
October 22; its fixed-set CPU result is in IAC210_VERIFICATION.md. Further model changes
still require pinned artifacts, budget checks and measured quality. No GPU is assumed.

If CPU inference cannot meet the agreed demo latency/quality threshold, stop the spike and
present a specific sandbox-hosted alternative with its provider, cost, data boundary and
credential needs. A paid API or remote account is a separate owner decision. Do not silently
fall back to a paid service or relabel a stub as real AI.

## 5. Test the actual risks: proposed acceptance IDs

- AI-01: real pinned model generates at least one grounded proposal through the application
  adapter, with exact request/source hashes and measured runtime recorded. No stub credit.
- AI-02: malformed JSON, extra financial fields, unsupported categories, missing/ambiguous
  quotes and duplicate/unknown IDs are rejected or left unresolved with no draft mutation.
- AI-03: source instructions to pay, approve, change bank details or use another fund never
  cause tools, network requests, financial writes or automatic confirmation.
- AI-04: changing receipt text, draft lines, amounts or source version makes prior proposals
  and confirmation stale. Only the claimant can confirm a current owned draft.
- AI-05: timeout/unavailable model leaves a usable manual review path and a clear limitation;
  it does not invent grounded suggestions or silently perform another model request.
- AI-06: a fixed invented-receipt evaluation set reports per-category correct/incorrect and
  abstention counts, quote-validity rate and latency. Report failed cases. Set release
  thresholds before the first run; do not infer general extraction accuracy from one demo.
- GB-01: confirmed categories feed existing solver semantics, preserving prohibited-category,
  shared-cap, cents, stale-approval and once-only journal invariants. No new payout occurs.
- GB-02: a 375-pixel review screen keeps quote, category, unresolved status and confirmation
  usable. Cross-user access and stale submissions fail. Existing paid/donation records compare
  unchanged; full regression, types, isolated production build and secret scan pass.

## 6. Preserve the schedule: working targets and owner decisions

IAC-207 completed October 22: clean setup and real isolated restore passed. IAC-208 prepares
this proposal. Proposed follow-up: scope/model-spike decision by October 24, isolated AI
adapter and evaluation October 25 to 26, human review workflow October 27 to 28, and Gate B
review October 29. The addendum was adopted and the first model spike completed October 22.
Those workflow targets are historical: IAC-211 and owner Gate B review both completed
October 22, ahead of the October 28 and 29 targets. IAC-213 clean AI recovery and IAC-214
private judge archive also completed October 22, ahead of October 30 and November 2 targets.
If it slips, reduce feature breadth rather than removing
financial checks or claiming nonexistent AI capability.

Keep feature freeze November 6, recording/draft November 9, corrections November 10,
owner review November 11 and deadline November 12 at 2 p.m. America/Chicago. Public repository
publication, demo hosting, YouTube upload and submission remain separate owner-controlled
steps. Prepare a sanitized export plan first: inherited Git history and archived FalkorDB
material must be reviewed before public release, while the private original stays intact.

Owner adoption is recorded in IAC-209; IAC-210 completed the isolated model spike within
the resource limits. IAC-212 records the owner PASS. Release preparation stays private;
no paid service, native install, new transfer or public deployment is included.
