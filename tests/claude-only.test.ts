import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, appendFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CLAUDE_LIMIT_MESSAGE, CLAUDE_REQUEST_CAP, createClaudeBudget, processClaudeBudget } from "../src/ai/budget";
import { CLAUDE_BASE_URL, UI_TEST_STUB_URL, claudeClientFor, realClaudeClient } from "../src/ai/claude-client";
import { ReceiptAiConfigError, createClaudeReceiptCategorizer } from "../src/ai/claude-receipt";
import { AI_OFF_MESSAGES, claudeAiStatus, defaultReceiptCategorizer, resolveReceiptAiProvider, selectReceiptCategorizer } from "../src/ai/provider";
import type { ReceiptInput } from "../src/ai/receipt";
import { AnalyticsModelError, analyticsRequest, createAnalyticsSelector } from "../src/analytics/explain";
import type { AnalyticsSnapshot } from "../src/analytics/model";
import { FOOTER_PROMISE, shellWording } from "../src/app/shell-copy";
import { FAKE_ENV, FAKE_KEY, claudeMessage, stubClient } from "./support/claude-stub";

// CLA-01 to CLA-14: Claude only AI. No test here reaches the Anthropic API: every call goes
// through a stub client or a stubbed global fetch, and the key is a fake string.
const input: ReceiptInput = { source: "INVENTED RECEIPT\nScience experiment kits\nNotebooks\n", lines: [{ id: "L1", description: "Science kits" }, { id: "L2", description: "Notebooks" }] };
const good = () => claudeMessage({ proposals: [{ lineId: "L1", category: "robot_kits_parts", quote: "Science experiment kits" }, { lineId: "L2", category: "classroom_supplies", quote: "Notebooks" }] });
const snapshot: AnalyticsSnapshot = {
  digest: "d".repeat(64), observedAt: "2026-10-30T00:00:00.000Z", source: "LOCAL_APPLICATION_DATABASE", organization: "cedar-hollow", fixture: true, matches: true,
  funds: [], cash: { openingCents: "0", providerDeltaCents: "0", bookCents: "0", payableCents: "0" },
  facts: [
    { id: "restricted", text: "Restricted funds hold 43000 cents.", source: "ledger" }, { id: "general", text: "General funds hold 7000 cents.", source: "ledger" },
    { id: "reserved", text: "Reserved 0 cents.", source: "ledger" }, { id: "availability", text: "Available 50000 cents.", source: "ledger" },
    { id: "payable", text: "Payable 0 cents.", source: "ledger" },
  ],
};
let fetchStub: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchStub = vi.fn(async () => new Response(JSON.stringify(good()), { status: 200, headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", fetchStub); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("provider selection", () => {
  it("CLA-01 an unset provider is claude, claude is accepted, and every other value refuses without echoing it", () => {
    expect(resolveReceiptAiProvider({})).toBe("claude"); expect(resolveReceiptAiProvider({ AIDTRACE_RECEIPT_AI_PROVIDER: "claude" })).toBe("claude");
    for (const value of ["local", "Claude", "claude ", "", " ", "openai", "sk-ant-api03-LEAKED-VALUE-0000"]) {
      let error: unknown; try { resolveReceiptAiProvider({ AIDTRACE_RECEIPT_AI_PROVIDER: value }); } catch (caught) { error = caught; }
      expect(error, JSON.stringify(value)).toBeInstanceOf(ReceiptAiConfigError);
      expect((error as Error).message).toBe("AIDTRACE_RECEIPT_AI_PROVIDER must be exactly: claude");
    }
    const { client } = stubClient(() => good());
    expect(selectReceiptCategorizer({ ...FAKE_ENV }, { client }).provider).toBe("claude");
    expect(() => selectReceiptCategorizer({ ...FAKE_ENV, AIDTRACE_RECEIPT_AI_PROVIDER: "local" }, { client })).toThrow(ReceiptAiConfigError);
  });
  it("CLA-02 the default categorizer refuses an unknown provider or model before any request and logs only the error class", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const env of [{ AIDTRACE_RECEIPT_AI_PROVIDER: "local" }, { AIDTRACE_RECEIPT_AI_PROVIDER: "claude-ish" }, { AIDTRACE_CLAUDE_MODEL: "qwen" }]) {
      await expect(defaultReceiptCategorizer({ AI_RECEIPT_ENABLED: "true", ANTHROPIC_API_KEY: FAKE_KEY, ...env })(input)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    }
    expect(fetchStub).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().join(" ")).not.toContain(FAKE_KEY); expect(errors.mock.calls.every(call => call.length === 2 && call[1] === "ReceiptAiConfigError")).toBe(true);
  });
});

