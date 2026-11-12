// IAC-440 Package B. The rows of the review table, built from one stored draft and the
// fund's current approved rules. Pure. A REFUSED draft has no rows, so no drafted value can be shown for one. The table says where each value came from: the clause
// and quoted sentence for a value the AI drafted, "Changed by a person" for an edit, and "Not settled by the grant" for a field the text does not settle.
import { BUDGET_LINES, THRESHOLD_KEYS, type DraftField, type ThresholdKey } from "../../rules-draft/draft-validate";
import type { DraftReview } from "../../rules-draft/drafts";
import { capLabel, categoryLabel, moneyText, pathLabel, programLabel, thresholdText, THRESHOLD_LABELS } from "./labels";

// NEEDED: the grant does not settle a field that must have a value before approval. CARRIED: a review limit left blank that keeps the fund's current value.
// BLANK: not settled and not required. DRAFTED and EDITED carry a value.
export type RowTone = "DRAFTED" | "EDITED" | "NEEDED" | "CARRIED" | "BLANK";
export type RowSource = { kind: "quote"; clauseId: string; quote: string } | { kind: "edited" } | { kind: "unsure" } | { kind: "written" };
export type ReviewRow = {
  path: string; label: string; current: string; draft: string; tone: RowTone; changed: boolean; source: RowSource;
  // The AI proposed a value for this field but its quote did not state it, so the value was removed and a person must fill the field.
  unsupported: boolean;
};

const NONE = "None";
const list = (items: string[] | null | undefined, label: (id: string) => string): string => (items && items.length ? items.map(label).join(", ") : NONE);

// The rows of a drafted review, in the order a person reads the rules. An empty list for a draft with no drafted values (refused).
export function reviewRows(review: DraftReview): ReviewRow[] {
  const { view, current } = review;
  const draft = view.draft, analysis = view.analysis;
  // Two guards on purpose: a refused answer stores no value, and even a view that carried one would show none, because the state is checked here too.
  if (!draft || !analysis || view.state === "REFUSED") return [];
  const missing = new Set(analysis.missing), unsupported = new Set(analysis.quoteUnsupported);

  const rows: ReviewRow[] = [];
  const sourceOf = <T>(field: DraftField<T>): RowSource => (field.status === "DRAFTED" && field.clauseId && field.quote ? { kind: "quote", clauseId: field.clauseId, quote: field.quote }
    : field.status === "EDITED" ? { kind: "edited" } : { kind: "unsure" });
  const push = <T>(path: string, label: string, field: DraftField<T>, show: (value: T) => string, currentText: string, carriedText: string | null = null) => {
    const unsure = field.value === null;
    const tone: RowTone = unsure ? (missing.has(path) ? "NEEDED" : carriedText !== null ? "CARRIED" : "BLANK") : field.status === "EDITED" ? "EDITED" : "DRAFTED";
    const draftText = unsure ? (tone === "NEEDED" ? "Needs a value" : carriedText !== null ? `Keeps ${carriedText}` : "Not set") : show(field.value as T);
    rows.push({ path, label, current: currentText, draft: draftText, tone, changed: !unsure && draftText !== currentText, source: sourceOf(field), unsupported: unsupported.has(path) });
  };

  push("programs", pathLabel("programs"), draft.programs, value => list(value, programLabel), list(current.programs, programLabel));
  push("allowedCategories", pathLabel("allowedCategories"), draft.allowedCategories, value => list(value, categoryLabel), list(current.allowedCategories, categoryLabel));
  push("periodStart", pathLabel("periodStart"), draft.periodStart, value => value, current.periodStart ?? "Not set");
  push("periodEnd", pathLabel("periodEnd"), draft.periodEnd, value => value, current.periodEnd ?? "Not set");
  for (const line of BUDGET_LINES) {
    const now = current.caps[line];
    push(`caps.${line}`, capLabel(line), draft.caps[line], value => moneyText(value), now === undefined ? NONE : moneyText(now));
  }
  for (const key of THRESHOLD_KEYS) {
    const now = current.thresholds?.values[key];
    const nowText = now === undefined ? "Not set" : thresholdText(key, now);
    push(`thresholds.${key}`, THRESHOLD_LABELS[key], draft.thresholds[key], value => thresholdText(key, value), nowText, now === undefined ? null : nowText);
  }
  rows.push({
    path: "summary", label: "Summary", current: current.summary, draft: draft.summary, tone: (view.changedFields ?? []).includes("summary") ? "EDITED" : "DRAFTED",
    changed: draft.summary !== current.summary, source: (view.changedFields ?? []).includes("summary") ? { kind: "edited" } : { kind: "written" }, unsupported: false,
  });
  return rows;
}

// True when an approval would be refused because some review limits are set in this draft, not all six are, and the fund has no earlier limits to fill the rest.
// This mirrors the check the bind makes, so the screen can say why approve is unavailable instead of letting a press fail.
export function thresholdsBlocked(review: DraftReview): boolean {
  const draft = review.view.draft;
  if (!draft) return false;
  const anySet = THRESHOLD_KEYS.some((key: ThresholdKey) => draft.thresholds[key].value !== null);
  const anyBlank = THRESHOLD_KEYS.some((key: ThresholdKey) => draft.thresholds[key].value === null);
  return anySet && anyBlank && review.current.thresholds === null;
}
