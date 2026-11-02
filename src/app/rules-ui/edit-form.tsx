// IAC-440 Package B (docs/plans/AI_DRAFTED_RULES_SCOPE.md section 5, docs/ASSUMPTIONS.md section 72). The edit form of an open draft. Presentation only: the route parses it
// (src/server/rules-input.ts) and the validator decides. Dollar fields show and take dollars, and the server turns them into integer cents with string arithmetic.
// An empty field means "the grant does not say" and is stored as not settled. A change saves as a new draft that needs its own two approvals.
import { BUDGET_LINES, SUMMARY_MAX_CHARS, THRESHOLD_KEYS } from "../../rules-draft/draft-validate";
import type { DraftReview } from "../../rules-draft/drafts";
import { EDIT_CAP_FIELDS, EDIT_CATEGORY_PREFIX, EDIT_PROGRAM_PREFIX, EDIT_THRESHOLD_FIELDS, centsToInput } from "../../server/rules-input";
import { capLabel, categoryLabel, isDayThreshold, programLabel, THRESHOLD_LABELS } from "./labels";

const REQUIRED = "Required before approval.";

export function EditForm({ review }: { review: DraftReview }) {
  const { view, catalogs } = review;
  const draft = view.draft;
  if (!draft || !view.analysis || view.state !== "OPEN") return null;
  const needed = new Set(view.analysis.missing);
  const programs = new Set(draft.programs.value ?? []), categories = new Set(draft.allowedCategories.value ?? []);
  const flag = (path: string) => (needed.has(path) ? { "data-needed": "true" } : {});
  const hint = (path: string, text: string) => (needed.has(path) ? `${REQUIRED} ${text}` : text);

  return <form className="rules-edit" method="post" action={`/api/funds/${view.fundId}/rules/drafts/${view.id}`} data-testid="rules-edit-form">
    <input type="hidden" name="action" value="edit" />
    <p className="muted">Change any value, or fill in one the grant does not settle. Saving makes a new draft. It needs its own two approvals, and the old draft stays on record.</p>

    <fieldset className="rules-field" {...flag("programs")}>
      <legend>Programs</legend>
      <p className="muted">{hint("programs", "Choose the programs this fund may pay for.")}</p>
      {catalogs.programs.length === 0 ? <p className="muted">This organization has no programs yet.</p>
        : <div className="rules-checks">{catalogs.programs.map(id => <label className="rules-check" key={id}><input type="checkbox" name={`${EDIT_PROGRAM_PREFIX}${id}`} value="on" defaultChecked={programs.has(id)} />{programLabel(id)}</label>)}</div>}
    </fieldset>

    <fieldset className="rules-field" {...flag("allowedCategories")}>
      <legend>Categories</legend>
      <p className="muted">{hint("allowedCategories", "Choose the kinds of cost this fund may pay for. Prohibited categories are not offered.")}</p>
      <div className="rules-checks">{catalogs.categories.map(id => <label className="rules-check" key={id}><input type="checkbox" name={`${EDIT_CATEGORY_PREFIX}${id}`} value="on" defaultChecked={categories.has(id)} />{categoryLabel(id)}</label>)}</div>
    </fieldset>

    <fieldset className="rules-field-group">
      <legend>Grant period</legend>
      <div className="rules-inputs">
        <div className="rules-field" {...flag("periodStart")}><label htmlFor="edit-periodStart">Period starts</label>
          <input id="edit-periodStart" type="date" name="periodStart" defaultValue={draft.periodStart.value ?? ""} aria-describedby="hint-periodStart" />
          <p className="muted" id="hint-periodStart">{hint("periodStart", "Year, month and day.")}</p></div>
        <div className="rules-field" {...flag("periodEnd")}><label htmlFor="edit-periodEnd">Period ends</label>
          <input id="edit-periodEnd" type="date" name="periodEnd" defaultValue={draft.periodEnd.value ?? ""} aria-describedby="hint-periodEnd" />
          <p className="muted" id="hint-periodEnd">{hint("periodEnd", "Year, month and day.")}</p></div>
      </div>
    </fieldset>

    <fieldset className="rules-field-group">
      <legend>Spending caps in dollars</legend>
      <div className="rules-inputs">{BUDGET_LINES.map(line => <div className="rules-field" key={line} {...flag(`caps.${line}`)}>
        <label htmlFor={`edit-cap-${line}`}>{capLabel(line)}</label>
        <input id={`edit-cap-${line}`} type="text" inputMode="decimal" autoComplete="off" name={EDIT_CAP_FIELDS[line]} defaultValue={centsToInput(draft.caps[line].value)} aria-describedby={`hint-cap-${line}`} />
        <p className="muted" id={`hint-cap-${line}`}>{hint(`caps.${line}`, "Dollars, like 300 or 300.50. Leave blank if the grant sets none.")}</p>
      </div>)}</div>
    </fieldset>

    <fieldset className="rules-field-group">
      <legend>Review limits</legend>
      <p className="muted">Most grants state none of these. A blank limit keeps the fund&apos;s current value.</p>
      <div className="rules-inputs">{THRESHOLD_KEYS.map(key => <div className="rules-field" key={key}>
        <label htmlFor={`edit-threshold-${key}`}>{THRESHOLD_LABELS[key]}</label>
        <input id={`edit-threshold-${key}`} type="text" inputMode={isDayThreshold(key) ? "numeric" : "decimal"} autoComplete="off" name={EDIT_THRESHOLD_FIELDS[key]}
          defaultValue={isDayThreshold(key) ? (draft.thresholds[key].value ?? "").toString() : centsToInput(draft.thresholds[key].value)} aria-describedby={`hint-threshold-${key}`} />
        <p className="muted" id={`hint-threshold-${key}`}>{isDayThreshold(key) ? "Whole days from 1 to 3650." : "Dollars, like 300 or 300.50."}</p>
      </div>)}</div>
    </fieldset>

    <div className="rules-field">
      <label htmlFor="edit-summary">Summary</label>
      <input id="edit-summary" type="text" name="summary" defaultValue={draft.summary} maxLength={SUMMARY_MAX_CHARS} aria-describedby="hint-summary" />
      <p className="muted" id="hint-summary">One plain sentence of at most {SUMMARY_MAX_CHARS} characters that says what the fund pays for.</p>
    </div>

    <button type="submit">Save my changes</button>
  </form>;
}
