# Run the judging session: access, roles and recovery

## 1. Check prerequisites: use a compatible existing engine

Follow the root README. Use an existing POSIX shell, Docker Compose v2 and Linux ARM64 or
AMD64 containers. Owner execution stays in OrbStack. The judge launcher accepts another
existing context without changing the global context. No native toolchain installation.
Native ARM application execution has evidence. Physical Docker
Desktop, full fresh AMD64 application setup and independent-machine access remain unverified.
Setup needs upstream downloads, storage and time. App caps do not establish a minimum
machine budget. Do not change pins or install native packages to conceal a failed setup.

## 2. Generate private access: one named session

Run doctor and setup once, then judge-new review-one 3102 and
judge-up review-one. Open http://127.0.0.1:3102/login. The exact private login file, relative
to this extracted folder, is local/judge-sessions/review-one/session.env. Its three generated
passwords correspond to maria (claimant), tara and ben (independent approvers).

Do not paste passwords or the file into chat, screenshots or reports. Configuration creation
refuses an existing name; validation refuses unexpected/duplicate fields, changed credentials
or financial settings, symlinks and non-private file permissions. The app forces empty
provider credentials and disables payment actions even if someone attempts a direct POST.
It does not inherit the owner's local/.env or reset another database.

## 3. Follow one receipt: AI, rules, people and PayPal

As maria, select Review Maria's $500 receipt. Keep the invented USD 280 kits, USD 150 notebooks
and USD 70 refreshments. Confirm fictional data and create the receipt. Prepare expense
proposal once, wait for completion or refresh its displayed status, then inspect every
category and saved source quote. A matched quote does not establish category correctness.
Correct a category with a reason if needed. Explicitly confirm categories and view allocation.
The unchanged fresh case uses USD 430 restricted / USD 70 General, versus USD 200 General
for its fixed ordered comparison. This is a fixture/ordering-specific difference.

Freeze as maria. Sign out, sign in as tara and open the same claim from the workspace.
Inspect expense, recipient and funding terms, then approve once. Expect one approval and
Awaiting approval. Sign out, sign in as ben and approve those same frozen terms. Expect
Approved, two approvals and USD 500 organization-wide payable on a fresh unchanged session.

Inspect the read-only PayPal handoff. Amount and currency are real approved terms; receiver
is masked. Sender and provider IDs are unassigned. Current state remains Not submitted.
The possible submitted/pending/SUCCESS/UNKNOWN path is explanatory, not a provider result.
No PayPal login, send, fee, capture, provider query or new payment is needed or permitted.

Each session admits one receipt, including concurrent form submissions. Reopening new-receipt
returns that existing receipt; it cannot silently consume fresh funds for another claim.
Edits are available only while normal receipt guards permit them and require another review.
An UNKNOWN category needs explicit manual choice/reason. Confirmed alcohol blocks every fund
and the whole expense before freeze. C-104 remains in tests but is not this judge journey.

## 4. Recover deliberately: preserve prior sessions

- Restart: judge-stop review-one, then judge-up review-one. Database, approvals and balances
  persist. A configuration-bound database comment admits retention without reseeding; an
  unbound nonempty database must pass the original strict seed guard or startup refuses it.
  A rebuild does not reset balances or give the same session fresh funds.
- Fresh repeat: stop the old app, then judge-new review-two 3102 and judge-up review-two.
  The old database/build/configuration remains. Use the new generated login file.
- Busy port: inspect the conflict. Do not terminate unrelated apps or modify firewalls.
- Exhausted engine address pool: inspect existing Docker subnets and host/VPN routes. An
  operator may supply a checked unused RFC1918 /28 as the fourth judge-new argument after
  the port. That session alone uses it. Syntax validation does not prove route availability.
  Do not prune or change global Docker pools. Preserve failed-session configuration.
- Login failure: use the generated role value from that exact session file. Across ports,
  loopback cookies can replace one another; use separate browser profiles or sign in again.
- AI off or a failed request: no Claude key in the launching shell, the 60 request limit or an API error. Use manual categories with
  reasons. This fallback does not demonstrate AI. To turn AI on, restart with ANTHROPIC_API_KEY exported. No automatic retry.
- Changed configuration: startup refuses it. Preserve the file for review; create a separate
  session rather than reusing owner credentials or resetting financial records.
- Old source: judge-up rebuilds only that named app. Keep DB pins and volumes intact.

Stop session apps when unused to conserve RAM (judge-stop NAME); the key is not stored anywhere,
so restart with it exported if you want AI again. Never use prune, down --volumes or owner secrets.

## 5. Keep proof scoped: later independent review

The instructions and local checks do not establish access from another machine/network.
After owner source/rights/access approval, record exact archive hash, architecture, engine
versions, fresh/reused caches, setup time/errors, actual AI and separate-role login outcomes,
restart persistence and stopping behavior. Do not include credentials or private identifiers.
Official rules allow runnable repository instructions or hosting; continued availability
through judging still requires a reviewed access plan. No public action follows here.
