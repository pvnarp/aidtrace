# Judging guide

How to run a private judging session on your own machine, what it shows with and without an
Anthropic API key, and how to recover from common setup problems. A session runs the real app
against its own database with the PayPal keys empty. It can reach a read-only PayPal handoff. It
never sends money.

## 1. Start a session

You need Docker with Compose v2 on a Linux ARM64 or AMD64 engine and a POSIX shell. No native
Node, pnpm, Python or Postgres is needed. Setup downloads images and packages, so it needs network
access, disk space and some time.

```sh
sh scripts/aidtrace doctor
sh scripts/aidtrace setup
sh scripts/aidtrace judge-new review-one 3102
sh scripts/aidtrace judge-up review-one
```

Open http://127.0.0.1:3102/login. The launcher writes three generated passwords for maria
(claimant), tara and ben (two independent approvers) to
`local/judge-sessions/review-one/session.env`. Do not paste that file or its values into chat,
screenshots or reports.

The launcher uses your current Docker context. Set `AIDTRACE_DOCKER_CONTEXT` to pick another one
without changing the global context.

To turn the AI on, export your own key in the same shell before `judge-up`:

```sh
read -rs ANTHROPIC_API_KEY
export ANTHROPIC_API_KEY
sh scripts/aidtrace judge-up review-one
```

The launcher passes the key to the app container by name only. It never writes it to a file and
never prints it. The container engine keeps it in that container's configuration until the
container is recreated or removed.

## 2. Know the session settings

| Setting | Value in a session | Effect |
|---|---|---|
| Rule drafts (`AI_RULE_DRAFTS_ENABLED`) | on | An approver can ask the AI to draft fund rules from grant text |
| Receipt photo reader (`AI_RECEIPT_PHOTO_ENABLED`) | on | A claimant can have the AI read a photo of a receipt into the form |
| Receipt review, expense proposals, analytics, policy check | on | Category suggestions, funding explanations and the per-line policy check |
| Fund modes and Autopilot (`FUND_MODES_ENABLED`, `FUND_AUTOPILOT_ENABLED`) | absent, so off | Every fund stays Manual |
| PayPal client id and secret | empty | No checkout, no payout, no provider request |
| Session marker (`AIDTRACE_JUDGE_SESSION`) | true | The server refuses send, refresh, retry and takeover actions, and /give shows a read-only preview |

Every AI feature also needs a key. Without one, the flags are on and the features say no key is
set. With a key, one app process sends at most 60 Claude requests in total, shared by every AI
feature, and the requests spend your own Anthropic account.

## 3. Check what each mode shows

Without a key:

1. As maria, open "Review Maria's $500 receipt", choose each category yourself with a reason,
   view the funding split and freeze. Approve as tara, then as ben, and inspect the read-only
   PayPal handoff.
2. As an approver, open the review queue on the home page, Funding and cash (/analytics),
   /analytics/report, /ledger and /donations.
3. Open "Draft rules from a grant" on a restricted fund. You can paste text or choose a text
   PDF, which is read inside the app. Pressing Draft rules answers that no key is set and sends
   nothing.
4. The new-receipt page shows no photo control without a key. Typing the receipt works.
5. Open /give. It shows a read-only preview of what a donation would send.

With your own key, add:

1. AI-drafted fund rules, each value beside its source quote, then two different approvers
   binding the draft.
2. The receipt photo read, the AI category proposal with saved source quotes, and the AI model
   check that runs with the policy checks on a frozen claim.
3. AI selection of snapshot facts under "Explain this snapshot" on Funding and cash.

Shown only in the demo video, because a session has no PayPal keys and no fund modes:

1. Sending the payout with PayPal and the settled "Paid, verified" state.
2. A donor gift through PayPal Checkout and the donor page.
3. Fund modes, Assisted approval and Autopilot paying a small clean claim.
4. A funder report with Autopilot and two-person spending.

## 4. Walk the keyed path

