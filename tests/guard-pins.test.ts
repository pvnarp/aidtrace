import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

// GP-01 to GP-03: repository-wide pins for docs/SPEC.md section 13 rule 7 ("Only `src/paypal/adapter.ts` may call PayPal.
// Only the ledger module may write journal entries.") and AGENTS.md section 3. Source text only. No database, no network.
// AU-22 (tests/autopilot-static.test.ts) covers only the payouts path under src; these cover absolute PayPal host URLs, the
// v1 to v3 REST families listed in PAYPAL_REST, scripts and release, and the journal tables. A relative path outside that
// family list is not detected.
// This file ships in a judge export (scripts/prepare-judge-export.mjs ships tests/ minus ownerOnlyTests). An export has no
// release/judge or tools folder: it copies release/judge/* to its root and omits the owner-only scripts, so the GP-01 paths
// follow whichever layout exists, as tests/claude-only.test.ts and tests/judge-session-config.test.ts do.
const inExport = !existsSync("release/judge");
const layout = (path: string) => inExport && path.startsWith("release/judge/") ? path.slice("release/judge/".length) : path;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);
const exists = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  if (SKIP_DIRS.has(name)) return [];
  const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path];
});
const source = (path: string) => readFileSync(path, "utf8");
const norm = (path: string) => path.replace(/\\/g, "/");
// Code only: YAML compose files, JSON, Markdown, CSS and fonts are configuration or text, not callers. The extensionless
// `aidtrace` control scripts are shell and are scanned.
const isCode = (path: string) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sh)$/.test(path) || basename(path) === "aidtrace";
const codeUnder = (roots: string[]) => roots.filter(exists).flatMap(walk).map(norm).filter(isCode).sort();
const ADAPTER = "src/paypal/adapter.ts";

// GP-01 detectors. A PayPal host (API, web, SDK or static asset) or a PayPal REST family path under v1, v2 or v3.
const PAYPAL_HOST = /paypal(?:objects)?\.com/i;
const PAYPAL_REST = /\bv[1-3]\/(?:oauth2|checkout|payments|notifications|reporting|identity|customers?|vault|invoicing|billing|catalogs|disputes|shipping|partner-referrals)\b/;
const namesPayPal = (line: string) => PAYPAL_HOST.test(line) || PAYPAL_REST.test(line);

// The exact lines outside the adapter that may name a PayPal host, by file and trimmed text. None of them sends a request.
// Any new line, or an edit to one of these, fails GP-01 and needs a reviewed entry here.
const PAYPAL_LINE_ALLOWLIST: ReadonlyArray<readonly [string, string, string]> = [
  // The donor's browser loads PayPal's JavaScript SDK for the buttons; the page posts to /api/donations, and order create
  // and capture run server side through the adapter.
  ["src/app/give/give-client.tsx", "script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&components=buttons&currency=USD&intent=capture`;", "browser SDK script"],
  // The /give Content Security Policy host list. A header value, not a request.
  ["src/server/give-csp.ts", 'const PAYPAL_HOSTS = "https://*.paypal.com https://*.paypalobjects.com";', "CSP host list"],
  // Mode decisions compare the configured PAYPAL_BASE_URL with the sandbox host.
  ["src/server/donation-mode.ts", 'const SANDBOX_URL = "https://api-m.sandbox.paypal.com";', "mode comparison"],
  ["src/server/judge-mode.ts", 'env.PAYPAL_BASE_URL === "https://api-m.sandbox.paypal.com" &&', "mode comparison"],
  // Onboarding checks assert the configured value.
  ["scripts/check-judge-onboarding-config.mjs", "assert.equal(a.environment.PAYPAL_BASE_URL,'https://api-m.sandbox.paypal.com');", "config assertion"],
  ["scripts/check-judge-onboarding.mjs", "assert.equal(fields.APP_ORIGIN,'http://127.0.0.1:3100');assert.equal(fields.PAYPAL_BASE_URL,'https://api-m.sandbox.paypal.com');", "config assertion"],
  // Fresh local configuration templates write the sandbox base URL with empty credentials.
  ["scripts/init-local.mjs", '"PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com",', "config template"],
  ["release/judge/scripts/init-local.mjs", '"PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com",', "config template"],
  // The judge session's fixed, non-payable environment.
  ["release/judge/scripts/judge-session.mjs", 'AIDTRACE_JUDGE_SESSION: "true", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",', "judge session config"],
];
const key = (file: string, line: string) => `${file} :: ${line}`;
// Every PayPal-naming line, keyed by file and trimmed text, one key per occurrence.
const paypalHits = (entries: ReadonlyArray<readonly [file: string, text: string]>) => entries.flatMap(([file, text]) => text.split("\n").filter(namesPayPal).map(line => key(file, line.trim()))).sort();
// The allowlist in the current layout. In the source tree every entry must match. In an export, release/judge/<p> becomes <p>,
// the owner-only onboarding checks are absent, and scripts/init-local.mjs is the release copy, so its two entries become one key.
const allowedKeys = () => [...new Set(PAYPAL_LINE_ALLOWLIST.map(([file, line]) => [layout(file), line] as const).filter(([file]) => !inExport || existsSync(file)).map(([file, line]) => key(file, line)))].sort();

