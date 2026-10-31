import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReceiptInput } from "../src/ai/receipt";

// CAI-27 to CAI-29: IAC-383 default categorizer selection for both receipt actions, stubbed
// evidence only. Claude is the only provider, so there is no fallback to observe: a refusal must make no request at all,
// and global fetch is the only network path the Claude SDK can reach, so it is stubbed.
import { defaultReceiptCategorizer } from "../src/ai/provider";

const KEY = "sk-ant-api03-FAKE-TEST-KEY-NOT-REAL-0000";
const input: ReceiptInput = { source: "INVENTED RECEIPT\nScience experiment kits\n", lines: [{ id: "L1", description: "Science kits" }] };
const message = (model = "claude-haiku-5-5") => ({ id: "msg_stub", type: "message", role: "assistant", model, stop_reason: "end_turn", stop_sequence: null,
  content: [{ type: "text", text: JSON.stringify({ proposals: [{ lineId: "L1", category: "robot_kits_parts", quote: "Science experiment kits" }] }) }], usage: { input_tokens: 10, output_tokens: 5 } }) as unknown as Anthropic.Message;
let fetchStub: ReturnType<typeof vi.fn>; let logs: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  fetchStub = vi.fn(async () => new Response(JSON.stringify(message()), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchStub);
  logs = (["log", "info", "warn", "error", "debug"] as const).map(name => vi.spyOn(console, name).mockImplementation(() => {}));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("CAI-27 an unset provider means Claude, and AI_RECEIPT_ENABLED stays the master switch for every provider value", async () => {
  await defaultReceiptCategorizer({ AI_RECEIPT_ENABLED: "true", ANTHROPIC_API_KEY: KEY })(input);
  expect(fetchStub).toHaveBeenCalledTimes(1); fetchStub.mockClear();
  for (const enabled of [undefined, "false", "TRUE", "true ", "1", ""]) {
    for (const provider of [undefined, "claude"]) {
      await expect(defaultReceiptCategorizer({ AI_RECEIPT_ENABLED: enabled, AIDTRACE_RECEIPT_AI_PROVIDER: provider, ANTHROPIC_API_KEY: KEY })(input), `${enabled}/${provider}`).rejects.toMatchObject({ code: "UNAVAILABLE" });
    }
  }
  expect(fetchStub).not.toHaveBeenCalled();
  // Disabled AI does not even read the provider value, so it logs nothing.
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});

it("CAI-28 an invalid provider or model never falls back to the other provider, makes no model call and logs only an error class name", async () => {
  const secret = "sk-ant-api03-SECRET-IN-WRONG-VARIABLE";
  const cases: Record<string, string>[] = [
    { AIDTRACE_RECEIPT_AI_PROVIDER: "Claude" }, { AIDTRACE_RECEIPT_AI_PROVIDER: "local" }, { AIDTRACE_RECEIPT_AI_PROVIDER: "claude " }, { AIDTRACE_RECEIPT_AI_PROVIDER: "" }, { AIDTRACE_RECEIPT_AI_PROVIDER: "openai" }, { AIDTRACE_RECEIPT_AI_PROVIDER: secret },
    { AIDTRACE_RECEIPT_AI_PROVIDER: "claude", AIDTRACE_CLAUDE_MODEL: "claude-opus-5-5" }, { AIDTRACE_RECEIPT_AI_PROVIDER: "claude", AIDTRACE_CLAUDE_MODEL: "" },
    { AIDTRACE_RECEIPT_AI_PROVIDER: "claude", AIDTRACE_CLAUDE_MODEL: secret },
  ];
  for (const vars of cases) {
    const categorize = defaultReceiptCategorizer({ AI_RECEIPT_ENABLED: "true", ANTHROPIC_API_KEY: KEY, ...vars });
    await expect(categorize(input), JSON.stringify(Object.keys(vars))).rejects.toMatchObject({ code: "UNAVAILABLE" });
  }
  expect(fetchStub).not.toHaveBeenCalled();
  const logged = logs.flatMap(log => log.mock.calls);
  expect(logged).toHaveLength(cases.length);
  for (const call of logged) { expect(call).toHaveLength(2); expect(typeof call[0]).toBe("string"); expect(call[1]).toBe("ReceiptAiConfigError"); }
  const text = JSON.stringify(logged);
  for (const value of [secret, KEY, "openai", "claude-opus-5-5", "Claude", "local"]) expect(text).not.toContain(value);
});

it("CAI-29 a valid Claude selection makes exactly one stubbed request, and times out before the 65000 ms RUNNING window", async () => {
  const categorize = defaultReceiptCategorizer({ AI_RECEIPT_ENABLED: "true", AIDTRACE_RECEIPT_AI_PROVIDER: "claude", ANTHROPIC_API_KEY: KEY });
  const result = await categorize(input);
  expect(result.audit).toMatchObject({ provider: "claude", model: "claude-haiku-5-5" });
  expect(fetchStub).toHaveBeenCalledTimes(1); expect(new URL(String(fetchStub.mock.calls[0]![0])).origin).toBe("https://api.anthropic.com");
  const sonnet = defaultReceiptCategorizer({ AI_RECEIPT_ENABLED: "true", AIDTRACE_RECEIPT_AI_PROVIDER: "claude", AIDTRACE_CLAUDE_MODEL: "claude-sonnet-5-5", ANTHROPIC_API_KEY: KEY });
  fetchStub.mockImplementation(async () => new Response(JSON.stringify(message("claude-sonnet-5-5")), { status: 200, headers: { "content-type": "application/json" } }));
  expect((await sonnet(input)).audit).toMatchObject({ provider: "claude", model: "claude-sonnet-5-5" });
  // Timeout: a request that never answers is aborted at 60000 ms, 5000 ms before suggestReceipt
  // and prepareExpenseProposal treat a RUNNING attempt as abandoned (65000 ms).
  vi.useFakeTimers();
  fetchStub.mockImplementation((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))); }));
  const hung = defaultReceiptCategorizer({ AI_RECEIPT_ENABLED: "true", AIDTRACE_RECEIPT_AI_PROVIDER: "claude", ANTHROPIC_API_KEY: KEY });
  let settled: unknown; const pending = hung(input).then(() => { settled = "resolved"; }, error => { settled = error; });
  await vi.advanceTimersByTimeAsync(59999); expect(settled).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1); await pending;
  expect(settled).toMatchObject({ code: "TIMEOUT" });
  expect(60000).toBeLessThan(65000);
});
