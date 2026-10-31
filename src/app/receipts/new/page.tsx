import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { findSession, SESSION_COOKIE } from "../../../server/auth";
import { DraftForm } from "../draft-form";
import { Journey } from "../../journey";
import { Workspace, type ShellState, type SummaryData } from "../../workspace";
import { aiCard, currentNote, paypalCard } from "../../shell-copy";
import { configuredReceiptAiName } from "../../../ai/provider";
import { judgeSession } from "../../../server/judge-mode";
import { getDatabase } from "../../../server/db";
import { claims } from "../../../../db/schema";
import { and, eq, like } from "drizzle-orm";
export default async function NewReceipt() {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login"); if (user.role !== "CLAIMANT") redirect("/");
  const judge = judgeSession();
  if (judge) {
    const [existing] = await getDatabase().select({ id: claims.id }).from(claims).where(and(eq(claims.claimantId, user.id), like(claims.id, "R-%"))).limit(1);
    if (existing) redirect(`/claims/${existing.id}/receipt`);
  }
  const summary: SummaryData = { claimant: user.displayName, program: "Robotics", amount: judge ? "$500.00" : "$6.00", status: "Draft not saved", statusCode: "DRAFT", reviews: 0,
    details: [["Program", "robotics"], ["Expense", "Fictional receipt"]], note: currentNote("DRAFT") };
  // IAC-373 shell cards: no claim exists yet, so nothing is run, approved or sent. Wording only.
  const shellState: ShellState = { typedReceipt: true, ai: aiCard({ applicable: true, suggestion: "NONE", confirmed: false, aiAccepted: false, savedModel: null, configured: configuredReceiptAiName() }), paypal: paypalCard({ claimStatus: null, approvals: 0, payout: null }) };
  return <Workspace user={user} stage={1} summary={summary} state={shellState}>
    <p className="kicker">Stage 1 / Receipt / Fictional receipt</p><h1>Start with the expense.</h1>
    <Journey stage={1} title="Save the receipt to begin." detail="The example is filled in for you. Check the fictional-data box, then create the draft below. Next you will review categories, not send a payment." href="#receipt-entry" action="Go to the receipt" />
    <p className="intro">{judge ? "$280 of science kits. $150 of notebooks. $70 of refreshments. Which funds may cover each part?" : "A $3 science kit. A $2 notebook. $1 of refreshments. Which funds may cover each part?"}</p><p className="muted">This creates an unpaid draft. It does not reserve funds, approve an expense or request payment.</p><div id="receipt-entry"><DraftForm {...(judge ? { total: "500.00", lines: [{ description: "Science experiment kit", amount: "280.00" }, { description: "Blank writing notebook", amount: "150.00" }, { description: "Sandwiches and apple juice", amount: "70.00" }] } : {})} /></div></Workspace>;
}
