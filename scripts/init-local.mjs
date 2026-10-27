import { randomBytes } from "node:crypto";
import { mkdirSync, openSync, writeFileSync, closeSync } from "node:fs";

mkdirSync("local", { recursive: true, mode: 0o700 });
const path = "local/.env";
try {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, [
      "APP_ORIGIN=http://127.0.0.1:3100",
      `SEED_PASSWORD_MARIA=${randomBytes(18).toString("hex")}`,
      `SEED_PASSWORD_TARA=${randomBytes(18).toString("hex")}`,
      `SEED_PASSWORD_BEN=${randomBytes(18).toString("hex")}`,
      "PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com",
      "PAYPAL_CLIENT_ID=",
      "PAYPAL_CLIENT_SECRET=",
      "PAYPAL_SANDBOX_PAYEE_EMAIL=judge-demo@example.invalid",
      "PAYEE_ALLOWLIST=judge-demo@example.invalid",
      "MAX_DEMO_PAYOUT_CENTS=50000",
      "PAYPAL_WEBHOOK_ID=",
      "",
    ].join("\n"));
  } finally { closeSync(fd); }
  console.log("Created private local/.env with fictional recipient and no PayPal credentials. Demo passwords generated; none printed.");
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
  console.log("local/.env already exists and was not changed.");
}