1. **Draft rules (tara).** Open "Draft rules from a grant" on Ashmere County Afterschool STEM
   Subgrant or Tallow Creek Robot Kit Initiative. Paste grant text (up to 20,000 characters) or
   choose a text PDF (up to 2 MB, 30 pages). `tests/fixtures/grant-two-pages.pdf` is a small
   sample with a grant period and a USD 300.00 supplies cap. Its parties are not the seeded
   funds, so it shows the flow, not a matching grant. Keep the page open: a draft can take a
   minute or more. Check each value against its quote. A field marked UNSURE needs your entry.
2. **Bind the rules (tara, then ben).** The rules take effect only after the second distinct
   approver. If binding changes the pay order, the review screen says so: receipts that are
   frozen but not yet approved twice go back to draft. Bind rules before the receipt.
3. **Create the receipt (maria).** Read a photo of a sample receipt (JPEG, PNG or WebP up to
   3.75 MB) and check every line, or keep the typed example: USD 280 robot kit and parts, USD 150
   engineering notebooks, USD 70 sandwiches and apple juice.
4. **Categories (maria).** Select Prepare expense proposal once. Check each AI category against
   its quote. A matching quote does not prove the category is right. Confirm and view the split.
5. **Freeze and approve (maria, tara, ben).** Freeze as maria. As tara, press Run policy checks,
   which runs the rule checks and then the AI model check, and approve. Ben approves the same
   frozen terms from his own login.
6. **Handoff.** The PayPal handoff shows the approved amount and currency, a masked receiver and
   the state Not submitted. There is no Send control, and a direct form post is refused.
7. **Books (tara or ben).** Open /ledger and /donations (AG Grid Community), the review queue,
   Funding and cash and /analytics/report, the funder report with its tie-out line. These read
   local accounting facts, not current PayPal cash.

Each session admits one receipt. For a fresh repeat, create another named session.

## 5. Read the numbers

The fresh seed holds USD 300.00 in Ashmere, USD 200.00 in Tallow Creek and USD 1,000.00 in
General Operating (`db/fixture.ts`). With the seeded version 1 rules, the USD 500 receipt takes
USD 430.00 from restricted funds and USD 70.00 from General (`e2e/proposal.spec.ts`). Paying each
line from the first eligible fund would take USD 200.00 from General. That difference is specific
to this fixture. It is not a measured saving. Rules you bind can change the split.

## 6. Recover deliberately

- **Restart.** `judge-stop review-one`, then `judge-up review-one`. Database, approvals and
  balances persist. A rebuild does not reset balances.
- **Fresh repeat.** `judge-new review-two 3102`, then `judge-up review-two`. The old session
  stays as it was. Use the new password file.
- **Busy port.** Pick another port in `judge-new`. Do not stop unrelated apps.
- **Exhausted address pool.** If Docker reports that all predefined address pools are used,
  pass a checked unused RFC1918 /28 as the fourth `judge-new` argument. It pins only the
  session's database network, so `judge-up` can still fail on the second network. `check`
  creates its own networks and can fail the same way. Do not prune or change global pools.
- **Login failure.** Use the value from that session's own file. Cookies on 127.0.0.1 can
  replace one another across ports, so use separate browser profiles or sign in again.
- **AI off or a failed request.** No key in the launching shell, the 60-request limit or an API
  error. Choose categories by hand and type the receipt. There is no automatic retry.
- **Changed configuration.** Startup refuses it. Create a separate session instead.

Stop session apps when you are done: `sh scripts/aidtrace judge-stop review-one`.

## 7. Run the checks

```sh
sh scripts/aidtrace check
```

`check` runs the Vitest suite and the TypeScript compiler against the synthetic fixtures, with a
scripted stand-in for the AI. It is not evidence about PayPal or the Claude API. The browser
suites behind `ui-check` read a source manifest that this repository does not include, so
`ui-check` does not run from a plain clone.
