import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fundAutopilotEnabled } from "../src/fund-modes/flag";

// IAC-405 step 3 PR P (docs/plans/FUND_MODES_SCOPE.md section 5, docs/ASSUMPTIONS.md section 78), AU-21 onward: static boundaries of the second flag, the automated send, the kill switch routes and
// the FIXTURE history source. File reads only. No database, no network.
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
const sourceFiles = (dir: string) => walk(dir).filter(path => /\.(ts|tsx)$/.test(path));
const importsOf = (path: string) => [...readFileSync(path, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(match => match[1]!);
const text = (path: string) => readFileSync(path, "utf8");
const norm = (paths: string[]) => paths.map(path => path.replace(/\\/g, "/")).sort();

describe("AU-21 the second flag", () => {
  it("AU-21: FUND_AUTOPILOT_ENABLED counts only when exactly true and only with FUND_MODES_ENABLED exactly true", () => {
    for (const value of [undefined, "", "false", "TRUE", "True", "1", "yes", " true", "true ", "on"]) {
      expect(fundAutopilotEnabled({ FUND_MODES_ENABLED: "true", FUND_AUTOPILOT_ENABLED: value }), JSON.stringify(value)).toBe(false);
      expect(fundAutopilotEnabled({ FUND_MODES_ENABLED: value, FUND_AUTOPILOT_ENABLED: "true" }), JSON.stringify(value)).toBe(false);
    }
    expect(fundAutopilotEnabled({})).toBe(false);
    expect(fundAutopilotEnabled({ FUND_MODES_ENABLED: "true", FUND_AUTOPILOT_ENABLED: "true" })).toBe(true);
  });

  it("AU-21: the compose file does not set either flag, and every writer of the switch and the mode checks the second flag", () => {
    expect(text("compose.yaml")).not.toContain("FUND_AUTOPILOT_ENABLED");
    expect(text("src/fund-modes/automation-read.ts")).toMatch(/export async function readAutomationSwitch[\s\S]*if \(!fundAutopilotEnabled\(deps\.env\)\) return refuse\("FLAG_OFF"\)/);
    const switchText = text("src/fund-modes/switch.ts");
    for (const name of ["proposeAutomationOn", "confirmAutomationOn", "turnAutomationOff", "recordDisagreement"]) {
      const body = switchText.slice(switchText.indexOf(`export async function ${name}`)); const end = body.indexOf("\n}\n");
      expect(body.slice(0, end), name).toMatch(/if \(!fundAutopilotEnabled\(deps\.env\)\) return refuse\("FLAG_OFF"\)/);
    }
    expect(text("src/fund-modes/modes.ts")).toMatch(/fundAutopilotEnabled/);
    expect(text("src/fund-modes/change.ts")).toMatch(/fundAutopilotEnabled/);
    expect(text("src/policy/service.ts")).toMatch(/fundAutopilotEnabled/);
  });
});

describe("AU-22 only the ledger sends, and nothing on the web reaches the automated send or the sweep", () => {
  it("AU-22: sendAutomatedPayout is defined in src/ledger/payout.ts and imported by the sweep module alone", () => {
    const importers = [...sourceFiles("src"), ...sourceFiles("scripts")].filter(path => /\bsendAutomatedPayout\b/.test(text(path)) && !/payout\.ts$/.test(path));
    expect(norm(importers)).toEqual(["src/fund-modes/policy-sweep.ts"]);
  });

  it("AU-22: no file under src/app or src/server imports the automated send, the sweep modules or the guardrails", () => {
    const offenders = [...sourceFiles("src/app"), ...sourceFiles("src/server")].filter(path => {
      const body = text(path);
      return /\bsendAutomatedPayout\b|\brecognizeAutonomously\b|\bevaluateGuardrails\b|\btripOnUnknownSend\b/.test(body) || importsOf(path).some(spec => /fund-modes\/policy-sweep$|fund-modes\/guardrails$|policy\/sweep$/.test(spec));
    });
    expect(norm(offenders)).toEqual([]);
  });

  it("AU-22: no module under src/fund-modes calls the payment transport, and none outside the adapter and payout.ts reaches PayPal", () => {
    for (const path of sourceFiles("src/fund-modes")) {
      const body = text(path);
      expect(body, path).not.toMatch(/\bprovider\.(send|balance|batch|item)\(|\btransport\.(send|balance|batch|item)\(|\bfetch\(/);
      for (const spec of importsOf(path)) if (/paypal\//.test(spec)) expect(body, `${path} ${spec}`).toMatch(new RegExp(`import type [^;]*from "${spec.replace(/[./]/g, "\\$&")}"`));
    }
    const reachers = [...sourceFiles("src")].filter(path => !/src\/paypal\//.test(path.replace(/\\/g, "/")) && /v1\/payments\/payouts/.test(text(path)));
    expect(norm(reachers)).toEqual([]);
    expect(text("src/server/automation-actions.ts")).not.toMatch(/ledger\/|paypal\/|policy-sweep|payout/);
  });

  it("AU-22: the automated send re-checks inside the persisting transaction, in order, and posts through the shared core and transmit step", () => {
    const source = text("src/ledger/payout.ts");
    const start = source.indexOf("export async function sendAutomatedPayout"); const body = source.slice(start, source.indexOf("function codeOf", start));
    const order = ["fundAutopilotEnabled(deps.env)", "claim.status !== \"APPROVED\"", "AUTO_RECOGNIZED", "modeAtRecognition(tx, expectedHash, edges, deps.env)", "automationState(tx, claim.organizationId)", "automationAllowed(state)", "g3FundDay(tx, edges, now, expectedHash)", "g4ClaimantWeek(tx, claim, claimCents, now, expectedHash)", "provider.validatePayout(claim.payeeEmail, claimCents)", "balance.readable", "recordAutopilot(tx, expectedHash, \"AUTO_SENT\"", "persistPayout(tx, claim, expectedHash, provider, balance, { automatedDecisionId: sendId })", "transmitPrepared(db, claimId, null"];
    const positions = order.map(needle => body.indexOf(needle, body.indexOf("const prepared = await serializable")));
    order.forEach((needle, index) => { if (index > 0 && !needle.startsWith("fundAutopilot") && !needle.startsWith("claim.status")) expect(positions[index], needle).toBeGreaterThan(-1); });
    const checks = positions.slice(3, 12); expect(checks).toEqual([...checks].sort((a, b) => a - b));
    expect(body).not.toMatch(/provider\.send\(/);
    expect(source).toMatch(/export async function sendClaimPayout[\s\S]*persistPayout\(tx, claim, expectedHash, provider, balance, \{ signedBy: actorId \}\)[\s\S]*transmitPrepared\(db, claimId, actorId, prepared, provider\)/);
  });
});

// AU-23 helper. The body of one exported handler, bounded by the next top-level export, so a check deleted from
// handleFundAutomation cannot be satisfied by the copy in handleClaimDisagree below it.
const ROUTE_ORDER = ["fundAutopilotEnabled(deps.env)", "request.method", "isSameOrigin", "findSession", '"APPROVER"'];
const handlerBody = (source: string, name: string) => {
  const start = source.indexOf(`export async function ${name}`); if (start === -1) return "";
  const end = source.indexOf("\nexport ", start + 1); return source.slice(start, end === -1 ? undefined : end);
};
const routeOrderProblems = (source: string, name: string): string[] => {
  const body = handlerBody(source, name); if (!body) return [`${name} not found`];
  const positions = ROUTE_ORDER.map(needle => body.indexOf(needle));
  const problems = ROUTE_ORDER.filter((_, index) => positions[index] === -1).map(needle => `${name} lacks ${needle}`);
  for (let index = 1; index < positions.length; index++) if (positions[index - 1]! > -1 && positions[index]! > -1 && positions[index - 1]! > positions[index]!) problems.push(`${name}: ${ROUTE_ORDER[index - 1]} after ${ROUTE_ORDER[index]}`);
  return problems;
};

describe("AU-23 the kill switch routes", () => {
  it("AU-23: each route is a thin wrapper over one handler and the handler answers 404 before anything else when the second flag is off", () => {
    for (const [path, handler] of [["src/app/api/funds/[fundId]/automation/route.ts", "handleFundAutomation"], ["src/app/api/claims/[claimId]/automation/route.ts", "handleClaimDisagree"]] as const) {
      const body = text(path);
      expect(body, path).toContain(handler); expect(body, path).toMatch(/export \{ action as GET, action as POST, action as PUT, action as PATCH, action as DELETE \}/);
      expect(importsOf(path).filter(spec => spec.startsWith("."))).toEqual(["../../../../../server/db", expect.stringMatching(/server\/automation-actions$/)]);
    }
    const actions = text("src/server/automation-actions.ts");
    for (const name of ["handleFundAutomation", "handleClaimDisagree"]) expect(routeOrderProblems(actions, name), name).toEqual([]);
    // The bound holds: handleFundAutomation's body stops before handleClaimDisagree starts.
    const fundBody = handlerBody(actions, "handleFundAutomation");
    expect(fundBody).not.toContain("export async function handleClaimDisagree"); expect(fundBody.length).toBeLessThan(actions.length - actions.indexOf("export async function handleFundAutomation"));
  });

  it("AU-23: the helper fails a handler that lacks a check even when the next handler still has it", () => {
    const handler = (name: string, lines: string[]) => [`export async function ${name}(request: Request, id: string, deps: AutomationRouteDeps): Promise<Response> {`, ...lines.map(line => `    ${line}`), "}"].join("\n");
    const flag = 'if (!fundAutopilotEnabled(deps.env)) return text(404, "Not found");', method = 'if (request.method !== "POST") return text(405, "Method not allowed", { Allow: "POST" });';
    const origin = 'if (!isSameOrigin(request)) return text(403, "Request origin rejected");', session = "const user = await findSession(sessionToken(request), deps.db);", role = 'if (user.role !== "APPROVER") return text(403, "Approver access required");';
    const withoutOrigin = [handler("handleFundAutomation", [flag, method, session, role]), handler("handleClaimDisagree", [flag, method, origin, session, role])].join("\n\n");
    expect(routeOrderProblems(withoutOrigin, "handleFundAutomation")).toEqual(["handleFundAutomation lacks isSameOrigin"]);
    expect(routeOrderProblems(withoutOrigin, "handleClaimDisagree")).toEqual([]);
    // The old unbounded slice ran to the end of the file and found the next handler's copy, which is why it passed.
    expect(withoutOrigin.slice(withoutOrigin.indexOf("export async function handleFundAutomation"))).toContain("isSameOrigin");
    const withoutRole = [handler("handleFundAutomation", [flag, method, origin, session]), handler("handleClaimDisagree", [flag, method, origin, session, role])].join("\n\n");
    expect(routeOrderProblems(withoutRole, "handleFundAutomation")).toEqual(['handleFundAutomation lacks "APPROVER"']);
    const reordered = [handler("handleFundAutomation", [flag, method, session, origin, role])].join("\n");
    expect(routeOrderProblems(reordered, "handleFundAutomation")).toEqual(["handleFundAutomation: isSameOrigin after findSession"]);
    expect(routeOrderProblems(reordered, "handleMissing")).toEqual(["handleMissing not found"]);
  });
});

describe("AU-24 the FIXTURE history source", () => {
  it("AU-24: only db/fixture.ts writes a FIXTURE history row; the claims trigger writes CLAIM; no web or domain code names the source", () => {
    const writers = [...sourceFiles("src"), ...sourceFiles("scripts"), ...sourceFiles("db").filter(path => !/schema\.ts$/.test(path)), ...sourceFiles("e2e")].filter(path => /source: "FIXTURE"|'FIXTURE'/.test(text(path)));
    expect(norm(writers)).toEqual(["db/fixture.ts"]);
    const migration = text("db/migrations/0020_autopilot.sql");
    expect(migration).toMatch(/INSERT INTO payee_email_history \(user_id, email, source\) VALUES \(NEW\.claimant_id, NEW\.payee_email, 'CLAIM'\)/);
    const readers = sourceFiles("src").filter(path => /["']FIXTURE["']/.test(text(path)));
    expect(norm(readers)).toEqual(["src/fund-modes/guardrails.ts"]);
  });

  it("AU-24: the seed writes the demo row once, 45 days back, only where the table exists", () => {
    const fixture = text("db/fixture.ts");
    expect(fixture).toContain("DEMO_HISTORY_DAYS = 45");
    expect(fixture).toContain("to_regclass('public.payee_email_history')");
    expect(fixture).toMatch(/userId: "maria", email: payeeEmail, source: "FIXTURE"/);
  });
});

describe("AU-25 migration 0020", () => {
  it("AU-25: each new table has its immutable and no-truncate triggers, and the new guards exist", () => {
    const migration = text("db/migrations/0020_autopilot.sql");
    for (const table of ["payee_email_history", "automation_switch_events", "disbursement_origins"]) {
      expect(migration, table).toMatch(new RegExp(`BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable\\(\\)`));
      expect(migration, table).toMatch(new RegExp(`BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable\\(\\)`));
    }
    for (const needle of ["disbursement_origin_exactly_one", "payee_email_history_source", "switch_event_shape", "aidtrace_recognition_guard", "aidtrace_automated_kind_guard", "aidtrace_switch_event_insert_guard", "aidtrace_disbursement_origin_insert_guard"]) expect(migration, needle).toContain(needle);
  });
  // The AU-25 check of scripts/policy-sweep.ts moved to the owner-only tests/policy-sweep-script.test.ts (IAC-442): the script is not in the judge export.
});

describe("AU-48 the organization lock is the first statement of the automated transactions", () => {
  const firstInTransactions = (source: string) => [...source.matchAll(/async tx => \{\s*\n?\s*(const claim = await lockClaimRowOrgFirst\(tx, [A-Za-z.]+, [A-Za-z.]+\);|[^\n]*)/g)].map(match => match[1]!.trim());
  it("AU-48: the helper runs the advisory lock before any select, and the automated recognition and both transactions of the automated send call it first", () => {
    const service = text("src/ledger/service.ts");
    const helper = service.slice(service.indexOf("export async function lockClaimRowOrgFirst"), service.indexOf("async function lockClaim(tx"));
    expect(helper.indexOf("pg_advisory_xact_lock")).toBeGreaterThan(-1);
    expect(helper.indexOf("pg_advisory_xact_lock")).toBeLessThan(helper.indexOf("tx.select"));
    expect(helper.indexOf("pg_advisory_xact_lock")).toBeLessThan(helper.indexOf("for update"));
    const auto = service.slice(service.indexOf("export async function recognizeAutonomously"), service.indexOf("export async function", service.indexOf("export async function recognizeAutonomously") + 10));
    expect(firstInTransactions(auto.slice(auto.indexOf("serializable(db"))).slice(0, 1)).toEqual(["const claim = await lockClaimRowOrgFirst(tx, located.organizationId, located.claimId);"]);
    const payout = text("src/ledger/payout.ts");
    const send = payout.slice(payout.indexOf("export async function sendAutomatedPayout"), payout.indexOf("function codeOf"));
    expect([...send.matchAll(/serializable\(db, async tx => \{\s*\n\s*([^\n]*)/g)].map(match => match[1]!.trim())).toEqual(["const claim = await lockClaimRowOrgFirst(tx, located.organizationId, claimId);", "const claim = await lockClaimRowOrgFirst(tx, located.organizationId, claimId);"]);
    expect(send).not.toMatch(/lockedClaim\(/);
  });

  it("AU-48: the draw is made once outside the retried closure, and the fresh switch read follows the lock in both paths", () => {
    const service = text("src/ledger/service.ts");
    const auto = service.slice(service.indexOf("export async function recognizeAutonomously"));
    expect(auto.indexOf("let drawn")).toBeGreaterThan(-1);
    expect(auto.indexOf("let drawn")).toBeLessThan(auto.indexOf("serializable(db"));
    expect(auto).toMatch(/audit \}\);/);
    expect(auto.indexOf("lockClaimRowOrgFirst(tx")).toBeLessThan(auto.indexOf("automationState(db, claim.organizationId)"));
    expect(text("src/ledger/payout.ts")).toMatch(/lockClaimRowOrgFirst\(tx[\s\S]*automationState\(db, claim\.organizationId\)/);
  });

  it("AU-48: an automated recognition needs a provider in the sweep, and Autopilot G1 is the strict check", () => {
    const sweepText = text("src/fund-modes/policy-sweep.ts");
    expect(sweepText).toMatch(/autopilotOn && !deps\.provider && \(await recordedMode\(db, hash\)\) === "AUTOPILOT"\) log\(\{ event: "autopilot-skipped-no-provider"/);
    expect(sweepText.indexOf("autopilot-skipped-no-provider")).toBeLessThan(sweepText.indexOf("recognizeAutonomously(db, hash"));
    expect(text("src/fund-modes/guardrails.ts")).toMatch(/noHoldsFor\(tx, decision\.decisionHash, now, \{ strict: true \}\)/);
  });
});