describe("AI off without a key", () => {
  it("CLA-03 every surface reports AI off with the fixed message, whitespace is no key, and the master switch still wins", () => {
    for (const flag of ["AI_RECEIPT_ENABLED", "AI_ANALYTICS_ENABLED", "AI_EXPENSE_PROPOSALS_ENABLED"] as const) {
      for (const key of [undefined, "", "   "]) expect(claudeAiStatus({ [flag]: "true", ANTHROPIC_API_KEY: key }, flag, createClaudeBudget()), `${flag}/${JSON.stringify(key)}`).toEqual({ on: false, reason: "NO_KEY" });
      expect(claudeAiStatus({ [flag]: "true", ...FAKE_ENV }, flag, createClaudeBudget())).toMatchObject({ on: true, model: "claude-haiku-5-5", name: "Claude Haiku 5.5", shellName: "Claude Haiku" });
      expect(claudeAiStatus({ [flag]: "false", ...FAKE_ENV }, flag, createClaudeBudget())).toEqual({ on: false, reason: "SWITCHED_OFF" });
      expect(claudeAiStatus({ ...FAKE_ENV }, flag, createClaudeBudget())).toEqual({ on: false, reason: "SWITCHED_OFF" });
    }
    expect(AI_OFF_MESSAGES.NO_KEY).toBe("AI suggestions are off in this session: no AI key is configured.");
    expect(claudeAiStatus({ AI_RECEIPT_ENABLED: "true", ...FAKE_ENV, AIDTRACE_RECEIPT_AI_PROVIDER: "local" })).toEqual({ on: false, reason: "SWITCHED_OFF" });
  });
  it("CLA-04 with no key the receipt categorizer, the default categorizer and the analytics selector make no request", async () => {
    const { client, calls } = stubClient(() => good());
    for (const env of [{}, { ANTHROPIC_API_KEY: "" }, { ANTHROPIC_API_KEY: "  " }]) {
      await expect(createClaudeReceiptCategorizer({ env, client })(input)).rejects.toMatchObject({ code: "UNAVAILABLE" });
      await expect(defaultReceiptCategorizer({ AI_RECEIPT_ENABLED: "true", ...env })(input)).rejects.toMatchObject({ code: "UNAVAILABLE" });
      await expect(createAnalyticsSelector({ env, client })(snapshot, "funding")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    }
    expect(calls).toHaveLength(0); expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("spend cap", () => {
  it("CLA-05 the process-wide cap is the constant 60 and no environment variable can raise it", async () => {
    expect(CLAUDE_REQUEST_CAP).toBe(60); expect(processClaudeBudget.cap).toBe(60); expect(createClaudeBudget().cap).toBe(60);
    expect(CLAUDE_LIMIT_MESSAGE).toBe("AI suggestions are off for this process: the limit of 60 AI requests was reached. Review manually.");
    for (const name of ["AIDTRACE_CLAUDE_REQUEST_CAP", "CLAUDE_REQUEST_CAP", "AIDTRACE_AI_BUDGET", "AI_REQUEST_CAP", "MAX_CLAUDE_REQUESTS"]) vi.stubEnv(name, "100000");
    vi.resetModules(); const again = await import("../src/ai/budget");
    expect(again.CLAUDE_REQUEST_CAP).toBe(60); expect(again.createClaudeBudget().cap).toBe(60);
    // One shared counter even when the module loads twice (separate bundles), and the module reads no environment at all.
    expect(again.processClaudeBudget).toBe(processClaudeBudget);
    expect(readFileSync("src/ai/budget.ts", "utf8")).not.toMatch(/process\.env|\benv\b/);
    const budget = createClaudeBudget(); for (let i = 0; i < 60; i++) expect(budget.reserve()).toBe(true);
    expect(budget.reserve()).toBe(false); expect(budget.used()).toBe(60); expect(budget.exhausted()).toBe(true);
  });
  it("CLA-06 one budget covers receipt and analytics calls, a failed call still counts, and past the cap no request is sent", async () => {
    const budget = createClaudeBudget(3); let fail = false;
    const analytics = claudeMessage({ selections: [{ id: "restricted", quote: "Restricted funds hold 43000 cents." }] });
    const calls: number[] = [];
    const client = stubClient(async body => { calls.push(1); if (fail) throw new Error("boom"); return "system" in body && String(body.system).startsWith("Select up to three") ? analytics : good(); }).client;
    const receiptOverClient = createClaudeReceiptCategorizer({ env: FAKE_ENV, budget, client });
    const select = createAnalyticsSelector({ env: FAKE_ENV, budget, client });
    await receiptOverClient(input); expect(budget.used()).toBe(1);
    await select(snapshot, "funding"); expect(budget.used()).toBe(2);
    fail = true; await expect(receiptOverClient(input)).rejects.toMatchObject({ code: "UNAVAILABLE" }); expect(budget.used()).toBe(3);
    fail = false; expect(budget.exhausted()).toBe(true);
    await expect(receiptOverClient(input)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(select(snapshot, "funding")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(calls).toHaveLength(3); expect(budget.used()).toBe(3);
    // The page and the shell turn AI off with the limit reason, and the manual path stays reachable.
    for (const flag of ["AI_RECEIPT_ENABLED", "AI_ANALYTICS_ENABLED", "AI_EXPENSE_PROPOSALS_ENABLED"] as const) expect(claudeAiStatus({ [flag]: "true", ...FAKE_ENV }, flag, budget)).toEqual({ on: false, reason: "LIMIT" });
    expect(AI_OFF_MESSAGES.LIMIT).toBe(CLAUDE_LIMIT_MESSAGE);
  });
  it("CLA-07 the default receipt path and the default analytics path draw on the process-wide budget, not a private one", async () => {
    const before = processClaudeBudget.used();
    await defaultReceiptCategorizer({ AI_RECEIPT_ENABLED: "true", ...FAKE_ENV })(input);
    expect(processClaudeBudget.used()).toBe(before + 1); expect(fetchStub).toHaveBeenCalledTimes(1);
    fetchStub.mockImplementation(async () => new Response(JSON.stringify(claudeMessage({ selections: [{ id: "restricted", quote: "Restricted funds hold 43000 cents." }] })), { status: 200, headers: { "content-type": "application/json" } }));
    await createAnalyticsSelector({ env: FAKE_ENV })(snapshot, "funding");
    expect(processClaudeBudget.used()).toBe(before + 2); expect(fetchStub).toHaveBeenCalledTimes(2);
    const used = processClaudeBudget.used(); await createClaudeReceiptCategorizer({ env: {} })(input).catch(() => undefined); expect(processClaudeBudget.used()).toBe(used);
  });
});

describe("analytics on Claude", () => {
  it("CLA-08 the request is a bounded structured output with fixed questions and server facts only, sent without retries", async () => {
    const { client, calls } = stubClient(() => claudeMessage({ selections: [{ id: "general", quote: "General funds hold 7000 cents." }] }));
    const result = await createAnalyticsSelector({ env: FAKE_ENV, client, timeoutMs: 5000 })(snapshot, "funding");
    expect(result.facts.map(fact => fact.id)).toEqual(["general"]); expect(result.model).toMatchObject({ id: "claude-haiku-5-5", name: "Claude Haiku 5.5", promptVersion: "analytics-facts-claude-v1" });
    const [[body, options]] = calls;
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "system"]);
    expect(body.model).toBe("claude-haiku-5-5"); expect(body.max_tokens).toBe(1024); expect(options).toMatchObject({ maxRetries: 0, timeout: 5000 });
    expect(body).not.toHaveProperty("tools"); expect(body).not.toHaveProperty("tool_choice"); expect(body).not.toHaveProperty("stream");
    expect(body.output_config?.format).toMatchObject({ type: "json_schema" });
    const content = JSON.parse(String(body.messages[0]!.content)); expect(Object.keys(content).sort()).toEqual(["facts", "question"]);
    expect(content.facts.map((fact: { id: string }) => fact.id)).toEqual(["restricted", "general", "reserved", "availability"]);
    expect(Object.keys(content.facts[0]).sort()).toEqual(["id", "text"]);
    const raw = JSON.stringify(body); for (const secret of [snapshot.digest, "cedar-hollow", FAKE_KEY]) expect(raw).not.toContain(secret);
    expect(analyticsRequest("claude-sonnet-5-5", snapshot, "payable").model).toBe("claude-sonnet-5-5");
  });
  it("CLA-09 a selection that is not an exact supplied fact, a wrong model, a truncation or a tool call is refused, never repaired or retried", async () => {
    const cases: [string, ReturnType<typeof claudeMessage>][] = [
      ["invented id", claudeMessage({ selections: [{ id: "invented", quote: "x" }] })],
      ["altered quote", claudeMessage({ selections: [{ id: "general", quote: "General funds hold 7001 cents." }] })],
      ["irrelevant fact", claudeMessage({ selections: [{ id: "payable", quote: "Payable 0 cents." }] })],
      ["extra key", claudeMessage({ selections: [{ id: "general", quote: "General funds hold 7000 cents.", note: "x" }] })],
      ["wrong model", claudeMessage({ selections: [{ id: "general", quote: "General funds hold 7000 cents." }] }, "claude-sonnet-5-5")],
      ["truncated", claudeMessage({ selections: [] }, "claude-haiku-5-5", { stop_reason: "max_tokens" })],
      ["refusal", claudeMessage({ selections: [] }, "claude-haiku-5-5", { stop_reason: "refusal" })],
      ["tool use", claudeMessage({}, "claude-haiku-5-5", { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "pay", input: {} }] })],
      ["not json", claudeMessage({}, "claude-haiku-5-5", { content: [{ type: "text", text: "not json" }] })],
    ];
    for (const [label, message] of cases) {
      const { client, calls } = stubClient(() => message);
      await expect(createAnalyticsSelector({ env: FAKE_ENV, client })(snapshot, "funding"), label).rejects.toMatchObject({ code: "VALIDATION" });
      expect(calls, label).toHaveLength(1);
    }
    const { client } = stubClient(() => { throw new Error("network"); });
    await expect(createAnalyticsSelector({ env: FAKE_ENV, client })(snapshot, "funding")).rejects.toBeInstanceOf(AnalyticsModelError);
    await expect(createAnalyticsSelector({ env: { ...FAKE_ENV, AIDTRACE_CLAUDE_MODEL: "qwen" }, client })(snapshot, "funding")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("shell wording", () => {
  it("CLA-10 key and no key wording is exact, says AI for every configured model (IAC-416 PR 2), and never says AI is off", () => {
    const on = claudeAiStatus({ AI_RECEIPT_ENABLED: "true", ...FAKE_ENV }, "AI_RECEIPT_ENABLED", createClaudeBudget());
    expect(on.on && shellWording({ name: on.name, shellName: on.shellName })).toEqual({ tag: "AI + PayPal", line: "Built with PayPal Payouts and AI" });
    const sonnet = claudeAiStatus({ AI_RECEIPT_ENABLED: "true", ...FAKE_ENV, AIDTRACE_CLAUDE_MODEL: "claude-sonnet-5-5" }, "AI_RECEIPT_ENABLED", createClaudeBudget());
    expect(sonnet.on && shellWording({ name: sonnet.name, shellName: sonnet.shellName }).line).toBe("Built with PayPal Payouts and AI");
    expect(shellWording(null)).toEqual({ tag: "", line: "Built with PayPal Payouts." });
    expect(FOOTER_PROMISE).toBe("AI suggests. Rules and people decide. PayPal pays.");
  });
});

// Static checks read the source tree. A judge export has the release templates at its root instead of under release/judge,
// so each check looks in whichever layout exists.
const first = (...paths: string[]) => paths.find(path => existsSync(path));
function walk(folder: string, found: string[] = []) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== ".next") walk(path, found); }
    else if (entry.isFile() && /\.(tsx?|css|mjs|md|json|ya?ml|txt|sh)$|(^|\/)(aidtrace|NOTICE)$/.test(path)) found.push(path);
  }
  return found;
}
describe("static checks", () => {
  it("CLA-11 no user-facing source or judge file names the retired local model", () => {
    const folders = ["src", ...(existsSync("release/judge") ? ["release/judge"] : [])];
    const files = folders.flatMap(folder => walk(folder));
    for (const name of ["compose.session.yaml", "compose.ui.yaml", "compose.setup.yaml", "README.md", "NOTICE", "docs/ACCESS.md", "docs/JUDGING.md", "docs/LICENSING.md", "docs/THIRD_PARTY_MODELS.md", "scripts/aidtrace"]) {
      if (!existsSync("release/judge") && existsSync(name)) files.push(name);
    }
    expect(files.length).toBeGreaterThan(40);
    const offenders = files.filter(path => /qwen|local model|local ai|1\.7b|llama/i.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("CLA-12 the session compose passes the key by name only, and no env file, session helper or launcher line holds or prints it", () => {
    const compose = first("release/judge/compose.session.yaml", "compose.session.yaml")!; const text = readFileSync(compose, "utf8");
    const lines = text.split("\n").filter(line => line.includes("ANTHROPIC_API_KEY"));
    expect(lines).toEqual(["      ANTHROPIC_API_KEY:"]);
    expect(text).not.toMatch(/inference|ingress|AIDTRACE_AI_PROJECT|ai-check/);
    expect(text).toMatch(/env_file: \$\{AIDTRACE_SESSION_ENV/);
    // The app is the only service that receives it, and it is the only service on the outbound network besides the relay.
    expect(text.slice(0, text.indexOf("  app:"))).not.toContain("ANTHROPIC_API_KEY"); expect(text.slice(text.indexOf("  relay:"))).not.toContain("ANTHROPIC_API_KEY");
    const launcher = readFileSync(first("release/judge/scripts/aidtrace", "scripts/aidtrace")!, "utf8");
    for (const line of launcher.split("\n").filter(item => item.includes("ANTHROPIC_API_KEY") && !item.trim().startsWith("#"))) {
      expect(line.trim(), line).toMatch(/^(without_key\(\) \( unset ANTHROPIC_API_KEY; "\$@" \)|if \[ -n "\$\{ANTHROPIC_API_KEY:-\}" \]; then echo '[^$]*'; else echo '[^$]*'; fi)$/);
    }
    expect(launcher).not.toMatch(/ANTHROPIC_API_KEY=|echo[^\n]*\$\{?ANTHROPIC_API_KEY|printf[^\n]*ANTHROPIC_API_KEY|--env|-e ANTHROPIC/);
    // Only the final app start receives the key: every other session_compose step is wrapped in without_key.
    const steps = launcher.split("\n").filter(line => /^\s+(without_key )?session_compose (build|up|run|stop)/.test(line));
    expect(steps.filter(line => !line.includes("without_key")).map(line => line.trim())).toEqual(["session_compose up -d --wait --no-deps app"]);
  });
  it("CLA-13 the session helper never writes the key to session.env and refuses a session file that carries it", () => {
    const helper = resolve(first("release/judge/scripts/judge-session.mjs", "scripts/judge-session.mjs")!);
    const root = mkdtempSync(join(tmpdir(), "aidtrace-cla-session-"));
    const run = (...args: string[]) => spawnSync(process.execPath, [helper, ...args], { encoding: "utf8", env: { ...process.env, JUDGE_SESSION_ROOT: root, ANTHROPIC_API_KEY: FAKE_KEY } });
    expect(run("new", "claude-one", "3102").status).toBe(0);
    const path = join(root, "claude-one/session.env"); const written = readFileSync(path, "utf8");
    expect(written).not.toContain("ANTHROPIC"); expect(written).not.toContain(FAKE_KEY); expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(run("check", "claude-one").status).toBe(0);
    appendFileSync(path, `ANTHROPIC_API_KEY=${FAKE_KEY}\n`);
    const refused = run("check", "claude-one"); expect(refused.status).not.toBe(0); expect(refused.stdout + refused.stderr).not.toContain(FAKE_KEY);
  });
  it("CLA-14 only the two test compose files set UI_TEST_CONTAINER, and only the Claude client reads it", () => {
    const composeFiles = [...readdirSync(".").filter(name => /^compose.*\.ya?ml$/.test(name)), ...(existsSync("release/judge") ? readdirSync("release/judge").filter(name => /^compose.*\.ya?ml$/.test(name)).map(name => `release/judge/${name}`) : [])];
    expect(composeFiles.length).toBeGreaterThanOrEqual(3);
    const setters = composeFiles.filter(path => readFileSync(path, "utf8").split("\n").some(line => /UI_TEST_CONTAINER/.test(line) && !line.trim().startsWith("#")));
    expect(setters.every(path => path.endsWith("compose.ui.yaml"))).toBe(true); expect(setters.length).toBeGreaterThanOrEqual(1);
    for (const name of ["Dockerfile", "Dockerfile.browser"]) if (existsSync(name)) expect(readFileSync(name, "utf8")).not.toContain("UI_TEST_CONTAINER");
    const readers = walk("src").filter(path => readFileSync(path, "utf8").includes("UI_TEST_CONTAINER"));
    expect(readers).toEqual(["src/ai/claude-client.ts"]);
  });
});

describe("client", () => {
  const request = { model: "claude-haiku-5-5", max_tokens: 16, messages: [{ role: "user" as const, content: "x" }] };
  it("CLA-15 the real client keeps the fixed endpoint, ignoring ANTHROPIC_BASE_URL, and the stub is on only for the exact test flag", async () => {
    expect(CLAUDE_BASE_URL).toBe("https://api.anthropic.com");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://evil.invalid"); vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "x");
    await realClaudeClient(FAKE_KEY).messages.create(request, { maxRetries: 0 });
    for (const env of [{}, { UI_TEST_CONTAINER: "TRUE" }, { UI_TEST_CONTAINER: "1" }, { UI_TEST_CONTAINER: "false" }, { UI_TEST_CONTAINER: "true " }]) {
      await claudeClientFor(FAKE_KEY, env).messages.create(request, { maxRetries: 0 });
    }
    expect(fetchStub).toHaveBeenCalledTimes(6);
    for (const call of fetchStub.mock.calls) { const url = String(call[0] instanceof Request ? call[0].url : call[0]); expect(url.startsWith("https://api.anthropic.com/"), url).toBe(true); }
    fetchStub.mockClear();
    await claudeClientFor(FAKE_KEY, { UI_TEST_CONTAINER: "true" }).messages.create(request, { maxRetries: 0 });
    expect(fetchStub).toHaveBeenCalledTimes(1); const [url, init] = fetchStub.mock.calls[0]!;
    expect(String(url)).toBe(UI_TEST_STUB_URL); expect(UI_TEST_STUB_URL).toBe("http://127.0.0.1:8080/v1/messages");
    expect(JSON.stringify(init)).not.toContain(FAKE_KEY); expect(Object.keys(init.headers as object)).toEqual(["content-type"]);
  });
  it("CLA-16 the client source builds the SDK with no retries, no logging and a fixed base URL, and reads no base URL variable", () => {
    const source = readFileSync("src/ai/claude-client.ts", "utf8").split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
    expect(source).toMatch(/baseURL: CLAUDE_BASE_URL, maxRetries: 0/); expect(source).toContain('logLevel: "off"');
    expect(source).not.toMatch(/ANTHROPIC_BASE_URL|process\.env\.ANTHROPIC/);
  });
});

// IAC-232 judge path validation: three fixes found while validating a fresh export.
describe("judge path fixes", () => {
  const launcherText = () => readFileSync(first("release/judge/scripts/aidtrace", "scripts/aidtrace")!, "utf8");
  it("CLA-17 ui-check makes the local folder before it makes the snapshot folder inside it", () => {
    const lines = launcherText().split("\n"); const ui = lines.findIndex(line => /^\s+ui-check\)/.test(line));
    expect(ui).toBeGreaterThan(-1);
    const make = lines.findIndex((line, index) => index > ui && line.trim() === "(umask 077; mkdir -p local)");
    const temp = lines.findIndex((line, index) => index > ui && line.includes('mktemp -d "$root/local/ui-source-XXXXXX"'));
    expect(make).toBeGreaterThan(ui); expect(temp).toBeGreaterThan(make);
  });
  it("CLA-18 the session relay waits longer than the slowest hosted request window the app can hold one browser request open for", () => {
    const relay = readFileSync(first("release/judge/scripts/session-relay.mjs", "scripts/session-relay.mjs")!, "utf8");
    const wait = Number(/upstream\.setTimeout\((\d+),/.exec(relay)?.[1]);
    const constant = (path: string, name: string) => Number(new RegExp(`export const ${name} = ([0-9_]+)`).exec(readFileSync(path, "utf8"))?.[1]?.replace(/_/g, ""));
    const draft = constant("src/rules-draft/draft-request.ts", "DRAFT_TIMEOUT_MS");
    // One policy-check POST runs the rule checks and then the model check, and each fund pair can make two sequential calls (Haiku, then
    // Sonnet), each bounded by CLAUDE_TIMEOUT_MS. Pairs run in parallel (src/policy/model-run.ts, Promise.all), so MODEL_RUN_WINDOW_MS is set from that bound. Photo reads have PHOTO_TIMEOUT_MS.
    const claude = constant("src/ai/claude-client.ts", "CLAUDE_TIMEOUT_MS"); const photo = constant("src/ai/claude-photo.ts", "PHOTO_TIMEOUT_MS");
    const policyWindow = constant("src/policy/compliance.ts", "MODEL_RUN_WINDOW_MS");
    for (const value of [wait, draft, claude, photo, policyWindow]) expect(Number.isFinite(value) && value > 0).toBe(true);
    expect(wait).toBeGreaterThan(draft); expect(wait).toBeGreaterThan(claude); expect(wait).toBeGreaterThan(photo); expect(wait).toBeGreaterThan(policyWindow);
  });
  it("CLA-19 the new-receipt page renders the photo reader only when a photo read could run, and the route keeps the flag-only gate", async () => {
    const page = readFileSync("src/app/receipts/new/page.tsx", "utf8").split("\n").filter(line => !line.trim().startsWith("//")).join("\n");
    expect(page).toMatch(/const photo = receiptPhotoStatus\(\)\.on;/); expect(page).not.toContain("receiptPhotoEnabled");
    expect(readFileSync("src/server/receipt-photo-actions.ts", "utf8")).toMatch(/if \(!receiptPhotoEnabled\(env\)\) return new Response\("Not found"/);
    const { receiptPhotoStatus } = await import("../src/ai/provider");
    const flags = { AI_RECEIPT_ENABLED: "true", AI_RECEIPT_PHOTO_ENABLED: "true" };
    expect(receiptPhotoStatus({ ...flags })).toEqual({ on: false, reason: "NO_KEY" });
    expect(receiptPhotoStatus({ ...flags, ANTHROPIC_API_KEY: "k" }).on).toBe(true);
    expect(receiptPhotoStatus({ ...flags, ANTHROPIC_API_KEY: "k" }, createClaudeBudget(0))).toEqual({ on: false, reason: "LIMIT" });
    expect(receiptPhotoStatus({ AI_RECEIPT_ENABLED: "true", ANTHROPIC_API_KEY: "k" })).toEqual({ on: false, reason: "SWITCHED_OFF" });
  });
});
