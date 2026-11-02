import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// IAC-440 Package B, DR-119 (docs/GATE_REPORT.md section 60): what the review screen, its three routes and its helpers may import and do. Source text only.
// Package A's DR-37 pins the importers of src/rules-draft. This file pins the Package B edge: no PayPal, ledger write, payout, claim approval or webhook module,
// no markup injection, no logging, no cross-origin header, no environment read in the new server files.
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
const source = (path: string) => readFileSync(path, "utf8");
const code = (path: string) => source(path).split("\n").map(line => line.replace(/^\s*\/\/.*$/, "")).join("\n");
const imports = (text: string) => [...text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map(match => match[1]!)
  .concat([...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map(match => match[1]!));
const BANNED = /(^|\/)(ledger\/(service|payout|retry|journal|donation|opening|reconcile|snapshot|webhooks)|paypal|server\/claim-actions|server\/payments|server\/webhook-[a-z]+)(\/|$)/;
const PINNED_EDGE = { file: "src/rules-draft/drafts.ts", target: "../ledger/service" };

const ROUTES = ["src/app/api/funds/[fundId]/rules/drafts/route.ts", "src/app/api/funds/[fundId]/rules/drafts/[draftId]/route.ts", "src/app/api/funds/[fundId]/rules/pdf-text/route.ts"];
const PAGES = ["src/app/funds/[fundId]/rules/page.tsx", "src/app/funds/[fundId]/rules/drafts/[draftId]/page.tsx"];
const SERVER = ["src/server/rules-draft-actions.ts", "src/server/rules-input.ts", "src/server/rules-notices.ts", "src/server/pdf-text.ts", "src/server/fund-rules-links.ts"];
const UI = walk("src/app/rules-ui").sort();
const NEW_FILES = [...ROUTES, ...PAGES, ...SERVER, ...UI, "src/app/ai-disclosure.ts"];

function closure(entry: string[]): Set<string> {
  const seen = new Set<string>(); const queue = [...entry];
  while (queue.length) {
    const file = queue.pop()!; if (seen.has(file)) continue; seen.add(file);
    for (const target of imports(source(file))) {
      if (!target.startsWith(".")) continue;
      if (file === PINNED_EDGE.file && target === PINNED_EDGE.target) continue;
      const resolved = join(file, "..", target).replace(/\\/g, "/");
      const path = [`${resolved}.ts`, `${resolved}.tsx`, join(resolved, "index.ts")].find(candidate => { try { return statSync(candidate).isFile(); } catch { return false; } });
      if (path) queue.push(path);
    }
  }
  return seen;
}

describe("DR-119 the review screen reaches no money, payout, claim approval or webhook module", () => {
  it("names the real files, so the checks below cannot pass on an empty list", () => {
    expect(UI.map(path => path.replace("src/app/rules-ui/", ""))).toEqual(["current-rules.tsx", "draft-form.tsx", "draft-list.tsx", "edit-form.tsx", "labels.ts", "review-rows.ts", "review-screen.tsx"]);
    for (const file of NEW_FILES) expect(statSync(file).isFile(), file).toBe(true);
  });
  it("no new file imports PayPal, any ledger module, a claim action, a payment or a webhook module directly", () => {
    for (const file of NEW_FILES) for (const target of imports(source(file))) {
      expect(target, `${file} -> ${target}`).not.toMatch(BANNED);
      expect(target, `${file} -> ${target}`).not.toMatch(/ledger|paypal|payout|webhook|claim-actions|payments/i);
    }
  });
  it("the transitive closure of the three routes and two pages has no banned module, apart from the one pinned ledger edge that Package A owns and DR-37 pins", () => {
    const seen = closure([...ROUTES, ...PAGES]);
    for (const file of seen) for (const target of imports(source(file))) {
      if (file === PINNED_EDGE.file && target === PINNED_EDGE.target) continue;
      expect(target, `${file} -> ${target}`).not.toMatch(BANNED);
    }
    expect(seen.has("src/rules-draft/drafts.ts")).toBe(true);
    expect(seen.has("src/server/pdf-text.ts")).toBe(true);
    expect([...seen].filter(file => /(^|\/)paypal\//.test(file) || /src\/ledger\//.test(file))).toEqual([]);
  });
  it("the PDF route and the PDF extractor reach neither the database tables of a draft nor the model client", () => {
    const pdfOnly = closure(["src/server/pdf-text.ts"]);
    expect([...pdfOnly]).toEqual(["src/server/pdf-text.ts"]);
    expect(code("src/server/pdf-text.ts")).not.toMatch(/drizzle|db\/schema|server\/db|claude|anthropic|fetch\(|process\.env|console\./i);
    expect(imports(source("src/server/pdf-text.ts"))).toEqual(["unpdf"]);
  });
  it("the three route files are thin: one handler call each, every method sent to the same checks, and nothing else", () => {
    for (const route of ROUTES) {
      const text = code(route);
      expect(text.match(/export \{ action as GET, action as POST, action as PUT, action as PATCH, action as DELETE \};/), route).not.toBeNull();
      expect(text.split("\n").filter(line => line.trim()).length, route).toBeLessThanOrEqual(10);
      expect(imports(source(route)).map(target => target.replace(/^(\.\.\/)+/, "")).sort(), route).toEqual(["server/db", "server/rules-draft-actions"]);
      expect(text, route).toMatch(/export const dynamic = "force-dynamic";/);
      expect(text, route).toMatch(/export const runtime = "nodejs";/);
    }
  });
});

describe("DR-119 the new files inject no markup, log nothing, and open no cross-origin or redirect hole", () => {
  it("no new file uses dangerouslySetInnerHTML, innerHTML, eval, new Function, document.write or a script string", () => {
    for (const file of NEW_FILES) expect(code(file), file).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML|\binsertAdjacentHTML|\beval\(|new Function\(|document\.write|<script/);
  });
  it("no new server or UI file logs, so no grant text, cookie or key can reach a log", () => {
    for (const file of NEW_FILES) expect(code(file), file).not.toMatch(/\bconsole\.|\blogger\b|\bdebugger\b/);
  });
  it("no new server file reads the environment: the route file passes the real one only through the service's own default", () => {
    for (const file of [...ROUTES, ...SERVER, ...PAGES, ...UI]) expect(code(file), file).not.toMatch(/process\.env|ANTHROPIC_API_KEY|AI_RULE_DRAFTS_ENABLED/);
  });
  it("no response carries a CORS header, and every handler response is no-store", () => {
    const text = code("src/server/rules-draft-actions.ts");
    expect(text).not.toMatch(/Access-Control|access-control/i);
    expect(text).toMatch(/const HEADERS = \{ "Cache-Control": "no-store" \};/);
    const makers = text.split("\n").filter(line => line.includes("new Response("));
    expect(makers).toHaveLength(5);
    for (const line of makers) expect(line, line).toContain("HEADERS");
  });
  it("every redirect is a fixed same-origin path built from a validated id and a code from the notice table, never from request input", () => {
    const text = code("src/server/rules-draft-actions.ts");
    expect([...text.matchAll(/Location:/g)]).toHaveLength(3);
    for (const site of text.matchAll(/Location: (`[^`]*`)/g)) expect(site[1], site[0]).toMatch(/^`\$\{(path\}\$\{noticeQuery\(code, extra\)\}|rulesPath\}\/drafts\/\$\{result\.draftId\}(\$\{noticeQuery\("edited"\)\})?)`$/);
    expect(text).toMatch(/Location: `\$\{path\}\$\{noticeQuery\(code, extra\)\}`/);
    for (const call of text.matchAll(/redirectTo\(([^,]+),/g)) expect(call[1], call[0]).toMatch(/^(reviewPath|rulesPath)$/);
    expect(text).not.toMatch(/request\.(url|headers\.get\("(referer|origin|host|x-forwarded)[^"]*"\))[^;]*Location/i);
    expect(text).not.toMatch(/searchParams\.get\(["'](next|redirect|returnTo|url)/);
    const notices = code("src/server/rules-notices.ts");
    expect(notices).not.toMatch(/redirect\(|Location|new URL\(|https?:\/\//);
  });
  it("both pages are dynamic, check a session and the approver role before reading, and treat a bad id as not found", () => {
    for (const page of PAGES) {
      const text = code(page);
      expect(text, page).toMatch(/export const dynamic = "force-dynamic";/);
      expect(text.indexOf("findSession("), page).toBeGreaterThan(-1);
      expect(text.indexOf('user.role !== "APPROVER"'), page).toBeGreaterThan(text.indexOf("findSession("));
      expect(text.indexOf("readFundRules(") > -1 ? text.indexOf("readFundRules(") : text.indexOf("readDraftReview("), page).toBeGreaterThan(text.indexOf('user.role !== "APPROVER"'));
      expect(text, page).toMatch(/redirect\("\/login"\)/);
      expect(text, page).toMatch(/const ID = \/\^\[A-Za-z0-9_-\]\{1,64\}\$\/;/);
      expect(text, page).toMatch(/notFound\(\)/);
    }
  });
  it("the draft form posts to this app's own two routes with a relative URL and sends cookies only to the same origin", () => {
    const text = code("src/app/rules-ui/draft-form.tsx");
    expect([...text.matchAll(/fetch\(([^,]+),/g)].map(match => match[1])).toEqual(["`/api/funds/${fundId}/rules/pdf-text`"]);
    expect(text).toMatch(/credentials: "same-origin"/);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).toMatch(/action=\{`\/api\/funds\/\$\{fundId\}\/rules\/drafts`\}/);
  });
});
