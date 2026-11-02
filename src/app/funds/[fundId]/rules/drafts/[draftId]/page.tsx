import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { readDraftReview } from "../../../../../../rules-draft/drafts";
import { findSession, SESSION_COOKIE } from "../../../../../../server/auth";
import { getDatabase } from "../../../../../../server/db";
import { rulesNotice, type NoticeParams } from "../../../../../../server/rules-notices";
import { AppHeader } from "../../../../../app-header";
import { ReviewScreen } from "../../../../../rules-ui/review-screen";

// IAC-440 Package B (docs/plans/AI_DRAFTED_RULES_SCOPE.md section 5, docs/ASSUMPTIONS.md section 72). The review screen of one drafted rule set. Approver only.
// A draft of another organization, or one that belongs to a different fund than the path names, reads as not found.
export const dynamic = "force-dynamic";
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export default async function DraftReviewPage({ params, searchParams }: { params: Promise<{ fundId: string; draftId: string }>; searchParams: Promise<NoticeParams> }) {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  if (user.role !== "APPROVER") return <main className="analytics-page"><AppHeader user={user} /><h1>Approver access required.</h1><p>Only approvers can review or approve drafted fund rules.</p></main>;
  const { fundId, draftId } = await params;
  const result = ID.test(fundId) && ID.test(draftId) ? await readDraftReview(getDatabase(), { id: user.id }, draftId) : null;
  if (!result || result.status !== "OK" || result.review.view.fundId !== fundId) notFound();
  return <main className="analytics-page reference-page rules-page">
    <AppHeader user={user} />
    <ReviewScreen review={result.review} viewerId={user.id} notice={rulesNotice(await searchParams)} />
    <footer>Rules drafted by AI are checked by the same validator as a hand edit, and nothing binds until two different approvers approve.</footer>
  </main>;
}
