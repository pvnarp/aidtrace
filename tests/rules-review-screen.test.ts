import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BUDGET_LINES, THRESHOLD_KEYS, type DraftField, type FieldStatus, type RulesDraft } from "../src/rules-draft/draft-validate";
import type { CurrentRules, DraftListItem, DraftReview, DraftState } from "../src/rules-draft/drafts";
import { ruleDraftFormDisclosure, ruleDraftReviewDisclosure } from "../src/app/ai-disclosure";
import { CurrentRulesView } from "../src/app/rules-ui/current-rules";
import { DraftList } from "../src/app/rules-ui/draft-list";
import { RulesDraftForm } from "../src/app/rules-ui/draft-form";
import { EditForm } from "../src/app/rules-ui/edit-form";
import { ReviewScreen } from "../src/app/rules-ui/review-screen";
import { reviewRows, thresholdsBlocked } from "../src/app/rules-ui/review-rows";
import { capLabel, categoryLabel, moneyText, pathLabel, thresholdText } from "../src/app/rules-ui/labels";
import { reviewTime } from "../src/server/display";
import { EDIT_CAP_FIELDS, EDIT_CATEGORY_PREFIX, EDIT_PROGRAM_PREFIX, EDIT_THRESHOLD_FIELDS } from "../src/server/rules-input";
import { rulesNotice } from "../src/server/rules-notices";

// IAC-440 Package B, DR-105 to DR-117 (docs/GATE_REPORT.md section 60): what the review screen, the form, the edit form and the lists show. Reviews are built by hand
// from the real types, so a type change fails the typecheck. Static markup only: no database, no browser. The browser path is e2e/rules-draft.spec.ts (DR-130).
const field = <T>(value: T | null, clauseId: string | null = null, quote: string | null = null, status: FieldStatus = value === null ? "UNSURE" : "DRAFTED"): DraftField<T> => ({ status, value, clauseId, quote });
const unsure = <T>(): DraftField<T> => field<T>(null);
const AT = new Date("2026-11-01T15:30:00Z");
const LATER = new Date("2026-11-01T16:45:00Z");
const GRANT = "Section 1. Funds may be used only for the robotics afterschool program.\nSection 3. Spending on supplies may not exceed $300.00 in total.";

function draftOf(over: Partial<RulesDraft> = {}): RulesDraft {
  return {
    clauses: [{ id: "1.1", text: "Funds may be used only for the robotics afterschool program." }, { id: "1.3", text: "Spending on supplies may not exceed $300.00 in total." }],
    programs: field(["robotics"], "1.1", "robotics afterschool program"),
    allowedCategories: field(["robot_kits_parts", "classroom_supplies"], "1.1", "robot kits"),
    periodStart: field("2026-09-01", "1.2", "begins on 2026-09-01"),
    periodEnd: field("2027-06-30", "1.2", "ends on 2027-06-30"),
    breadth: 2,
    caps: { supplies: field(30000, "1.3", "$300.00"), other: unsure(), travel: unsure(), equipment: unsure(), contractual: unsure() },
    thresholds: { suppliesLimitCents: unsure(), equipmentLimitCents: unsure(), claimLimitCents: unsure(), staleReceiptDays: unsure(), duplicateWindowDays: unsure(), splitWindowDays: unsure() },
    summary: "Pays direct costs of the robotics afterschool program.",
    ...over,
  };
}
const CURRENT: CurrentRules = {
  version: 1, summary: "Current summary.", programs: ["robotics"], allowedCategories: ["classroom_supplies"], periodStart: "2026-01-01", periodEnd: "2026-12-31",
  caps: { supplies: "10000", travel: "5000" }, thresholds: null, clauses: [{ id: "1.1", text: "An earlier clause." }],
};
const CATALOGS = { categories: ["robot_kits_parts", "classroom_supplies", "books"], programs: ["robotics", "tutoring"] };
// The five budget lines other than supplies and the periods are filled, so the one UNSURE field a test needs is the only gap.
const complete = (): RulesDraft => draftOf({ caps: { supplies: field(30000, "1.3", "$300.00"), other: field(1000, "1.3", "$10.00"), travel: field(2000, "1.3", "$20.00"), equipment: field(3000, "1.3", "$30.00"), contractual: field(4000, "1.3", "$40.00") } });