describe("GP-01 only src/paypal/adapter.ts names a PayPal host or REST path", () => {
  const files = codeUnder(["src", "scripts", "release", "tools"]).filter(path => path !== ADAPTER);

  it("GP-01: the scan reaches the files it claims to cover", () => {
    for (const expected of ["src/server/donation-actions.ts", "src/server/judge-mode.ts", "scripts/init-local.mjs", layout("release/judge/scripts/judge-session.mjs"), "scripts/aidtrace"]) expect(files, expected).toContain(expected);
    expect(files).not.toContain(ADAPTER);
    expect(files.some(path => /\.ya?ml$/.test(path))).toBe(false);
  });

  it("GP-01: every line outside the adapter that names PayPal is an exact allowlisted line, and every allowlisted line still exists", () => {
    expect(paypalHits(files.map(file => [file, source(file)] as const))).toEqual(allowedKeys());
  });

  it("GP-01: the detectors bite on direct calls and leave unrelated URLs alone", () => {
    for (const bad of [
      "await fetch(`${env.PAYPAL_BASE_URL}/v2/checkout/orders/${id}/capture`, { method: \"POST\" });",
      "const token = await fetch(\"https://api-m.sandbox.paypal.com/v1/oauth2/token\");",
      "await fetch(base + \"/v1/oauth2/token\", init);",
      "const url = \"https://api-m.paypal.com\";",
      "await request(`${base}/v1/payments/payouts`);",
      "await call(\"/v1/reporting/balances?currency_code=USD\");",
      "await call(`/v1/notifications/webhooks/${id}`);",
      "curl -s https://API-M.SANDBOX.PAYPAL.COM/v1/identity/oauth2/userinfo",
      "await fetch(`${env.PAYPAL_BASE_URL}/v3/vault/payment-tokens`, init);",
      "await call(\"/v3/vault/setup-tokens\", body);",
    ]) expect(namesPayPal(bad), bad).toBe(true);
    for (const good of ["export const UI_TEST_STUB_URL = \"http://127.0.0.1:8080/v1/messages\";", "const payout = await provider.send(prepared);", "import { createPayPalAdapter } from \"../paypal/adapter\";", "await fetch(\"/v3/users/me\");"]) expect(namesPayPal(good), good).toBe(false);
  });

  it("GP-01: a new line in an allowlisted file is not covered by that file's entry", () => {
    // The real donation-mode.ts plus one synthetic call, run through the same collection the scan uses.
    const file = "src/server/donation-mode.ts", extra = "await fetch(`${SANDBOX_URL}/v1/oauth2/token`);";
    const allowed = allowedKeys().filter(entry => entry.startsWith(`${file} :: `));
    expect(allowed).toHaveLength(1);
    expect(paypalHits([[file, source(file)]])).toEqual(allowed);
    const widened = paypalHits([[file, `${source(file)}\n${extra}`]]);
    expect(widened).not.toEqual(allowed); expect(widened).toContain(key(file, extra)); expect(widened).toHaveLength(2);
  });
});

