import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { findSession, SESSION_COOKIE } from "../../../server/auth";
import { DraftForm } from "../draft-form";
export default async function NewReceipt() {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login"); if (user.role !== "CLAIMANT") redirect("/");
  return <main><header className="page-header"><Link href="/">AidTrace</Link><span>{user.displayName} · Claimant</span></header>
    <h1>Review an invented receipt.</h1><p>Create an unpaid draft, review AI suggestions and confirm each category yourself. Creating this draft does not reserve funds, approve an expense or request payment.</p><DraftForm /></main>;
}
