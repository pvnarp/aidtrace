import Anthropic from "@anthropic-ai/sdk";

// The one place a Claude client is built (receipt, preparation and analytics all use it).
// Fixed endpoint: the SDK would otherwise honor ANTHROPIC_BASE_URL and send the key there.
export const CLAUDE_BASE_URL = "https://api.anthropic.com";
export const CLAUDE_TIMEOUT_MS = 60000;

export type ClaudeRequest = Anthropic.MessageCreateParamsNonStreaming;
export type ClaudeRequestOptions = { timeout?: number; maxRetries?: number; signal?: AbortSignal };
// The part of the SDK client the app uses. Tests inject a stub with this shape.
export type ClaudeMessagesClient = { messages: { create(body: ClaudeRequest, options?: ClaudeRequestOptions): PromiseLike<Anthropic.Message> } };
type Env = Record<string, string | undefined>;

// No retries, no logging of headers, no telemetry, and never a base URL from the environment.
export function realClaudeClient(key: string): ClaudeMessagesClient {
  return new Anthropic({ apiKey: key, baseURL: CLAUDE_BASE_URL, maxRetries: 0, timeout: CLAUDE_TIMEOUT_MS, logLevel: "off", openTelemetry: false });
}

// UI test container only. compose.ui.yaml is the single file that sets UI_TEST_CONTAINER. The stub never
// sees the key and only talks to a loopback listener owned by the Playwright process in the same container.
export const UI_TEST_STUB_URL = "http://127.0.0.1:8080/v1/messages";
const uiTestClient: ClaudeMessagesClient = { messages: { async create(body, options) {
  const response = await fetch(UI_TEST_STUB_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: options?.signal });
  if (!response.ok) { await response.body?.cancel(); throw new Error("UI test stub unavailable"); }
  return await response.json() as Anthropic.Message;
} } };

export function claudeClientFor(key: string, env: Env = process.env): ClaudeMessagesClient {
  if (env.UI_TEST_CONTAINER === "true") return uiTestClient;
  // A fresh client per request is cheap and keeps the key out of any long-lived module state.
  return realClaudeClient(key);
}
