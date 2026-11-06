# AidTrace: AI receipt review and PayPal reimbursements

A nonprofit has USD 500 of expenses and three funds with different promises. AI proposes
receipt categories with source quotes. Rules compute USD 430 restricted and USD 70 General
on the fresh example. Two people approve the same terms. A read-only PayPal handoff shows
what an explicitly authorized reimbursement would require. This judging session stays unpaid.

Typography is self-hosted: one pinned Inter 4.1 font and its OFL notice travel with the source.
No CDN or system font installation is needed. See docs/FONT_PROVENANCE.md.

## 1. Prepare Docker: keep execution in containers

Use an existing Docker Engine or Docker Desktop with Compose v2, Linux ARM64 or AMD64,
a POSIX shell and upstream network access for pinned images and packages.
No native Node, pnpm, Python or Postgres is needed. The launcher uses the current Docker
context, or an explicit AIDTRACE_DOCKER_CONTEXT. The owner's execution stays in OrbStack.
Windows users need an existing WSL2 POSIX shell with Docker integration.

Native ARM app execution has evidence. Physical Docker Desktop, a fresh full AMD64 app
installation, another machine/network and Safari remain unverified. See [access requirements](docs/ACCESS.md).

AI features come from the hosted Claude API and need your own Anthropic API key, read
from the shell that starts a session: category suggestions, AI-drafted fund rules, the
receipt photo reader, the policy model check and analytics fact selection. No key is
required to review the app: without one, the AI features are off and the manual path works
end to end. [What a session shows with and without a key](docs/JUDGING.md) lists each one.

From this extracted folder, prepare dependencies once:

```sh
sh scripts/aidtrace doctor
sh scripts/aidtrace setup
```

Dependency setup uses a separate declaration with no environment file, database or port.
No model is downloaded. Each session app permits 3 GiB/two CPUs; its database
permits 384 MiB/one CPU, plus a 128 MiB local relay. Allow additional engine/build/image/package storage. Run heavy
builds and browser checks sequentially. These caps are not a total machine memory budget.

## 2. Create one session: preserve every earlier run

Choose a new lowercase session name, 3 to 24 characters, and an unused loopback port:

```sh
sh scripts/aidtrace judge-new review-one 3102
sh scripts/aidtrace judge-up review-one
```

To turn AI suggestions on, export your key in the same shell first (export ANTHROPIC_API_KEY
with your own value, not saved in a file) and then run judge-up. Typing the value on the command
line stores it in your shell history file. To avoid that, run `read -rs ANTHROPIC_API_KEY` (bash
or zsh) and paste the value, then `export ANTHROPIC_API_KEY`, or delete the history line afterwards. The
launcher passes the variable by name to the session app container only. The launcher never
writes it to session.env or any other file and never prints it. The container engine keeps the
value in the app container's configuration, including after judge-stop, until that container is
recreated or removed. Without it the app says AI suggestions are off in
this session and everything except the AI features still works. One process allows at most 60 Claude
requests in total, then AI turns itself off until the app restarts. The session turns the rule draft
and photo reader flags on, and leaves fund modes and Autopilot off.

Open http://127.0.0.1:3102/login. Private generated passwords are in
local/judge-sessions/review-one/session.env. Use SEED_PASSWORD_MARIA, SEED_PASSWORD_TARA
and SEED_PASSWORD_BEN privately. Do not share that file or include it in screenshots.
No PayPal login, key, tunnel or owner account is needed.

judge-new refuses existing names. judge-up validates configuration, starts a separately
named database, applies migrations, initializes a new fixture once, builds and serves the
production app. A database comment binds the generated configuration for later retention without reseeding.
An unbound database containing later work is refused, never adopted or reset automatically.
The comment is lifecycle metadata, not a financial journal or schema migration. The app does
not read local/.env. Provider credentials are forced empty, its
recipient is non-payable, and payment actions are disabled server-side. Internal application
networks connect the app to its session database, which has no outside route. The app also
has outbound HTTPS to the Claude API on one session-local edge network, shared only with a fixed
loopback relay. The relay has no credentials and forwards only to this app.
The shared dependency volume is read-only; each session has its own database and compiled build volume.

