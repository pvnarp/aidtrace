# AidTrace

Claude turns a grant PDF into rules two people approve. Small clean expenses then pay through PayPal on their own, and donors see the receipt lines their gift was applied to.

All payments are PayPal sandbox payments. The nonprofit, grants and receipts are invented, and the accounting model has not been reviewed by a nonprofit accountant.

Try it: https://98-89-192-170.sslip.io/

## 1. Understand the problem: restricted grants, one treasurer

A small nonprofit runs on restricted grants, each with its own caps, dates and exclusions. The treasurer retypes every agreement's rules, matches each receipt line to a fund, chases a second signature, sends the reimbursement and later proves to the funder that no restricted dollar paid for an ineligible line. Paying from the wrong fund quietly burns unrestricted money. Donors rarely learn what their gift bought.

## 2. Follow the workflow: grant to rules, receipt to payment

```text
Grant PDF --> Claude drafts rules, each beside its exact quote --> two people approve --> binding rules
Receipt   --> Claude reads it and proposes categories --> the claimant confirms
              --> min-cost flow picks the funds (no model decides the split)
              --> rules checks and a Claude policy check
              --> Manual, Assisted or Autopilot --> PayPal Payouts --> ledger --> donor page
```

1. Grant PDF to rules. Claude Sonnet 5.5 drafts caps, dates and categories, each beside the exact quote it came from, and code checks every quote. Unsupported values stay empty. Two different approvers bind the draft.
2. Receipt to categories. Claude Haiku 5.5 reads the receipt, code checks the arithmetic to the cent, Claude proposes a category per line with a quote, and the claimant confirms each one.
3. Funding split. A min-cost flow solver in integer cents applies each fund's restrictions and uses as little unrestricted money as the rules allow. No model decides the split.
4. Checks before money moves. Rules checks and a Claude policy check with clause citations can hold a claim. A model answer alone never pays one.
5. Three fund modes. Manual: two people approve every claim. Assisted: bulk approval of clean claims. Autopilot: a small clean claim pays itself under eight guardrails, including caps, a 5 percent random audit and a kill switch. Two approvers turn automation on.
6. PayPal on both sides. Checkout (Orders v2) for gifts, Payouts for reimbursements and verified webhooks. An uncertain payout stays UNKNOWN until a person authorizes a retry, so a network failure cannot become a second payment.
7. Books in AG Grid Community. Read-only ledger, donations and approver queue views, an analytics dashboard and a funder report that ties out to the books.

## 3. Know the AI boundaries: people decide, the AI never pays

1. Every Claude call has no tools, a closed JSON schema and code-side validation.
2. The AI suggests categories. The claimant confirms them.
3. The AI drafts fund rules. Two different people bind them. The model never writes a binding rule.
4. The AI never freezes a claim, approves it, allocates funds or pays.
5. A quote that matches the source does not prove that a value is right. A person checks it.
6. One running app allows at most 60 Claude requests, then turns the AI off until it restarts.
7. Every AI screen names the model that answered.

Without an Anthropic API key, the AI features are off and the manual path still works end to end.

## 4. Open the hosted demo: one private workspace per judge

Open https://98-89-192-170.sslip.io/ and choose Open workspace for any workspace from 1 to 7. Each workspace is a private copy of the app with sample data and its own AI request limit. The sign-in passwords for the three demo users (maria, tara and ben) are given with the judging instructions, not in this repository.

1. Sign in as maria and open Review Maria's $500 receipt. Create the draft, confirm the categories, continue to funding and freeze the terms.
2. Sign out, sign in as tara, open the awaiting claim and approve.
3. Sign out, sign in as ben and approve the same terms. The claim then shows approved and unpaid.
4. For the AI-drafted rules, sign in as tara and use Draft rules from a grant on the home page.

Hosted workspaces have no PayPal credentials, so nothing is sent to PayPal. Fund modes, Autopilot, Checkout gifts, the donor page and the Paid state are shown only in the video.

## 5. Run it locally: Docker only

You need Docker with Compose v2 on Linux ARM64 or AMD64, and a POSIX shell. No native Node, pnpm, Python or Postgres is needed. No PayPal account is needed: local judging sessions never pay. See `docs/ACCESS.md` for requirements and recovery steps.

```sh
sh scripts/aidtrace doctor
sh scripts/aidtrace setup
sh scripts/aidtrace judge-new review-one 3102
sh scripts/aidtrace judge-up review-one
```

Open http://127.0.0.1:3102/login. The launcher generates the three passwords into the `session.env` file under `local/judge-sessions/review-one/`. Do not share that file.

To turn the AI features on, export your own `ANTHROPIC_API_KEY` in the same shell before `judge-up`. Use `read -rs ANTHROPIC_API_KEY` and then `export ANTHROPIC_API_KEY` so the value stays out of your shell history. The launcher passes the key to the app container by name and never writes it to a file. `docs/JUDGING.md` lists what a session shows with and without a key.

Optional checks run on synthetic fixtures with a scripted stand-in for the AI. They are not evidence about PayPal or the Claude API.

```sh
sh scripts/aidtrace check
sh scripts/aidtrace ui-check
```

`check` runs the Vitest suite (135 test files in this repository) and the TypeScript compiler.

## 6. Review the evidence: results and limits

| Check | Result | Limit |
|---|---|---|
| Rules drafter, four agreements | 69 of 69 determinate fields right, 0 fabricated values | Invented agreements |
| Policy check, 840 calls | 0 of 72 risky receipt runs cleared; at least 32 of 96 clean receipt runs held for a person | Synthetic receipts, labels written by Claude; a zero is a bound, not a rate |
| Receipt photo reader | 5 of 5 photos and 5 of 5 injection receipts | Ten invented images, one run each |
| Sandbox payments | $500.00 after two approvals; a $50.00 gift; a $42.00 claim paid under Autopilot | One rehearsal run each |

The evaluation harnesses and their datasets are not in this repository. Not done: scanned-PDF grants, a pilot with a real treasurer and an accountant's review. The donor link is shown once, with no recovery flow.

## 7. Read the license: MIT

The application is released under the MIT license. See `LICENSE`. Copyright (c) 2026 Pavan Aripakula.

Dependencies and model services keep their own terms. See `NOTICE`, `THIRD_PARTY_NOTICES.txt`, `DEPENDENCY_LICENSES.json`, `UPSTREAM_LICENSE_SOURCES.json`, `docs/LICENSING.md` and `docs/THIRD_PARTY_MODELS.md`. AG Grid Community 36.2.0 is under the MIT license. The bundled Inter font is under the SIL Open Font License; see `docs/FONT_PROVENANCE.md`.

Built with TypeScript, Node.js 22, Next.js 16, React 19, PostgreSQL, Drizzle ORM, Claude Haiku 5.5 and Claude Sonnet 5.5 through the Anthropic API, PayPal Checkout (Orders v2) and PayPal Payouts, AG Grid Community 36.2.0, unpdf, Docker Compose, Vitest and Playwright. Codex and Claude models assisted the implementation, testing and documentation under the author's direction.

Author: Pavan Aripakula
