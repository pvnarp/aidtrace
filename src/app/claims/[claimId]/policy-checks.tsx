import { ActionForm } from "./action-form";
import type { StoredPolicyRun } from "../../../policy/service";
import { POLICY_FOOTER, POLICY_LEAD, POLICY_NO_FLAGS, POLICY_NOT_RUN, POLICY_RUN_BUTTON, POLICY_TITLE, SEVERITY_LABEL, THRESHOLD_RULE_NAMES } from "../../../policy/copy";

// IAC-405 step 1: rule flags for approvers. Server component, plain list, no table, so phone and desktop share the markup.
// A flag is a text label and a sentence. It never changes the Approve control, which reads nothing from the policy tables.
// Flag text is stored data and renders as escaped text only. Nothing here says a claim is cleared, approved or passed.
// Only existing classes are reused. receipt-page supplies overflow-wrap for bounded vendor text. It must not be expense-review,
// because the proposal e2e locates that class and needs exactly one match.
export function PolicyChecks({ claimId, decisionHash, run, canRun }: { claimId: string; decisionHash: string; run: StoredPolicyRun | null; canRun: boolean }) {
  return <section id="policy-checks" aria-labelledby="policy-checks-title" className="receipt-page">
    <h2 id="policy-checks-title">{POLICY_TITLE}</h2>
    <p>{POLICY_LEAD}</p>
    {!run && <p>{POLICY_NOT_RUN}</p>}
    {!run && canRun && <ActionForm action="run" claimId={claimId} decisionHash={decisionHash} endpoint="policy-checks" button={POLICY_RUN_BUTTON} />}
    {run && run.flags.length === 0 && <p>{POLICY_NO_FLAGS}</p>}
    {run && run.flags.length > 0 && <ul className="reasons">{run.flags.map(flag => <li key={flag.sequence}><strong>{SEVERITY_LABEL[flag.severity]}:</strong>{" "}{flag.flagText}</li>)}</ul>}
    {run && run.notChecked.length > 0 && <>
      <p>{run.notChecked[0]!.flagText}</p>
      <p>Rules not checked: {run.notChecked.map(row => THRESHOLD_RULE_NAMES[row.ruleId] ?? row.ruleId).join(", ")}.</p>
    </>}
    <p className="muted">{POLICY_FOOTER}</p>
  </section>;
}
