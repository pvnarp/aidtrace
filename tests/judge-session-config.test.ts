import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, statSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aidtrace-session-"));
  const helper = existsSync("release/judge/scripts/judge-session.mjs") ? "release/judge/scripts/judge-session.mjs" : "scripts/judge-session.mjs";
  const run = (...args: string[]) => spawnSync(process.execPath, [resolve(helper), ...args], { encoding: "utf8", env: { ...process.env, JUDGE_SESSION_ROOT: root, PAYPAL_CLIENT_ID: "synthetic-owner-key", PAYPAL_CLIENT_SECRET: "synthetic-owner-secret", DATABASE_URL: "postgres://owner/keep-original" } });
  return { root, run };
}
test("sessions isolate generated configuration, refuse overwrite, and withhold passwords", () => {
  const { root, run } = fixture();
  for (const name of ["first", "second"]) expect(run("new", name, "3102").status).toBe(0);
  const path = join(root, "first/session.env"), bytes = readFileSync(path), env = parseEnv(bytes.toString());
  expect(env.PAYPAL_CLIENT_ID).toBe(""); expect(env.PAYPAL_CLIENT_SECRET).toBe(""); expect(env.DATABASE_URL).toBeUndefined();
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const passwords = [env.SEED_PASSWORD_MARIA, env.SEED_PASSWORD_TARA, env.SEED_PASSWORD_BEN]; expect(new Set(passwords).size).toBe(3);
  const checked = run("check", "first"); expect(checked.status).toBe(0); expect(checked.stdout.trim()).toBe("3102");
  for (const value of passwords) expect(checked.stdout + checked.stderr).not.toContain(value);
  expect(run("new", "first", "3103").status).not.toBe(0); expect(readFileSync(path)).toEqual(bytes);
  expect(parseEnv(readFileSync(join(root, "second/session.env"), "utf8")).SEED_PASSWORD_MARIA).not.toBe(env.SEED_PASSWORD_MARIA);
});
test("tampered credentials, duplicate fields, escaping names and symlinked configuration fail closed", () => {
  const { root, run } = fixture(); expect(run("new", "first").status).toBe(0);
  const path = join(root, "first/session.env"), original = readFileSync(path, "utf8");
  for (const contents of [original.replace("PAYPAL_CLIENT_ID=", "PAYPAL_CLIENT_ID=injected"), original + "PAYPAL_CLIENT_ID=\n", original + "DATABASE_URL=postgres://owner\n", original.replace("AIDTRACE_JUDGE_SESSION=true", "AIDTRACE_JUDGE_SESSION=false")]) {
    writeFileSync(path, contents); expect(run("check", "first").status).not.toBe(0);
  }
  for (const name of ["../escape", "x", "UPPER", "a;exit", "a".repeat(25)]) expect(run("new", name).status).not.toBe(0);
  symlinkSync(join(root, "first"), join(root, "linked")); expect(run("check", "linked").status).not.toBe(0);
});
test("optional subnet is explicit, private, aligned and preserved across starts", () => {
  const { run } = fixture();
  expect(run("new", "scoped", "3190", "172.30.253.0/28").status).toBe(0);
  expect(run("check", "scoped").stdout.trim()).toBe("3190 172.30.253.0/28");
  for (const range of ["8.8.8.0/28", "172.32.0.0/28", "172.30.253.1/28", "10.0.0.0/8", "010.0.0.0/28", "10.999.0.0/28", "x;exit"]) expect(run("new", "bad-range", "3191", range).status).not.toBe(0);
});
