/**
 * The thread (November 10 judge thread): who acts next, and how to become that person.
 * Pure functions. Every name comes from saved state the page already loaded (the organization's approvers, the claim's approvals),
 * never from a typed constant and never from the query string except through validAs. Nothing here stores, grants or approves anything.
 */

/** The same username shape src/server/auth.ts accepts at sign-in. A value that does not match is ignored, so ?as= can never reach the page as markup. */
export const USERNAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** The username to prefill on /login, or null. An array (two ?as= values) or any other shape is ignored. */
export function validAs(value: string | string[] | undefined): string | null {
  return typeof value === "string" && USERNAME_PATTERN.test(value) ? value : null;
}

export const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export type Person = { id: string; username: string; displayName: string };

export const firstName = (displayName: string) => displayName.trim().split(/\s+/)[0] || displayName;

/** The organization's approvers who could still act on this claim: not the claimant, not anyone who already approved it. Order is kept. */
export function remainingApprovers(approvers: readonly Person[], claimantId: string, approvedIds: readonly string[]): Person[] {
  return approvers.filter(person => person.id !== claimantId && !approvedIds.includes(person.id));
}

export type Handoff = { username: string | null; label: string };
export type Thread = { actor: string; handoff?: Handoff };

export type ThreadInput = {
  status: string;
  /** The viewer is the claim's claimant. */
  claimant: boolean;
  /** The viewer is an approver who is not the claimant. */
  approver: boolean;
  approvedByMe: boolean;
  feasible: boolean;
  policyBlocked: boolean;
  /** Display name of the viewer. */
  viewerName: string;
  /** remainingApprovers(...) for this claim. */
  remaining: readonly Person[];
};

const label = (name: string) => `Sign out and continue as ${name}`;

/**
 * The actor line and the handoff for the Next decision card. Null where the card needs no line (payment states).
 * A handoff names a person only when the loaded data names exactly one (or, for the claimant, the first of the remaining approvers);
 * with none or several after an approval it says "another approver" and opens plain sign-in.
 */
export function threadFor(input: ThreadInput): Thread | null {
  const me = firstName(input.viewerName);
  if (input.status === "DRAFT") {
    if (input.policyBlocked) return input.claimant ? { actor: `Your move, ${me}. Correct the receipt.` } : null;
    if (!input.claimant) return { actor: "The claimant acts first." };
    return { actor: input.feasible ? `Your move, ${me}. Rules computed this split.` : `Your move, ${me}.` };
  }
  if (input.status !== "AWAITING_APPROVAL") return null;
  const names = input.remaining.map(person => firstName(person.displayName));
  if (input.claimant) {
    const who = names.length === 1 ? `${names[0]} acts next.` : names.length === 2 ? `${names[0]} and ${names[1]} act next.` : "Approvers act next.";
    const first = input.remaining[0];
    return { actor: who, ...(first ? { handoff: { username: first.username, label: label(names[0]!) } } : {}) };
  }
  if (input.approver && !input.approvedByMe) return { actor: `Your move, ${me}. Run the checks, then approve.` };
  if (input.approver && input.approvedByMe) {
    const one = input.remaining.length === 1 ? input.remaining[0]! : null;
    return { actor: `${one ? firstName(one.displayName) : "Another approver"} acts next.`,
      handoff: one ? { username: one.username, label: label(firstName(one.displayName)) } : { username: null, label: label("another approver") } };
  }
  return null;
}

/** The sign-in address a handoff opens. Always /login: a username only travels as the validated ?as= value. */
export function handoffTarget(username: string | null): string {
  return username !== null && USERNAME_PATTERN.test(username) ? `/login?as=${encodeURIComponent(username)}` : "/login";
}

/** The one line above Approve: what the stored policy check run says, from the data the claim page already loads. Approve never waits on it. */
export function checksStatus(run: { flags: readonly unknown[] } | null | undefined): string {
  if (!run) return "Checks not run yet.";
  return run.flags.length === 0 ? "Checks run: no flags." : `Checks run: ${run.flags.length} ${run.flags.length === 1 ? "flag" : "flags"}.`;
}
