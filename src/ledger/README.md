# Use the transactional ledger

IAC-135 implements the ledger. Only this module writes application journals.
The accounting-inspired recognition/release model remains pending nonprofit accountant review.

- journal.ts validates exact cents and source replay, then writes a complete balanced batch.
- opening.ts posts the labeled fixture opening once; db/seed.ts delegates to it.
- snapshot.ts loads current approved policies, caps, priority and capacity. Policy-only mode
  reads no credits, debits or reservations, preventing recognition from subtracting its own hold.
- service.ts freezes/reserves, approves, invalidates, rejects and recognizes in SERIALIZABLE
  transactions with a maximum of three retries. Routes must supply authenticated actor IDs.
- reconcile.ts computes fund/GL tie-out, open payable, fixture cash and provider-activity delta.
  The latter is a book figure, never an actual PayPal available balance.

PostgreSQL migrations enforce deferred balancing, immutable journal/approval/frozen records,
same-transaction posting/edge insertion and recognized claim immutability. Admins are trusted.
tests/ledger.integration.test.ts creates and removes only its uniquely named test database.
Its simulated settlement is test data, not a provider call.

IAC-136 adds payout.ts: persist sender identity and UNKNOWN before a provider POST, bind
independent status responses to the approved item, and post settlement/actual fees once.
Network calls happen outside database transactions. Only this module posts application
settlement journals. Refund/reversal and fee conflicts need manual review; unknown or failed
attempts cannot obtain a new sender ID here.
