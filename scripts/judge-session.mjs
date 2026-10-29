import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync } from "node:fs";
import { parseEnv } from "node:util";

// Container-only configuration helper. No database, provider client or shell execution.
const [action, name, requestedPort = "3102", requestedSubnet = ""] = process.argv.slice(2);
const root = process.env.JUDGE_SESSION_ROOT ?? "/sessions";
if (!/^[a-z][a-z0-9-]{2,23}$/.test(name ?? "") || !["new", "check"].includes(action)) throw Error("Use new|check with a new lowercase session name of 3 to 24 characters");
const folder = `${root}/${name}`, path = `${folder}/session.env`;
const fixed = {
  AIDTRACE_JUDGE_SESSION: "true", PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com",
  PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_WEBHOOK_ID: "",
  PAYPAL_PRODUCT_WEBHOOK_ID: "", PAYPAL_PRODUCT_WEBHOOK_ENABLED: "false", PAYPAL_BALANCE_READABLE: "false",
  PAYPAL_SANDBOX_PAYEE_EMAIL: "judge-demo@example.invalid", PAYEE_ALLOWLIST: "judge-demo@example.invalid",
  MAX_DEMO_PAYOUT_CENTS: "50000",
};
const roles = ["MARIA", "TARA", "BEN"];
function port(value) {
  if (!/^[1-9][0-9]{3,4}$/.test(value) || Number(value) < 3102 || Number(value) > 65535) throw Error("Choose an unused loopback port from 3102 to 65535");
  return value;
}
function subnet(value) {
  if (!value) return "";
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/28$/.exec(value);
  const parts = match?.slice(1).map(Number);
  if (!parts || parts.some((v, i) => v > 255 || String(v) !== match[i + 1]) || parts[3] % 16 || !(parts[0] === 10 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168)) throw Error("Explicit subnet must be a checked unused RFC1918 /28 network");
  return value;
}
if (action === "new") {
  port(requestedPort); subnet(requestedSubnet);
  mkdirSync(folder, { mode: 0o700 }); // EEXIST preserves any previous or partial session.
  const fields = { ...fixed, APP_ORIGIN: `http://127.0.0.1:${requestedPort}`, AIDTRACE_SESSION_SUBNET: requestedSubnet,
    ...Object.fromEntries(roles.map(role => [`SEED_PASSWORD_${role}`, randomBytes(18).toString("hex")])) };
  writeFileSync(path, Object.entries(fields).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  console.log(`Created local/judge-sessions/${name}/session.env. Passwords withheld. No database or payment created.`);
} else {
  if (lstatSync(folder).isSymbolicLink() || !lstatSync(folder).isDirectory() || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || !realpathSync(path).startsWith(`${realpathSync(root)}/`)) throw Error("Session configuration must be a private regular file");
  if ((lstatSync(path).mode & 0o777) !== 0o600) throw Error("Session configuration must retain mode 600");
  const text = readFileSync(path, "utf8"), env = parseEnv(text);
  const keys = [...Object.keys(fixed), "APP_ORIGIN", "AIDTRACE_SESSION_SUBNET", ...roles.map(role => `SEED_PASSWORD_${role}`)];
  const lines = text.trimEnd().split("\n");
  if (lines.length !== keys.length || lines.some(line => !/^[A-Z_]+=.*$/.test(line)) || new Set(lines.map(line => line.split("=")[0])).size !== keys.length || Object.keys(env).length !== keys.length || keys.some(key => !(key in env))) throw Error("Unexpected or duplicate session setting");
  if (Object.entries(fixed).some(([key, value]) => env[key] !== value)) throw Error("Session financial configuration changed; refusing to start");
  const credentials = roles.map(role => env[`SEED_PASSWORD_${role}`]);
  if (credentials.some(value => !/^[a-f0-9]{36}$/.test(value)) || new Set(credentials).size !== 3) throw Error("Session logins changed or invalid");
  const match = /^http:\/\/127\.0\.0\.1:([0-9]{4,5})$/.exec(env.APP_ORIGIN);
  if (!match) throw Error("Loopback session origin required");
  console.log([port(match[1]), subnet(env.AIDTRACE_SESSION_SUBNET)].filter(Boolean).join(" ")); // Safe dispatch only.
}
