import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_PROMPT_VERSION, CLAUDE_SCHEMA_VERSION, createClaudeReceiptCategorizer, type ClaudeAudit, type ClaudeMessagesClient, type ClaudeModel, type ClaudeReceiptCategorizer, type ClaudeReceiptResult } from "../../src/ai/claude-receipt";
import { createClaudeBudget, type ClaudeBudget } from "../../src/ai/budget";
import { validateProposals, type ReceiptInput } from "../../src/ai/receipt";

// Shared test seams for the Claude only AI (docs/plans/CLAUDE_ONLY_SCOPE.md). Nothing here imports vitest, so a child process
// worker may use it too. No helper calls the Anthropic API: every categorizer is built from a stub client or returns a canned
// result. The key is a fake string that only proves it never reaches a result, an error or a log.
export const FAKE_KEY = "sk-ant-api03-FAKE-TEST-KEY-NOT-REAL-0000";
export const FAKE_ENV = { ANTHROPIC_API_KEY: FAKE_KEY };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// A valid stored Claude audit for the given receipt text (the shape storedReceiptAudit accepts).
export function claudeAudit(source: string, over: Partial<ClaudeAudit> = {}): ClaudeAudit {
  return { provider: "claude", model: "claude-haiku-5-5", responseModel: "claude-haiku-5-5", effort: "low", promptVersion: CLAUDE_PROMPT_VERSION,
    schemaVersion: CLAUDE_SCHEMA_VERSION, sourceSha256: sha(source), requestSha256: "a".repeat(64), responseSha256: "b".repeat(64), latencyMs: 1,
    inputTokens: 10, outputTokens: 5, ...over };
}

// A categorizer that never touches a client: it validates the proposals exactly like the real one and returns a valid audit.
export function cannedCategorizer(proposalsFor: (input: ReceiptInput) => unknown[], over: Partial<ClaudeAudit> = {}): ClaudeReceiptCategorizer {
  return async (input): Promise<ClaudeReceiptResult> => ({ proposals: validateProposals(input, { proposals: proposalsFor(input) }), audit: claudeAudit(input.source, over) });
}

// An Anthropic Message as the API would return it for a structured output.
export function claudeMessage(value: unknown, model: string = "claude-haiku-5-5", over: Record<string, unknown> = {}): Anthropic.Message {
  return { id: "msg_stub", type: "message", role: "assistant", model, stop_reason: "end_turn", stop_sequence: null,
    content: [{ type: "text", text: JSON.stringify(value) }], usage: { input_tokens: 812, output_tokens: 57 }, ...over } as unknown as Anthropic.Message;
}

type Create = ClaudeMessagesClient["messages"]["create"];
// A stub client that records every call. The default handler answers every call with the same message.
export function stubClient(handler: (...args: Parameters<Create>) => PromiseLike<Anthropic.Message> | Anthropic.Message) {
  const calls: Parameters<Create>[] = [];
  const client: ClaudeMessagesClient = { messages: { create: async (...args) => { calls.push(args); return await handler(...args); } } };
  return { client, calls };
}

// The real Claude categorizer over a stub client, with its own budget so tests never share the process-wide count.
export function stubbedClaudeCategorizer(handler: (...args: Parameters<Create>) => PromiseLike<Anthropic.Message> | Anthropic.Message, options: { model?: ClaudeModel; budget?: ClaudeBudget } = {}) {
  const stub = stubClient(handler);
  const env: Record<string, string> = { ...FAKE_ENV, ...(options.model ? { AIDTRACE_CLAUDE_MODEL: options.model } : {}) };
  return { ...stub, categorize: createClaudeReceiptCategorizer({ env, client: stub.client, budget: options.budget ?? createClaudeBudget() }) };
}

// Fixtures for historical rows written before the move to Claude only. Rows with provider "local" still exist in older databases
// and must keep reading, so tests insert them directly. Nothing writes them any more.
export const RETIRED_MODEL_SHA256 = "061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a";
export const RETIRED_MODEL_REVISION = "90862c4b9d2787eaed51d12237eafdfe7c5f6077";
