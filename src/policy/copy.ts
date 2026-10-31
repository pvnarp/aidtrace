// Fixed strings for the Policy checks section (docs/plans/POLICY_CHECK_SCOPE.md section 5). The model rows are not built.
// None of these strings says a claim is cleared, approved or passed: a flag is information and a missing flag is not permission.
export const POLICY_TITLE = "Policy checks";
export const POLICY_LEAD = "Automatic checks run before you approve. They add information. They never approve, reject or pay a claim.";
export const POLICY_NOT_RUN = "Policy checks have not run for this frozen decision.";
export const POLICY_RUN_BUTTON = "Run policy checks";
export const POLICY_NO_FLAGS = "No rule flags. This is not an approval.";
export const POLICY_FOOTER = "Flags do not block approval. Two approvers are still required.";
export const NOT_CHECKED_TEXT = "Not checked: no thresholds are recorded for the funds on this claim.";
export const THRESHOLD_RULE_NAMES: Record<string, string> = { P1: "duplicate", P2: "split", P3: "stale receipt", P5: "line amount", P6: "claim total" };
export const SEVERITY_LABEL = { HOLD: "Hold", NOTE: "Note" } as const;
