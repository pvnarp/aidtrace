import { createApplicationSandboxPayments, payPalConfigFromEnvironment } from "../paypal/adapter";
import { judgeSession } from "./judge-mode";

let provider: ReturnType<typeof createApplicationSandboxPayments> | undefined;
export function getPayments() {
  if (judgeSession()) throw new Error("Judge session payments disabled");
  return provider ??= createApplicationSandboxPayments(payPalConfigFromEnvironment(process.env), process.env.PAYPAL_BALANCE_READABLE === "true");
}
