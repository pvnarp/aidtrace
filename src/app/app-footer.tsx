import { connection } from "next/server";
import { receiptAiStatus } from "../ai/provider";
import { PayPalText } from "./brand";
import { FOOTER_PROMISE, shellWording } from "./shell-copy";

/** The shell footer on every screen (layout.tsx renders it once). The second line follows the configured receipt AI. */
export async function AppFooter() {
  await connection();
  const status = receiptAiStatus();
  const { line } = shellWording(status.on ? status : null);
  return <footer className="app-footer"><p className="footer-promise"><PayPalText text={FOOTER_PROMISE} /></p><p className="footer-built"><PayPalText text={line} /></p></footer>;
}
