import { createHash } from "node:crypto";
import type { ReceiptInput } from "./receipt";
import { CLAUDE_EFFORT, CLAUDE_MODELS, CLAUDE_PROMPT_VERSION, CLAUDE_SCHEMA_VERSION, servedBy, type ClaudeModel, type ClaudeReceiptResult } from "./claude-receipt";

// Provider-tagged receipt audit. The receipt_suggestions.audit column is plain jsonb
// (Record<string, string | number>). IAC-392 added the provider and model columns.
//
// Claude only (docs/plans/CLAUDE_ONLY_SCOPE.md): every new suggestion is a Claude suggestion. Suggestions saved before
// October 30 by the retired on-device model still sit in the database, and the provider column still allows "local" for them,
// so READERS keep recognizing that stored shape (six fields, no "provider" key, kept so every stored hash stays identical).
// Nothing here can WRITE that shape any more.
export type ReceiptCategorizeResult = ClaudeReceiptResult;
export type AnyReceiptCategorizer = (input: ReceiptInput, signal?: AbortSignal) => Promise<ReceiptCategorizeResult>;
export type StoredReceiptAudit = Record<string, string | number>;
// Read-only: the audit shape of suggestions saved by the retired model.
export type RetiredReceiptAudit = { provider: "local"; sourceSha256: string; requestSha256: string; responseSha256: string; modelSha256: string; modelRevision: string; promptVersion: string };
export type ClaudeReceiptAudit = { provider: "claude"; model: ClaudeModel; responseModel: string; effort: typeof CLAUDE_EFFORT; promptVersion: string; schemaVersion: string;
  sourceSha256: string; requestSha256: string; responseSha256: string; latencyMs: number; inputTokens: number; outputTokens: number };
export type ReceiptAudit = RetiredReceiptAudit | ClaudeReceiptAudit;

const HASH = /^[a-f0-9]{64}$/;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const CLAUDE_KEYS = ["provider", "model", "responseModel", "effort", "promptVersion", "schemaVersion", "sourceSha256", "requestSha256", "responseSha256", "latencyMs", "inputTokens", "outputTokens"];
const count = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0;
const sameKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join(",") === [...keys].sort().join(",");

// The audit written for a READY suggestion. Throws "Invalid audit" and stores nothing otherwise.
export function storedReceiptAudit(result: ReceiptCategorizeResult, source: string): StoredReceiptAudit {
  const audit: unknown = result.audit;
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) throw new Error("Invalid audit");
  const value = audit as Record<string, unknown>;
  const sourceSha256 = digest(source);
  if (value.sourceSha256 !== sourceSha256 || typeof value.requestSha256 !== "string" || !HASH.test(value.requestSha256) || typeof value.responseSha256 !== "string" || !HASH.test(value.responseSha256)) throw new Error("Invalid audit");
  if (value.provider !== "claude" || !sameKeys(value, CLAUDE_KEYS) || typeof value.model !== "string") throw new Error("Invalid audit");
  const model = CLAUDE_MODELS.find(name => name === value.model);
  if (!model || !servedBy(model, value.responseModel) || value.effort !== CLAUDE_EFFORT || value.promptVersion !== CLAUDE_PROMPT_VERSION || value.schemaVersion !== CLAUDE_SCHEMA_VERSION ||
    !count(value.latencyMs) || !count(value.inputTokens) || !count(value.outputTokens)) throw new Error("Invalid audit");
  return { provider: "claude", model, responseModel: value.responseModel as string, effort: CLAUDE_EFFORT, promptVersion: CLAUDE_PROMPT_VERSION, schemaVersion: CLAUDE_SCHEMA_VERSION,
    sourceSha256, requestSha256: value.requestSha256, responseSha256: value.responseSha256, latencyMs: value.latencyMs as number, inputTokens: value.inputTokens as number, outputTokens: value.outputTokens as number };
}

// The provider and model columns written with a READY suggestion (IAC-392, docs/plans/PROVIDER_COLUMNS.md). Derived only from an
// audit that storedReceiptAudit returned. The database check refuses any row where the columns and the audit disagree.
export function receiptAuditColumns(audit: StoredReceiptAudit): { provider: "claude"; model: string } {
  if (audit.provider === "claude" && typeof audit.model === "string") return { provider: "claude", model: audit.model };
  throw new Error("Invalid audit");
}

// The row shape the readers take. The provider and model columns are the authority; the audit is the evidence they must agree with.
export type StoredReceiptRow = { provider: string | null; model: string | null; audit: StoredReceiptAudit | null | undefined };

// Read a READY row's audit as the tagged union. Returns null when the provider column is null, when the audit is malformed, or
// when the audit disagrees with the columns, so the UI never invents a provider. A missing provider key in the audit is the
// stored shape of a retired-model suggestion and is accepted only when the provider column says local.
export function readReceiptAudit(row: StoredReceiptRow | null | undefined): ReceiptAudit | null {
  if (!row || !row.provider || !row.model) return null;
  const stored = row.audit;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  if (row.provider === "local") {
    if (stored.provider !== undefined) return null;
    const { sourceSha256, requestSha256, responseSha256, modelSha256, modelRevision, promptVersion } = stored;
    if ([sourceSha256, requestSha256, responseSha256, modelSha256, modelRevision, promptVersion].some(item => typeof item !== "string") || modelRevision !== row.model) return null;
    return { provider: "local", sourceSha256: sourceSha256 as string, requestSha256: requestSha256 as string, responseSha256: responseSha256 as string, modelSha256: modelSha256 as string, modelRevision: modelRevision as string, promptVersion: promptVersion as string };
  }
  if (row.provider !== "claude" || stored.provider !== "claude" || !sameKeys(stored, CLAUDE_KEYS)) return null;
  const model = CLAUDE_MODELS.find(name => name === stored.model);
  if (!model || model !== row.model || typeof stored.responseModel !== "string" || stored.effort !== CLAUDE_EFFORT || typeof stored.promptVersion !== "string" || typeof stored.schemaVersion !== "string" ||
    ![stored.sourceSha256, stored.requestSha256, stored.responseSha256].every(item => typeof item === "string") || !count(stored.latencyMs) || !count(stored.inputTokens) || !count(stored.outputTokens)) return null;
  return stored as unknown as ClaudeReceiptAudit;
}

export const CLAUDE_NAMES: Record<ClaudeModel, string> = { "claude-haiku-5-5": "Claude Haiku 5.5", "claude-sonnet-5-5": "Claude Sonnet 5.5" };
// The header and footer name: "Claude Haiku" for the default model, the full display name otherwise.
export const CLAUDE_SHELL_NAMES: Record<ClaudeModel, string> = { "claude-haiku-5-5": "Claude Haiku", "claude-sonnet-5-5": "Claude Sonnet 5.5" };
export const RETIRED_MODEL_LABEL = { short: "Earlier AI", model: "Earlier AI model, since retired" };
// Names come only from the stored columns and the audit they agree with, never from the environment.
export function receiptAuditLabel(row: StoredReceiptRow | null | undefined): { short: string; model: string } | null {
  const audit = readReceiptAudit(row);
  if (!audit) return null;
  return audit.provider === "claude" ? { short: CLAUDE_NAMES[audit.model], model: CLAUDE_NAMES[audit.model] } : RETIRED_MODEL_LABEL;
}
