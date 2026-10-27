# Preserve bounded analytics: adopted application contract

## 1. Inspect funding and cash: read-only dashboard

Approvers may view exact local fund book balances, reservations, book cash, recorded
activity and payable. Claimants cannot access organization-wide analytics. The app fails
closed when more than one organization exists because the journal schema is not tenant-keyed.
This dashboard neither fetches provider balances nor independently reconciles PayPal cash.

## 2. Constrain explanations: fixed facts and human authority

The private model selects fact IDs and exact server-authored quotes for three listed
questions. Server validation rejects unsupported output. Money remains exact integer
cents and is formatted by AidTrace. No free-form financial tools, database access,
approval, allocation, payee changes or payments are offered to the model. Manual facts
remain available without AI. Receipt confirmation and deterministic financial authority
remain governed by SPEC and the Gate B addendum.

## 3. Apply the fallback override: native presentation

This source variant uses ordinary React and same-origin requests, governed by
STUDIO_FREE_FALLBACK_SCOPE.md. The original commercial Studio evaluation is separately
preserved. No Studio key, permission grant or AG sponsor-use claim accompanies this variant.
