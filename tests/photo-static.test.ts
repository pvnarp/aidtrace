import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// IAC-384, PH-21 to PH-30 (docs/GATE_REPORT.md section 72): static checks of the photo reader. Source text only.
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
const source = (path: string) => readFileSync(path, "utf8");
const code = (path: string) => source(path).split("\n").map(line => line.replace(/^\s*\/\/.*$/, "").replace(/^\s*\/\*.*\*\/\s*$/, "")).join("\n");
const SRC = walk("src").filter(path => /\.(ts|tsx)$/.test(path));
const PHOTO_FILES = ["src/ai/claude-photo.ts", "src/receipt/photo-reads.ts", "src/server/receipt-photo-actions.ts", "src/server/receipt-photo-rate-limit.ts", "src/app/receipts/photo-reader.tsx", "src/app/receipts/photo-copy.ts", "src/app/api/receipts/photo-text/route.ts"];

describe("PH-21 only claude-photo.ts builds the photo request", () => {
  it("is the only file under src with an image content block, a base64 source or a media_type field", () => {
    const hits = SRC.filter(path => /type:\s*"image"|type:\s*"base64"|media_type/.test(code(path)));
    expect(hits).toEqual(["src/ai/claude-photo.ts"]);
  });
  it("reaches the model only through claudeClientFor and never builds an SDK client or reads the key itself", () => {
    const text = code("src/ai/claude-photo.ts");
    expect(text).toMatch(/claudeClientFor\(key, env\)/);
    expect(text).not.toMatch(/new Anthropic|realClaudeClient|fetch\(|baseURL|tools:|tool_choice/);
    for (const file of PHOTO_FILES.filter(path => path !== "src/ai/claude-photo.ts")) expect(code(file), file).not.toMatch(/ANTHROPIC_API_KEY|new Anthropic|claudeClientFor/);
  });
  it("PH-22 calls the model from one place", () => { expect(SRC.filter(path => /readReceiptPhoto\(/.test(code(path))).sort()).toEqual(["src/ai/claude-photo.ts", "src/server/receipt-photo-actions.ts"]); });
});

describe("PH-23 no file under src writes image bytes anywhere", () => {
  it("no photo file imports fs, writes a file, logs or touches storage", () => {
    for (const file of PHOTO_FILES) {
      const text = code(file);
      expect(text, file).not.toMatch(/node:fs|from "fs"|writeFile|appendFile|createWriteStream|mkdtemp|tmpdir|localStorage|sessionStorage|indexedDB|FileReader|readAsDataURL|console\.|process\.std/);
    }
  });
  it("no file under src that writes to disk mentions a photo", () => {
    for (const path of SRC) { const text = code(path); if (/writeFile|appendFile|createWriteStream/.test(text)) expect(text, path).not.toMatch(/photo/i); }
  });
  it("the browser keeps the photo as an object URL only and sends the file as the raw body", () => {
    const text = code("src/app/receipts/photo-reader.tsx");
    expect(text).toMatch(/URL\.createObjectURL\(file\)/); expect(text).toMatch(/URL\.revokeObjectURL/); expect(text).toMatch(/body: file/);
    expect(text).not.toMatch(/btoa|arrayBuffer|toDataURL|base64/i);
  });
  it("the read table has no column that could hold an image, a transcript or an error message", () => {
    const schema = source("db/schema.ts"); const start = schema.indexOf('export const receiptPhotoReads'); const block = schema.slice(start, schema.indexOf("export const receiptReviews"));
    const columns = [...block.matchAll(/(\w+): (?:text|integer|boolean|uuid|timestamp)\(/g)].map(match => match[1]);
    expect(columns).toEqual(["id", "organizationId", "userId", "photoSha256", "model", "promptVersion", "schemaVersion", "outcome", "stopReason", "inputTokens", "outputTokens", "arithmeticOk", "prefillSha256", "createdAt"]);
    expect(block).toMatch(/photo_read_stop_reason/);
  });
});

// November 5 owner decision (docs/decisions.md, "Rule drafts and the photo reader on in judge sessions"): exactly one file, by full path, may turn the flag on.
// An export flattens release/judge into the root and has no release/judge folder. In the repository a missing judge compose must fail, so the mode comes from the folder, not from the file.
import { EXPORT_MODE } from "./support/export-mode";
const JUDGE_SESSION = EXPORT_MODE ? "compose.session.yaml" : "release/judge/compose.session.yaml";
const ON_TEXT = /AI_RECEIPT_PHOTO_ENABLED\s*[:=]\s*["']?(true|\$\{[^}]*:?[-+]\s*["']?true)/;
const flagOnOutsideJudgeSession = (path: string, text: string) => path !== JUDGE_SESSION && ON_TEXT.test(text);

describe("PH-24 the flag is read in one place and is off in every compose file except the judge session compose", () => {
  it("only src/ai/provider.ts names AI_RECEIPT_PHOTO_ENABLED, and it reads it with one comparison", () => {
    expect(SRC.filter(path => code(path).includes("AI_RECEIPT_PHOTO_ENABLED"))).toEqual(["src/ai/provider.ts"]);
    expect((code("src/ai/provider.ts").match(/env\.AI_RECEIPT_PHOTO_ENABLED/g) ?? []).length).toBe(1);
    expect(source("src/ai/provider.ts")).toMatch(/env\.AI_RECEIPT_PHOTO_ENABLED === "true" && env\.AI_RECEIPT_ENABLED === "true"/);
  });
  it("the route handler and the page ask receiptPhotoEnabled and nothing else", () => {
    expect(code("src/server/receipt-photo-actions.ts")).toMatch(/receiptPhotoEnabled\(env\)/);
    expect(code("src/app/receipts/new/page.tsx")).toMatch(/receiptPhotoStatus\(\)\.on/);
  });
  it("no compose file, script or tracked environment file turns it on", () => {
    const files = readdirSync(".").filter(name => /^compose.*\.ya?ml$/.test(name)).concat(walk("release").filter(path => /\.ya?ml$/.test(path)));
    for (const file of files.filter(path => path !== JUDGE_SESSION)) expect(source(file), file).not.toMatch(/AI_RECEIPT_PHOTO_ENABLED:\s*["']?true/);
  });
  it("PH-87 the judge session compose turns the photo flag on exactly once, beside the receipt flag, and no other compose file does", () => {
    const text = source(JUDGE_SESSION);
    expect(text.match(/AI_RECEIPT_PHOTO_ENABLED/g)).toHaveLength(1);
    expect(text).toMatch(/^\s+AI_RECEIPT_ENABLED: "true"\n\s+AI_RECEIPT_PHOTO_ENABLED: "true"$/m);
    const files = readdirSync(".").filter(name => /^compose.*\.ya?ml$/.test(name)).concat(walk("release").filter(path => /\.ya?ml$/.test(path)));
    expect(files).toContain(JUDGE_SESSION);
    expect(files.filter(path => flagOnOutsideJudgeSession(path, source(path)))).toEqual([]);
    expect(files.filter(path => ON_TEXT.test(source(path)))).toEqual([JUDGE_SESSION]);
  });
  it("PH-88 a second compose file with the flag on is caught, in every form, while the judge session path is the only one allowed", () => {
    for (const path of ["compose.yaml", "compose.owner-preview.yaml", "compose.review.yaml", "release/judge/compose.ui.yaml", "release/judge/compose.setup.yaml", "release/judge/compose.session-subnet.yaml", "release/judge/compose.session.yaml.copy", "release/judge/other/compose.session.yaml", "./release/judge/compose.session.yaml"]) {
      for (const text of ["AI_RECEIPT_PHOTO_ENABLED: \"true\"", "AI_RECEIPT_PHOTO_ENABLED: true", "- AI_RECEIPT_PHOTO_ENABLED=true", "AI_RECEIPT_PHOTO_ENABLED: ${AI_RECEIPT_PHOTO_ENABLED:-true}"]) expect(flagOnOutsideJudgeSession(path, text), `${path} ${text}`).toBe(true);
      expect(flagOnOutsideJudgeSession(path, "AI_RECEIPT_PHOTO_ENABLED: \"false\""), path).toBe(false);
    }
    expect(flagOnOutsideJudgeSession(JUDGE_SESSION, "AI_RECEIPT_PHOTO_ENABLED: \"true\"")).toBe(false);
  });
  // PH-24, extended: the map form, the list form, an interpolation default, an env_file reference and every script, workflow and Dockerfile.
  const OFF_TEXT = /AI_RECEIPT_PHOTO_ENABLED\s*[:=]\s*["']?(true|\$\{[^}]*:?[-+]\s*["']?true)/;
  const everywhere = () => {
    const roots = [".github", "scripts", "release", "docker", "ops"].filter(path => { try { return statSync(path).isDirectory(); } catch { return false; } });
    const top = readdirSync(".").filter(name => /^(compose.*\.ya?ml|Dockerfile.*|\.env\.example|.*\.sh)$/.test(name));
    return top.concat(roots.flatMap(walk)).filter(path => !/\.(png|jpg|jpeg|webp|woff2?|ttf|zip|gz|sqlite)$/.test(path) && !/photo-static\.test/.test(path) && path !== JUDGE_SESSION);
  };
  // The one script that names the flag as "true" does so only inside an assertion that the judge session compose says so. Every other matching line still fails.
  const PREPARATION_ASSERT = /^assert\(read\('release\/judge\/compose\.session\.yaml'\)\.includes\('AI_RECEIPT_PHOTO_ENABLED: "true"'\)\);$/;
  const withoutAllowedLines = (file: string) => source(file).split("\n").filter(line => !(file === "scripts/check-judge-preparation.mjs" && PREPARATION_ASSERT.test(line))).join("\n");
  it("no file turns the flag on in map form, list form, an interpolation default or a shell assignment", () => {
    for (const file of everywhere()) expect(withoutAllowedLines(file), file).not.toMatch(OFF_TEXT);
  });
  it("PH-89 the preparation script allowance is one exact assertion line and nothing else in that file matches", () => {
    if (EXPORT_MODE && !existsSync("scripts/check-judge-preparation.mjs")) return; // not exported; in the owner tree a missing script fails when it is read
    const lines = source("scripts/check-judge-preparation.mjs").split("\n").filter(line => OFF_TEXT.test(line));
    expect(lines).toHaveLength(1); expect(lines[0]).toMatch(PREPARATION_ASSERT);
    expect("assert(read('release/judge/compose.session.yaml').includes('AI_RECEIPT_PHOTO_ENABLED: \"true\"')); process.env.AI_RECEIPT_PHOTO_ENABLED=true").not.toMatch(PREPARATION_ASSERT);
  });
  it("the detector itself catches each form it is meant to catch", () => {
    for (const bad of ["AI_RECEIPT_PHOTO_ENABLED: true", "AI_RECEIPT_PHOTO_ENABLED: \"true\"", "      - AI_RECEIPT_PHOTO_ENABLED=true", "AI_RECEIPT_PHOTO_ENABLED: ${AI_RECEIPT_PHOTO_ENABLED:-true}", "AI_RECEIPT_PHOTO_ENABLED=${X:-true}", "export AI_RECEIPT_PHOTO_ENABLED=true", "AI_RECEIPT_PHOTO_ENABLED=\"true\""]) expect(bad, bad).toMatch(OFF_TEXT);
    for (const good of ["AI_RECEIPT_PHOTO_ENABLED: \"false\"", "- AI_RECEIPT_PHOTO_ENABLED=false", "AI_RECEIPT_PHOTO_ENABLED: ${AI_RECEIPT_PHOTO_ENABLED:-false}"]) expect(good, good).not.toMatch(OFF_TEXT);
  });
  it("no compose file names an env_file at all, so no file outside this check can turn the flag on", () => {
    for (const file of readdirSync(".").filter(name => /^compose.*\.ya?ml$/.test(name))) {
      const text = source(file);
      // Every env_file reference must be a file this check can read, and that file must not turn the flag on.
      const rows = text.split("\n"); const targets: string[] = [];
      rows.forEach((row, index) => {
        if (!/^\s*env_file:/.test(row)) return;
        const indent = row.length - row.trimStart().length;
        const inline = row.replace(/^\s*env_file:\s*/, "").trim(); if (inline) targets.push(inline.replace(/^\[|\]$/g, "").replace(/["']/g, ""));
        for (let next = index + 1; next < rows.length; next++) {
          const body = rows[next]!; if (body.trim() === "") continue;
          if (body.length - body.trimStart().length <= indent) break;
          const found = /(?:^\s*-\s*(?:path:\s*)?|^\s*path:\s*)["']?([^\s"'#]+)/.exec(body); if (found && !/^required:/.test(found[1]!)) targets.push(found[1]!);
        }
      });
      for (const target of targets) {
        // The judge session compose names its session file through an interpolation that only judge-new can resolve; the text itself must not turn the flag on.
        if (target.includes("${")) { expect(target, `${file} -> ${target}`).not.toMatch(OFF_TEXT); expect(target).toMatch(/^\$\{AIDTRACE_SESSION_ENV:\?/); continue; }
        // The one owner file lives under the git-ignored local folder, so nothing tracked can turn the flag on through it. Any other target must be readable here and must not turn the flag on.
        if (target === "./local/" + "." + "env") { expect(source(".gitignore")).toMatch(/^\/?local\/?$/m); continue; }
        expect(source(target), `${file} -> ${target}`).not.toMatch(OFF_TEXT);
      }
    }
  });
});

describe("PH-25 the route file and the order of the handler", () => {
  it("hands every method to the one handler", () => {
    const text = source("src/app/api/receipts/photo-text/route.ts");
    expect(text).toMatch(/export \{ action as GET, action as POST, action as PUT, action as PATCH, action as DELETE \}/);
    expect(text).toMatch(/handlePhotoText\(request, \{ db: getDatabase\(\) \}\)/);
  });
  it("runs flag, method, origin, session, role, rate limit, byte bound, magic bytes, AI status, model call in that order", () => {
    const text = code("src/server/receipt-photo-actions.ts"); const at = (needle: string | RegExp) => { const index = typeof needle === "string" ? text.indexOf(needle) : text.search(needle); expect(index, String(needle)).toBeGreaterThan(-1); return index; };
    const order = [at("receiptPhotoEnabled(env)"), at('request.method !== "POST"'), at("isSameOrigin(request)"), at("findSession("), at('user.role !== "CLAIMANT"'), at(".take(user.id)"), at("readBounded(request, PHOTO_MAX_BYTES)"), at("sniffPhotoType(body.bytes)"), at("receiptPhotoStatus("), at("readReceiptPhoto(body.bytes")];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("imports no PayPal, ledger, payout, claim approval or webhook module", () => {
    const banned = /(^|\/)(ledger\/|paypal|server\/claim-actions|server\/payments|server\/webhook-)/;
    for (const file of PHOTO_FILES) for (const match of source(file).matchAll(/from\s+["']([^"']+)["']/g)) expect(match[1], `${file} -> ${match[1]}`).not.toMatch(banned);
  });
  it("only the read module writes the read table, and the receipt service writes no read row", () => {
    const writers = SRC.filter(path => /\.(?:insert|update|delete)\(\s*s\.receiptPhotoReads/.test(code(path)));
    expect(writers).toEqual(["src/receipt/photo-reads.ts"]);
    expect(SRC.filter(path => /\.(?:update|delete)\(\s*s\.receiptPhotoReads/.test(code(path)))).toEqual([]);
  });
});

describe("PH-26 migration 0021", () => {
  const sql = source("db/migrations/0021_receipt-photo.sql");
  it("adds one table and one nullable column, with the immutable triggers and the insert guard", () => {
    expect(sql.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(sql).toMatch(/ALTER TABLE "receipt_reviews" ADD COLUMN IF NOT EXISTS "photo_read_id" uuid;/);
    expect(sql).not.toMatch(/photo_read_id" uuid NOT NULL/);
    expect(sql).toMatch(/CREATE TRIGGER photo_read_immutable BEFORE UPDATE OR DELETE ON receipt_photo_reads FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable\(\)/);
    expect(sql).toMatch(/CREATE TRIGGER photo_read_no_truncate BEFORE TRUNCATE ON receipt_photo_reads FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable\(\)/);
    expect(sql).toMatch(/CREATE TRIGGER photo_read_insert_guard BEFORE INSERT/);
    expect(sql).not.toMatch(/^(DROP |DELETE FROM |UPDATE [a-z"])/mi);
  });
  it("adds the photo_unchanged flag, the partial unique index on first revisions and the link guard trigger", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "photo_unchanged" boolean DEFAULT false NOT NULL/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "receipt_review_photo_read_first" ON "receipt_reviews" USING btree \("photo_read_id"\) WHERE "receipt_reviews"\."revision" = 1/);
    expect(sql).toMatch(/CREATE TRIGGER review_photo_link_guard BEFORE INSERT ON receipt_reviews FOR EACH ROW EXECUTE FUNCTION aidtrace_review_photo_link_guard\(\)/);
    expect(sql).toMatch(/outcome = 'READ' AND user_id = NEW\.created_by/); expect(sql).toMatch(/NEW\.photo_read_id IS DISTINCT FROM previous/);
    expect(sql).toMatch(/receipt_photo_unchanged_needs_link/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "prefill_sha256"|"prefill_sha256" text/);
  });
  it("is listed in the journal as entry 21, followed by 0022", () => {
    const journal = JSON.parse(source("db/migrations/meta/_journal.json")) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries[21]).toMatchObject({ idx: 21, tag: "0021_receipt-photo" }); expect(journal.entries[22]).toMatchObject({ idx: 22, tag: "0022_photo-prompt-v2" });
  });
});