type Over = { state?: DraftState; draft?: RulesDraft | null; missing?: string[]; carried?: string[]; quoteUnsupported?: string[]; changesPayOrder?: boolean | null; changedFields?: string[] | null;
  approvers?: DraftReview["approvers"]; model?: DraftReview["view"]["model"]; inputText?: string; current?: CurrentRules; refusal?: { reason: string; path: string } | null; bound?: number | null };
function review(over: Over = {}): DraftReview {
  const draft = over.draft === undefined ? draftOf() : over.draft;
  const missing = over.missing ?? (draft ? BUDGET_LINES.filter(line => draft.caps[line].value === null).map(line => `caps.${line}`) : []);
  const approvers = over.approvers ?? [];
  return {
    view: {
      id: "11111111-1111-4111-8111-111111111111", fundId: "fund_a", fundName: "Robotics Fund", basePolicyVersion: 1, currentPolicyVersion: 1, parentDraftId: null,
      state: over.state ?? "OPEN", outcome: draft ? "DRAFTED" : "REFUSED", draft,
      analysis: draft ? { complete: missing.length === 0, missing, carried: (over.carried ?? []) as never, quoteUnsupported: over.quoteUnsupported ?? [], changesPayOrder: over.changesPayOrder ?? null } : null,
      refusal: draft ? null : over.refusal ?? { reason: "QUOTE_NOT_IN_CLAUSE", path: "caps.supplies" }, changedFields: over.changedFields ?? null,
      inputText: over.inputText ?? GRANT, inputSha256: "0".repeat(64), draftedBy: "tara", createdAt: AT,
      model: over.model === undefined ? { model: "claude-sonnet-5-5", effort: "high", promptVersion: "p1", schemaVersion: "s1", requestDigest: "d".repeat(64), stopReason: "end_turn", inputTokens: 10, outputTokens: 20 } : over.model,
      approvals: approvers.map(approver => ({ actorId: approver.actorId, recordedAt: approver.recordedAt })), boundPolicyVersion: over.bound ?? null,
    },
    current: over.current ?? CURRENT, catalogs: CATALOGS, draftedByName: "Tara Lin", approvers,
  };
}
const render = (value: DraftReview, viewerId = "ben", notice = null as ReturnType<typeof rulesNotice>) => renderToStaticMarkup(createElement(ReviewScreen, { review: value, viewerId, notice }));
const row = (html: string, path: string): string => new RegExp(`<tr [^>]*data-path="${path.replace(".", "\\.")}"[^>]*>.*?</tr>`, "s").exec(html)?.[0] ?? "";
const approveButton = (html: string) => /<button type="submit"([^>]*)>Approve \((first|second) of two\)<\/button>/.exec(html);

describe("DR-105 the review table shows field, current, draft and source, with the quoted sentence for each drafted value", () => {
  it("has the four columns, one row per rule field in reading order, and the clause and quote of a drafted value", () => {
    const html = render(review());
    for (const heading of ["Field", "Current (version 1)", "Draft", "Source"]) expect(html).toContain(`<th scope="col">${heading}</th>`);
    const paths = [...html.matchAll(/data-path="([^"]+)"/g)].map(match => match[1]);
    expect(paths).toEqual(["programs", "allowedCategories", "periodStart", "periodEnd", ...BUDGET_LINES.map(line => `caps.${line}`), ...THRESHOLD_KEYS.map(key => `thresholds.${key}`), "summary"]);
    const supplies = row(html, "caps.supplies");
    expect(supplies).toContain("$100.00");
    expect(supplies).toContain("$300.00");
    expect(supplies).toContain("Clause 1.3");
    expect(supplies).toContain('<blockquote class="rules-quote">$300.00</blockquote>');
    expect(supplies).toContain('data-tone="DRAFTED"');
    expect(supplies).toContain('data-changed="true"');
    expect(row(html, "programs")).toContain("Robotics");
    expect(row(html, "programs")).toContain('data-changed="false"');
    expect(row(html, "allowedCategories")).toContain(categoryLabel("robot_kits_parts"));
    expect(row(html, "summary")).toContain("Written by the AI from the clauses");
  });
  it("formats money by integer cents without a float, including amounts a float would misround", () => {
    expect(moneyText(30000)).toBe("$300.00");
    expect(moneyText("9007199254740993")).toBe("$90,071,992,547,409.93");
    expect(moneyText("1")).toBe("$0.01");
    expect(moneyText("not cents")).toBe("Not set");
    expect(thresholdText("staleReceiptDays", 1)).toBe("1 day");
    expect(thresholdText("duplicateWindowDays", 90)).toBe("90 days");
    expect(thresholdText("suppliesLimitCents", 25000)).toBe("$250.00");
  });
  it("marks a person's change as changed by a person", () => {
    const edited = draftOf({ summary: "A person wrote this.", periodStart: field("2026-08-01", null, null, "EDITED") });
    const html = render(review({ draft: edited, changedFields: ["summary", "periodStart"] }));
    expect(row(html, "summary")).toContain("Changed by a person");
    expect(row(html, "periodStart")).toContain("Changed by a person");
    expect(row(html, "periodStart")).toContain('data-tone="EDITED"');
    expect(html).toContain("A person changed: Summary, Period starts.");
  });
});

