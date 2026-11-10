// IAC-440 Package B (docs/ASSUMPTIONS.md section 72). The fund's current approved rules, read only. Presentation only.
// November 10 calm rules pages: only the caps the rules set are listed one by one; the lines with no cap share one plain sentence, and the six review limits sit
// in a closed list, so the page leads with what the fund pays for instead of a grid of "None".
import type { CurrentRules } from "../../rules-draft/drafts";
import { BUDGET_LINES, THRESHOLD_KEYS } from "../../rules-draft/draft-validate";
import { BUDGET_NAMES } from "../../ai/categories";
import { capLabel, categoryLabel, humanize, moneyText, programLabel, thresholdText, THRESHOLD_LABELS } from "./labels";

export function CurrentRulesView({ rules }: { rules: CurrentRules }) {
  const list = (items: string[] | null, label: (id: string) => string) => (items && items.length ? items.map(label).join(", ") : "None");
  const capped = BUDGET_LINES.filter(line => rules.caps[line] !== undefined);
  const uncapped = BUDGET_LINES.filter(line => rules.caps[line] === undefined);
  return <div className="rules-current" data-testid="rules-current">
    <p className="rules-summary">{rules.summary}</p>
    <dl className="rules-facts">
      <div><dt>Programs</dt><dd>{list(rules.programs, programLabel)}</dd></div>
      <div><dt>Categories</dt><dd>{list(rules.allowedCategories, categoryLabel)}</dd></div>
      <div><dt>Grant period</dt><dd>{rules.periodStart && rules.periodEnd ? `${rules.periodStart} to ${rules.periodEnd}` : "Not set"}</dd></div>
      {capped.map(line => <div key={line}><dt>{capLabel(line)}</dt><dd>{moneyText(rules.caps[line]!)}</dd></div>)}
    </dl>
    {uncapped.length > 0 && <p className="muted rules-uncapped" data-testid="rules-uncapped">No cap on {uncapped.map(line => (line === "other" ? "other costs" : (BUDGET_NAMES[line] ?? humanize(line)).toLowerCase())).join(", ")}.</p>}
    <details className="rules-limits-details">
      <summary>Review limits{rules.thresholds ? "" : ": not set"}</summary>
      <dl className="rules-facts">
        {THRESHOLD_KEYS.map(key => <div key={key}><dt>{THRESHOLD_LABELS[key]}</dt><dd>{rules.thresholds ? thresholdText(key, rules.thresholds.values[key]) : "Not set"}</dd></div>)}
      </dl>
    </details>
    {rules.clauses.length > 0 && <details>
      <summary>Clauses of version {rules.version} ({rules.clauses.length})</summary>
      <ol className="rules-clauses">{rules.clauses.map(clause => <li key={clause.id}><span className="rules-clause">Clause {clause.id}</span> {clause.text}</li>)}</ol>
    </details>}
  </div>;
}
