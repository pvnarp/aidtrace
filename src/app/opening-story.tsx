"use client";

import { useEffect, useState } from "react";

const stages = [
  { label: "AI proposes", name: "01 / Local AI", title: "Turn receipt text into reviewable suggestions.", text: "The local model suggests Science kits, Notebooks, and Food and refreshments, with a quote for each. A person checks every category. AI cannot approve or pay.", output: "Output: category suggestions for human confirmation" },
  { label: "Rules allocate", name: "02 / Deterministic policy engine", title: "$430 restricted. Only $70 from General.", text: "STEM B covers $200 of science kits. Education A covers the other $80 and $150 of notebooks. Refreshments use $70 of General. Dates, categories, available funds and shared caps constrain the split.", output: "Output: a funding proposal, still awaiting freeze and approval" },
  { label: "People approve", name: "03 / Two independent reviewers", title: "The same expense. The same split. Two approvals.", text: "The claimant confirms categories and freezes the terms. Two different approvers review the expense, recipient and funding. Changed financial terms invalidate the old approvals. Approved is still unpaid.", output: "Output: an approved reimbursement payable" },
  { label: "PayPal reimburses", name: "04 / PayPal Sandbox", title: "An explicit send. An independently checked result.", text: "An authorized person confirms Send. AidTrace submits through PayPal Payouts, then independently retrieves the individual payout item. Only verified SUCCESS permits settlement and its reported fee, once.", output: "Output: a verified payout result and matching accounting" },
] as const;

export function OpeningStory({ actionHref, actionLabel }: { actionHref: string; actionLabel: string }) {
  const [stage, setStage] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);
  const detail = stages[stage]!;
  return <div className="opening-story">
    <div className="story-hero">
      <div className="story-pitch">
        <p className="story-kicker"><span aria-hidden="true" className="story-dot" /> AI + PayPal for nonprofit expenses</p>
        <h1>A nonprofit expense.<br /><span>Three funds. One clear answer.</span></h1>
        <p className="story-lead">Donors give money with promises attached. Find which restricted funds can pay each item, and keep General funding flexible.</p>
        <p className="story-promise"><strong>AI</strong> reviews receipt text. <strong>Rules</strong> compute the split. <strong>Two people</strong> approve. <strong>PayPal</strong> reimburses.</p>
        <a className="story-primary" href={actionHref}>{actionLabel}<span aria-hidden="true"> ↗</span></a>
        <p className="story-caption">Practice locally. No payment is sent by this walkthrough.</p>
      </div>
      <div className={`story-receipt${blocked ? " story-blocked" : ""}`}>
        <div className="story-receipt-top"><span>RECEIPT TO REIMBURSEMENT</span><span className="story-example">Illustration</span></div>
        <div className="story-receipt-total"><strong>$500<span>.00</span></strong><span>Youth robotics supplies</span></div>
        <div className="story-line"><span>Science kits</span><strong>$280</strong></div>
        <div className="story-line"><span>Notebooks</span><strong>$150</strong></div>
        <div className="story-line"><span>{blocked ? "Alcohol instead of refreshments" : "Refreshments"}</span><strong>$70</strong></div>
        <div className="story-result" aria-live="polite" aria-atomic="true">
          <p>{blocked ? "ORGANIZATION POLICY BLOCKS THIS" : "PERMITTED FUNDING PROPOSAL"}</p>
          {blocked ? <><strong className="story-block-title">No fund can cover alcohol.</strong><span>General cannot bypass an organization-wide ban. This example stops before approval or PayPal.</span></> : <>
            <div className="story-funds"><span><i className="fund-stem" />STEM B<strong>$200</strong><small>Part of the $280 kits</small></span><span><i className="fund-education" />Education A<strong>$230</strong><small>$80 kits + $150 notebooks</small></span><span><i className="fund-general" />General<strong>$70</strong><small>Refreshments / flexible funds</small></span></div>
            <div className="story-paypal"><strong>PayPal <span>Sandbox</span></strong><span>$500 reimbursement to Maria</span><small>Only after category review, frozen terms and two approvals</small></div>
          </>}
        </div>
        <button className="story-contrast" disabled={!ready} aria-pressed={blocked} onClick={() => setBlocked(value => !value)}>{blocked ? "Return to the allowed receipt" : "What if one item is prohibited?"}<span aria-hidden="true"> →</span></button>
        <p className="story-receipt-note">Fictional receipt and funds. This illustration sends no request.</p>
      </div>
    </div>
    <div className="story-workflow" aria-labelledby="story-workflow-title">
      <div className="story-workflow-heading"><p className="story-kicker">See what each part does</p><h2 id="story-workflow-title">AI helps prepare. People keep control.</h2><p>Choose a stage to inspect its role. These controls explain the workflow; they execute no requests.</p></div>
      <div className="story-stage-buttons" role="group" aria-label="Expense workflow explanation">{stages.map((item, index) => <button key={item.label} disabled={!ready} className={`story-stage stage-${index}`} aria-pressed={stage === index} onClick={() => setStage(index)}><span aria-hidden="true">0{index + 1}</span>{item.label}</button>)}</div>
      <div className="story-stage-detail" aria-live="polite" aria-atomic="true"><div><p className="story-kicker">{detail.name}</p><h3>{detail.title}</h3></div><div><p>{detail.text}</p><strong className="story-output">{detail.output}</strong></div></div>
    </div>
  </div>;
}
