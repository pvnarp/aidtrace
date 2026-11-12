import { ActionForm } from "./action-form";
import type { StoredPolicyRun } from "../../../policy/service";
import type { StoredModelRun } from "../../../policy/model-read";
import {
  MODEL_INTERRUPTED, MODEL_NOT_APPLICABLE, MODEL_NOT_RUN, MODEL_RUN_BUTTON, MODEL_RUNNING, MODEL_STATUS_TEXT, POLICY_FOOTER, POLICY_LEAD, POLICY_NO_FLAGS, POLICY_NOT_RUN, POLICY_RUN_BUTTON,
  POLICY_TITLE, SEVERITY_LABEL, THRESHOLD_RULE_NAMES, modelAskedBy, modelCheckedBy, modelLineText, modelNotChecked, modelOkSentence, modelSkipped,
} from "../../../policy/copy";
import { modelCheckDisclosure } from "../../ai-disclosure";

// IAC-405 step 1: rule flags for approvers, then the model rows of piece G. Server component, plain list, no table, so phone and desktop share the markup.
// A flag is a text label and a sentence. It never changes the Approve control, which reads nothing from the policy tables.
// Flag text, clause text and line descriptions are stored data and render as escaped text only. Nothing here says a claim is cleared, approved or passed.
// Model rows are separate from the rule rows above them. A model OK never removes, hides or reorders a rule Hold.
// Only existing classes are reused. receipt-page supplies overflow-wrap for bounded vendor text. It must not be expense-review,
// because the proposal e2e locates that class and needs exactly one match.
// aiOff is the fixed AI_OFF_MESSAGES text, passed in by the page. modelEligible is true only for a claim with a confirmed receipt review.
// Both are optional: a caller that passes neither renders the rule section exactly as before.
// IAC-415 PR 6: headingLevel defaults to 2, so a caller that passes nothing renders the same h2 as before. The claim page nests this block inside its own
// "Checks" h2 and passes 3, so the page has one Checks heading and "Policy checks" reads as its sub-heading.
// The Run model check control shows only when the rules ran, the model run is absent, the claim has a confirmed receipt review, the compliance AI is on
// and the viewer can run checks. It posts action run-model to the same endpoint, which calls only the model check.
// IAC-416 PR 2: the per-row lines say "AI (Sonnet 5.5)". One "Powered by" line names the models that were sent a request, built from the stored CALL rows, and the provider (src/app/ai-disclosure.ts). A pair
// IAC-405 PR A follow-up: footer defaults to the fixed POLICY_FOOTER. The claim page passes a different fixed sentence only for a decision that needs one approval (src/fund-modes/review-copy.ts).
// refused by the request limit (reason LIMIT) sent nothing, so its model is not named there; with no pair asked the line is absent.
// November 5 (Pavan: "Powered by [model name]" wherever a model is used): the models named in the "Powered by" line and of each fund's "Checked by" line come from the stored CALL rows
// (calledModels, called), so Haiku, which is asked first, is named whenever it was sent a request, and a model that was never sent one is not. A pair refused by the request
// limit (reason LIMIT) stores no CALL row, so it is named nowhere.
const askedModels = (pair: StoredModelRun["pairs"][number]): string[] => pair.called;
function ModelRows({ model }: { model: StoredModelRun }) {
  const disclosure = modelCheckDisclosure(model.calledModels);
  return <>
    <p><strong>{MODEL_STATUS_TEXT[model.status]}</strong></p>
    {model.state === "RUNNING" && <p>{MODEL_RUNNING}</p>}
    {model.state === "INTERRUPTED" && <p>{MODEL_INTERRUPTED}</p>}
    {disclosure && <p>{disclosure}</p>}
    {model.pairs.map(pair => <div key={pair.fundId}>
      {pair.state === "SKIPPED" ? <p>{modelSkipped(pair.fundName)}</p> : <>
        <p><strong>{pair.fundName}</strong>{pair.effort && askedModels(pair).length > 0 ? <>{" "}{pair.state === "CHECKED" ? modelCheckedBy(askedModels(pair), pair.effort) : modelAskedBy(askedModels(pair), pair.effort)}</> : null}</p>
        {pair.state === "NOT_CHECKED" && <p>{modelNotChecked(pair.reasonCode)}</p>}
        {pair.state === "CHECKED" && <ul className="reasons">{pair.lines.filter(line => line.verdict !== "OK").map(line => {
          const shown = modelLineText(line);
          return <li key={line.lineId} data-verdict={line.verdict}><strong>{shown.label}:</strong>{" "}{shown.text}{shown.quote ? <>{" "}&quot;{shown.quote}&quot;</> : null}</li>;
        })}{pair.lines.some(line => line.verdict === "OK") && <li>{modelOkSentence(pair.lines.filter(line => line.verdict === "OK"))}</li>}</ul>}
      </>}
    </div>)}
  </>;
}

export function PolicyChecks({ claimId, decisionHash, run, canRun, aiOff = null, modelEligible, headingLevel = 2, footer = POLICY_FOOTER }: { claimId: string; decisionHash: string; run: StoredPolicyRun | null; canRun: boolean; aiOff?: string | null; modelEligible?: boolean; headingLevel?: 2 | 3; footer?: string }) {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  return <section id="policy-checks" aria-labelledby="policy-checks-title" className="receipt-page">
    <Heading id="policy-checks-title">{POLICY_TITLE}</Heading>
    <p>{POLICY_LEAD}</p>
    {!run && <p>{POLICY_NOT_RUN}</p>}
    {!run && canRun && <ActionForm action="run" claimId={claimId} decisionHash={decisionHash} endpoint="policy-checks" button={POLICY_RUN_BUTTON} />}
    {run && run.flags.length === 0 && <p>{POLICY_NO_FLAGS}</p>}
    {run && run.flags.length > 0 && <ul className="reasons">{run.flags.map(flag => <li key={flag.sequence} data-severity={flag.severity}><strong>{SEVERITY_LABEL[flag.severity]}:</strong>{" "}{flag.flagText}</li>)}</ul>}
    {run && run.notChecked.length > 0 && <>
      <p>{run.notChecked[0]!.flagText}</p>
      <p>Rules not checked: {run.notChecked.map(row => THRESHOLD_RULE_NAMES[row.ruleId] ?? row.ruleId).join(", ")}.</p>
    </>}
    {modelEligible === false && run && <p>{MODEL_NOT_APPLICABLE}</p>}
    {modelEligible === true && run?.model && <ModelRows model={run.model} />}
    {modelEligible === true && !run?.model && aiOff && <p>{aiOff}</p>}
    {modelEligible === true && run && !run.model && !aiOff && <p>{MODEL_NOT_RUN}</p>}
    {modelEligible === true && run && !run.model && !aiOff && canRun && <ActionForm action="run-model" claimId={claimId} decisionHash={decisionHash} endpoint="policy-checks" button={MODEL_RUN_BUTTON} />}
    <p className="muted">{footer}</p>
  </section>;
}
