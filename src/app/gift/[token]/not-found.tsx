import "./gift.css";
import { GiftBrand } from "./trail-view";

// IAC-413 PR A (docs/plans/DONOR_TRAIL_SCOPE.md section 3.6): one page for a malformed token and for a well-formed token that names
// no gift, so the two cannot be told apart by their response. The copy is fixed and carries no part of the requested token.
export default function GiftNotFound() {
  return <main className="gift-page" data-testid="gift-not-found">
    <title>Gift link not found | AidTrace</title>
    <GiftBrand />
    <h1>This link does not match a gift.</h1>
    <p>Check that you copied the whole link. If you gave in this demo, the link was shown once on the thank-you screen and cannot be shown again. No account or email is kept, so a lost link cannot be recovered.</p>
  </main>;
}
