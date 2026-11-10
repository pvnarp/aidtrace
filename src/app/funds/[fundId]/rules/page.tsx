import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { DRAFT_INPUT_MAX_CHARS } from "../../../../rules-draft/draft-validate";
import { readFundMode } from "../../../../fund-modes/change";
import { automationFlagOn, fundModesEnabled } from "../../../../fund-modes/flag";
import { readAutomationSwitch } from "../../../../fund-modes/automation-read";
import { DRAFT_LIST_LIMIT, readFundRules } from "../../../../rules-draft/drafts";
import { findSession, SESSION_COOKIE } from "../../../../server/auth";
import { getDatabase } from "../../../../server/db";
import { PDF_MAX_BYTES } from "../../../../server/pdf-text";
import { rulesNotice, type NoticeParams } from "../../../../server/rules-notices";
import { AppHeader } from "../../../app-header";
import { ruleDraftFormDisclosure } from "../../../ai-disclosure";
import { CurrentRulesView } from "../../../rules-ui/current-rules";
import { DraftList } from "../../../rules-ui/draft-list";
import { FundModeSection } from "../../../rules-ui/fund-mode-section";
import { AutomationSwitchSection } from "../../../rules-ui/automation-switch-section";
import { RulesDraftForm } from "../../../rules-ui/draft-form";
import { SAMPLE_GRANT_FUND_ID, SAMPLE_GRANT_TEXT } from "../../../rules-ui/sample-grant";

// IAC-440 Package B (docs/plans/AI_DRAFTED_RULES_SCOPE.md section 5, docs/ASSUMPTIONS.md section 72). The approver's rules page for one fund: the current approved rules,
// the form that drafts rules from a grant, and the fund's drafts. Approver only. Another organization's fund reads as not found. Only a restricted fund offers the form.
export const dynamic = "force-dynamic";
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export default async function FundRulesPage({ params, searchParams }: { params: Promise<{ fundId: string }>; searchParams: Promise<NoticeParams> }) {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect("/login");
  if (user.role !== "APPROVER") return <main className="analytics-page"><AppHeader user={user} /><h1>Approver access required.</h1><p>Only approvers can draft or approve fund rules.</p></main>;
  const { fundId } = await params;
  const result = ID.test(fundId) ? await readFundRules(getDatabase(), { id: user.id }, fundId) : null;
  if (!result || result.status !== "OK") notFound();
  const { view } = result;
  const notice = rulesNotice(await searchParams);
  const restricted = view.fundClass === "RESTRICTED";
  // Shown only with the fund modes flag on. A flag-off instance renders the page exactly as before.
  const mode = fundModesEnabled() ? await readFundMode(getDatabase(), { id: user.id }, fundId) : null;
  // The kill switch section needs the second flag as well. With it off the page is exactly the PR F page.
  const autopilot = automationFlagOn();
  const automation = autopilot ? await readAutomationSwitch(getDatabase(), { id: user.id }) : null;
  return <main className="analytics-page reference-page rules-page">
    <AppHeader user={user} />
    <div className="reference-screen rules-screen">
      <p className="kicker"><a href="/">Review</a></p>
      <h1 className="screen-heading">Rules for {view.fundName}</h1>
      <p className="reference-intro">AI can draft this fund&apos;s rules from its grant agreement. You review every value against the grant, and two different approvers must approve before anything changes. The AI drafts only. It never approves, pays or allocates.</p>
      {notice && <p className={notice.tone === "warning" ? "notice warning" : "notice"} role="status" data-testid="rules-notice">{notice.text}</p>}

      {mode?.status === "OK" && <FundModeSection fundId={view.fundId} view={mode.view} userId={user.id} autopilot={autopilot} />}
      {automation?.status === "OK" && <AutomationSwitchSection fundId={view.fundId} view={automation.view} userId={user.id} />}

      <section className="rules-section" aria-labelledby="rules-draft-heading">
        <h2 id="rules-draft-heading">Draft rules from a grant</h2>
        {restricted
          ? <RulesDraftForm fundId={view.fundId} disclosure={ruleDraftFormDisclosure(view.arm.model)} maxChars={DRAFT_INPUT_MAX_CHARS} maxPdfBytes={PDF_MAX_BYTES} sample={view.fundId === SAMPLE_GRANT_FUND_ID ? SAMPLE_GRANT_TEXT : null} />
          : <p className="notice" data-testid="rules-unrestricted">This is an unrestricted fund, so it has no grant to draft rules from. Only a restricted fund takes AI-drafted rules.</p>}
      </section>

      <section className="rules-section" aria-labelledby="rules-current-heading">
        <h2 id="rules-current-heading">Current approved rules, version {view.current.version}</h2>
        <CurrentRulesView rules={view.current} />
      </section>
      <section className="rules-section" aria-labelledby="rules-drafts-heading">
        <h2 id="rules-drafts-heading">Drafts of this fund</h2>
        <p className="muted">Newest first, up to {DRAFT_LIST_LIMIT}.</p>
        <DraftList fundId={view.fundId} drafts={view.drafts} />
      </section>
    </div>
    <footer>Rules drafted by AI are checked by the same validator as a hand edit, and nothing binds until two different approvers approve.</footer>
  </main>;
}