describe("DR-106 a field the grant does not settle is highlighted, marked Required, and approval is disabled with the missing list", () => {
  it("marks each UNSURE required field and shows the plain missing sentence", () => {
    const html = render(review());
    const travel = row(html, "caps.travel");
    expect(travel).toContain('data-tone="NEEDED"');
    expect(travel).toContain('<span class="rules-required">Required</span>');
    expect(travel).toContain("Needs a value");
    expect(travel).toContain("Not settled by the grant");
    const missing = ["other", "travel", "equipment", "contractual"].map(line => capLabel(line)).join(", ");
    expect(html).toContain(`Still needed before approval: ${missing}. Fill them in with the form below.`);
  });
  it("disables the approve button and points it at the missing list while any required field is empty, and enables it when none is", () => {
    const blocked = approveButton(render(review()));
    expect(blocked).not.toBeNull();
    expect(blocked![1]).toContain("disabled");
    expect(blocked![1]).toContain('aria-describedby="rules-missing"');
    const ready = approveButton(render(review({ draft: complete() })));
    expect(ready).not.toBeNull();
    expect(ready![1]).not.toContain("disabled");
    expect(ready![2]).toBe("first");
  });
  it("opens the edit form while something is missing and keeps it collapsed otherwise", () => {
    expect(render(review())).toMatch(/<details class="rules-edit-details" open="">/);
    expect(render(review({ draft: complete() }))).toMatch(/<details class="rules-edit-details">/);
  });
  it("a single missing field is named in the singular", () => {
    const one = draftOf({ caps: { supplies: field(30000, "1.3", "$300.00"), other: field(1, "1.3", "$0.01"), travel: field(1, "1.3", "$0.01"), equipment: field(1, "1.3", "$0.01"), contractual: unsure() } });
    expect(render(review({ draft: one }))).toContain(`Still needed before approval: ${capLabel("contractual")}. Fill it in with the form below.`);
  });
  it("blocks approval and says why when some review limits are set, some are blank, and the fund has none to carry", () => {
    const partial = complete(); partial.thresholds.claimLimitCents = field(100000, "1.3", "$1,000.00");
    const value = review({ draft: partial });
    expect(thresholdsBlocked(value)).toBe(true);
    const html = render(value);
    expect(approveButton(html)![1]).toContain("disabled");
    expect(html).toContain("Fill in all six review limits, or clear them all, before approving.");
    expect(thresholdsBlocked(review({ draft: partial, current: { ...CURRENT, thresholds: { version: 1, values: { suppliesLimitCents: "25000", equipmentLimitCents: "50000", claimLimitCents: "100000", staleReceiptDays: "60", duplicateWindowDays: "90", splitWindowDays: "3" } } } }))).toBe(false);
    expect(thresholdsBlocked(review({ draft: complete() }))).toBe(false);
  });
});

describe("DR-107 a blank review limit that keeps the fund's current value says so", () => {
  it("shows the carried value, and 'Not set' where the fund has none", () => {
    const withLimits: CurrentRules = { ...CURRENT, thresholds: { version: 2, values: { suppliesLimitCents: "25000", equipmentLimitCents: "50000", claimLimitCents: "100000", staleReceiptDays: "60", duplicateWindowDays: "90", splitWindowDays: "3" } } };
    const html = render(review({ draft: complete(), current: withLimits, carried: [...THRESHOLD_KEYS] }));
    const supplies = row(html, "thresholds.suppliesLimitCents");
    expect(supplies).toContain('data-tone="CARRIED"');
    expect(supplies).toContain("Keeps $250.00");
    expect(supplies).toContain("Carries the current value");
    expect(supplies).not.toContain("rules-required");
    expect(row(html, "thresholds.staleReceiptDays")).toContain("Keeps 60 days");
    const none = render(review({ draft: complete() }));
    expect(row(none, "thresholds.suppliesLimitCents")).toContain('data-tone="BLANK"');
    expect(row(none, "thresholds.suppliesLimitCents")).toContain("Not set");
    expect(row(none, "thresholds.suppliesLimitCents")).not.toContain("Carries the current value");
  });
});

