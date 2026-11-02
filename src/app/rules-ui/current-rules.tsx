// IAC-440 Package B (docs/ASSUMPTIONS.md section 72). The fund's current approved rules, read only. Presentation only.
import type { CurrentRules } from "../../rules-draft/drafts";
import { BUDGET_LINES, THRESHOLD_KEYS } from "../../rules-draft/draft-validate";
import { capLabel, categoryLabel, moneyText, programLabel, thresholdText, THRESHOLD_LABELS } from "./labels";

export function CurrentRulesView({ rules }: { rules: CurrentRules }) {
  const list = (items: string[] | null, label: (id: string) => string) => (items && items.length ? items.map(label).join(", ") : "None");
  return <div className="rules-current" data-testid="rules-current">
    <p className="rules-summary">{rules.summary}</p>
    <dl className="rules-facts">
      <div><dt>Programs</dt><dd>{list(rules.programs, programLabel)}</dd></div>
      <div><dt>Categories</dt><dd>{list(rules.allowedCategories, categoryLabel)}</dd></div>
      <div><dt>Grant period</dt><dd>{rules.periodStart && rules.periodEnd ? `${rules.periodStart} to ${rules.periodEnd}` : "Not set"}</dd></div>
      {BUDGET_LINES.map(line => <div key={line}><dt>{capLabel(line)}</dt><dd>{rules.caps[line] === undefined ? "None" : moneyText(rules.caps[line]!)}</dd></div>)}
      {THRESHOLD_KEYS.map(key => <div key={key}><dt>{THRESHOLD_LABELS[key]}</dt><dd>{rules.thresholds ? thresholdText(key, rules.thresholds.values[key]) : "Not set"}</dd></div>)}
    </dl>
    {rules.clauses.length > 0 && <details>
      <summary>Clauses of version {rules.version} ({rules.clauses.length})</summary>
      <ol className="rules-clauses">{rules.clauses.map(clause => <li key={clause.id}><span className="rules-clause">Clause {clause.id}</span> {clause.text}</li>)}</ol>
    </details>}
  </div>;
}
