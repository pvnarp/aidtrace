import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { expect, it, vi } from "vitest";
import { RETIRED_MODEL_LABEL, readReceiptAudit, receiptAuditColumns, receiptAuditLabel, storedReceiptAudit } from "../src/ai/audit";
import { createClaudeReceiptCategorizer, CLAUDE_PROMPT_VERSION, CLAUDE_SCHEMA_VERSION, type ClaudeMessagesClient } from "../src/ai/claude-receipt";
import type { ReceiptInput } from "../src/ai/receipt";
import { suggestionHash } from "../src/receipt/service";

// CAI-23 to CAI-26: IAC-383 provider-tagged audit, stubbed evidence only. No test calls Anthropic.
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const input: ReceiptInput = { source: "INVENTED RECEIPT\nScience experiment kits\n", lines: [{ id: "L1", description: "Science kits" }] };
const proposal = { lineId: "L1", category: "robot_kits_parts", quote: "Science experiment kits" };
const claudeMessage = (model = "claude-haiku-5-5") => ({ id: "msg_stub", type: "message", role: "assistant", model, stop_reason: "end_turn", stop_sequence: null,
  content: [{ type: "text", text: JSON.stringify({ proposals: [proposal] }) }], usage: { input_tokens: 812, output_tokens: 57 } }) as unknown as Anthropic.Message;
const claudeResult = async (model: "claude-haiku-5-5" | "claude-sonnet-5-5" = "claude-haiku-5-5") => {
  const client = { messages: { create: vi.fn(async () => claudeMessage(model)) } } as unknown as ClaudeMessagesClient;
  return createClaudeReceiptCategorizer({ env: { ANTHROPIC_API_KEY: "sk-ant-fake-test-key", AIDTRACE_CLAUDE_MODEL: model }, client })(input);
};

// A row exactly as databases hold it today: the audit has six fields and no provider key.
// The expected digests were produced outside this code with `shasum -a 256` over the literal
// JSON text, so they pin the algorithm and the stored shape, not just self-consistency.
const LEGACY_AUDIT = { sourceSha256: "a".repeat(64), requestSha256: "b".repeat(64), responseSha256: "c".repeat(64),
  modelSha256: "061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a", modelRevision: "90862c4b9d2787eaed51d12237eafdfe7c5f6077", promptVersion: "receipt-category-v1" };
// The row shape the readers take (IAC-392): the provider and model columns plus the stored audit.
const LEGACY_LOCAL_ROW = { provider: "local", model: LEGACY_AUDIT.modelRevision, audit: LEGACY_AUDIT };
const rowOf = (audit: Record<string, string | number>) => ({ ...receiptAuditColumns(audit), audit });
const LEGACY_ROW = { id: "11111111-1111-4111-8111-111111111111", status: "READY", proposals: [{ lineId: "L1", category: "science_kits", quote: "Science experiment kit", start: 0, end: 22 }], audit: LEGACY_AUDIT };
const LEGACY_JSON = '{"id":"11111111-1111-4111-8111-111111111111","status":"READY","proposals":[{"lineId":"L1","category":"science_kits","quote":"Science experiment kit","start":0,"end":22}],"audit":{"sourceSha256":"' + "a".repeat(64) + '","requestSha256":"' + "b".repeat(64) + '","responseSha256":"' + "c".repeat(64) + '","modelSha256":"061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a","modelRevision":"90862c4b9d2787eaed51d12237eafdfe7c5f6077","promptVersion":"receipt-category-v1"}}';

it("CAI-23 an existing local row keeps its suggestion hash, and an absent suggestion keeps its hash", () => {
  expect(JSON.stringify(LEGACY_ROW)).toBe(LEGACY_JSON);
  expect(suggestionHash(LEGACY_ROW as unknown as Parameters<typeof suggestionHash>[0])).toBe("5d28e3c7a5cedc7a1aef37067a0edb18daa24896e3db99db8f33a6c70084a7d0");
  expect(suggestionHash(undefined)).toBe("74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b");
  // The reader never mutates the row it normalizes, so reading cannot change a later hash.
  const before = JSON.stringify(LEGACY_AUDIT); readReceiptAudit(LEGACY_LOCAL_ROW); receiptAuditLabel(LEGACY_LOCAL_ROW);
  expect(JSON.stringify(LEGACY_AUDIT)).toBe(before);
});