describe("DR-108 a value the AI proposed without a supporting quote shows the warning and no value", () => {
  it("warns on the row, shows no drafted value there, and requires it", () => {
    const stripped = complete(); stripped.caps.travel = unsure();
    const html = render(review({ draft: stripped, quoteUnsupported: ["caps.travel"], missing: ["caps.travel"] }));
    const travel = row(html, "caps.travel");
    expect(travel).toContain('<p class="rules-unsupported" role="note">The AI proposed a value here, but its quote does not state it, so the value was removed. Fill this field in yourself.</p>');
    expect(travel).toContain("Needs a value");
    expect(travel).toContain('<span class="rules-required">Required</span>');
    expect(row(html, "caps.contractual")).not.toContain("rules-unsupported");
    expect(html.match(/rules-unsupported/g)).toHaveLength(1);
  });
});

describe("DR-109 the pay-order warning appears only when the draft would change the pay order, and only while it can be approved", () => {
  it("shows it for true and never for false or unknown", () => {
    const warned = render(review({ draft: complete(), changesPayOrder: true }));
    expect(warned).toContain('data-testid="rules-payorder-warning"');
    expect(warned).toContain("Approving these rules changes the pay order.");
    expect(warned).toContain("Receipts that are frozen but not yet approved twice go back to draft and need both approvals again. Paid claims are untouched.");
    expect(render(review({ draft: complete(), changesPayOrder: false }))).not.toContain("rules-payorder");
    expect(render(review({ draft: complete(), changesPayOrder: null }))).not.toContain("rules-payorder");
  });
  it("is not shown for a draft that is no longer open, even if the flag is stored true", () => {
    for (const state of ["STALE", "WITHDRAWN", "BOUND"] as const) expect(render(review({ draft: complete(), state, changesPayOrder: true, bound: state === "BOUND" ? 2 : null })), state).not.toContain("rules-payorder");
  });
});

