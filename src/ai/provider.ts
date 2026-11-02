import { ReceiptAiError } from "./receipt";
import { CLAUDE_NAMES, CLAUDE_SHELL_NAMES, type AnyReceiptCategorizer } from "./audit";
import { ReceiptAiConfigError, createClaudeReceiptCategorizer, resolveClaudeModel, type ClaudeMessagesClient, type ClaudeModel, type ClaudeReceiptCategorizer } from "./claude-receipt";
import { CLAUDE_LIMIT_MESSAGE, processClaudeBudget, type ClaudeBudget } from "./budget";

// Claude only (docs/plans/CLAUDE_ONLY_SCOPE.md). The one provider is the hosted Claude API. AIDTRACE_RECEIPT_AI_PROVIDER stays,
// but it accepts only "claude" (or unset). It stays so a stale value such as the retired "local" stops AI with a refusal instead
// of being ignored: an ignored value would send receipt text to Anthropic when the operator asked for something else.
export const RECEIPT_AI_PROVIDERS = ["claude"] as const;
export type ReceiptAiProvider = typeof RECEIPT_AI_PROVIDERS[number];
type Env = Record<string, string | undefined>;

// Unset means claude. Any other value must match exactly, including a blank one: a typo must stop AI, never choose silently.
export function resolveReceiptAiProvider(env: Env): ReceiptAiProvider {
  const value = env.AIDTRACE_RECEIPT_AI_PROVIDER;
  if (value === undefined) return "claude";
  const match = RECEIPT_AI_PROVIDERS.find(provider => provider === value);
  if (!match) throw new ReceiptAiConfigError(`AIDTRACE_RECEIPT_AI_PROVIDER must be exactly: ${RECEIPT_AI_PROVIDERS.join(", ")}`);
  return match;
}

export type SelectedReceiptCategorizer = { provider: "claude"; model: ClaudeModel; categorize: ClaudeReceiptCategorizer };

// One shared Claude categorizer per model keeps the per-process single-flight guard in force.
const shared = new Map<ClaudeModel, ClaudeReceiptCategorizer>();
export function selectReceiptCategorizer(env: Env = process.env, deps: { client?: ClaudeMessagesClient; budget?: ClaudeBudget } = {}): SelectedReceiptCategorizer {
  resolveReceiptAiProvider(env);
  const model = resolveClaudeModel(env);
  if (env !== process.env || deps.client || deps.budget) return { provider: "claude", model, categorize: createClaudeReceiptCategorizer({ env, client: deps.client, budget: deps.budget }) };
  let categorize = shared.get(model);
  if (!categorize) { categorize = createClaudeReceiptCategorizer({ env }); shared.set(model, categorize); }
  return { provider: "claude", model, categorize };
}

const unavailable: AnyReceiptCategorizer = async () => { throw new ReceiptAiError("UNAVAILABLE"); };
// Default categorizer for the receipt and preparation actions. AI_RECEIPT_ENABLED === "true" stays the master switch.
// An invalid provider or model value never selects anything: it logs the error class name only (never the env value) and
// returns a categorizer that refuses with UNAVAILABLE before any model call, which is the failure the claimant already sees
// when AI is off. A missing key and the process-wide request cap refuse the same way inside the Claude categorizer.
export function defaultReceiptCategorizer(env: Env = process.env): AnyReceiptCategorizer {
  if (env.AI_RECEIPT_ENABLED !== "true") return unavailable;
  try { return selectReceiptCategorizer(env).categorize; }
  catch (error) {
    console.error("Receipt AI provider configuration refused:", error instanceof Error ? error.name : "UnknownError");
    return unavailable;
  }
}

// Why AI is off, for the page and the shell. Fixed messages only.
export type AiOffReason = "SWITCHED_OFF" | "NO_KEY" | "LIMIT";
export const AI_OFF_MESSAGES: Record<AiOffReason, string> = {
  NO_KEY: "AI suggestions are off in this session: no AI key is configured.",
  LIMIT: CLAUDE_LIMIT_MESSAGE,
  SWITCHED_OFF: "AI suggestions are switched off in this session.",
};
export type AiStatus = { on: true; model: ClaudeModel; name: string; shellName: string } | { on: false; reason: AiOffReason };
// AI_COMPLIANCE_ENABLED (IAC-405 piece G) gates the approver's model compliance check. Off by default like the others.
// AI_RULE_DRAFTS_ENABLED (IAC-440 Package A) gates the approver's AI-drafted fund rules request. Off by default and in every compose file.
export type AiFlag = "AI_RECEIPT_ENABLED" | "AI_ANALYTICS_ENABLED" | "AI_EXPENSE_PROPOSALS_ENABLED" | "AI_COMPLIANCE_ENABLED" | "AI_RULE_DRAFTS_ENABLED";

// Display and gating: is Claude usable for this surface right now? On only with the surface's flag, a valid configuration, a
// key present in this process and request budget left. It reads the key's presence only, never its value.
export function claudeAiStatus(env: Env = process.env, flag: AiFlag = "AI_RECEIPT_ENABLED", budget: ClaudeBudget = processClaudeBudget): AiStatus {
  if (env[flag] !== "true") return { on: false, reason: "SWITCHED_OFF" };
  let model: ClaudeModel;
  try { resolveReceiptAiProvider(env); model = resolveClaudeModel(env); }
  catch { return { on: false, reason: "SWITCHED_OFF" }; }
  if (!env.ANTHROPIC_API_KEY?.trim()) return { on: false, reason: "NO_KEY" };
  if (budget.exhausted()) return { on: false, reason: "LIMIT" };
  return { on: true, model, name: CLAUDE_NAMES[model], shellName: CLAUDE_SHELL_NAMES[model] };
}
export const receiptAiStatus = (env: Env = process.env) => claudeAiStatus(env, "AI_RECEIPT_ENABLED");

// Display only: the model a new suggestion request would use, for the receipt page before any suggestion exists. A saved
// suggestion is always named from its own stored audit (src/ai/audit.ts), never from this. Null when AI is off.
export function configuredReceiptAiName(env: Env = process.env): { name: string; shellName: string } | null {
  const status = receiptAiStatus(env);
  return status.on ? { name: status.name, shellName: status.shellName } : null;
}
