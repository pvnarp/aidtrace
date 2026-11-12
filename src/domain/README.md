# Use the pure allocation functions

IAC-134 implements allocate.ts and naive.ts. model.ts defines the
approved policy and capacity snapshot contract, policy eligibility, and candidate validation.
Money and costs are bigint cents. Input snapshots are not mutated.

allocate first minimizes unrestricted cents, then minimizes original v1 priority cost while
holding that minimum. Shared budget-line nodes enforce caps across several categories.
naive follows line ID then fund ID order for comparison only; never use it to authorize payment.
Infeasible results expose deficits and no partial allocations. Neither function performs I/O.

IAC-135 owns approved snapshot loading, RFC 8785 hashing, frozen decisions, reservations,
two independent approvals, recognition, release, and ledger transactions. The pure solver
does not establish user authority or persist any financial decision.
