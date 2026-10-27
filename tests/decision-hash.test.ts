import { expect, it } from "vitest";
import { allocate } from "../src/domain/allocate";
import { buildDecisionPayload, hashDecision, type DecisionTerms } from "../src/domain/hash";
import { fixture } from "./fixtures/allocation";
function terms(): DecisionTerms {
  const input = fixture(); const result = allocate(input); if (result.status !== "FUNDED") throw new Error("Fixture allocation required");
  return { claimId: "C-104", claimVersion: 1, claimantId: "maria", vendor: "Brightbench Supply Co.", program: input.program, incurredOn: "2026-10-14", lines: input.lines.map(line => ({ ...line, description: line.id })), edges: result.edges, fundPolicyVersions: { fund_a: 1, fund_b: 1, fund_g: 1 }, solverPriorityVersion: 1, payeeEmail: "recipient@personal.example.com" };
}
it("canonicalizes equivalent key and array ordering into the same approval hash", () => {
  const original = terms(); const first = buildDecisionPayload(original);
  const second = buildDecisionPayload({ ...original, lines: [...original.lines].reverse(), edges: [...original.edges].reverse(), fundPolicyVersions: { fund_g: 1, fund_b: 1, fund_a: 1 } });
  expect(hashDecision(first)).toMatch(/^[a-f0-9]{64}$/); expect(hashDecision(first)).toBe(hashDecision(second));
  expect(first.lines.every(line => typeof line.amountCents === "string")).toBe(true);
});
it.each(["payee", "amount", "category", "budget", "claimant", "vendor", "policy", "description", "reason", "date"])("binds changed %s terms to a new hash", field => {
  const original = terms(); let changed = { ...original };
  if (field === "payee") changed.payeeEmail = "different@personal.example.com";
  if (field === "claimant") changed.claimantId = "another-claimant";
  if (field === "vendor") changed.vendor = "Another vendor";
  if (field === "date") changed.incurredOn = "2026-10-15";
  if (field === "policy") changed.fundPolicyVersions = { ...original.fundPolicyVersions, fund_b: 2 };
  if (["amount", "category", "budget", "description"].includes(field)) changed.lines = original.lines.map((line, index) => index ? line : { ...line, ...(field === "amount" ? { amountCents: line.amountCents + 1n } : field === "category" ? { category: "other" } : field === "budget" ? { budgetLine: "other" } : { description: "Changed description" }) });
  if (field === "reason") changed.edges = original.edges.map((edge, index) => index ? edge : { ...edge, reason: "Changed explanation" });
  expect(hashDecision(buildDecisionPayload(changed))).not.toBe(hashDecision(buildDecisionPayload(original)));
});
it("rejects malformed Unicode rather than hashing an ambiguous replacement", () => {
  expect(() => hashDecision(buildDecisionPayload({ ...terms(), vendor: "\ud800" }))).toThrow();
});
