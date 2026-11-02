"use client";
import "./gift.css";

// IAC-413 PR A (docs/plans/DONOR_TRAIL_SCOPE.md section 5.2): when the stored facts cannot be shown honestly (TrailInvariantError)
// or the database cannot be read, the page shows this fixed line and no data (an error boundary; the HTTP status is not asserted by any test). The error and its digest are not shown.
// This is a client component, so it imports nothing from the server modules.
export default function GiftUnavailable() {
  return <main className="gift-page" data-testid="gift-unavailable">
    <h1>This page is unavailable right now.</h1>
  </main>;
}
