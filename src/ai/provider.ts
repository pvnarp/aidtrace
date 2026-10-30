import { localReceiptCategorizer, type createReceiptCategorizer } from "./receipt";
import { ReceiptAiConfigError, createClaudeReceiptCategorizer, resolveClaudeModel, type ClaudeMessagesClient, type ClaudeModel, type ClaudeReceiptCategorizer } from "./claude-receipt";

// IAC-383 provider switch. Nothing in the application imports this module yet: wiring it
// into receipt persistence is blocked by the gap recorded in docs/GATE_REPORT.md.
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
