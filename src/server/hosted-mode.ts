/** HOST-01: hosted mode. Set only by the compose file that release/hosted/gen.sh writes. It admits one configured https origin and a Secure
 * session cookie. Auth reads it, and auth sits inside route import closures that must name no PayPal module (tests/fund-modes-static.test.ts AS-20),
 * so this file stays free of provider and payout words. Owner mode and plain judge sessions never read it as true. */
export const hostedSession = (env: Readonly<Record<string, string | undefined>> = process.env) => env.AIDTRACE_HOSTED === "true";
/** Hosted mode also requires the judge session flag, the same exact-string rule as src/server/judge-mode.ts, so a hosted workspace is never payable. */
export const hostedJudgeFlag = (env: Readonly<Record<string, string | undefined>> = process.env) => env.AIDTRACE_JUDGE_SESSION === "true";
