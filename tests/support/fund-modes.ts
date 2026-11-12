import { desc, eq } from "drizzle-orm";
import * as s from "../../db/schema";
import type { FundMode } from "../../db/schema";
import type { AppDatabase } from "../../src/server/db";
import type { ClaudeMessagesClient } from "../../src/ai/claude-client";
import type { ComplianceRequest } from "../../src/policy/compliance";

// IAC-405 step 2 PR F test helpers. Real Postgres in the isolated check project. A model call goes only to a stub that a test defines.
// Nothing here reaches the network, a key or a provider.
export const FLAG_ON = { FUND_MODES_ENABLED: "true" };
export const AI_ENV = { AI_COMPLIANCE_ENABLED: "true", ANTHROPIC_API_KEY: "test-key-not-real" };
export const SWEEP_ENV = { ...FLAG_ON, ...AI_ENV };
export const HAIKU = "claude-haiku-5-5";
export const SONNET = "claude-sonnet-5-5";
export const FUNDS = ["fund_a", "fund_b", "fund_g"] as const;
export const ALL_ASSISTED: Record<string, FundMode> = { fund_a: "ASSISTED", fund_b: "ASSISTED", fund_g: "ASSISTED" };
export const ALL_AUTOPILOT: Record<string, FundMode> = { fund_a: "AUTOPILOT", fund_b: "AUTOPILOT", fund_g: "AUTOPILOT" };

// The SQLSTATE and the joined messages of a database refusal, however deeply the driver wrapped it.
export const dbError = async (promise: PromiseLike<unknown>) => promise.then(() => ({ code: "", message: "no error" }), (error: unknown) => {
  let current: unknown = error; let code = ""; const messages: string[] = [];
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    if ("code" in current && typeof current.code === "string" && !code) code = current.code;
    if ("message" in current && typeof current.message === "string") messages.push(current.message);
    current = "cause" in current ? current.cause : undefined;
  }
  return { code, message: messages.join(" | ") };
});

// Writes one approved mode for a fund the way the two-step change does: a proposal by one approver, then the next version approved by another. It writes the rows directly
// (the database guards still run), so a test can store AUTOPILOT, which the service refuses to propose.
export async function setMode(db: AppDatabase, fundId: string, mode: FundMode, people: { proposer?: string; approver?: string } = {}) {
  const [last] = await db.select({ version: s.fundModes.version }).from(s.fundModes).where(eq(s.fundModes.fundId, fundId)).orderBy(desc(s.fundModes.version)).limit(1);
  const baseVersion = last?.version ?? 0;
  const [proposal] = await db.insert(s.fundModeProposals).values({ fundId, mode, baseVersion, proposedBy: people.proposer ?? "tara" }).returning({ id: s.fundModeProposals.id });
  if (!proposal) throw new Error("Proposal was not created");
  await db.insert(s.fundModes).values({ fundId, version: baseVersion + 1, mode, proposalId: proposal.id, approvedBy: people.approver ?? "ben" });
  return { proposalId: proposal.id, version: baseVersion + 1 };
}
export async function setModes(db: AppDatabase, modes: Record<string, FundMode>) {
  for (const [fundId, mode] of Object.entries(modes)) await setMode(db, fundId, mode);
}

// A second organization with its own approver, claimant and fund, to prove the organization checks. Inserts organizations, users and one fund only.
export async function otherOrganization(db: AppDatabase) {
  await db.insert(s.organizations).values({ id: "other-org", name: "Other Organization", prohibitedCategories: [], isFixture: true, openingSourceType: "fixture_opening_balance" });
  await db.insert(s.users).values([
    { id: "zed", organizationId: "other-org", username: "zed", displayName: "Zed", role: "APPROVER", passwordHash: "not-a-real-hash", isFixture: true },
    { id: "zoe", organizationId: "other-org", username: "zoe", displayName: "Zoe", role: "CLAIMANT", passwordHash: "not-a-real-hash", isFixture: true },
  ]);
}

// The stub Claude client. It records every request and answers from a handler that sees the parsed user message.
export type Receipt = { fund: { name: string; clauses: { id: string; text: string }[] }; receipt: { vendor: string; date: string; lines: { id: string; description: string; amountCents: number }[] } };
export type Seen = { model: string; request: ComplianceRequest; options: { timeout?: number; maxRetries?: number; signal?: AbortSignal } | undefined };
export type Handler = (seen: Seen, input: Receipt, nth: number) => unknown;
export function stub(handler: Handler) {
  const seen: Seen[] = [];
  const client = { messages: { async create(request: ComplianceRequest, options?: Seen["options"]) {
    const entry: Seen = { model: request.model, request, options };
    seen.push(entry);
    return await handler(entry, JSON.parse(request.messages[0]!.content) as Receipt, seen.length);
  } } } as unknown as ClaudeMessagesClient;
  return { client, seen };
}
export const envelope = (model: string, text: string, patch: Record<string, unknown> = {}) => ({ id: "msg_test", type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 120, output_tokens: 30 }, ...patch });
export type Spec = (line: Receipt["receipt"]["lines"][number], index: number, input: Receipt) => [string, string | null];
export const answer = (call: Seen, input: Receipt, spec: Spec) => envelope(call.model, JSON.stringify({ lines: input.receipt.lines.map((line, index) => { const [verdict, clauseId] = spec(line, index, input); return { lineId: line.id, verdict, clauseId }; }) }));
export const allOk: Handler = (call, input) => answer(call, input, () => ["OK", null]);
export const unsureAll: Handler = (call, input) => answer(call, input, () => ["UNSURE", null]);
export const conflictAll: Handler = (call, input) => answer(call, input, (_line, _index, whole) => ["CONFLICT", whole.fund.clauses[3]!.id]);
export const isAshmere = (input: Receipt) => input.fund.name.startsWith("Ashmere");
export const notJson: Handler = call => envelope(call.model, "this is not json");