it("CAI-24 the retired local shape can no longer be written, and a row whose provider column says local still reads as an earlier model", async () => {
  // The six-field shape with no provider key is what older databases hold. The write boundary refuses it, whatever it carries.
  const retired = { proposals: [], audit: { ...LEGACY_AUDIT, sourceSha256: sha(input.source) } };
  expect(() => storedReceiptAudit(retired as never, input.source)).toThrow("Invalid audit");
  expect(() => storedReceiptAudit({ proposals: [], audit: { ...retired.audit, provider: "local" } } as never, input.source)).toThrow("Invalid audit");
  expect(() => receiptAuditColumns(LEGACY_AUDIT as never)).toThrow("Invalid audit");
  const localRow = { provider: "local", model: LEGACY_AUDIT.modelRevision, audit: LEGACY_AUDIT };
  expect(readReceiptAudit(localRow)).toEqual({ provider: "local", ...LEGACY_AUDIT });
  expect(receiptAuditLabel(localRow)).toEqual(RETIRED_MODEL_LABEL);
  expect(JSON.stringify(RETIRED_MODEL_LABEL)).not.toMatch(/local|qwen|llama/i);
});

it("CAI-25 a Claude result is stored as the categorizer returned it, tagged claude, and named from the stored audit", async () => {
  for (const [model, label] of [["claude-haiku-5-5", "Claude Haiku 5.5"], ["claude-sonnet-5-5", "Claude Sonnet 5.5"]] as const) {
    const result = await claudeResult(model);
    const stored = storedReceiptAudit(result, input.source);
    expect(stored).toEqual(result.audit);
    expect(stored).toMatchObject({ provider: "claude", model, responseModel: model, effort: "low", promptVersion: CLAUDE_PROMPT_VERSION, schemaVersion: CLAUDE_SCHEMA_VERSION, inputTokens: 812, outputTokens: 57 });
    expect(stored).not.toHaveProperty("modelSha256"); expect(stored).not.toHaveProperty("modelRevision");
    expect(readReceiptAudit(rowOf(stored))).toEqual(result.audit);
    expect(receiptAuditLabel(rowOf(stored))).toEqual({ short: label, model: label });
  }
  const dated = await claudeResult(); const snapshot = { ...dated, audit: { ...dated.audit, responseModel: "claude-haiku-5-5-20261001" } };
  expect(storedReceiptAudit(snapshot, input.source)).toMatchObject({ model: "claude-haiku-5-5", responseModel: "claude-haiku-5-5-20261001" });
  // Every tampered audit is refused, never stored under either provenance.
  const good = (await claudeResult()).audit as unknown as Record<string, unknown>;
  const tampers: Record<string, unknown>[] = [
    { sourceSha256: sha("other") }, { requestSha256: "XYZ" }, { responseSha256: "A".repeat(64) }, { responseSha256: undefined }, { provider: "openai" }, { provider: undefined, modelSha256: "x" },
    { model: "claude-opus-5-5" }, { responseModel: "claude-sonnet-5-5" }, { effort: "high" }, { promptVersion: "receipt-category-v1" }, { schemaVersion: "other" },
    { latencyMs: -1 }, { inputTokens: 1.5 }, { outputTokens: "57" }, { extra: "field" },
  ];
  for (const tamper of tampers) {
    const audit = { ...good, ...tamper }; if (tamper.provider === undefined && "provider" in tamper) delete audit.provider;
    expect(() => storedReceiptAudit({ proposals: [], audit } as never, input.source), JSON.stringify(Object.keys(tamper))).toThrow("Invalid audit");
  }
  const missing = { ...good }; delete missing.inputTokens;
  expect(() => storedReceiptAudit({ proposals: [], audit: missing } as never, input.source)).toThrow("Invalid audit");
  expect(() => storedReceiptAudit({ proposals: [], audit: null } as never, input.source)).toThrow("Invalid audit");
  // A result in the retired local shape is refused at the write boundary, with or without a valid source digest.
  for (const audit of [{ ...LEGACY_AUDIT, sourceSha256: sha(input.source) }, { ...LEGACY_AUDIT, sourceSha256: sha("other") }, { ...(await claudeResult()).audit, provider: "local" }])
    expect(() => storedReceiptAudit({ proposals: [], audit } as never, input.source)).toThrow("Invalid audit");
});

