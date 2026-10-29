# Run the bounded judging demonstration

Use ACCESS.md for prerequisites, generated login handling, no-payment review, troubleshooting
and the later independent-machine evidence checklist. This template grants no vendor rights.

## 1. Reproduce the tested platform: ARM64 OrbStack

Follow the root README in a fresh extracted folder with OrbStack already installed. All
package installs and project execution stay in containers. Setup generates unique local
demo passwords; no owner credential or payment identifier is included. Tested platform is
Linux ARM64 on OrbStack. Other architectures and physical Safari have not been verified.
Use the fictional receipt-review journey through allocation preview. No payment is needed.
Start the model with receipt-ai-up, then use review-up for the stable production review
runtime. Select Prepare expense proposal once on a new fictional receipt, review the
provisional funding/quotes and confirm categories explicitly. Follow ACCESS.md through
Freeze and the separate Tara/Ben approvals. Stop at Approved before any Send action. Code
changes require review-up again; it rebuilds/restarts only the app with separate build storage.

For the optional analytics dashboard, sign in as tara or ben, open /analytics, filter
funds, ask a listed snapshot question and inspect the manual facts. Maria is denied.
These are local accounting figures, not current PayPal cash. This source variant uses the
native dashboard, without the Studio SDK or a vendor key. Its application MIT license does
not relicense other dependencies. Review docs/LICENSING.md and release/variant.json.

The official rules allow complete runnable repository instructions instead of a hosted
application. Keep the final public source, instructions and upstream download availability
usable through December 15, 2026. This candidate has not been published, and no continuing
availability or external judge access has been verified. See
https://paypalaihackathon.devpost.com/rules . The owner must approve the final access plan.

## 2. Separate provider evidence: synthetic configuration

The default recipient is non-payable and PayPal credentials are empty. The tests use
synthetic provider responses. The owner's real sandbox payout, capture and verified webhook
were observed separately and are described in the README without publishing their private
configuration or identifiers. Do not claim the local fictional fixture was paid by PayPal.

If independent provider testing is requested, obtain a separate PayPal Developer sandbox
app and separate Business sender/Personal recipient using your own account. Enable Payouts
on that sandbox app. Before the first database seed, privately configure PAYPAL_CLIENT_ID,
PAYPAL_CLIENT_SECRET, PAYPAL_SANDBOX_PAYEE_EMAIL and PAYEE_ALLOWLIST in local/.env. Both
recipient fields must be that separate Personal sandbox address, not the Business sender.
Keep PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com and the existing USD 500 demo limit.
Never add production credentials or publish any .env file. Changing an already seeded payee
does not update existing bound approvals; use a fresh separate demo, not a reset of paid data.

Balance reporting may remain unavailable, as it was during owner acceptance. The application
can submit to sandbox under the documented fallback and handle provider rejection; fixture
ledger cash is not evidence of available PayPal cash. A real submission still requires the
explicit confirmation shown in the application, independent approvals and enough sandbox
balance for the principal and fee. Item SUCCESS must be independently fetched before Paid.
UNKNOWN requires manual reconciliation; no automatic retry is permitted.

These are optional setup instructions, not permission to reuse the owner's account or send
a payment. No independent judge provider setup was exercised for this release preparation.
The event receiver/tunnel infrastructure and private sandbox lab are intentionally excluded.

## 3. Keep submission actions separate: owner checklist

Choose a final repository destination, review the exact release candidate/license and
confirm ownership before public creation or push. Record an English functioning-demo video
under three minutes near the November 9 target; use invented data and conceal credentials.
Public YouTube upload and Devpost submission still require the owner's direction. Submission
deadline is November 12, 2026 at 2 p.m. America/Chicago. No recording is required now.
