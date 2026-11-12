import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// IAC-413 PR A static checks (docs/plans/DONOR_TRAIL_SCOPE.md section 6, GT-30 for the modules this package adds, and the read-only
// parts of GT-21 and GT-26). Source text only: no database, no network.
const source = (path: string) => readFileSync(path, "utf8");
// Code only: whole-line comments are removed so a comment that names a forbidden thing does not trip a check on code.
const code = (path: string) => source(path).split("\n").map(line => line.replace(/^\s*(\/\/|\*|\/\*).*$/, "")).join("\n");
// Value imports only. A type-only import is erased at build time and carries no runtime reach.
const imports = (text: string) => [...text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map(match => match[1]!)
  .concat([...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map(match => match[1]!));
const BANNED = /(^|\/)(ledger\/(service|payout|retry|journal|donation|opening|reconcile|snapshot|webhooks)|paypal|ai|donation\/orders|server\/claim-actions|server\/payments|server\/webhook-[a-z]+)(\/|$)/;
const PAGE = "src/app/gift/[token]";
const READERS = ["src/donation/gift-link.ts", "src/donation/trail.ts", "src/server/gift-csp.ts", "src/server/gift-rate-limit.ts", `${PAGE}/page.tsx`, `${PAGE}/trail-view.tsx`, `${PAGE}/not-found.tsx`, `${PAGE}/error.tsx`];

function closure(entries: string[]) {
  const seen = new Set<string>(); const queue = [...entries]; const edges: string[] = [];
  while (queue.length) {
    const file = queue.pop()!; if (seen.has(file)) continue; seen.add(file);
    for (const target of imports(source(file))) {
      if (!target.startsWith(".")) { edges.push(`${file} -> ${target}`); continue; }
      const resolved = join(file, "..", target).replace(/\\/g, "/");
      edges.push(`${file} -> ${resolved}`);
      const path = [`${resolved}.ts`, `${resolved}.tsx`, join(resolved, "index.ts"), join(resolved, "index.tsx")].find(candidate => { try { return statSync(candidate).isFile(); } catch { return false; } });
      if (path) queue.push(path);
    }
  }
  return { files: [...seen].sort(), edges };
}

describe("GT-30 the gift modules have no reach into the ledger writers, the PayPal adapter or the order code", () => {
  it("no direct import of a banned module", () => {
    for (const file of [...READERS, "src/proxy.ts", "src/app/give/gift-link-panel.tsx"]) for (const target of imports(source(file))) expect(`${file} -> ${target}`, `${file} -> ${target}`).not.toMatch(BANNED);
  });
  it("the transitive value-import closure of the gift link, the trail and both pages has no banned module", () => {
    const { files, edges } = closure(READERS);
    for (const edge of edges) expect(edge, edge).not.toMatch(BANNED);
    expect(files).toContain("src/donation/note.ts"); expect(files).toContain("src/donation/attribution-reader.ts");
    for (const file of files) expect(file, file).not.toMatch(BANNED);
  });
  it("the proxy and the thank-you panel close over no banned module either", () => {
    for (const edge of [...closure(["src/proxy.ts"]).edges, ...closure(["src/app/give/gift-link-panel.tsx"]).edges]) expect(edge, edge).not.toMatch(BANNED);
  });
  it("the order code does not mention gift links, and no gift module calls the network or a key", () => {
    expect(source("src/donation/orders.ts")).not.toMatch(/gift-link|giftLink|gift_links|GIFT_LINK/);
    for (const file of [...READERS, "src/proxy.ts"]) expect(code(file), file).not.toMatch(/fetch\(|XMLHttpRequest|process\.env|ANTHROPIC_|PAYPAL_/);
  });
});

describe("the trail read model is read only", () => {
  it("trail.ts has no insert, update or delete, never names gift_links, and reads inside a read-only transaction", () => {
    const text = code("src/donation/trail.ts");
    expect(text).not.toMatch(/\.(insert|update|delete)\(/);
    expect(text).not.toMatch(/gift_links|giftLinks|GIFT_LINK/);
    expect(text).not.toMatch(/\bexecute\(\s*sql`\s*(insert|update|delete|truncate|alter|drop|create)/i);
    expect(text).toContain("set transaction read only");
    expect(text).toContain('isolationLevel: "repeatable read"');
  });
  it("trail.ts never converts money to a floating point value", () => {
    const text = source("src/donation/trail.ts");
    for (const banned of ["Number(", "parseFloat", "toFixed", "Math."]) expect(text.includes(banned), banned).toBe(false);
  });
  it("the page files write nothing", () => {
    for (const file of [`${PAGE}/page.tsx`, `${PAGE}/trail-view.tsx`, `${PAGE}/not-found.tsx`, `${PAGE}/error.tsx`]) expect(code(file), file).not.toMatch(/\.(insert|update|delete)\(/);
  });
  it("gift-link.ts writes only gift_links, with one insert and no update or delete", () => {
    const text = code("src/donation/gift-link.ts");
    expect([...text.matchAll(/\.(insert|update|delete)\(\s*(?:s\.)?(\w+)/g)].map(match => `${match[1]} ${match[2]}`)).toEqual(["insert giftLinks"]);
    expect(text).not.toMatch(/console\./);
  });
});

describe("GT-21 the public page never reads a session, a cookie or a header", () => {
  it("imports no auth module and never calls cookies() or headers()", () => {
    for (const file of [`${PAGE}/page.tsx`, `${PAGE}/trail-view.tsx`, `${PAGE}/not-found.tsx`, `${PAGE}/error.tsx`, "src/donation/trail.ts", "src/donation/gift-link.ts"]) {
      for (const target of imports(source(file))) expect(`${file} -> ${target}`, `${file} -> ${target}`).not.toMatch(/(^|\/)auth$|next\/headers/);
      expect(code(file), file).not.toMatch(/\bcookies\(|\bheaders\(|findSession|SESSION_COOKIE|sessionToken|set-cookie/i);
    }
  });
});

describe("the token is never logged or stored by the server code", () => {
  it("no gift module prints anything", () => {
    for (const file of [...READERS, "src/proxy.ts", "src/app/give/gift-link-panel.tsx"]) expect(code(file), file).not.toMatch(/console\.|localStorage|sessionStorage|document\.cookie/);
  });
});

// Added at the merge: a rewrite of the opening comment once dropped its closing "*/", which turned the whole
// stylesheet into a comment and left the page unstyled while every browser check still passed.
describe("the gift stylesheets close every comment and keep their rules", () => {
  it("gift.css and gift-link-panel.css have balanced comments and their key selectors outside comments", () => {
    const sheets: [string, string[]][] = [
      ["src/app/gift/[token]/gift.css", [".gift-page", ".gift-panel", ".gift-page .gift-trace", ".gift-card", ".gift-footer"]],
      ["src/app/give/gift-link-panel.css", [".gift-link-panel", ".gift-link-actions"]],
    ];
    for (const [file, selectors] of sheets) {
      const text = source(file);
      expect(text.split("/*").length, file).toBe(text.split("*/").length);
      const rules = text.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(rules, file).not.toContain("/*");
      for (const selector of selectors) expect(rules, `${file} ${selector}`).toContain(selector);
    }
  });
});
