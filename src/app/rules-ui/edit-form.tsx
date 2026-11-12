// IAC-440 Package B. The edit form of an open draft. Presentation only: the route parses it
// (src/server/rules-input.ts) and the validator decides. Dollar fields show and take dollars, and the server turns them into integer cents with string arithmetic.
// An empty field means "the grant does not say" and is stored as not settled. A change saves as a new draft that needs its own two approvals.
// November 10 calm rules pages: the same form has two modes. "all" shows every field. "needed" shows only the fields the draft still needs and carries every other
// value as a hidden input with exactly the value the full form would show, so the route receives the same complete field set either way (rules-input.ts refuses
// a post that is missing any fixed field). Ids carry a prefix per mode, so both forms can sit on one page without a duplicate id.
import { BUDGET_LINES, SUMMARY_MAX_CHARS, THRESHOLD_KEYS } from "../../rules-draft/draft-validate";
import type { DraftReview } from "../../rules-draft/drafts";
import { EDIT_CAP_FIELDS, EDIT_CATEGORY_PREFIX, EDIT_PROGRAM_PREFIX, EDIT_THRESHOLD_FIELDS, centsToInput } from "../../server/rules-input";
import { capLabel, categoryLabel, isDayThreshold, programLabel, THRESHOLD_LABELS } from "./labels";

const REQUIRED = "Required before approval.";
export type EditMode = "all" | "needed";

