# Judge the app: what a session shows, with and without a key

Follow README.md and ACCESS.md to start a named judging session on your own machine. A session
runs the real app against its own database with the PayPal keys empty, so it can reach the
read-only PayPal handoff and never send money. Nothing here is owner-accepted, a gate PASS or
live in production.

## 1. Know the session settings: flags come from compose.session.yaml

| Setting | Value in a session | Effect |
|---|---|---|
| Rule drafts (AI_RULE_DRAFTS_ENABLED) | on | An approver can ask the AI to draft fund rules from grant text |
| Receipt photo reader (AI_RECEIPT_PHOTO_ENABLED) | on | A claimant can have the AI read a photo of a sample receipt into the form |
| Receipt review, expense proposals, analytics, policy check | on | Category suggestions, funding explanations and the per-line policy check |
| Fund modes and Autopilot (FUND_MODES_ENABLED, FUND_AUTOPILOT_ENABLED) | absent, so off | Every fund stays Manual. No mode controls, no Autopilot |
| PayPal client id and secret | empty | No checkout, no payout, no provider request |
| Session marker (AIDTRACE_JUDGE_SESSION) | true | The server refuses send, refresh, retry and takeover actions, and /give shows a read-only preview |

Every AI feature also needs a key. A session started with no ANTHROPIC_API_KEY in the launching
shell has the flags on and the features unavailable. A session started with your own key spends
your own Anthropic account, in one app process capped at 60 hosted requests in total, shared by
every AI feature. The launcher passes the key to the app container by name only and never
writes it to a file. Details are in README.md section 2.

## 2. Check what each mode shows: keyless, keyed and video only

Without a key, as maria, tara and ben:
1. Sign in, open the $500 workshop receipt, choose each category yourself with a reason, view the
   funding split, freeze, approve as tara and as ben, and inspect the read-only PayPal handoff.
2. As an approver, open the review queue on the home page, Funding and cash (/analytics, with
   its manual fallback), /analytics/report, /ledger and /donations.
3. Open a restricted fund's rules page from "Draft rules from a grant". It shows the current
   approved rules. You can paste text or choose a text PDF, which is read inside the app
   without the AI. Pressing Draft rules then answers that AI drafting has no key set and
   sends nothing.
4. The new-receipt page shows no photo control without a key, because a read could not run
   (src/app/receipts/new/page.tsx, CLA-19). Typing the receipt works.
5. Open /give. It shows a read-only preview of what a donation would send, because a judge
   session is never in donation checkout mode.

With your own key, add:
1. AI-drafted fund rules, each value beside its source quote, then two different approvers
   binding the draft.
2. The receipt photo read, then the AI category proposal with saved source quotes, and the
   AI model check that runs with the policy checks on a frozen claim.
3. AI selection of snapshot facts under "Explain this snapshot" on Funding and cash.

Shown only in the video, because the session has no PayPal keys or the flag is absent:
1. Sending the payout with PayPal and the settled "paid, verified" state.
2. A donor gift through PayPal Checkout and the donor trail page.
3. Fund modes, Assisted approval and Autopilot paying a small clean claim.
4. A funder report with paid Autopilot and two-person spending. No claim in a session is
   paid, so the report cannot show that.

The video's USD 542.00 tie-out and the Autopilot payments come from a separate owner sandbox
instance, not from this session (docs/GATE_REPORT.md sections 85 to 89, in the owner
repository).

## 3. Walk the keyed path: rules, receipt, approvals, handoff

Export your key in the launching shell first, as README.md section 2 says, then judge-up. The
launcher prints "AI suggestions: on". Log in with the three generated passwords privately.

1. **Draft rules (tara).** On the home page open "Draft rules from a grant" on Ashmere County
   Afterschool STEM Subgrant or Tallow Creek Robot Kit Initiative. Paste grant text of your
   own (up to 20,000 characters) or choose a text PDF (up to 2 MB, 30 pages). The export does
   not ship the owner's demo grant PDF or its generator. It does ship
   tests/fixtures/grant-two-pages.pdf, a small two-page sample text PDF with a grant period and
   a USD 300.00 supplies cap. Its parties are not the seeded funds, so it shows the draft
   flow, not a matching grant. Press Draft rules and keep the page open, because a draft can take a minute or more.
   Check each value against its quote. A field the AI marks UNSURE needs your entry.