describe("DR-110 approvals are shown as n of 2 with names and times, and one approver cannot give the second", () => {
  const ben = { actorId: "ben", displayName: "Ben Ortiz", recordedAt: LATER };
  it("says nobody has approved, and offers the first approval", () => {
    const html = render(review({ draft: complete() }));
    expect(html).toContain("Approvals: 0 of 2");
    expect(html).toContain("No one has approved yet. Two different approvers must approve before these rules take effect.");
    expect(approveButton(html)![2]).toBe("first");
  });
  it("lists who approved and when, in UTC, and offers a different approver the second approval", () => {
    const html = render(review({ draft: complete(), approvers: [ben] }), "tara");
    expect(html).toContain("Approvals: 1 of 2");
    expect(html).toContain(`Ben Ortiz approved on <time dateTime="${LATER.toISOString()}">${reviewTime(LATER)}</time>.`);
    expect(reviewTime(LATER)).toBe("Nov 1, 2026, 4:45 PM UTC");
    expect(approveButton(html)![2]).toBe("second");
    expect(html).not.toContain("rules-second-approver");
  });
  it("shows a viewer who already approved the second-approver message and no approve button", () => {
    const html = render(review({ draft: complete(), approvers: [ben] }), "ben");
    expect(html).toContain('data-testid="rules-second-approver"');
    expect(html).toContain("You approved this draft. A second, different approver must approve it before anything changes.");
    expect(approveButton(html)).toBeNull();
    expect(html).not.toContain('name="action" value="approve"');
    expect(html).toContain('name="action" value="withdraw"');
  });
  it("posts every action to the draft's own route with a fixed action value, never an id or an actor", () => {
    const html = render(review({ draft: complete() }));
    expect(html).toContain('action="/api/funds/fund_a/rules/drafts/11111111-1111-4111-8111-111111111111"');
    for (const name of [...html.matchAll(/<input type="hidden" name="([^"]+)"/g)].map(match => match[1])) expect(name).toBe("action");
    expect(html).not.toMatch(/name="(actorId|draftId|fundId|userId)"/);
  });
});

describe("DR-111 a refused draft shows no drafted value", () => {
  it("shows the reason, nothing to approve, no table, no edit form, and the grant text only inside the collapsed source", () => {
    const html = render(review({ draft: null, state: "REFUSED", refusal: { reason: "QUOTE_NOT_IN_CLAUSE", path: "caps.supplies" } }));
    expect(html).toContain('data-testid="rules-refused"');
    expect(html).toContain("The AI answer was refused");
    expect(html).toContain("Nothing was approved or changed.");
    expect(html).not.toContain("rules-review-table");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("data-path=");
    expect(html).not.toContain("Approvals:");
    expect(html).not.toContain("Approve (");
    expect(html).not.toContain("rules-edit");
    expect(html).not.toContain("Withdraw this draft");
    // The grant text stays in the collapsed source and nowhere else: with that block removed, no drafted amount is left on the page.
    expect(html.replace(/<details class="rules-source-details">[\s\S]*<\/details>/, "")).not.toContain("$300.00");
    expect(reviewRows(review({ draft: null, state: "REFUSED" }))).toEqual([]);
  });
  it("shows no drafted value even if a refused view wrongly carried a draft: the state is checked as well as the data", () => {
    const carried = review({ draft: complete(), state: "REFUSED", refusal: { reason: "QUOTE_NOT_IN_CLAUSE", path: "caps.supplies" } });
    expect(carried.view.draft).not.toBeNull();
    expect(reviewRows(carried)).toEqual([]);
    const html = render(carried);
    expect(html).toContain('data-testid="rules-refused"');
    expect(html).not.toContain("<table");
    expect(html).not.toContain("data-path=");
    expect(html).not.toContain("Approve (");
    expect(html).not.toContain("rules-edit-form");
    expect(html.replace(/<details class="rules-source-details">[\s\S]*<\/details>/, "")).not.toContain("$300.00");
    expect(renderToStaticMarkup(createElement(EditForm, { review: carried }))).toBe("");
  });
});

describe("DR-112 stale, withdrawn and bound drafts are read only", () => {
  it.each([["STALE", "rules-stale", "can no longer be approved or edited"], ["WITHDRAWN", "", "This draft was withdrawn. It takes no more approvals."], ["BOUND", "rules-bound", "approved by two different approvers and is in use as version 2"]] as const)(
    "%s shows the table and the state, with no approve button and no edit form", (state, testId, sentence) => {
      const html = render(review({ draft: complete(), state, bound: state === "BOUND" ? 2 : null, approvers: [{ actorId: "ben", displayName: "Ben Ortiz", recordedAt: LATER }, { actorId: "tara", displayName: "Tara Lin", recordedAt: LATER }] }), "maria");
      expect(html).toContain(sentence);
      if (testId) expect(html).toContain(`data-testid="${testId}"`);
      expect(html).toContain('data-testid="rules-review-table"');
      expect(approveButton(html)).toBeNull();
      expect(html).not.toContain('name="action" value="approve"');
      expect(html).not.toContain('data-testid="rules-edit-form"');
      expect(html).not.toContain("Fill in or change values");
      expect(html).not.toContain("rules-missing");
    });
  it("lets a stale draft be withdrawn, as the service allows, and gives a withdrawn or bound one no actions at all", () => {
    expect(render(review({ draft: complete(), state: "STALE" }))).toContain('name="action" value="withdraw"');
    for (const state of ["WITHDRAWN", "BOUND"] as const) expect(render(review({ draft: complete(), state, bound: 2 })), state).not.toContain("<form");
  });
  it("shows the state badge from a fixed label", () => {
    for (const [state, label] of [["OPEN", "Open"], ["STALE", "Out of date"], ["REFUSED", "Refused"], ["WITHDRAWN", "Withdrawn"], ["BOUND", "In use"]] as const)
      expect(render(review({ draft: state === "REFUSED" ? null : complete(), state, bound: 2 })), state).toContain(`data-state="${state}" data-testid="rules-state">${label}</span>`);
  });
});

describe("DR-113 grant text and quotes render as plain text, never as markup", () => {
  const ATTACK = `<script>alert("x")</script><img src=x onerror=alert(1)> & "quotes"`;
  it("escapes markup in the grant text, a quote, a clause and the summary", () => {
    const hostile = complete();
    hostile.caps.supplies = field(30000, "1.3", ATTACK);
    hostile.summary = ATTACK;
    const html = render(review({ draft: hostile, inputText: ATTACK }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html.split("&lt;script&gt;").length - 1).toBeGreaterThanOrEqual(3);
  });
  it("keeps the grant text in a closed details element", () => {
    const html = render(review());
    expect(html).toMatch(/<details class="rules-source-details"><summary>Grant text this draft came from<\/summary><pre class="rules-source" data-testid="rules-source">Section 1\./);
    expect(html).not.toMatch(/<details class="rules-source-details" open/);
  });
  it("shows a notice from the fixed table and nothing for a code it does not know", () => {
    const notice = rulesNotice({ notice: "approved-1" });
    expect(notice?.text).toBe("Your approval is recorded. A second, different approver must approve before anything changes.");
    expect(render(review({ draft: complete() }), "ben", notice)).toContain('data-testid="rules-notice"');
    expect(rulesNotice({ notice: "<script>alert(1)</script>" })).toBeNull();
    expect(rulesNotice({ notice: "https://evil.example/" })).toBeNull();
    expect(render(review({ draft: complete() }), "ben", rulesNotice({ notice: "javascript:alert(1)" }))).not.toContain("rules-notice");
  });
});

describe("DR-114 the disclosure line comes from the stored model, and says so when a person made the draft", () => {
  it("names the stored model and Anthropic on a drafted review, built from the id", () => {
    expect(ruleDraftReviewDisclosure("claude-sonnet-5-5")).toBe("Drafted by Claude Sonnet 5.5. The grant text was sent to Anthropic. The AI drafts only: it cannot approve or change a rule.");
    expect(render(review())).toContain('<p class="rules-disclosure" data-testid="rules-disclosure">Drafted by Claude Sonnet 5.5. The grant text was sent to Anthropic.');
    expect(render(review({ model: { ...review().view.model!, model: "claude-haiku-5-5" } }))).toContain("Drafted by Claude Haiku 5.5.");
  });
  it("says nothing was sent for an edited draft, which stores no model", () => {
    expect(ruleDraftReviewDisclosure(null)).toBe("A person edited this draft. Saving the edit sent nothing to Anthropic.");
    const html = render(review({ model: null, changedFields: ["summary"] }));
    expect(html).toContain("A person edited this draft. Saving the edit sent nothing to Anthropic.");
    expect(html).not.toContain("Drafted by Claude");
  });
  it("the form line names the arm's model, says nothing is sent until the button, and an unknown id is shown as it is", () => {
    expect(ruleDraftFormDisclosure("claude-sonnet-5-5")).toBe("Nothing is sent until you press Draft rules. Then the grant text above goes to Anthropic, and Claude Sonnet 5.5 drafts the rules for you to review.");
    expect(ruleDraftFormDisclosure("custom-model")).toContain("custom-model drafts the rules");
  });
});

describe("DR-115 the draft form sends nothing until the button, and a chosen PDF never posts to the draft route", () => {
  const html = renderToStaticMarkup(createElement(RulesDraftForm, { fundId: "fund_a", disclosure: ruleDraftFormDisclosure("claude-sonnet-5-5"), maxChars: 20000, maxPdfBytes: 2 * 1024 * 1024 }));
  it("posts a textarea named text to the create route, with no maxLength and the disclosure above a button that starts disabled", () => {
    expect(html).toContain('action="/api/funds/fund_a/rules/drafts" method="post"');
    expect(html).toMatch(/<textarea id="rules-grant-text" name="text"[^>]*required=""/);
    expect(html).not.toMatch(/maxLength|maxlength/);
    expect(html).toContain('data-ready="false"');
    expect(html).toContain("0 of 20,000 characters");
    expect(html.indexOf("rules-form-disclosure")).toBeLessThan(html.indexOf("rules-draft-submit"));
    expect(html).toContain("Nothing is sent until you press Draft rules.");
    expect(html).toMatch(/<button type="submit" disabled="" aria-busy="false" data-testid="rules-draft-submit">Draft rules<\/button>/);
  });
  it("offers a PDF picker with no name, so the file itself can never be part of the form post, and states the limits", () => {
    const picker = /<input id="rules-grant-pdf"[^>]*>/.exec(html)![0];
    expect(picker).toContain('type="file"');
    expect(picker).toContain('accept="application/pdf,.pdf"');
    expect(picker).not.toMatch(/\sname=/);
    expect(html).toContain("Up to 2 MB and 30 pages, with text in it. A scan of paper has no text to read.");
    expect([...html.matchAll(/<(?:input|textarea|select)[^>]*\sname="([^"]+)"/g)].map(match => match[1])).toEqual(["text"]);
  });
});

describe("DR-116 the edit form takes dollars, never cents, and flags what is required", () => {
  it("shows each cap and limit in dollars under the field names the route reads, and the stored checkboxes", () => {
    const filled = complete(); filled.thresholds.suppliesLimitCents = field(25000, "1.3", "$250.00"); filled.thresholds.staleReceiptDays = field(60, "1.3", "60 days");
    const html = renderToStaticMarkup(createElement(EditForm, { review: review({ draft: filled }) }));
    expect(html).toContain(`name="${EDIT_CAP_FIELDS.supplies}" value="300.00"`);
    expect(html).toContain(`name="${EDIT_CAP_FIELDS.contractual}" value="40.00"`);
    expect(html).toContain(`name="${EDIT_THRESHOLD_FIELDS.suppliesLimitCents}" value="250.00"`);
    expect(html).toContain(`name="${EDIT_THRESHOLD_FIELDS.staleReceiptDays}" value="60"`);
    expect(html).toContain(`name="${EDIT_THRESHOLD_FIELDS.claimLimitCents}" value=""`);
    expect(html).not.toContain('value="30000"');
    expect(html).toMatch(new RegExp(`name="${EDIT_PROGRAM_PREFIX}robotics" checked="" value="on"`));
    expect(html).toMatch(new RegExp(`name="${EDIT_PROGRAM_PREFIX}tutoring" value="on"`));
    expect(html).toMatch(new RegExp(`name="${EDIT_CATEGORY_PREFIX}robot_kits_parts" checked="" value="on"`));
    expect(html).toMatch(new RegExp(`name="${EDIT_CATEGORY_PREFIX}books" value="on"`));
    expect(html).toContain('name="periodStart" value="2026-09-01"');
    expect(html).toContain('type="date"');
    expect(html).toContain('<input type="hidden" name="action" value="edit"/>');
  });
  it("flags only the fields the draft still needs, and renders nothing for a draft that is not open", () => {
    const html = renderToStaticMarkup(createElement(EditForm, { review: review() }));
    expect(html.match(/data-needed="true"/g)).toHaveLength(4);
    expect(html).toContain("Required before approval. Dollars, like 300 or 300.50. Leave blank if the grant sets none.");
    for (const state of ["STALE", "WITHDRAWN", "BOUND"] as const) expect(renderToStaticMarkup(createElement(EditForm, { review: review({ draft: complete(), state }) })), state).toBe("");
    expect(renderToStaticMarkup(createElement(EditForm, { review: review({ draft: null, state: "REFUSED" }) }))).toBe("");
  });
  it("offers no program checkbox when the organization has none, and never a prohibited category", () => {
    const value = review();
    value.catalogs = { categories: ["classroom_supplies"], programs: [] };
    const html = renderToStaticMarkup(createElement(EditForm, { review: value }));
    expect(html).toContain("This organization has no programs yet.");
    expect(html).not.toContain(`name="${EDIT_PROGRAM_PREFIX}`);
    expect(html).not.toContain(`name="${EDIT_CATEGORY_PREFIX}alcohol`);
  });
});

describe("DR-117 the current rules and the draft list read from stored values only", () => {
  it("shows the current approved rules in plain words with money from integer cents", () => {
    const html = renderToStaticMarkup(createElement(CurrentRulesView, { rules: CURRENT }));
    expect(html).toContain("Current summary.");
    expect(html).toContain("2026-01-01 to 2026-12-31");
    expect(html).toContain(`<dt>${capLabel("supplies")}</dt><dd>$100.00</dd>`);
    expect(html).toContain(`<dt>${capLabel("contractual")}</dt><dd>None</dd>`);
    expect(html).toContain("<dd>Not set</dd>");
    expect(html).toContain("Clauses of version 1 (1)");
    expect(renderToStaticMarkup(createElement(CurrentRulesView, { rules: { ...CURRENT, programs: null, allowedCategories: [], periodStart: null, clauses: [] } }))).toContain("<dt>Programs</dt><dd>None</dd>");
  });
  it("lists drafts with state, approvals and a fixed detail line, and says so when there are none", () => {
    const item = (over: Partial<DraftListItem>): DraftListItem => ({ id: "22222222-2222-4222-8222-222222222222", state: "OPEN", parentDraftId: null, createdAt: AT, createdByName: "Tara Lin", basePolicyVersion: 1, boundPolicyVersion: null, approvals: 1, refusalReason: null, changedFields: null, ...over });
    const html = renderToStaticMarkup(createElement(DraftList, { fundId: "fund_a", drafts: [
      item({}), item({ id: "33333333-3333-4333-8333-333333333333", state: "BOUND", approvals: 2, boundPolicyVersion: 3 }), item({ id: "44444444-4444-4444-8444-444444444444", state: "REFUSED", approvals: 0, refusalReason: "QUOTE_NOT_IN_CLAUSE" }),
      item({ id: "55555555-5555-4555-8555-555555555555", parentDraftId: "22222222-2222-4222-8222-222222222222", changedFields: ["summary"] }), item({ id: "66666666-6666-4666-8666-666666666666", state: "STALE" }),
    ] }));
    expect(html).toContain('href="/funds/fund_a/rules/drafts/22222222-2222-4222-8222-222222222222"');
    expect(html).toContain("1 of 2");
    expect(html).toContain("2 of 2");
    expect(html).toContain("In use as version 3.");
    expect(html).toContain("Edited draft of");
    expect(html).toContain(`A person changed: ${pathLabel("summary")}.`);
    expect(html).toContain("which is no longer current.");
    expect(html).toMatch(/data-state="REFUSED"[\s\S]*?<td>None<\/td>/);
    expect(renderToStaticMarkup(createElement(DraftList, { fundId: "fund_a", drafts: [] }))).toContain("No drafts yet for this fund.");
  });
  it("a draft id that is not a plain id still cannot break out of the link attribute", () => {
    const html = renderToStaticMarkup(createElement(DraftList, { fundId: "fund_a", drafts: [{ id: '"><script>x</script>', state: "OPEN", parentDraftId: null, createdAt: AT, createdByName: "<b>Tara</b>", basePolicyVersion: 1, boundPolicyVersion: null, approvals: 0, refusalReason: null, changedFields: null }] }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>Tara</b>");
  });
});

describe("DR-120 the home fund row links only restricted funds to the rules page", () => {
  type Meter = Parameters<typeof import("../src/app/fund-row").FundRow>[0]["meter"];
  const meter = (label: "Restricted" | "Unrestricted"): Meter => ({ name: "Robotics Fund", label, available: "$1.00", book: "$2.00", reserved: "$1.00", percent: 50, ariaLabel: "50 percent reserved" } as unknown as Meter);
  const find = (node: unknown, name: string): ReactElement | null => {
    if (!isValidElement(node)) return Array.isArray(node) ? node.map(child => find(child, name)).find(Boolean) ?? null : null;
    if (typeof node.type === "function" && node.type.name === name) return node;
    const children = (node.props as { children?: unknown }).children;
    return find(children, name);
  };
  it("renders the link component for a restricted row only, and the component resolves to a plain anchor or to nothing", async () => {
    vi.resetModules();
    vi.doMock("../src/server/fund-rules-links", () => ({ fundRulesPath: async (name: string) => (name === "Robotics Fund" ? "/funds/fund_a/rules" : null) }));
    const { FundRow } = await import("../src/app/fund-row");
    const restricted = FundRow({ meter: meter("Restricted") });
    const link = find(restricted, "FundRulesLink");
    expect(link).not.toBeNull();
    expect(find(FundRow({ meter: meter("Unrestricted") }), "FundRulesLink")).toBeNull();
    const rendered = await (link!.type as (props: unknown) => Promise<ReactElement | null>)(link!.props);
    expect(renderToStaticMarkup(rendered as ReactElement)).toBe('<p class="fund-r-link"><a href="/funds/fund_a/rules" data-testid="fund-rules-link">Draft rules from a grant</a></p>');
    const other = await (link!.type as (props: unknown) => Promise<ReactElement | null>)({ name: "Some Other Fund" });
    expect(other).toBeNull();
    vi.doUnmock("../src/server/fund-rules-links");
    vi.resetModules();
  });
});
