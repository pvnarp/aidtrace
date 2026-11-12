// Process-wide hard cap on hosted Claude requests.
// One counter covers receipt, preparation and analytics calls. The cap is a constant on purpose:
// no environment variable, setting or request can raise it, and nothing resets it except a
// process restart. The counter lives on globalThis under a registered symbol so that bundles
// which load this module twice still share one count.
export const CLAUDE_REQUEST_CAP = 60;
export const CLAUDE_LIMIT_MESSAGE = `AI suggestions are off for this process: the limit of ${CLAUDE_REQUEST_CAP} AI requests was reached. Review manually.`;

export type ClaudeBudget = { readonly cap: number; reserve(): boolean; used(): number; exhausted(): boolean };

// The cap is a parameter only so unit tests can use a small one. Production code never passes it.
export function createClaudeBudget(cap: number = CLAUDE_REQUEST_CAP): ClaudeBudget {
  let used = 0;
  return {
    cap,
    // Counts a request when it is about to be sent, so a failed or refused call still counts.
    reserve() { if (used >= cap) return false; used += 1; return true; },
    used: () => used,
    exhausted: () => used >= cap,
  };
}

const KEY = Symbol.for("aidtrace.claude.request-budget");
type Holder = { [KEY]?: ClaudeBudget };
const holder = globalThis as unknown as Holder;
export const processClaudeBudget: ClaudeBudget = holder[KEY] ??= createClaudeBudget();
