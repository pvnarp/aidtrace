import { createApplicationSandboxPayments, payPalConfigFromEnvironment } from "../paypal/adapter";

let provider: ReturnType<typeof createApplicationSandboxPayments> | undefined;
export function getPayments() {
  return provider ??= createApplicationSandboxPayments(payPalConfigFromEnvironment(process.env), process.env.PAYPAL_BALANCE_READABLE === "true");
}
