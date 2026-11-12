import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// IAC-232 and IAC-440, DR-136 to DR-140: source text only.
// November 5 owner decision ("Rule drafts and the photo reader on in judge sessions"):
// exactly one compose file, by full path, may turn AI_RULE_DRAFTS_ENABLED on. Every other compose file, script and tracked environment example must not.
// An export flattens release/judge into the root and has no release/judge folder. In the repository a missing judge compose must fail, so the mode comes from the folder, not from the file.
import { EXPORT_MODE } from "./support/export-mode";
const JUDGE_SESSION = EXPORT_MODE ? "compose.session.yaml" : "release/judge/compose.session.yaml";
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
const source = (path: string) => readFileSync(path, "utf8");
const ON_TEXT = /AI_RULE_DRAFTS_ENABLED\s*[:=]\s*["']?(true|\$\{[^}]*:?[-+]\s*["']?true)/;
const onOutsideJudgeSession = (path: string, text: string) => path !== JUDGE_SESSION && ON_TEXT.test(text);
const composeFiles = () => readdirSync(".").filter(name => /^compose.*\.ya?ml$/.test(name)).concat(walk("release").filter(path => /\.ya?ml$/.test(path)));

describe("DR-136 the judge session compose turns rule drafts on and no other compose file does", () => {
  it("names the flag once, set to the string true", () => {
    const text = source(JUDGE_SESSION);
    expect(text.match(/AI_RULE_DRAFTS_ENABLED/g)).toHaveLength(1);
    expect(text).toMatch(/^\s+AI_RULE_DRAFTS_ENABLED: "true"$/m);
  });
  it("is the only compose file whose flag text reads true", () => {
    const files = composeFiles();
    expect(files).toContain(JUDGE_SESSION);
    expect(files.filter(path => onOutsideJudgeSession(path, source(path)))).toEqual([]);
    expect(files.filter(path => ON_TEXT.test(source(path)))).toEqual([JUDGE_SESSION]);
  });
});

describe("DR-137 a second compose file with the flag on is caught", () => {
  it("flags every form outside the judge session path and none for the false value", () => {
    for (const path of ["compose.yaml", "compose.owner-preview.yaml", "compose.rules-draft-eval.yaml", "release/judge/compose.ui.yaml", "release/judge/compose.session-subnet.yaml", "release/judge/other/compose.session.yaml", "./release/judge/compose.session.yaml"]) {
      for (const text of ["AI_RULE_DRAFTS_ENABLED: \"true\"", "AI_RULE_DRAFTS_ENABLED: true", "- AI_RULE_DRAFTS_ENABLED=true", "AI_RULE_DRAFTS_ENABLED: ${AI_RULE_DRAFTS_ENABLED:-true}"]) expect(onOutsideJudgeSession(path, text), `${path} ${text}`).toBe(true);
      expect(onOutsideJudgeSession(path, "AI_RULE_DRAFTS_ENABLED: \"false\""), path).toBe(false);
    }
    expect(onOutsideJudgeSession(JUDGE_SESSION, "AI_RULE_DRAFTS_ENABLED: \"true\"")).toBe(false);
  });
});

describe("DR-138 the owner preview compose and the tracked environment example keep the flag off", () => {
  it("reads false in both, and both must exist in the repository", () => {
    // An export does not ship these two files. In the repository a missing file fails.
    if (EXPORT_MODE) { for (const path of ["compose.owner-preview.yaml", ".env.example"]) if (existsSync(path)) expect(source(path)).toMatch(/AI_RULE_DRAFTS_ENABLED(: "false"|=false)/); return; }
    expect(source("compose.owner-preview.yaml")).toMatch(/AI_RULE_DRAFTS_ENABLED: "false"/);
    expect(source(".env.example")).toMatch(/^AI_RULE_DRAFTS_ENABLED=false$/m);
  });
});

// Line-level allowances. Each exempt file may match only on the exact lines below, so any other matching line in it still fails.
const PREPARATION_ASSERT = /^assert\(read\('release\/judge\/compose\.session\.yaml'\)\.includes\('AI_RULE_DRAFTS_ENABLED: "true"'\)\);$/;
const EVAL_ENV_LINE = '  const env = { AI_RULE_DRAFTS_ENABLED: "true", ANTHROPIC_API_KEY: "placeholder-not-a-credential" };'; // the owner-run drafter evaluation's in-process env object, not a deployment setting
const allowed = (file: string, line: string) => (file === "scripts/check-judge-preparation.mjs" && PREPARATION_ASSERT.test(line)) || (file === "scripts/support/rules-draft-eval.ts" && line === EVAL_ENV_LINE);

describe("DR-139 no script, workflow or Dockerfile turns the flag on", () => {
  it("holds no true assignment outside tests, apart from the pinned lines", () => {
    const roots = [".github", "scripts", "release", "docker", "ops"].filter(path => { try { return statSync(path).isDirectory(); } catch { return false; } });
    const top = readdirSync(".").filter(name => /^(compose.*\.ya?ml|Dockerfile.*|.*\.sh)$/.test(name));
    const files = top.concat(roots.flatMap(walk)).filter(path => !/\.(png|jpg|jpeg|webp|woff2?|ttf|zip|gz|sqlite)$/.test(path) && path !== JUDGE_SESSION);
    for (const file of files) expect(source(file).split("\n").filter(line => !allowed(file, line)).join("\n"), file).not.toMatch(ON_TEXT);
  });
  it("DR-140 each allowance is exactly one line and a look-alike line is not allowed", () => {
    for (const [file, pattern] of [["scripts/check-judge-preparation.mjs", ON_TEXT], ["scripts/support/rules-draft-eval.ts", ON_TEXT]] as const) {
      if (EXPORT_MODE && !existsSync(file)) continue; // not exported; in the owner tree a missing file fails when it is read
      const hits = source(file).split("\n").filter(line => pattern.test(line));
      expect(hits.filter(line => allowed(file, line)), file).toHaveLength(1); expect(hits, file).toHaveLength(1);
    }
    expect(allowed("scripts/support/rules-draft-eval.ts", EVAL_ENV_LINE)).toBe(true);
    expect(allowed("scripts/support/rules-draft-eval.ts", '  const env = { AI_RULE_DRAFTS_ENABLED: "true", ANTHROPIC_API_KEY: "x" };')).toBe(false);
    expect(allowed("scripts/other.mjs", EVAL_ENV_LINE)).toBe(false);
    expect(allowed("scripts/check-judge-preparation.mjs", `assert(read('release/judge/compose.session.yaml').includes('AI_RULE_DRAFTS_ENABLED: "true"')); x`)).toBe(false);
  });
});
