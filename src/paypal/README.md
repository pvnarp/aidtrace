# Keep provider access in one boundary

adapter.ts is the sole PayPal network boundary. createApplicationSandboxPayments provides
guarded product payout/status/balance methods with an in-memory OAuth token and one refresh
on 401. Requests use the exact sandbox origin, no redirects and bounded timeouts. Payout USD
strings are created here from bigint cents. The ledger service persists IDs before invoking it.

createManualSandboxLab remains separate and human-invoked. Product routes never invoke lab
methods. Authentication probing, donation experiments and signature checks are not automatic.
No setup, seed, page load, build or test performs real provider requests. Tests inject stubs.

Product status parsing retains only typed fields needed for binding and settlement. It never
logs tokens, full headers or recipient addresses. Unknown statuses remain conservative.
Provider balance is separate from book cash. The lab-readability flag defaults to false;
reporting may lag and unavailable reporting is never zero. See docs/FEASIBILITY.md.
