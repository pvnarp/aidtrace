import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// IAC-405 step 1 static checks (docs/plans/POLICY_CHECK_SCOPE.md section 6): PC-14 (the only AI reach is src/policy/model-run.ts, and it imports
// only the provider, budget and claude-client modules) and PC-17 (the policy module has no money, approval, payout or PayPal reach, and the money
// paths have no reach into it). Piece G added the model files and widened exactly that one AI allowance. Source text only.
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
const source = (path: string) => readFileSync(path, "utf8");
// Code only: line comments are removed so a comment that names a forbidden thing does not trip a check on code.
const code = (path: string) => source(path).split("\n").map(line => line.replace(/^\s*\/\/.*$/, "")).join("\n");
// Value imports only. A type-only import is erased at build time and carries no runtime reach.
const imports = (text: string) => [...text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map(match => match[1]!)
  .concat([...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map(match => match[1]!));
const BANNED = /(^|\/)(ledger\/(service|payout|retry|journal|donation|opening|reconcile|snapshot|webhooks)|paypal|ai|server\/claim-actions|server\/payments|server\/webhook-[a-z]+)(\/|$)/;
// The same list without the ai folder. Piece G lets exactly one file, src/policy/model-run.ts, import three named ai modules (checked below).
const BANNED_NO_AI = /(^|\/)(ledger\/(service|payout|retry|journal|donation|opening|reconcile|snapshot|webhooks)|paypal|server\/claim-actions|server\/payments|server\/webhook-[a-z]+)(\/|$)/;
const AI_ALLOWED = /^\.\.\/ai\/(provider|budget|claude-client)$/;
const SELF = ["src/policy/compliance.ts", "src/policy/copy.ts", "src/policy/facts.ts", "src/policy/model-read.ts", "src/policy/model-run.ts", "src/policy/money.ts", "src/policy/rules.ts", "src/policy/service.ts", "src/policy/text.ts", "src/policy/types.ts"];
const MODEL_RUN = "src/policy/model-run.ts";

describe("PC-17 import boundaries of the policy module", () => {
  const files = [...walk("src/policy"), "src/server/policy-actions.ts", "src/app/api/claims/[claimId]/policy-checks/route.ts"];
  it("lists exactly the files this package adds under src/policy", () => { expect(walk("src/policy").sort()).toEqual(SELF); });
  it("imports none of the ledger service, payout, retry, journal, PayPal or claim-action modules, directly, and reaches src/ai only from model-run", () => {
    for (const file of files) for (const target of imports(source(file))) {
      expect(`${file} -> ${target}`, `${file} -> ${target}`).not.toMatch(BANNED_NO_AI);
      if (/(^|\/)ai(\/|$)/.test(target)) { expect(file, `${file} -> ${target}`).toBe(MODEL_RUN); expect(target, `${file} -> ${target}`).toMatch(AI_ALLOWED); }
    }
  });
  it("src/policy reaches only drizzle, node:crypto, the schema, the database type, the pure receipt screen, the three ai modules (model-run only) and itself", () => {
    const allowed = /^(drizzle-orm|node:crypto|\.\.\/\.\.\/db\/schema|\.\.\/receipt\/prohibited-screen|\.\/(compliance|copy|facts|model-read|model-run|money|rules|service|text|types))$/;
    for (const file of walk("src/policy")) for (const target of imports(source(file))) expect(target, `${file} -> ${target}`).toMatch(file === MODEL_RUN ? new RegExp(`${allowed.source}|${AI_ALLOWED.source}`) : allowed);
  });
  it("the transitive closure of src/policy has no ledger, payout, retry, PayPal or claim-action module", () => {
    const seen = new Set<string>(); const queue = walk("src/policy");
    while (queue.length) {
      const file = queue.pop()!; if (seen.has(file)) continue; seen.add(file);
      for (const target of imports(source(file))) {
        if (!target.startsWith(".")) continue;
        const resolved = join(file, "..", target).replace(/\\/g, "/");
        expect(resolved, `${file} -> ${target}`).not.toMatch(BANNED_NO_AI);
        const path = [`${resolved}.ts`, join(resolved, "index.ts")].find(candidate => { try { return statSync(candidate).isFile(); } catch { return false; } });
        if (path) queue.push(path);
      }
    }
  });
  it("only the policy service and its own module write the policy tables, and no policy file calls PayPal, the ledger writer or an insert on another table", () => {
    const text = SELF.map(code).join("\n");
    const written = [...text.matchAll(/\.(?:insert|update|delete)\(\s*s\.(\w+)/g)].map(match => match[1]);
    expect([...new Set(written)].sort()).toEqual(["policyCheckResults", "policyCheckRuns", "policyModelResults"]);
    expect(text).not.toMatch(/journal(Entries|Postings)|disbursement|reservation|approvals\b.*\.(insert|update)|fetch\(|XMLHttpRequest/i);
    // The process environment is read only by the model module, which passes it to claudeAiStatus and the key lookup. No other policy file reads it.
    for (const file of SELF.filter(path => path !== MODEL_RUN)) expect(code(file), file).not.toMatch(/process\.env/);
    expect(source("src/server/policy-actions.ts")).not.toMatch(/\.(insert|update|delete)\(/);
  });
  it("no money, approval or payout path imports or names the policy module or its tables", () => {
    const money = [...walk("src/ledger"), "src/server/claim-actions.ts", ...walk("src/paypal")];
    for (const file of money) expect(source(file), file).not.toMatch(/policy[-_/]?check|\.\.\/policy\/|policyCheck|fundCheckSettings|fund_check_settings|policyModel|fundPolicyClauses|fund_policy_clauses|model-run|AI_COMPLIANCE/i);
  });
  it("the Approve, Reject and Send controls on the claim page read nothing from the policy section", () => {
    const lines = source("src/app/claims/[claimId]/page.tsx").split("\n").filter(line => /action="(approve|reject|freeze|send|refresh|retry|authorize-retry)"/.test(line));
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const line of lines) expect(line).not.toMatch(/policyChecks|PolicyChecks|policy-checks/);
    expect(source("src/server/claim-actions.ts")).not.toMatch(/policyCheck|policy-check|\.\.\/policy\//);
  });
});

describe("PC-14 the model reach is one file", () => {
  const all = [...walk("src/policy"), "src/server/policy-actions.ts", "src/app/api/claims/[claimId]/policy-checks/route.ts", "src/app/claims/[claimId]/policy-checks.tsx"];
  it("no file imports an Anthropic SDK, and only src/policy/model-run.ts imports src/ai, only the provider, budget and claude-client modules", () => {
    for (const file of all) for (const target of imports(source(file))) {
      expect(target, `${file} -> ${target}`).not.toMatch(/anthropic/i);
      if (/(^|\/)ai(\/|$)/.test(target)) { expect(file, `${file} -> ${target}`).toBe(MODEL_RUN); expect(target, `${file} -> ${target}`).toMatch(AI_ALLOWED); }
    }
  });
  it("only the model module names a key, and only the model module and the pinned request copy name a model or call the client", () => {
    for (const file of all) {
      const text = code(file);
      if (file !== MODEL_RUN) expect(text, file).not.toMatch(/ANTHROPIC|api[-_ ]?key|messages\.create/i);
      if (file !== MODEL_RUN && file !== "src/policy/compliance.ts") expect(text, file).not.toMatch(/claude-/i);
      expect(text, file).not.toMatch(/fetch\(|XMLHttpRequest|console\./);
    }
  });
  it("the claim page and the policy section reach the model only through the display status, the fixed off text and the stored rows", () => {
    expect(code("src/app/claims/[claimId]/policy-checks.tsx")).not.toMatch(/process\.env|runModelCheck|claudeAiStatus/);
    expect(code("src/server/claim-view.ts")).not.toMatch(/runModelCheck|claude-client|\.messages\./);
  });
});
