import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXPORT_MODE } from "./support/export-mode";

// IAC-440 Package A static checks (docs/GATE_REPORT.md section 58, DR-37): who may write the policy tables, what the model path can reach, and that
// no money, claim-approval, payout or PayPal path reaches the draft module. Source text only. The folder is src/rules-draft because
// tests/policy-static.test.ts pins the exact file list of src/policy and is a guard test that stays as it is.
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
const source = (path: string) => readFileSync(path, "utf8");
const code = (path: string) => source(path).split("\n").map(line => line.replace(/^\s*\/\/.*$/, "")).join("\n");
const imports = (text: string) => [...text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map(match => match[1]!)
  .concat([...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map(match => match[1]!));
const BANNED = /(^|\/)(ledger\/(service|payout|retry|journal|donation|opening|reconcile|snapshot|webhooks)|paypal|server\/claim-actions|server\/payments|server\/webhook-[a-z]+)(\/|$)/;
const FILES = ["src/rules-draft/draft-request.ts", "src/rules-draft/draft-validate.ts", "src/rules-draft/drafts.ts"];
const WRITE = /\.(?:insert|update|delete)\(\s*s\.(\w+)/g;
// The one ledger edge, amended for the November 1 fixes and allowed for drafts.ts only: the serializable helper (finding D) and the existing solver
// priority revision that a breadth-changing bind re-applies in its own transaction (finding A). Both names are pinned. No other ledger name may be imported.
const LEDGER_EDGE = "../ledger/service";
const LEDGER_NAMES = ["advanceSolverPriorityInTransaction", "serializable"];
const isLedgerEdge = (file: string, target: string) => file === "src/rules-draft/drafts.ts" && target === LEDGER_EDGE;

describe("DR-37 import and write boundaries of the draft module", () => {
  it("lists exactly the three files this package adds under src/rules-draft", () => { expect(walk("src/rules-draft").sort()).toEqual(FILES); });
  it("imports only drizzle, the schema, the catalogs, the model client modules, the policy compliance helpers, the pure domain model and itself, plus the one pinned ledger edge for drafts.ts", () => {
    const allowed = /^(drizzle-orm|\.\.\/\.\.\/db\/schema|\.\.\/ai\/(categories|budget|claude-client|provider)|\.\.\/policy\/(compliance|service)|\.\.\/domain\/model|\.\.\/server\/db|\.\/(draft-request|draft-validate|drafts))$/;
    for (const file of FILES) for (const target of imports(source(file))) {
      if (isLedgerEdge(file, target)) continue;
      expect(target, `${file} -> ${target}`).toMatch(allowed);
      expect(target, `${file} -> ${target}`).not.toMatch(BANNED);
    }
  });
  it("the ledger edge is drafts.ts alone and names exactly the serializable helper and the solver priority revision", () => {
    for (const file of FILES) {
      const edges = imports(source(file)).filter(target => /ledger/.test(target));
      expect(edges, file).toEqual(file === "src/rules-draft/drafts.ts" ? [LEDGER_EDGE] : []);
    }
    const clause = source("src/rules-draft/drafts.ts").match(/^import\s*\{([^}]*)\}\s*from\s*["']\.\.\/ledger\/service["']/m);
    expect(clause, "a named import from the ledger service").not.toBeNull();
    expect(clause![1]!.split(",").map(name => name.trim()).filter(Boolean).sort()).toEqual(LEDGER_NAMES);
    // Neither name is re-exported, so no other module reaches the ledger through the draft module.
    expect(code("src/rules-draft/drafts.ts")).not.toMatch(/export\s*\{[^}]*(serializable|advanceSolverPriorityInTransaction)|export\s*\*/);
  });
  it("the transitive closure has no ledger writer, payout, retry, journal, PayPal, payment or claim-action module, apart from the pinned ledger edge, which is not followed", () => {
    const seen = new Set<string>(); const queue = [...FILES];
    while (queue.length) {
      const file = queue.pop()!; if (seen.has(file)) continue; seen.add(file);
      for (const target of imports(source(file))) {
        if (!target.startsWith(".")) continue;
        // The ledger service is reviewed as its own boundary (tests/versioning and the ledger tests). Only this one edge is exempt, and only from this file.
        if (isLedgerEdge(file, target)) continue;
        const resolved = join(file, "..", target).replace(/\\/g, "/");
        expect(resolved, `${file} -> ${target}`).not.toMatch(BANNED);
        const path = [`${resolved}.ts`, join(resolved, "index.ts")].find(candidate => { try { return statSync(candidate).isFile(); } catch { return false; } });
        if (path) queue.push(path);
      }
    }
    expect(seen.size).toBeGreaterThan(FILES.length);
  });
  it("only drafts.ts writes to the database, and only these seven tables", () => {
    expect(code("src/rules-draft/draft-request.ts")).not.toMatch(/\.(insert|update|delete)\(|\.execute\(|\bsql`/);
    expect(code("src/rules-draft/draft-validate.ts")).not.toMatch(/\.(insert|update|delete)\(|\.execute\(|\bsql`/);
    const written = [...code("src/rules-draft/drafts.ts").matchAll(WRITE)].map(match => match[1]);
    expect([...new Set(written)].sort()).toEqual(["fundBudgetLines", "fundCheckSettings", "fundPolicyClauses", "fundPolicyVersions", "funds", "policyDraftEvents", "policyDrafts"]);
    // The funds write is the one pointer move, guarded by the base version, and nothing else in the file updates or deletes a row.
    const text = code("src/rules-draft/drafts.ts");
    expect([...text.matchAll(/\.update\(\s*s\.(\w+)/g)].map(match => match[1])).toEqual(["funds"]);
    expect(text).not.toMatch(/\.delete\(|truncate/i);
    // Raw SQL is limited to one statement: the organization advisory lock, with the ledger's key (hashtext of the organization id), taken for an approver.
    expect([...text.matchAll(/\.execute\(/g)]).toHaveLength(1);
    expect([...text.matchAll(/\bsql`/g)]).toHaveLength(1);
    expect(text).toMatch(/\.execute\(sql`select pg_advisory_xact_lock\(hashtext\(\$\{s\.users\.organizationId\}\)::bigint\) from \$\{s\.users\} where \$\{s\.users\.id\} = \$\{actorId\} and \$\{s\.users\.role\} = 'APPROVER'`\)/);
  });
  it("the model request module never touches the database, an event, an approval or a policy row, and has no tool, key read or network call of its own", () => {
    const text = code("src/rules-draft/draft-request.ts");
    expect(imports(source("src/rules-draft/draft-request.ts")).join(" ")).not.toMatch(/db\/schema|server\/db|drizzle/);
    // The system prompt text legitimately says a person approves, so the check names code identifiers, not the word.
    expect(text).not.toMatch(/\bs\.[a-z]|\btx\.|\bdb\.|\bbind\(|\bapproveDraft|policyDraftEvents|fundPolicyVersions/);
    expect(text).not.toMatch(/fetch\(|XMLHttpRequest|require\(|ANTHROPIC_API_KEY\s*[:=]\s*["'`]/);
    expect(text).not.toMatch(/\btools\s*:|tool_choice|mcp_servers/);
  });
  it("the validator is pure: no database, network, clock, randomness or process access", () => {
    const text = code("src/rules-draft/draft-validate.ts");
    expect(imports(source("src/rules-draft/draft-validate.ts")).sort()).toEqual(["../ai/categories", "../domain/model"]);
    expect(text).not.toMatch(/process\.|fetch\(|Date\.now|new Date\(\)|Math\.random|crypto/);
  });
  it("the service reads no environment itself: the caller passes it", () => {
    expect(code("src/rules-draft/drafts.ts")).not.toMatch(/process\.env/);
  });
});

describe("DR-37 nothing outside the draft package reaches the draft module in Package A", () => {
  it("no route, server action, UI component or other source file imports src/rules-draft, and only the schema names its tables", () => {
    const owners = [...walk("src"), ...walk("db").filter(path => path.endsWith(".ts")), ...walk("scripts").filter(path => /\.(ts|mjs)$/.test(path))]
      .filter(path => !path.startsWith("src/rules-draft/") && /\.(ts|tsx|mjs)$/.test(path));
    const importers = owners.filter(path => /rules-draft/.test(code(path))).sort();
    // Package B (IAC-440, docs/ASSUMPTIONS.md section 72) adds the review screen. Its files are named here one by one, so a new importer fails this test until a person adds it.
    const reviewScreen = [
      "src/app/api/funds/[fundId]/rules/drafts/[draftId]/route.ts", "src/app/api/funds/[fundId]/rules/drafts/route.ts", "src/app/api/funds/[fundId]/rules/pdf-text/route.ts",
      "src/app/funds/[fundId]/rules/drafts/[draftId]/page.tsx", "src/app/funds/[fundId]/rules/page.tsx",
      "src/app/rules-ui/current-rules.tsx", "src/app/rules-ui/draft-form.tsx", "src/app/rules-ui/draft-list.tsx", "src/app/rules-ui/edit-form.tsx",
      "src/app/rules-ui/labels.ts", "src/app/rules-ui/review-rows.ts", "src/app/rules-ui/review-screen.tsx",
      "src/server/rules-draft-actions.ts", "src/server/rules-input.ts", "src/server/rules-notices.ts",
    ];
    // scripts/prepare-judge-export.mjs names the owner-only test files tests/rules-draft-eval.test.ts and tests/rules-draft-schema-harness.test.ts (IAC-442); it imports nothing from the draft module.
    // scripts/check-judge-preparation.mjs names only the ignore glob **/rules-draft.spec.ts in the judge ui-check ignore list (November 5, IAC-232, JX-05); it imports nothing from the draft module.
    expect(importers).toEqual(["db/schema.ts", "scripts/check-judge-preparation.mjs", "scripts/prepare-judge-export.mjs", "scripts/rules-draft-eval.ts", "scripts/support/rules-draft-eval.ts", ...reviewScreen].filter(path => !EXPORT_MODE || owners.includes(path)).sort());
    // The judge export omits the export script, so the pin runs where the script exists, as the filter above does; in the owner tree (release/judge present) it always runs and a missing script fails.
    if (!EXPORT_MODE || owners.includes("scripts/check-judge-preparation.mjs")) expect([...code("scripts/check-judge-preparation.mjs").matchAll(/[\w./*-]*rules-draft[\w./-]*/g)].map(match => match[0])).toEqual(["**/rules-draft.spec.ts"]);
    if (!EXPORT_MODE || owners.includes("scripts/prepare-judge-export.mjs")) expect([...code("scripts/prepare-judge-export.mjs").matchAll(/[\w./-]*rules-draft[\w./-]*/g)].map(match => match[0])).toEqual(["tests/rules-draft-eval.test.ts", "tests/rules-draft-schema-harness.test.ts"]);
    for (const file of owners.filter(path => path.startsWith("src/"))) expect(code(file), file).not.toMatch(/policyDrafts|policyDraftEvents|policy_drafts|policy_draft_events/);
  });
  it("no money, approval, payout, PayPal or claim path names the draft module, its tables or its flag", () => {
    const money = [...walk("src/ledger"), "src/server/claim-actions.ts", ...walk("src/paypal")];
    for (const file of money) expect(source(file), file).not.toMatch(/rules-draft|policyDraft|policy_draft|AI_RULE_DRAFTS/);
  });
  it("only the policy version, budget line, settings, clause and pointer writes in drafts.ts name the policy tables from the rules-draft folder", () => {
    // No other src file outside src/policy, src/rules-draft, the seed and the ledger reads writes a policy version, budget line, clause or pointer.
    for (const file of walk("src").filter(path => !path.startsWith("src/rules-draft/") && /\.(ts|tsx)$/.test(path))) {
      const text = code(file);
      expect(text, file).not.toMatch(/\.(?:insert|update|delete)\(\s*s\.(fundPolicyVersions|fundBudgetLines|fundPolicyClauses|funds)\b/);
    }
  });
});
