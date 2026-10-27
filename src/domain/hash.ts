import canonicalize from "canonicalize";
import { createHash } from "node:crypto";
import { compareIds, type AllocationEdge, type ClaimLine } from "./model";

export interface DecisionTerms {
  claimId: string; claimVersion: number; claimantId: string; vendor: string; program: string; incurredOn: string;
  lines: readonly (ClaimLine & { description: string })[]; edges: readonly AllocationEdge[];
  fundPolicyVersions: Readonly<Record<string, number>>; solverPriorityVersion: number; payeeEmail: string;
}
export function buildDecisionPayload(terms: DecisionTerms) {
  if (!Number.isSafeInteger(terms.claimVersion) || terms.claimVersion < 1 || !Number.isSafeInteger(terms.solverPriorityVersion) || terms.solverPriorityVersion < 1) throw new Error("Valid decision versions required");
  const amount = (cents: bigint) => { if (typeof cents !== "bigint" || cents <= 0n) throw new Error("Positive bigint decision amounts required"); return cents.toString(); };
  // Bind every displayed claim detail as well as the spec's financial fields.
  return {
    claimId: terms.claimId, claimVersion: terms.claimVersion, claimantId: terms.claimantId,
    vendor: terms.vendor, program: terms.program, incurredOn: terms.incurredOn,
    lines: terms.lines.map(line => ({ id: line.id, description: line.description, category: line.category, budgetLine: line.budgetLine, incurredOn: line.incurredOn, amountCents: amount(line.amountCents) })).sort((a, b) => compareIds(a.id, b.id)),
    edges: terms.edges.map(edge => ({ fundId: edge.fundId, lineId: edge.lineId, amountCents: amount(edge.amountCents), policyVersion: edge.policyVersion, solverPriorityVersion: edge.solverPriorityVersion, reason: edge.reason })).sort((a, b) => compareIds(a.fundId, b.fundId) || compareIds(a.lineId, b.lineId)),
    fundPolicyVersions: Object.fromEntries(Object.entries(terms.fundPolicyVersions).sort(([a], [b]) => compareIds(a, b))),
    solverPriorityVersion: terms.solverPriorityVersion,
    payee: { wallet: "PAYPAL", recipientType: "EMAIL", receiver: terms.payeeEmail },
  };
}
export type DecisionPayload = ReturnType<typeof buildDecisionPayload>;
export function hashDecision(payload: DecisionPayload) {
  const canonical = canonicalize(payload);
  if (typeof canonical !== "string") throw new Error("Decision cannot be canonically serialized");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
