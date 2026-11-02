import { modelFullName } from "../policy/copy";

// IAC-416 PR 2 (Pavan, November 1: "we need to just say AI"): screens say "AI" and keep the model and the provider in a few disclosure lines, so a person can see
// where their text went. The other two are in src/app/receipts/ai-recommendation.tsx (the saved suggestion line and the idle strip). Each always names Anthropic.

/**
 * The one provider disclosure line of the claim page's model check section. It names each stored model once, in first-seen order, built from the stored ids,
 * and Anthropic. A caller passes only the models that were asked: a pair refused by the request limit sent nothing, so its model is not passed. An empty list
 * gives an empty string, and the caller renders nothing.
 */
export function modelCheckDisclosure(models: readonly string[]): string {
  const names = [...new Set(models)].map(modelFullName);
  if (names.length === 0) return "";
  const named = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
  return `Model check: ${named}. Claim line and clause text was sent to Anthropic.`;
}

/**
 * IAC-440 Package B: the disclosure line above the "Draft rules" button. It names the model a new draft would use (built from the arm's model id, never typed)
 * and Anthropic, and says nothing has been sent yet: the text goes only when the approver presses the button.
 */
export function ruleDraftFormDisclosure(model: string): string {
  return `Nothing is sent until you press Draft rules. Then the grant text above goes to Anthropic, and ${modelFullName(model)} drafts the rules for you to review.`;
}

/**
 * IAC-440 Package B: the disclosure line of a review screen, from the model stored with the draft. An edited draft stores no model: a person made it and no
 * request was sent, so it says that. A null model on a draft that was not edited gives the same plain statement of what is known.
 */
export function ruleDraftReviewDisclosure(model: string | null): string {
  return model === null
    ? "A person edited this draft. Saving the edit sent nothing to Anthropic."
    : `Drafted by ${modelFullName(model)}. The grant text was sent to Anthropic. The AI drafts only: it cannot approve or change a rule.`;
}