export function EditForm({ review, mode = "all" }: { review: DraftReview; mode?: EditMode }) {
  const { view, catalogs } = review;
  const draft = view.draft;
  if (!draft || !view.analysis || view.state !== "OPEN") return null;
  const needed = new Set(view.analysis.missing);
  const only = mode === "needed";
  if (only && needed.size === 0) return null;
  const id = (name: string) => `${only ? "need" : "edit"}-${name}`;
  const shown = (path: string) => !only || needed.has(path);
  const programs = new Set(draft.programs.value ?? []), categories = new Set(draft.allowedCategories.value ?? []);
  const flag = (path: string) => (needed.has(path) && !only ? { "data-needed": "true" } : {});
  const hint = (path: string, text: string) => (needed.has(path) && !only ? `${REQUIRED} ${text}` : text);
  const hidden = (name: string, value: string) => <input key={name} type="hidden" name={name} value={value} />;
  const thresholdValue = (key: (typeof THRESHOLD_KEYS)[number]) => (isDayThreshold(key) ? (draft.thresholds[key].value ?? "").toString() : centsToInput(draft.thresholds[key].value));

  const periodShown = shown("periodStart") || shown("periodEnd");
  const capsShown = BUDGET_LINES.filter(line => shown(`caps.${line}`));
  const thresholdsShown = THRESHOLD_KEYS.filter(key => shown(`thresholds.${key}`));

  return <form className={only ? "rules-edit rules-edit-needed" : "rules-edit"} method="post" action={`/api/funds/${view.fundId}/rules/drafts/${view.id}`} data-testid={only ? "rules-needed-form" : "rules-edit-form"}>
    <input type="hidden" name="action" value="edit" />
    {!only && <p className="muted">Change any value, or fill in one the grant does not settle. Saving makes a new draft. It needs its own two approvals, and the old draft stays on record.</p>}

    {shown("programs") ? <fieldset className="rules-field" {...flag("programs")}>
      <legend>Programs</legend>
      <p className="muted">{hint("programs", "Choose the programs this fund may pay for.")}</p>
      {catalogs.programs.length === 0 ? <p className="muted">This organization has no programs yet.</p>
        : <div className="rules-checks">{catalogs.programs.map(item => <label className="rules-check" key={item}><input type="checkbox" name={`${EDIT_PROGRAM_PREFIX}${item}`} value="on" defaultChecked={programs.has(item)} />{programLabel(item)}</label>)}</div>}
    </fieldset> : catalogs.programs.filter(item => programs.has(item)).map(item => hidden(`${EDIT_PROGRAM_PREFIX}${item}`, "on"))}

    {shown("allowedCategories") ? <fieldset className="rules-field" {...flag("allowedCategories")}>
      <legend>Categories</legend>
      <p className="muted">{hint("allowedCategories", "Choose the kinds of cost this fund may pay for. Prohibited categories are not offered.")}</p>
      <div className="rules-checks">{catalogs.categories.map(item => <label className="rules-check" key={item}><input type="checkbox" name={`${EDIT_CATEGORY_PREFIX}${item}`} value="on" defaultChecked={categories.has(item)} />{categoryLabel(item)}</label>)}</div>
    </fieldset> : catalogs.categories.filter(item => categories.has(item)).map(item => hidden(`${EDIT_CATEGORY_PREFIX}${item}`, "on"))}

    {periodShown && <fieldset className="rules-field-group">
      <legend>Grant period</legend>
      <div className="rules-inputs">
        {(["periodStart", "periodEnd"] as const).map(name => shown(name) ? <div className="rules-field" key={name} {...flag(name)}><label htmlFor={id(name)}>{name === "periodStart" ? "Period starts" : "Period ends"}</label>
          <input id={id(name)} type="date" name={name} defaultValue={draft[name].value ?? ""} aria-describedby={id(`hint-${name}`)} />
          <p className="muted" id={id(`hint-${name}`)}>{hint(name, "Year, month and day.")}</p></div> : hidden(name, draft[name].value ?? ""))}
      </div>
    </fieldset>}
    {!periodShown && <>{hidden("periodStart", draft.periodStart.value ?? "")}{hidden("periodEnd", draft.periodEnd.value ?? "")}</>}

    {capsShown.length > 0 && <fieldset className="rules-field-group">
      <legend>Spending caps in dollars</legend>
      <div className="rules-inputs">{capsShown.map(line => <div className="rules-field" key={line} {...flag(`caps.${line}`)}>
        <label htmlFor={id(`cap-${line}`)}>{capLabel(line)}</label>
        <input id={id(`cap-${line}`)} type="text" inputMode="decimal" autoComplete="off" name={EDIT_CAP_FIELDS[line]} defaultValue={centsToInput(draft.caps[line].value)} aria-describedby={id(`hint-cap-${line}`)} />
        <p className="muted" id={id(`hint-cap-${line}`)}>{hint(`caps.${line}`, "Dollars, like 300 or 300.50. Leave blank if the grant sets none.")}</p>
      </div>)}</div>
    </fieldset>}
    {BUDGET_LINES.filter(line => !capsShown.includes(line)).map(line => hidden(EDIT_CAP_FIELDS[line], centsToInput(draft.caps[line].value)))}

    {thresholdsShown.length > 0 && <fieldset className="rules-field-group">
      <legend>Review limits</legend>
      {!only && <p className="muted">Most grants state none of these. A blank limit keeps the fund&apos;s current value.</p>}
      <div className="rules-inputs">{thresholdsShown.map(key => <div className="rules-field" key={key}>
        <label htmlFor={id(`threshold-${key}`)}>{THRESHOLD_LABELS[key]}</label>
        <input id={id(`threshold-${key}`)} type="text" inputMode={isDayThreshold(key) ? "numeric" : "decimal"} autoComplete="off" name={EDIT_THRESHOLD_FIELDS[key]}
          defaultValue={thresholdValue(key)} aria-describedby={id(`hint-threshold-${key}`)} />
        <p className="muted" id={id(`hint-threshold-${key}`)}>{isDayThreshold(key) ? "Whole days from 1 to 3650." : "Dollars, like 300 or 300.50."}</p>
      </div>)}</div>
    </fieldset>}
    {THRESHOLD_KEYS.filter(key => !thresholdsShown.includes(key)).map(key => hidden(EDIT_THRESHOLD_FIELDS[key], thresholdValue(key)))}

    {only ? hidden("summary", draft.summary) : <div className="rules-field">
      <label htmlFor={id("summary")}>Summary</label>
      <input id={id("summary")} type="text" name="summary" defaultValue={draft.summary} maxLength={SUMMARY_MAX_CHARS} aria-describedby={id("hint-summary")} />
      <p className="muted" id={id("hint-summary")}>One plain sentence of at most {SUMMARY_MAX_CHARS} characters that says what the fund pays for.</p>
    </div>}

    <button type="submit">{only ? "Save and make a new draft" : "Save my changes"}</button>
    {only && <p className="muted">Saving makes a new draft with these values. It needs its own two approvals. Every other value stays as drafted.</p>}
  </form>;
}
