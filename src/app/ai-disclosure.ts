import { CLAUDE_NAMES } from "../ai/audit";

// IAC-416 PR 2 (Pavan, November 1: "we need to just say AI"): running copy says "AI". November 5 amendment (Pavan: "We should mention 'Powered by [insert model name]'
// whenever a specific model is used ... Call it out."): every place a model's output is shown, or a request is about to be sent, carries one line that starts
// "Powered by " and names each model that was or will be sent a request. The names come only from the stored model ids through CLAUDE_NAMES, never from page code.
// The Anthropic data-sent sentences stay and sit in the same line as the "Powered by" sentence.

/** Joins display names: "A", "A and B", "A, B and C". */
const joinNames = (names: readonly string[]) => names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
const KNOWN_NAMES = new Set<string>(Object.values(CLAUDE_NAMES));

/**
 * "Powered by Claude Haiku 5.5." for display names that came from CLAUDE_NAMES (a saved audit or the configured status). Names each once, in first-seen order.
 * An empty list gives an empty string, and so does any name that is not in the table: a model that cannot be named exactly is not guessed at, and the caller renders nothing.
 */
export function poweredByNames(names: readonly string[]): string {
  const unique = [...new Set(names)];
  if (unique.length === 0 || unique.some(name => !KNOWN_NAMES.has(name))) return "";
  return `Powered by ${joinNames(unique)}.`;
}

/**
 * The one "Powered by" line builder, from stored model ids. A caller passes only the models that were sent a request: a pair refused by the request limit sent
 * nothing, so its model is not passed. Duplicates collapse, first-seen order stays. An empty list or an unknown id gives an empty string.
 */
export function poweredByLine(models: readonly string[]): string {
  const names: string[] = [];
  for (const id of models) {
    const name = (CLAUDE_NAMES as Record<string, string | undefined>)[id];
    if (!name) return "";
    names.push(name);
  }
  return poweredByNames(names);
}

/** Puts the "Powered by" sentence first and the data-sent sentence after it. With no model to name, the data-sent sentence stands alone. */
const withPoweredBy = (poweredBy: string, rest: string) => poweredBy ? `${poweredBy} ${rest}` : rest;

/**
 * The one provider disclosure line of the claim page's model check section. It starts with "Powered by", names each model that was sent a request once, in
 * first-seen order, built from the stored CALL rows, and says the claim line and clause text went to Anthropic. An empty list gives an empty string, and the
 * caller renders nothing.
 */
export function modelCheckDisclosure(models: readonly string[]): string {
  const line = poweredByLine(models);
  return line ? `${line} Claim line and clause text was sent to Anthropic.` : "";
}

/**
 * IAC-440 Package B: the disclosure line above the "Draft rules" button. It starts with "Powered by" and names the model a new draft would use (built from the
 * arm's model id, never typed) and Anthropic, and says nothing has been sent yet: the text goes only when the approver presses the button.
 */
export function ruleDraftFormDisclosure(model: string): string {
  return withPoweredBy(poweredByLine([model]), "Nothing is sent until you press Draft rules. Then the grant text above goes to Anthropic for the draft, which you review.");
}

/**
 * IAC-440 Package B: the disclosure line of a review screen, from the model stored with the draft. An edited draft stores no model: a person made it and no
 * request was sent, so it says that and carries no "Powered by" line. A null model on a draft that was not edited gives the same plain statement of what is known.
 */
export function ruleDraftReviewDisclosure(model: string | null): string {
  if (model === null) return "A person edited this draft. Saving the edit sent nothing to Anthropic.";
  return withPoweredBy(poweredByLine([model]), "The grant text was sent to Anthropic. The AI drafts only: it cannot approve or change a rule.");
}
