/** Server-only configuration. Never infer financial authority from a client field. */
export const judgeSession = (env: Readonly<Record<string, string | undefined>> = process.env) => env.AIDTRACE_JUDGE_SESSION === "true";
export function paymentConfigured(payee: string, env: Readonly<Record<string, string | undefined>> = process.env) {
  return !judgeSession(env) && !payee.toLowerCase().endsWith(".invalid") &&
    env.PAYPAL_BASE_URL === "https://api-m.sandbox.paypal.com" &&
    Boolean(env.PAYPAL_CLIENT_ID?.trim() && env.PAYPAL_CLIENT_SECRET?.trim()) &&
    (env.PAYEE_ALLOWLIST ?? "").split(",").map(value => value.trim()).includes(payee);
}
