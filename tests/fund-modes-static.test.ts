import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fundModesEnabled } from "../src/fund-modes/flag";
import { ALLOWED_MODULE_NAMES, BASE_MODULES, SELECTION_MODULES } from "../src/app/grid/modules";

// IAC-405 step 2 PR F, FM-25: static boundaries of the flag, the sweep and the deployment file.
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
const sourceFiles = (dir: string) => walk(dir).filter(path => /\.(ts|tsx)$/.test(path));
const importsOf = (path: string) => [...readFileSync(path, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(match => match[1]!);

describe("FM-25 static boundaries", () => {
  it("FM-25: nothing under src/server or src/app imports the sweep modules", () => {
    const offenders = [...sourceFiles("src/server"), ...sourceFiles("src/app")].filter(path => importsOf(path).some(spec => /(^|\/)policy\/sweep$|fund-modes\/policy-sweep$|\.\/sweep$|\.\/policy-sweep$/.test(spec)));
    expect(offenders).toEqual([]);
  });

  it("FM-25: the web policy route imports only the approver-trigger entry points of the checks", () => {
    const text = readFileSync("src/server/policy-actions.ts", "utf8");
    expect(text).not.toMatch(/runRulesCheck|runModelCheckAs|sweepRulesCheck|sweepModelCheck|trigger/);
    expect(text).toMatch(/import \{ runModelCheck, type ModelRunDeps \} from "..\/policy\/model-run"/);
    expect(text).toMatch(/import \{ runPolicyChecks \} from "..\/policy\/service"/);
  });

  it("FM-25: only the sweep module imports the SWEEP entry points", () => {
    // The script's own imports are checked in the owner-only tests/policy-sweep-script.test.ts (IAC-442): scripts/policy-sweep.ts is not in the judge export.
    const importers = sourceFiles("src").filter(path => importsOf(path).some(spec => /(^|\/)policy\/sweep$/.test(spec)));
    expect(importers).toEqual([join("src", "fund-modes", "policy-sweep.ts")]);
  });

  it("FM-25: the flag is on only for exactly the text true", () => {
    for (const value of [undefined, "", "false", "TRUE", "True", "1", "yes", " true", "true ", "on"]) expect(fundModesEnabled({ FUND_MODES_ENABLED: value }), JSON.stringify(value)).toBe(false);
    expect(fundModesEnabled({})).toBe(false);
    expect(fundModesEnabled({ FUND_MODES_ENABLED: "true" })).toBe(true);
  });

  it("FM-25: the compose service reads the app's env file and does not set the flag (the script's refusal is in the owner-only tests/policy-sweep-script.test.ts)", () => {
    const compose = readFileSync("compose.yaml", "utf8");
    const block = (name: string) => { const start = compose.indexOf(`\n  ${name}:`); expect(start, name).toBeGreaterThan(-1); const rest = compose.slice(start + 1); const next = rest.slice(1).search(/\n  [a-z-]+:\n|\nvolumes:/); return next < 0 ? rest : rest.slice(0, next + 1); };
    const worker = block("fund-modes-worker"); const app = block("app");
    const envFile = (text: string) => text.match(/env_file:\n\s+- path: (\S+)\n\s+required: (\S+)/)?.slice(1);
    expect(envFile(worker)).toBeDefined();
    expect(envFile(worker)).toEqual(envFile(app));
    expect(worker).toContain("profiles: [fund-modes]");
    expect(worker).toContain("scripts/policy-sweep.ts, --loop");
    expect(worker.replace(/^\s*#.*$/gm, "")).not.toContain("FUND_MODES_ENABLED");
    expect(app).not.toContain("FUND_MODES_ENABLED");
  });
});

describe("FM-25 no app or server file reaches recognition or a rules run", () => {
  it("FM-25: no file under src/server or src/app contains recognizeWhenReady, runRulesCheck or the literal SWEEP", () => {
    // policy-actions.ts could call runRulesCheck with an APPROVER starter; today it does not (it calls runPolicyChecks), so the allowance is empty and pinned as empty.
    const ALLOWED_RUN_RULES_CHECK: string[] = [];
    const found = (pattern: RegExp) => [...sourceFiles("src/server"), ...sourceFiles("src/app")].filter(path => pattern.test(readFileSync(path, "utf8")));
    expect(found(/recognizeWhenReady/)).toEqual([]);
    expect(found(/\bSWEEP\b/)).toEqual([]);
    expect(found(/runRulesCheck/)).toEqual(ALLOWED_RUN_RULES_CHECK);
  });
  it("FM-25: approveFundMode reads the organization's unrecognized decisions after taking the organization lock (the tightening read)", () => {
    const text = readFileSync("src/fund-modes/change.ts", "utf8");
    const body = text.slice(text.indexOf("export async function approveFundMode"), text.indexOf("export type PendingProposal"));
    const lock = body.indexOf("await lockOrganization(");
    const read = body.search(/from\(s\.allocationDecisions\)\.where\(and\(eq\(s\.allocationDecisions\.organizationId, gated\.organizationId\), isNull\(s\.allocationDecisions\.recognizedAt\)\)\)/);
    expect(lock).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(lock);
    expect(body.indexOf("tx.insert(s.fundModes)")).toBeGreaterThan(read);
  });
});

describe("FM-25 the fund mode route", () => {
  it("FM-25: the flag check is the first statement of the handler and the form type is compared whole, as the rules routes do", () => {
    const text = readFileSync("src/server/fund-mode-actions.ts", "utf8");
    const body = text.slice(text.indexOf("export async function handleFundMode"));
    expect(body.indexOf("fundModesEnabled(deps.env)")).toBeGreaterThan(-1);
    expect(body.indexOf("fundModesEnabled(deps.env)")).toBeLessThan(body.indexOf("request.method"));
    expect(text).toMatch(/const mediaType = \(request: Request\): string => \(request\.headers\.get\("content-type"\) \?\? ""\)\.split\(";"\)\[0\]!\.trim\(\)\.toLowerCase\(\);/);
    expect(text).toContain("if (mediaType(request) !== FORM_TYPE) return text(415");
    expect(text).not.toMatch(/startsWith\("application/);
    expect(text).toMatch(/approveFundMode\(deps\.db, actor, form\.get\("proposalId"\)!, \{ env \}, fundId\)/);
  });
});

// IAC-405 step 2 PR A, AS-20 to AS-24: static boundaries of the bulk approval route and the Assisted queue screens. Source text only.
const code = (path: string) => readFileSync(path, "utf8").split("\n").map(line => line.replace(/^\s*\/\/.*$/, "")).join("\n");
const importsInCode = (path: string) => [...code(path).matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s*["']([^"']+)["']/gm)].map(match => match[1]!).concat([...code(path).matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map(match => match[1]!));
function closureOf(entry: string): Set<string> {
  const seen = new Set<string>(); const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!; if (seen.has(file)) continue; seen.add(file);
    for (const target of importsInCode(file)) {
      if (!target.startsWith(".")) continue;
      const resolved = join(file, "..", target).replace(/\\/g, "/");
      const found = [`${resolved}.ts`, `${resolved}.tsx`, join(resolved, "index.ts")].find(candidate => { try { return statSync(candidate).isFile(); } catch { return false; } });
      if (found) queue.push(found);
    }
  }
  return seen;
}
const BULK_ROUTE = "src/app/api/approvals/bulk/route.ts";

describe("AS-20 the bulk approval route reaches no PayPal, payout or sweep module", () => {
  it("AS-20: its whole import closure, ledger service included, holds no PayPal adapter, payout, retry, webhook, claim action or sweep file", () => {
    const seen = [...closureOf(BULK_ROUTE)];
    expect(seen).toEqual(expect.arrayContaining([BULK_ROUTE, "src/server/bulk-approve-actions.ts", "src/fund-modes/bulk-approve.ts", "src/ledger/service.ts"]));
    expect(seen.filter(file => /(^|\/)paypal\/|ledger\/(payout|retry|webhooks)|policy-sweep|policy\/sweep|server\/(claim-actions|payments|webhook-)/.test(file))).toEqual([]);
    // The ledger service itself defines recognizeWhenReady for the sweep, so the sweep entry points are checked in every file the route owns and every other file in the closure.
    for (const file of seen) expect(code(file), file).not.toMatch(file === "src/ledger/service.ts" ? /PAYPAL_|api-m\.|sendClaimPayout/ : /PAYPAL_|api-m\.|sendClaimPayout|runRulesCheck|sweepRulesCheck|sweepModelCheck|recognizeWhenReady/);
  });
  it("AS-20: the service imports exactly approveDecision and serializable from the ledger service and nothing else from the ledger", () => {
    const text = readFileSync("src/fund-modes/bulk-approve.ts", "utf8");
    expect(importsInCode("src/fund-modes/bulk-approve.ts").filter(target => /ledger/.test(target))).toEqual(["../ledger/service"]);
    const clause = text.match(/^import\s*\{([^}]*)\}\s*from\s*["']\.\.\/ledger\/service["']/m);
    expect(clause).not.toBeNull();
    expect(clause![1]!.split(",").map(name => name.trim()).filter(Boolean)).toEqual(["approveDecision", "serializable"]);
    expect(text).not.toMatch(/export\s*(\{[^}]*\}|\*)\s*from\s*["'][^"']*ledger/);
  });
  it("AS-20: no browser file for the queue imports a server writer, and the only fetch posts to the bulk route", () => {
    const files = readdirSync("src/app/assisted-queue").map(name => join("src/app/assisted-queue", name)).filter(path => /\.(ts|tsx)$/.test(path));
    for (const file of files) for (const target of importsInCode(file)) expect(target, `${file} -> ${target}`).not.toMatch(/ledger|paypal|payout|webhook|claim-actions|payments|bulk-approve$|bulk-approve-actions|policy-sweep|server\/db/);
    const client = code("src/app/assisted-queue/client.tsx");
    expect([...client.matchAll(/fetch\(([^,]+),/g)].map(match => match[1])).toEqual(["'/api/approvals/bulk'"]);
    expect(client).toMatch(/credentials: 'same-origin'/);
    expect(client).not.toMatch(/https?:\/\/|decisionHash|decisionId|hash|ag-grid-enterprise|AllCommunityModule/);
    expect(client.match(/body\.append\('([a-zA-Z]+)'/g)).toEqual(["body.append('claim'"]);
  });
});

describe("AS-21 the bulk approval route checks in the fixed order", () => {
  it("AS-21: the flag, the method, the origin, the session, the approver role, the form type, the bounded body and the exact fields come in that order, before any write", () => {
    const text = code("src/server/bulk-approve-actions.ts");
    const body = text.slice(text.indexOf("export async function handleBulkApprove"));
    const order = ["fundModesEnabled(deps.env)", 'request.method !== "POST"', "isSameOrigin(request)", "findSession(", 'user.role !== "APPROVER"', "mediaType(request) !== FORM_TYPE", "BULK_BODY_LIMIT", 'key !== "claim"', "values.length > BULK_LIMIT", "bulkApprove("].map(piece => body.indexOf(piece));
    for (const index of order) expect(index).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toMatch(/const mediaType = \(request: Request\): string => \(request\.headers\.get\("content-type"\) \?\? ""\)\.split\(";"\)\[0\]!\.trim\(\)\.toLowerCase\(\);/);
    expect(text).not.toMatch(/startsWith\("application|process\.env|console\.|Access-Control/);
    expect(text.match(/new Response\(/g)).toHaveLength(2);
    expect(text).toContain('const HEADERS = { "Cache-Control": "no-store" };');
  });
  it("AS-21: the service decides one claim at a time in its own serializable transaction and recomputes no holds, the mode and the claimant itself, then records through approveDecision with its own hash", () => {
    const text = code("src/fund-modes/bulk-approve.ts");
    expect(text).toMatch(/return serializable\(db, async \(tx\)/);
    const checkOrder = ["claim.version !== item.claimVersion", "modeAtRecognition(tx, decision.decisionHash, edges, env)", "noHoldsFor(tx, decision.decisionHash)", "claim.claimantId === actor.id", "approveDecision(db, checked.decisionId, actorId, checked.hash"].map(piece => text.indexOf(piece));
    for (const index of checkOrder) expect(index).toBeGreaterThan(-1);
    expect([...checkOrder].sort((a, b) => a - b)).toEqual(checkOrder);
    expect(text).not.toMatch(/process\.env|console\.|\bfetch\(/);
    expect(text).toMatch(/for \(const item of items\)/);
    expect(text).toMatch(/catch \(error\) \{ skip\(failureReason\(error\)\); \}/);
  });
});

describe("AS-22 the queue selection uses the Community row selection module only", () => {
  it("AS-22: RowSelection is on the allowed list, is not in the base modules, and only the Assisted queue passes it", () => {
    expect(ALLOWED_MODULE_NAMES).toContain("RowSelection");
    expect(SELECTION_MODULES.map(module => (module as { moduleName?: string }).moduleName)).toEqual(["RowSelection"]);
    expect(BASE_MODULES.map(module => (module as { moduleName?: string }).moduleName)).not.toContain("RowSelection");
    const importers = sourceFiles("src")
      .filter(path => /SELECTION_MODULES/.test(readFileSync(path, "utf8"))).sort();
    expect(importers).toEqual([join("src", "app", "assisted-queue", "client.tsx"), join("src", "app", "grid", "modules.ts")].sort());
    for (const path of ["src/app/grid/modules.ts", "src/app/assisted-queue/client.tsx", "src/app/grid/grid.tsx"]) expect(code(path), path).not.toMatch(/ag-grid-enterprise|AllCommunityModule|AllEnterpriseModule/);
  });
  it("AS-22: a row is selectable only when the server marked it selectable, and the queue without the flag never reaches the Assisted client", () => {
    const client = code("src/app/assisted-queue/client.tsx");
    expect(client).toContain("const isRowSelectable = (row: AssistedQueueRow) => row.selectable === true;");
    const queue = code("src/app/approver-queue/client.tsx");
    expect(queue).toContain("if (assisted) return <AssistedQueueClient");
    const page = code("src/app/page.tsx");
    expect(page).toContain("assistedChecks.size > 0 ? Object.fromEntries(assistedChecks) : undefined");
  });
});

describe("AS-23 the Checks read", () => {
  it("AS-23: it is one read only repeatable read transaction of SELECT statements that starts with the flag, and it reuses noHoldsFor and modeAtRecognition", () => {
    const text = code("src/server/assisted-checks.ts");
    expect(text.indexOf("fundModesEnabled(deps.env)")).toBeGreaterThan(-1);
    expect(text.indexOf("fundModesEnabled(deps.env)")).toBeLessThan(text.indexOf("db.transaction("));
    expect(text.indexOf("set transaction read only")).toBeGreaterThan(-1);
    expect(text.indexOf("set transaction read only")).toBeLessThan(text.indexOf(".select(", text.indexOf("db.transaction(")));
    expect(text).toMatch(/isolationLevel: "repeatable read"/);
    expect(text).not.toMatch(/\.(insert|update|delete|truncate)\s*\(/);
    expect(text).toContain("noHoldsFor(tx, decision.hash, now)");
    expect(text).toContain("modeAtRecognition(tx, decision.hash, edges, deps.env)");
    expect(importsInCode("src/server/assisted-checks.ts").filter(target => /ledger|paypal|payout|sweep/.test(target))).toEqual([]);
  });
});
