import { ReceiptAiError, localReceiptCategorizer, type createReceiptCategorizer } from "./receipt";
import type { AnyReceiptCategorizer } from "./audit";
import { ReceiptAiConfigError, createClaudeReceiptCategorizer, resolveClaudeModel, type ClaudeMessagesClient, type ClaudeModel, type ClaudeReceiptCategorizer } from "./claude-receipt";

// IAC-383 provider switch. defaultReceiptCategorizer below is the default for both receipt
// actions, and suggestReceipt stores the categorizer's own provider-tagged audit (src/ai/audit.ts).
export const RECEIPT_AI_PROVIDERS = ["local", "claude"] as const;
export type ReceiptAiProvider = typeof RECEIPT_AI_PROVIDERS[number];
type Env = Record<string, string | undefined>;

// Unset means local. Any other value must match exactly, including a blank one: a typo
// must stop startup, never choose a provider silently.
export function resolveReceiptAiProvider(env: Env): ReceiptAiProvider {
  const value = env.AIDTRACE_RECEIPT_AI_PROVIDER;
  if (value === undefined) return "local";
  const match = RECEIPT_AI_PROVIDERS.find(provider => provider === value);
  if (!match) throw new ReceiptAiConfigError(`AIDTRACE_RECEIPT_AI_PROVIDER must be exactly one of: ${RECEIPT_AI_PROVIDERS.join(", ")}`);
  return match;
}

export type SelectedReceiptCategorizer =
  | { provider: "local"; categorize: ReturnType<typeof createReceiptCategorizer> }
  | { provider: "claude"; model: ClaudeModel; categorize: ClaudeReceiptCategorizer };

// One shared Claude categorizer per model keeps the per-process single-flight guard in force.
const shared = new Map<ClaudeModel, ClaudeReceiptCategorizer>();
export function selectReceiptCategorizer(env: Env = process.env, deps: { local?: ReturnType<typeof createReceiptCategorizer>; client?: ClaudeMessagesClient } = {}): SelectedReceiptCategorizer {
  if (resolveReceiptAiProvider(env) === "local") return { provider: "local", categorize: deps.local ?? localReceiptCategorizer };
  const model = resolveClaudeModel(env);
  if (env !== process.env || deps.client) return { provider: "claude", model, categorize: createClaudeReceiptCategorizer({ env, client: deps.client }) };
  let categorize = shared.get(model);
  if (!categorize) { categorize = createClaudeReceiptCategorizer({ env }); shared.set(model, categorize); }
  return { provider: "claude", model, categorize };
}

const unavailable: AnyReceiptCategorizer = async () => { throw new ReceiptAiError("UNAVAILABLE"); };
// Default categorizer for the receipt and preparation actions. AI_RECEIPT_ENABLED === "true"
// stays the master switch for every provider. An invalid provider or model value never falls
// back to the other provider: it logs the error class name only (never the env value) and
// returns a categorizer that refuses with UNAVAILABLE before any model call, which is the
// failure the claimant already sees when AI is off or the model is down.
export function defaultReceiptCategorizer(env: Env = process.env): AnyReceiptCategorizer {
  if (env.AI_RECEIPT_ENABLED !== "true") return unavailable;
  try { return selectReceiptCategorizer(env).categorize; }
  catch (error) {
    console.error("Receipt AI provider configuration refused:", error instanceof Error ? error.name : "UnknownError");
    return unavailable;
  }
}
