import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { findSession, SESSION_COOKIE } from "../../../server/auth";
import { DraftForm } from "../draft-form";
import { Journey } from "../../journey";
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
  return <main className="claim-page receipt-page"><header className="page-header"><Link href="/">AidTrace</Link><span>{user.displayName} · Claimant</span><form action="/api/auth/logout" method="post"><button className="secondary">Sign out</button></form></header>
    <Journey stage={1} title="Save the receipt to begin." detail="The example is filled in for you. Check the fictional-data box, then create the draft below. Next you will review categories, not send a payment." href="#receipt-entry" action="Go to the receipt" />
    <p className="eyebrow">Fictional receipt</p><h1>Start with the expense.</h1><p className="intro">{judge ? "$280 of science kits. $150 of notebooks. $70 of refreshments. Which funds may cover each part?" : "A $3 science kit. A $2 notebook. $1 of refreshments. Which funds may cover each part?"}</p><p className="muted">This creates an unpaid draft. It does not reserve funds, approve an expense or request payment.</p><div id="receipt-entry"><DraftForm {...(judge ? { total: "500.00", lines: [{ description: "Science experiment kit", amount: "280.00" }, { description: "Blank writing notebook", amount: "150.00" }, { description: "Sandwiches and apple juice", amount: "70.00" }] } : {})} /></div></main>;
}