2. **Bind the rules (tara, then ben).** Tara approves the draft. Ben approves it from his own
   login. The rules take effect only after the second distinct approver. When approving would
   change the pay order, the review screen warns that it does and that receipts that are frozen
   but not yet approved twice go back to draft, so bind rules before the receipt. A session allows one receipt.
3. **Create the receipt (maria).** Choose "Review Maria's $500 receipt". Either read a photo of a
   sample receipt (JPEG, PNG or WebP up to 3.75 MB) and check every line against it, or keep
   the typed example: USD 280 robot kit and parts, USD 150 engineering notebooks and USD 70
   sandwiches and apple juice. Check the sample-data box and create the draft.
4. **Categories (maria).** Select Prepare expense proposal once. Check each AI category against its
   highlighted source quote. A matching quote does not prove the category is right. The
   sandwiches line stays for a person. Confirm the categories and view the allocation.
5. **Freeze and approvals (maria, tara, ben).** Freeze as maria. Sign in as tara and open the
   awaiting-approval claim. Press Run policy checks. With a key it runs the rule checks and then
   the model check, which is the AI part, in one action. "Run model check" appears only when no
   model result was stored. Then approve. Only an approver who is not the claimant sees these
   checks. Ben approves the same frozen terms from his own login.
6. **Handoff.** Open the PayPal handoff. Amount and currency are real approved terms, the
   receiver is masked, sender and provider ids are unassigned, and the state is Not
   submitted. There is no Send control, and a direct form post is refused.
7. **Books (tara or ben).** Open /ledger and /donations in the AG Grid Community views, the review
   queue on the home page, Funding and cash, and /analytics/report, the funder report with a
   tie-out line. These read local accounting facts, not current PayPal cash.

## 4. Read the numbers: what is fixed and what is not

The fresh seed holds USD 300.00 in Ashmere, USD 200.00 in Tallow Creek and USD 1,000.00 in
General Operating (db/fixture.ts). With the unchanged version 1 rules, the USD 500 receipt
computes USD 430.00 from restricted funds and USD 70.00 from General (checked by
e2e/proposal.spec.ts). The ordered first-eligible comparison uses USD 200 General. The
difference is specific to this fixture and ordering, not measured customer savings.
Rules you bind in step 2 can change the split, so those numbers hold only for the unchanged
seed. The owner's recording used an owner grant and reached USD 500.00 from restricted funds
only. A judge session with other grant text can differ.

Do not raise caps, overwrite balances or erase previous sessions to reproduce a number. For a
fresh repeat, create another named session. C-104 is a preserved test fixture, not the judge
claim.

## 5. Keep the scope: separate decisions

What AI sees and proposes, by feature:
1. Category suggestions read the receipt text and line descriptions, with no structured amount,
   payee or fund fields. The receipt text itself is sent as typed, including any printed
   amounts and the vendor (src/ai/claude-receipt.ts).
2. The photo reader transcribes the printed lines and amounts, in cents, from a photo you
   choose. Code checks the arithmetic to the cent, and a read only pre-fills the receipt form.
3. The rule drafter reads grant text you paste or extract from a PDF and proposes caps and
   thresholds, each with a quoted clause. A draft binds only after two different approvers
   (people with the approver role, such as tara and ben) each approve it once.

AI never confirms, freezes, approves, allocates or pays. Separate logins, confirmation, freeze
and two approvals stay deliberate. The analytics views read local journals. Licensing is in
LICENSING.md: release/variant.json has sponsorUseClaimed true for AG Grid Community only, with
no Studio clearance claimed. Hosted AI notices and the cost limit are in THIRD_PARTY_MODELS.md.

Official access route: https://paypalaihackathon.devpost.com/rules , which allows runnable
repository instructions or a hosted application. Final deadline: November 12, 2026 at 12:00 pm
PST (2:00 pm Chicago). Judging runs December 1 to 15, and winners are announced December 21.
Our judging access stays up through 11:00 pm Chicago on December 22.
These dates are planning facts, not permission. Hosting, the recording, publication and the
Devpost submission remain the owner's separate decisions.