// GP-02 detectors. A file that both names the PayPal secret and calls fetch could build its own authenticated call.
const NAMES_SECRET = /PAYPAL_CLIENT_SECRET|\bclientSecret\b/;
const CALLS_FETCH = /\bfetch\s*\(/;
const secretAndFetch = (text: string) => NAMES_SECRET.test(text) && CALLS_FETCH.test(text);

describe("GP-02 no file other than the adapter both names the PayPal secret and calls fetch", () => {
  it("GP-02: the set is empty over src, scripts, release and tools", () => {
    const files = codeUnder(["src", "scripts", "release", "tools"]).filter(path => path !== ADAPTER);
    // The scan sees both halves today: files that name the secret and files that call fetch, just never the same file.
    expect(files.some(path => NAMES_SECRET.test(source(path)))).toBe(true);
    expect(files.some(path => CALLS_FETCH.test(source(path)))).toBe(true);
    expect(files.filter(path => secretAndFetch(source(path)))).toEqual([]);
  });

  it("GP-02: the detector bites on a synthetic file and leaves either half alone", () => {
    expect(secretAndFetch("const secret = env.PAYPAL_CLIENT_SECRET;\nconst res = await fetch(url, { headers });")).toBe(true);
    expect(secretAndFetch("const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`);\nawait globalThis.fetch (url);")).toBe(true);
    expect(secretAndFetch("if (env.PAYPAL_CLIENT_SECRET?.trim()) return \"KEYED\";")).toBe(false);
    expect(secretAndFetch("const response = await fetch(\"/api/donations\", { method: \"POST\" });")).toBe(false);
  });
});

// GP-03 detectors. Drizzle writes name the table object (`s.journalEntries`, `schema.journalPostings` or a bare named import);
// raw SQL names journal_entries or journal_postings (db/schema.ts, pgTable("journal_entries") and pgTable("journal_postings")).
const DRIZZLE_WRITE = /\.(?:insert|update|delete)\(\s*(?:\w+\.)?journal(?:Entries|Postings)\b/;
const SQL_WRITE = /\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?|merge\s+into)\s+(?:only\s+)?(?:"?public"?\.)?"?journal_(?:entries|postings)\b/i;
const writesJournal = (text: string) => DRIZZLE_WRITE.test(text) || SQL_WRITE.test(text);
const LEDGER_WRITERS = ["src/ledger/journal.ts"];

describe("GP-03 only the ledger module writes the journal tables", () => {
  // tests/ is out of scope on purpose: tests/ledger.integration.test.ts writes the tables directly to prove the triggers refuse
  // empty, unbalanced, updated, deleted and truncated journal rows.
  it("GP-03: over src, scripts, db and e2e the only writer is src/ledger/journal.ts", () => {
    const files = [...codeUnder(["src", "scripts", "db", "e2e"]), ...(exists("db/migrations") ? walk("db/migrations").map(norm).filter(path => path.endsWith(".sql")) : [])];
    expect(files).toContain("src/ledger/journal.ts"); expect(files).toContain("db/fixture.ts"); expect(files).toContain("db/migrations/0003_ledger-constraints.sql");
    expect(files.filter(path => writesJournal(source(path))).sort()).toEqual(LEDGER_WRITERS);
  });

  it("GP-03: migrations name the journal tables for DDL and triggers only, which the detector leaves alone", () => {
    // Migrations are scanned above. They create the tables, add constraints and attach the immutable, no-truncate, insert guard
    // and balance triggers; none inserts, updates, deletes or truncates rows. This pins that their text reaches the detector
    // without tripping it, so a future data migration that writes journal rows fails GP-03.
    const ddl = source("db/migrations/0000_fine_luckman.sql"); const triggers = source("db/migrations/0003_ledger-constraints.sql");
    expect(ddl).toMatch(/CREATE TABLE "journal_entries"/); expect(triggers).toMatch(/BEFORE UPDATE OR DELETE ON journal_entries/); expect(triggers).toMatch(/BEFORE TRUNCATE ON journal_postings/);
    expect(writesJournal(ddl)).toBe(false); expect(writesJournal(triggers)).toBe(false);
  });

  it("GP-03: the writer module really writes both tables", () => {
    const journal = source("src/ledger/journal.ts");
    expect(journal).toMatch(/tx\.insert\(s\.journalEntries\)/); expect(journal).toMatch(/tx\.insert\(s\.journalPostings\)/);
  });

  it("GP-03: the detectors bite on drizzle and raw SQL writes and leave reads and DDL alone", () => {
    for (const bad of [
      "await tx.insert(s.journalEntries).values({ sourceType, sourceId, purpose, effectiveOn });",
      "await tx.insert(\n    s.journalPostings).values(rows);",
      "await db.update(schema.journalEntries).set({ purpose: \"changed\" });",
      "await db.delete(journalPostings);",
      "await db.execute(sql`insert into journal_entries (source_type) values ('x')`);",
      "await client`INSERT INTO \"journal_postings\" (entry_id) VALUES (${id})`;",
      "UPDATE ONLY public.journal_entries SET purpose = 'x';",
      "DELETE FROM journal_postings WHERE entry_id = $1;",
      "truncate journal_entries cascade",
      "TRUNCATE TABLE \"public\".\"journal_postings\";",
    ]) expect(writesJournal(bad), bad).toBe(true);
    for (const good of [
      "const [row] = await connection.client`select count(*)::int as n from journal_postings`;",
      "(select count(*) from journal_entries) as count",
      "CREATE TRIGGER journal_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();",
      "CREATE TRIGGER posting_no_truncate BEFORE TRUNCATE ON journal_postings FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();",
      "ALTER TABLE \"journal_postings\" ADD CONSTRAINT \"posting_known_account\" CHECK (true);",
      "const rows = await db.select().from(s.journalPostings);",
    ]) expect(writesJournal(good), good).toBe(false);
  });
});