## 3. Review Maria's receipt: finish at the unpaid handoff

[JUDGING.md](docs/JUDGING.md) gives the full keyed path, with AI-drafted rules first, and names what is shown only in the
video. The shorter receipt path: sign in as maria. Choose Review Maria's $500 receipt. Create the default fictional receipt:
USD 280 kits, USD 150 notebooks and USD 70 refreshments. Select Prepare expense proposal
once. Check the Claude suggestions (or choose each category yourself when AI is off) against highlighted saved receipt text, confirm each
category and choose View allocation. The fresh unchanged example computes Tallow Creek Robot Kit Initiative USD 200,
Ashmere County Afterschool STEM Subgrant USD 230 and General Operating USD 70. The ordered first-eligible comparison uses USD 200
General Operating. The USD 130 difference is specific to this fixture and ordering, not measured
customer savings. Changes to categories or capacity can change the result.

Freeze the reviewed allocation as maria. Sign out, sign in as tara and approve the same
claim once. Sign out and repeat as ben. Two approvals recognize USD 500 payable but do not
pay it. Inspect PayPal handoff, its masked request structure and possible future states.
Expect Approved, Not submitted and Unassigned IDs. There is no Send control in this session.
Neither opening a panel nor refreshing the page creates an attempt or journal.

AI has no financial tools. UNKNOWN requires human categories/reasons. An organization-wide
prohibition blocks the whole expense, including General. Separate logins, confirmation,
freeze and two approvals remain deliberate. One session permits one receipt; its edits need
fresh review before freeze. C-104 remains a separate test fixture, outside this judge story.

## 4. Restart or repeat: do not reset data

```sh
sh scripts/aidtrace judge-stop review-one
sh scripts/aidtrace judge-up review-one
```

Restart retains the same receipt, approvals and balances. For fresh opening funds, stop the
old app and create a new name, for example judge-new review-two 3102, then judge-up review-two.
The earlier database/configuration/build remains preserved. No prune or volume deletion.
A busy port is an error to investigate, never permission to stop unrelated apps.
If the engine reports exhausted address pools, preserve the error. An operator may inspect
Docker subnets and host/VPN routes, then pass one checked unused private /28 as judge-new's
fourth argument after the port. It affects only that session and is retained in its config.
The helper validates syntax, not global routing availability. Never prune networks or change
global address pools automatically. Omit the subnet argument on an engine with normal capacity.
Browser cookies share a loopback hostname across ports; use a separate browser profile or
sign in again when switching between sessions. Do not reuse owner passwords.

Optional checks: sh scripts/aidtrace check and sh scripts/aidtrace ui-check use isolated
synthetic fixtures. They use a scripted stand-in for the AI and are not PayPal or Claude API evidence.
To switch AI off, restart the session from a shell without ANTHROPIC_API_KEY. Manual review stays available.

## 5. Review evidence and rights: no publication follows

[The detailed access guide](docs/ACCESS.md) covers failure recovery and independent access.
The native analytics dashboard is available to tara/ben at /analytics; its facts come from
local journals, not current PayPal cash. AI selects validated snapshot facts with a manual
fallback. This variant contains no Studio SDK. It uses AG Grid Community (MIT) for the ledger, donations
and queue views, and release/variant.json records sponsorUseClaimed true for that package only (docs/LICENSING.md section 6).

The owner's separately observed sandbox payout, capture and webhook evidence is not this
session's payment history. Its private database, identifiers, keys and media are excluded.
A later real sandbox run requires separate configuration and authorization outside this
non-payable session. Do not edit its guard settings to enable payment.

The application MIT license is included. Dependency/model rights remain separate: review
LICENSE, NOTICE, THIRD_PARTY_NOTICES.txt, DEPENDENCY_LICENSES.json, UPSTREAM_LICENSE_SOURCES.json,
docs/LICENSING.md and docs/THIRD_PARTY_MODELS.md. The accounting model awaits accountant review.
SOURCE_MANIFEST.json identifies the prepared source, excluding Git history, local secrets
and backups. No AI model weights ship with it. Exact candidate, ownership, access and publication remain owner decisions.
This source is unpublished. Nothing here authorizes hosting, recording, contact or submission.
