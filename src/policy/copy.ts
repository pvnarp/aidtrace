// Fixed strings for the Policy checks section (docs/plans/POLICY_CHECK_SCOPE.md section 5). The model strings are at the end of the file.
// None of these strings says a claim is cleared, approved or passed: a flag is information and a missing flag is not permission.
export const POLICY_TITLE = "Policy checks";
export const POLICY_LEAD = "Automatic checks run before you approve. They add information. They never approve, reject or pay a claim.";
export const POLICY_NOT_RUN = "Policy checks have not run for this frozen decision.";
export const POLICY_RUN_BUTTON = "Run policy checks";
export const POLICY_NO_FLAGS = "No rule flags. This is not an approval.";
// IAC-415 PR 6 (checks read once): the footer uses the row label "Hold", not the older word "Flags", so the rows and the footer use one term. This replaces the
// footer pinned in docs/plans/POLICY_CHECK_SCOPE.md section 5 ("Flags do not block approval. Two approvers are still required."); that table stays as scope history.
export const POLICY_FOOTER = "Holds do not block approval. Two approvers are still required.";
export const NOT_CHECKED_TEXT = "Not checked: no thresholds are recorded for the funds on this claim.";
export const THRESHOLD_RULE_NAMES: Record<string, string> = { P1: "duplicate", P2: "split", P3: "stale receipt", P5: "line amount", P6: "claim total" };
export const SEVERITY_LABEL = { HOLD: "Hold", NOTE: "Note" } as const;
// IAC-415 PR 6: the summary line of the Checks panel. It names what the count counts ("Rule checks") and, when the stored policy run has Hold rows, says so in the
// same line, so "3 of 3 clear" is not read as "nothing to review". Only the HOLD severity is counted: a NOTE keeps its own label and adds no clause. A missing run
// (not run yet, or a claim whose viewer cannot see the policy rows) adds no clause. The words approved, passed and cleared are never used for a Hold.
export function ruleChecksSummary(clear: number, total: number, flags: readonly { severity: "HOLD" | "NOTE" }[] | null | undefined): string {
  const holds = (flags ?? []).filter(flag => flag.severity === "HOLD").length;
  const count = `Rule checks: ${clear} of ${total} clear.`;
  return holds === 0 ? count : `${count} ${holds} ${holds === 1 ? "Hold below goes" : "Holds below go"} to the approvers.`;
}

// IAC-405 piece G model rows (scope section 5). The vocabulary is OK, CONFLICT, UNSURE and NOT_CHECKED. Nothing here says a claim is cleared, approved
// or passed, and no string is the control name of another panel. A model OK is "no conflict found by the model" and never removes a rule Hold.
export const MODEL_RUNNING = "Policy checks are running. Reload in a few seconds.";
export const MODEL_INTERRUPTED = "Not checked by the model: the check did not finish.";
export const MODEL_NOT_RUN = "The model check did not run for this frozen decision.";
export const MODEL_RUN_BUTTON = "Run model check";
export const MODEL_NOT_APPLICABLE = "The model check applies to claims with a confirmed receipt review. This claim has rule checks only.";
export const MODEL_STATUS_TEXT = {
  RUNNING: "Model status: running.",
  HOLD: "Model status: Hold. A person decides.",
  NO_CONFLICT_FOUND: "Model status: no conflict found by the model. This is not an approval.",
  NOTHING_CHECKED: "Model status: nothing was checked.",
} as const;
export const NOT_CHECKED_REASON_TEXT: Record<string, string> = {
  TIMEOUT: "the request timed out",
  UNAVAILABLE: "the model service was unavailable",
  INVALID: "the answer was invalid and was discarded",
  LIMIT: "the request limit was reached",
  NO_CLAUSES: "no clauses are recorded for this fund",
  GENERAL_FUND: "the General fund has no clauses to check",
};
export const modelNotChecked = (reason: string | null) => `Not checked by the model: ${NOT_CHECKED_REASON_TEXT[reason ?? "UNAVAILABLE"] ?? NOT_CHECKED_REASON_TEXT.UNAVAILABLE}.`;
export const modelSkipped = (fundName: string) => `${fundName}: not checked by the model. The General fund has no clauses to check.`;
// Display name from the stored model id, for example "vendor-family-5-5" becomes "Vendor Family 5.5". It formats the stored string and names no
// model itself, because PC-14 allows only the model module and the pinned request copy to name a model.
// IAC-416 PR 2 (Pavan, November 1): the per-row lines say "AI" and keep the model in brackets without its first word ("AI (Family 5.5)"). The full
// name, modelFullName, is for the one disclosure line of the model check section (src/app/ai-disclosure.ts), which also names the provider. This file
// holds no provider name, because PC-14 allows only the model module to name one.
const word = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const MODEL_ID = /^([a-z]+)-([a-z]+)-(\d+)-(\d+)$/;
export const modelFullName = (model: string) => { const parts = MODEL_ID.exec(model); return parts ? `${word(parts[1]!)} ${word(parts[2]!)} ${parts[3]}.${parts[4]}` : model; };
const modelShortName = (model: string) => { const parts = MODEL_ID.exec(model); return parts ? `${word(parts[2]!)} ${parts[3]}.${parts[4]}` : model; };
// November 5: a fund the check escalated names both models in the order they were asked: "AI (Haiku 5.5, then Sonnet 5.5)". One model gives the earlier "AI (Haiku 5.5)".
const modelShortNames = (models: string | readonly string[]) => (typeof models === "string" ? [models] : [...new Set(models)]).map(modelShortName).join(", then ");
export const modelCheckedBy = (models: string | readonly string[], effort: string) => `Checked by AI (${modelShortNames(models)}) at ${effort} effort.`;
// A NOT_CHECKED pair names the model that was asked and failed. It never says "Checked by".
export const modelAskedBy = (models: string | readonly string[], effort: string) => `Asked AI (${modelShortNames(models)}) at ${effort} effort.`;
export const modelLineLabel = (lineId: string, description: string) => `Line ${lineId} (${description})`;
export function modelLineText(line: { lineId: string; description: string; verdict: "OK" | "CONFLICT" | "UNSURE"; clauseId: string | null; clauseText: string | null }): { label: string; text: string; quote: string | null } {
  const label = modelLineLabel(line.lineId, line.description);
  if (line.verdict === "CONFLICT") return { label, text: `conflict with clause ${line.clauseId}:`, quote: line.clauseText };
  if (line.verdict === "UNSURE") return { label, text: line.clauseId ? `the model could not tell whether clause ${line.clauseId} permits this line.` : "the model could not tell whether the fund clauses permit this line.", quote: null };
  return { label, text: "no conflict found by the model. This is not an approval.", quote: null };
}
// IAC-415 PR 4 (say it once): the OK lines of one fund read as one sentence that names every line. A CONFLICT or UNSURE line never goes through this
// builder: it keeps its own row and, for a CONFLICT, the quoted clause (modelLineText). "This is not an approval." stays once, in MODEL_STATUS_TEXT.
// Two lines join with "and", three or more join with commas and a final "and". An empty list gives an empty string and the caller renders nothing.
export function modelOkSentence(lines: readonly { lineId: string; description: string }[]): string {
  const labels = lines.map(line => modelLineLabel(line.lineId, line.description));
  if (labels.length === 0) return "";
  const named = labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]!}`;
  return `No conflict found by the model on ${named}.`;
}
