import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { findSession, SESSION_COOKIE } from "../../../server/auth";
import { DraftForm } from "../draft-form";
import { WORKSHOP_EXAMPLE } from "../examples";
import { Journey } from "../../journey";
import { Workspace, type ShellState, type SummaryData } from "../../workspace";
import { TraceKicker } from "../../trace";
import { aiCard, currentNote, paypalCard } from "../../shell-copy";
import { configuredReceiptAiName, receiptPhotoStatus } from "../../../ai/provider";
import { PhotoReader } from "../photo-reader";
import { poweredByNames } from "../../ai-disclosure";
import { judgeSession } from "../../../server/judge-mode";
import { getDatabase } from "../../../server/db";
import { claims } from "../../../../db/schema";
import { and, eq, like } from "drizzle-orm";
// IAC-415 PR 7: a judge session always loads the workshop example. Owner mode keeps the $6 practice expense unless the URL is exactly ?example=workshop (any other value, or two values, is the practice default).
export default async function NewReceipt({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login"); if (user.role !== "CLAIMANT") redirect("/");
  // The reader shows only when a photo read could run: both flags, a key and request budget (receiptPhotoStatus). A keyless judge session shows no photo control.
  const photo = receiptPhotoStatus().on;
  const judge = judgeSession(); const workshop = judge || (await searchParams).example === "workshop";
  if (judge) {
    const [existing] = await getDatabase().select({ id: claims.id }).from(claims).where(and(eq(claims.claimantId, user.id), like(claims.id, "R-%"))).limit(1);
    if (existing) redirect(`/claims/${existing.id}/receipt`);
  }
  const summary: SummaryData = { claimant: user.displayName, program: "Robotics", amount: workshop ? "$500.00" : "$6.00", status: "Draft not saved", statusCode: "DRAFT", reviews: 0,
    details: [["Program", "robotics"], ["Expense", "New receipt"]], note: currentNote("DRAFT") };
  // IAC-373 shell cards: no claim exists yet, so nothing is run, approved or sent. Wording only.
  const shellState: ShellState = { typedReceipt: true, ...(photo ? { photoIntake: true } : {}), ai: aiCard({ applicable: true, suggestion: "NONE", confirmed: false, aiAccepted: false, savedModel: null, configured: configuredReceiptAiName() }), paypal: paypalCard({ claimStatus: null, approvals: 0, payout: null }) };
  return <Workspace user={user} stage={1} summary={summary} state={shellState} layout="single">
    <TraceKicker stage={1} state={shellState} reviews={summary.reviews} suffix=" / New receipt" /><h1>Start with the expense.</h1>
    <Journey title="Save the receipt to begin." detail="The example is filled in for you. Check the personal-details box, then create the draft below. Next you will review categories, not send a payment." href="#receipt-entry" action="Go to the receipt" />
    <p className="intro">{workshop ? "$280 of robot kit parts. $150 of engineering notebooks. $70 of sandwiches and juice. Which funds may cover each part?" : "A $3 science kit. A $2 notebook. $1 of refreshments. Which funds may cover each part?"}</p>
    {!judge && <p><Link className="button-link secondary" href={workshop ? "/receipts/new" : "/receipts/new?example=workshop"} prefetch={false}>{workshop ? "Use the $6 small example" : "Use the $500 workshop example"}</Link></p>}
    <p className="muted">This creates an unpaid draft. It does not reserve funds, approve an expense or request payment.</p><div className={photo ? "photo-layout with-photo" : undefined}><div id="receipt-entry"><DraftForm key={workshop ? "workshop" : "small"} photo={photo} {...(workshop ? WORKSHOP_EXAMPLE : {})} /></div>{photo && <PhotoReader poweredBy={poweredByNames([configuredReceiptAiName()?.name ?? ""])} />}</div></Workspace>;
}
