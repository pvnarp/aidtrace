import { CATEGORY_NAMES } from "../../ai/categories";
import type { ProhibitedMatch } from "../../receipt/prohibited-screen";
// IAC-394: names the matched terms with their category names. Shared by the receipt page, the proposal review and the approver flag.
export const describeMatches = (matches: readonly ProhibitedMatch[]) => matches.map(match => `${match.term} (${CATEGORY_NAMES[match.category] ?? match.category})`).join(", ");
// Shown before confirmation. The box is never preselected and never required, because choosing the matching category also resolves the flag.
export function ProhibitedNotice({ matches }: { matches: readonly ProhibitedMatch[] }) {
  if (!matches.length) return null;
  return <div className="notice prohibited-notice"><p id="prohibited-notice-text">This receipt mentions: {describeMatches(matches)}. If a line is that item, choose that category. Otherwise tick to confirm it is not claimed under another category.</p>
    <label className="confirm"><input type="checkbox" name="acknowledgeProhibited" value="yes" aria-describedby="prohibited-notice-text" /> I checked: this is not claimed under another category.</label></div>;
}