it("CAI-26 an unrecognized stored audit is never given a provider or model name", async () => {
  const claude = (await claudeResult()).audit as unknown as Record<string, string | number>;
  const columns = [{ provider: "local", model: LEGACY_AUDIT.modelRevision }, { provider: "claude", model: "claude-haiku-5-5" }];
  for (const stored of [null, undefined, {}, { provider: "openai" }, { provider: "local", ...LEGACY_AUDIT }, { ...LEGACY_AUDIT, modelSha256: 7 },
    { ...claude, model: "claude-opus-5-5" }, { ...claude, extra: 1 }, { ...claude, inputTokens: -1 }] as never[]) {
    for (const pair of columns) { expect(readReceiptAudit({ ...pair, audit: stored })).toBeNull(); expect(receiptAuditLabel({ ...pair, audit: stored })).toBeNull(); }
  }
});

it("PRV-01 the provider and model columns are the authority: a null provider, a mismatched audit or a malformed audit reads as null", async () => {
  const haiku = (await claudeResult()).audit as unknown as Record<string, string | number>;
  const sonnet = (await claudeResult("claude-sonnet-5-5")).audit as unknown as Record<string, string | number>;
  const localRow = { provider: "local", model: LEGACY_AUDIT.modelRevision, audit: LEGACY_AUDIT };
  const claudeRow = { provider: "claude", model: "claude-haiku-5-5", audit: haiku };
  // Agreeing rows read as before.
  expect(readReceiptAudit(localRow)).toEqual({ provider: "local", ...LEGACY_AUDIT }); expect(readReceiptAudit(claudeRow)).toEqual(haiku);
  expect(receiptAuditLabel(localRow)).toEqual(RETIRED_MODEL_LABEL); expect(receiptAuditLabel(claudeRow)).toEqual({ short: "Claude Haiku 5.5", model: "Claude Haiku 5.5" });
  // A null provider or model never infers one from the audit, including the old "missing key means local" shape.
  for (const row of [{ provider: null, model: null, audit: LEGACY_AUDIT }, { provider: null, model: null, audit: haiku }, { ...localRow, provider: null }, { ...localRow, model: null }, { ...claudeRow, model: null }, { provider: "", model: "", audit: LEGACY_AUDIT }]) {
    expect(readReceiptAudit(row)).toBeNull(); expect(receiptAuditLabel(row)).toBeNull();
  }
  expect(readReceiptAudit(null)).toBeNull(); expect(readReceiptAudit(undefined)).toBeNull();
  // The columns disagree with the audit.
  const disagree = [
    { ...localRow, provider: "claude" }, { ...localRow, model: "f".repeat(40) }, { ...localRow, provider: "other" },
    { ...claudeRow, provider: "local" }, { ...claudeRow, model: "claude-sonnet-5-5" }, { ...claudeRow, model: "claude-opus-5-5", audit: { ...haiku, model: "claude-opus-5-5" } },
    { provider: "claude", model: "claude-haiku-5-5", audit: sonnet }, { provider: "local", model: LEGACY_AUDIT.modelRevision, audit: { provider: "local", ...LEGACY_AUDIT } },
    { provider: "local", model: LEGACY_AUDIT.modelRevision, audit: haiku },
  ];
  for (const row of disagree) { expect(readReceiptAudit(row)).toBeNull(); expect(receiptAuditLabel(row)).toBeNull(); }
  // A malformed audit is null even when the columns look right.
  for (const audit of [null, undefined, {}, { ...LEGACY_AUDIT, promptVersion: 1 }]) expect(readReceiptAudit({ ...localRow, audit: audit as never })).toBeNull();
  expect(readReceiptAudit({ ...claudeRow, audit: { ...haiku, inputTokens: -1 } })).toBeNull();
  expect(readReceiptAudit({ ...claudeRow, audit: { ...haiku, extra: 1 } })).toBeNull();
});

it("PRV-02 receiptAuditColumns derives the columns from a validated stored audit and refuses anything else", async () => {
  expect(() => receiptAuditColumns(LEGACY_AUDIT as never)).toThrow("Invalid audit"); // the retired shape derives no columns: nothing writes it
  for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5"] as const)
    expect(receiptAuditColumns(storedReceiptAudit(await claudeResult(model), input.source))).toEqual({ provider: "claude", model });
  for (const audit of [{}, { provider: "openai", model: "x" }, { provider: "local", model: "x" }, { provider: "claude" }, { sourceSha256: "x" }] as never[]) expect(() => receiptAuditColumns(audit)).toThrow("Invalid audit");
});
