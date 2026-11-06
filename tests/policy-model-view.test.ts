import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PolicyChecks } from "../src/app/claims/[claimId]/policy-checks";
import { AI_OFF_MESSAGES } from "../src/ai/provider";
import * as copy from "../src/policy/copy";
import { modelStatusOf, type ModelRunState, type StoredModelLine, type StoredModelPair, type StoredModelRun } from "../src/policy/model-read";
import type { StoredPolicyRun } from "../src/policy/service";

// IAC-405 piece G render and status cases (docs/plans/POLICY_CHECK_SCOPE.md section 5). No database, no clock, no network, no model.
const HASH = "a".repeat(64);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const line = (over: Partial<StoredModelLine> = {}): StoredModelLine => ({ lineId: "L2", description: "Classroom markers", verdict: "OK", clauseId: null, clauseText: null, ...over });
// PB-: a pair stores the models of its CALL rows (called). By default a checked pair, or a failed pair that was answered, timed out or came back invalid, was sent one request to its own model; a LIMIT, NO_CLAUSES or General fund pair was sent none.
const pair = (over: Partial<StoredModelPair> = {}): StoredModelPair => {
  const base = { fundId: "fund_a", fundName: "Fund A", policyVersion: 1, state: "CHECKED" as const, reasonCode: null, model: "claude-haiku-5-5", effort: "low", lines: [line()], ...over };
  const sent = base.model !== null && base.state !== "SKIPPED" && base.reasonCode !== "LIMIT" && base.reasonCode !== "NO_CLAUSES" && base.reasonCode !== "GENERAL_FUND";
  return { ...base, called: over.called ?? (sent ? [base.model!] : []) };
};
const modelRun = (state: ModelRunState, pairs: StoredModelPair[], calledModels: string[] = [...new Set(pairs.flatMap(item => item.called))]): StoredModelRun => ({
  id: "run-1", startedAt: new Date("2026-10-31T12:00:00Z"), model: "claude-haiku-5-5>claude-sonnet-5-5", effort: "low", promptVersion: "compliance-v1", schemaVersion: "compliance-lines-v1",
  clauseSetHash: "b".repeat(64), state, status: modelStatusOf(state, pairs), pairs, calledModels,
});
const rules = (model: StoredModelRun | null | undefined, flags: StoredPolicyRun["flags"] = []): StoredPolicyRun => ({
  id: "rules-1", startedAt: new Date("2026-10-31T11:59:00Z"), startedByName: "Tara", ruleSetVersion: "rules-v1", settingsVersions: { fund_a: 1 }, complete: true, flags, notChecked: [], ...(model === undefined ? {} : { model }),
});
const hold = (over: Partial<StoredPolicyRun["flags"][number]> = {}) => ({ sequence: 1, ruleId: "P7", severity: "HOLD" as const, lineId: "L3", fundId: "fund_a", settingsVersion: 1, flagText: "Gift cards are on this claim.", ...over });
const render = (props: Partial<Parameters<typeof PolicyChecks>[0]> & { run: StoredPolicyRun | null }) =>
  renderToStaticMarkup(createElement(PolicyChecks, { claimId: "R-1", decisionHash: HASH, canRun: false, modelEligible: true, ...props }));

describe("PC-13 the claim-level model status", () => {
  const cases: [string, ModelRunState, StoredModelPair[], string][] = [
    ["a running run", "RUNNING", [], "RUNNING"],
    ["a running run with rows is still running", "RUNNING", [pair()], "RUNNING"],
    ["an interrupted run holds even when every stored line is OK", "INTERRUPTED", [pair()], "HOLD"],
    ["a finished run with every line OK has no conflict found", "DONE", [pair(), pair({ fundId: "fund_b", fundName: "Fund B" })], "NO_CONFLICT_FOUND"],
    ["one CONFLICT holds", "DONE", [pair({ lines: [line({ verdict: "CONFLICT", clauseId: "1.4", clauseText: "No gift cards." })] })], "HOLD"],
    ["one UNSURE holds", "DONE", [pair({ lines: [line(), line({ lineId: "L3", verdict: "UNSURE" })] })], "HOLD"],
    ["one NOT_CHECKED pair holds even beside an OK pair", "DONE", [pair(), pair({ fundId: "fund_b", fundName: "Fund B", state: "NOT_CHECKED", reasonCode: "INVALID", lines: [] })], "HOLD"],
    ["a NO_CLAUSES pair holds", "DONE", [pair({ state: "NOT_CHECKED", reasonCode: "NO_CLAUSES", model: null, effort: null, lines: [] })], "HOLD"],
    ["only a skipped General fund means nothing was checked", "DONE", [pair({ fundId: "fund_g", fundName: "General fund", state: "SKIPPED", reasonCode: "GENERAL_FUND", model: null, effort: null, lines: [] })], "NOTHING_CHECKED"],
    ["a skipped General fund beside an OK pair is still no conflict found", "DONE", [pair(), pair({ fundId: "fund_g", fundName: "General fund", state: "SKIPPED", reasonCode: "GENERAL_FUND", model: null, effort: null, lines: [] })], "NO_CONFLICT_FOUND"],
    ["a finished run with no pairs checked nothing", "DONE", [], "NOTHING_CHECKED"],
  ];
  it.each(cases)("%s", (_name, state, pairs, expected) => { expect(modelStatusOf(state, pairs)).toBe(expected); });
});

describe("PC-14 the model rows on the claim page", () => {
  it("uses only OK, CONFLICT, UNSURE and NOT_CHECKED words, and no output says cleared, approved, passed, Hold for review or Allowed", () => {
    const variants: StoredModelRun[] = [
      modelRun("RUNNING", []),
      modelRun("INTERRUPTED", [pair()]),
      modelRun("DONE", [pair()]),
      modelRun("DONE", [pair({ lines: [line({ verdict: "CONFLICT", clauseId: "1.4", clauseText: "Gift cards are not an allowed expense." }), line({ lineId: "L3", verdict: "UNSURE", clauseId: "1.2" })] })]),
      modelRun("DONE", [pair({ lines: [line({ verdict: "UNSURE" })] })]),
      ...["TIMEOUT", "UNAVAILABLE", "INVALID", "LIMIT", "NO_CLAUSES", "GENERAL_FUND", null].map(reason =>
        modelRun("DONE", [pair({ state: "NOT_CHECKED", reasonCode: reason as never, model: reason === "NO_CLAUSES" ? null : "claude-sonnet-5-5", lines: [] })])),
      modelRun("DONE", [pair({ fundId: "fund_g", fundName: "General fund", state: "SKIPPED", reasonCode: "GENERAL_FUND", model: null, effort: null, lines: [] })]),
    ];
    for (const run of variants) {
      const body = text(render({ run: rules(run) }));
      expect(body).not.toMatch(/\b(cleared|approved|passed)\b/i);
      expect(body).not.toMatch(/Hold for review/);
      expect(body).not.toMatch(/\bAllowed\b/);
      expect(body).toContain(copy.MODEL_STATUS_TEXT[run.status]);
    }
  });

  it("a rule Hold and a model OK are both shown, the rule row first, and the OK does not remove or soften the Hold", () => {
    const run = rules(modelRun("DONE", [pair()]), [hold()]);
    const markup = render({ run });
    const body = text(markup);
    expect(body).toContain("Hold: Gift cards are on this claim.");
    expect(body).toContain(copy.MODEL_STATUS_TEXT.NO_CONFLICT_FOUND);
    // IAC-415 PR 4: the OK line is one sentence per fund (FO-06, FO-07). "This is not an approval." stays once, in the model status line.
    expect(body).toContain("No conflict found by the model on Line L2 (Classroom markers)."); expect(body.match(/This is not an approval\./g)).toHaveLength(1);
    expect(body.indexOf("Gift cards are on this claim.")).toBeLessThan(body.indexOf("Model status"));
    // The model section sits inside the same Rule checks section, after the rule rows.
    expect(markup.match(/<section /g)).toHaveLength(1);
    expect(markup.indexOf("Gift cards are on this claim.")).toBeLessThan(markup.indexOf("Model status"));
    // The rule rows render identically with and without a model run: the model adds text after them and removes none.
    const without = text(render({ run: rules(undefined, [hold()]), modelEligible: false }));
    expect(without).toContain("Hold: Gift cards are on this claim.");
  });

  it("a CONFLICT shows the server-looked-up clause text as a quote, the model id and effort, and the stored line description", () => {
    const body = text(render({ run: rules(modelRun("DONE", [pair({ lines: [line({ lineId: "L3", description: "Gift cards for volunteers", verdict: "CONFLICT", clauseId: "1.4", clauseText: "Gift cards are not an allowed expense." })] })])) }));
    expect(body).toContain('Line L3 (Gift cards for volunteers): conflict with clause 1.4: "Gift cards are not an allowed expense."');
    expect(body).toContain("Checked by AI (Haiku 5.5) at low effort.");
    expect(body).toContain(copy.MODEL_STATUS_TEXT.HOLD);
  });

  it("only a CONFLICT carries a quote, and an UNSURE or OK line never shows clause text", () => {
    const body = text(render({ run: rules(modelRun("DONE", [pair({ lines: [
      line({ lineId: "L1", verdict: "UNSURE", clauseId: "1.2", clauseText: "SECRET CLAUSE TEXT" }), line({ lineId: "L2", verdict: "OK", clauseId: null, clauseText: "SECRET CLAUSE TEXT" }),
    ] })])) }));
    expect(body).not.toContain("SECRET CLAUSE TEXT");
    expect(body).toContain("the model could not tell whether clause 1.2 permits this line.");
  });

  it("each NOT_CHECKED reason shows its fixed sentence, names the model that failed when there is one, and the skipped General fund says so", () => {
    for (const reason of ["TIMEOUT", "UNAVAILABLE", "INVALID", "LIMIT", "NO_CLAUSES", "GENERAL_FUND"] as const) {
      const failed = reason !== "NO_CLAUSES"; const sent = failed && reason !== "LIMIT";
      const body = text(render({ run: rules(modelRun("DONE", [pair({ state: "NOT_CHECKED", reasonCode: reason, model: failed ? "claude-sonnet-5-5" : null, effort: failed ? "low" : null, lines: [], called: sent ? ["claude-sonnet-5-5"] : [] })])) }));
      expect(body).toContain(copy.modelNotChecked(reason));
      expect(body).toContain(copy.MODEL_STATUS_TEXT.HOLD);
      // PB-: a LIMIT pair stored no CALL row, so no model was sent a request and the row does not say it was asked.
      if (sent) expect(body).toContain("Asked AI (Sonnet 5.5) at low effort."); expect(body).not.toMatch(sent ? /Checked by/ : /Checked by|Asked /);
    }
    const skipped = text(render({ run: rules(modelRun("DONE", [pair({ fundId: "fund_g", fundName: "General fund", state: "SKIPPED", reasonCode: "GENERAL_FUND", model: null, effort: null, lines: [] })])) }));
    expect(skipped).toContain("General fund: not checked by the model. The General fund has no clauses to check.");
    expect(skipped).toContain(copy.MODEL_STATUS_TEXT.NOTHING_CHECKED);
  });

  it("a running run shows the running sentence and an interrupted run shows the not-checked sentence, and neither shows an OK", () => {
    const running = text(render({ run: rules(modelRun("RUNNING", [])) }));
    expect(running).toContain(copy.MODEL_RUNNING); expect(running).toContain(copy.MODEL_STATUS_TEXT.RUNNING);
    const interrupted = text(render({ run: rules(modelRun("INTERRUPTED", [pair()])) }));
    expect(interrupted).toContain(copy.MODEL_INTERRUPTED); expect(interrupted).toContain(copy.MODEL_STATUS_TEXT.HOLD);
  });

  // IAC-416 PR 2 (Pavan, November 1: "we need to just say AI"): the rows say "AI (Haiku 5.5)" and one line names the provider and each model that was asked.
  it("the model check section carries one disclosure line naming the provider and each asked model once, and the rows say AI", () => {
    const both = text(render({ run: rules(modelRun("DONE", [pair(), pair({ fundId: "fund_b", fundName: "Fund B", model: "claude-sonnet-5-5" }), pair({ fundId: "fund_c", fundName: "Fund C", model: "claude-haiku-5-5" })])) }));
    expect(both.match(/Claim line and clause text was sent to Anthropic\./g)).toHaveLength(1);
    expect(both).toContain("Powered by Claude Haiku 5.5 and Claude Sonnet 5.5. Claim line and clause text was sent to Anthropic.");
    expect(both).toContain("Checked by AI (Haiku 5.5) at low effort."); expect(both).toContain("Checked by AI (Sonnet 5.5) at low effort.");
    expect(both.match(/Claude/g)).toHaveLength(2);
    const one = text(render({ run: rules(modelRun("DONE", [pair()])) }));
    expect(one).toContain("Powered by Claude Haiku 5.5. Claim line and clause text was sent to Anthropic.");
  });
  it("a pair that sent no request is not named: a request-limit refusal, a skipped General fund, a pair with no model and a run with no pair asked add no disclosure", () => {
    const limited = text(render({ run: rules(modelRun("DONE", [pair({ state: "NOT_CHECKED", reasonCode: "LIMIT", model: "claude-sonnet-5-5", lines: [] })])) }));
    expect(limited).not.toMatch(/Asked AI|sent to Anthropic|Claude|Powered by/);
    const skipped = text(render({ run: rules(modelRun("DONE", [pair({ fundId: "fund_g", fundName: "General fund", state: "SKIPPED", reasonCode: "GENERAL_FUND", model: null, effort: null, lines: [] })])) }));
    expect(skipped).not.toMatch(/sent to Anthropic|Claude/);
    const noClauses = text(render({ run: rules(modelRun("DONE", [pair({ state: "NOT_CHECKED", reasonCode: "NO_CLAUSES", model: null, effort: null, lines: [] })])) }));
    expect(noClauses).not.toMatch(/sent to Anthropic|Claude/);
    // A limit-refused pair beside an asked pair names only the asked model.
    const mixed = text(render({ run: rules(modelRun("DONE", [pair(), pair({ fundId: "fund_b", fundName: "Fund B", state: "NOT_CHECKED", reasonCode: "LIMIT", model: "claude-sonnet-5-5", lines: [] })])) }));
    expect(mixed).toContain("Powered by Claude Haiku 5.5. Claim line and clause text was sent to Anthropic."); expect(mixed).not.toContain("Claude Sonnet");
    // A timed-out request was sent, so its pair is named.
    const timedOut = text(render({ run: rules(modelRun("DONE", [pair({ state: "NOT_CHECKED", reasonCode: "TIMEOUT", model: "claude-sonnet-5-5", lines: [] })])) }));
    expect(timedOut).toContain("Powered by Claude Sonnet 5.5. Claim line and clause text was sent to Anthropic.");
  });
  it("stored descriptions, clause text, fund names and flag text render as escaped text, never markup", () => {
    const evil = "<script>alert(1)</script><img src=x onerror=alert(2)>";
    const markup = render({ run: rules(modelRun("DONE", [pair({ fundName: evil, lines: [line({ description: evil, verdict: "CONFLICT", clauseId: "1.4", clauseText: evil })] })]), [hold({ flagText: evil })]) });
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;script&gt;");
  });
});

describe("PC-23 the AI-off line and the applicability line", () => {
  it("each AI-off message appears word for word when the model check did not run and the claim is eligible", () => {
    for (const message of Object.values(AI_OFF_MESSAGES)) {
      const markup = render({ run: rules(null), aiOff: message });
      expect(markup).toContain(message.replace(/&/g, "&amp;"));
      expect(markup).not.toContain(copy.MODEL_NOT_RUN);
      expect(text(markup)).not.toMatch(/Model status|Checked by|Line L\d/);
    }
  });
  it("a model run that exists wins over the AI-off text, and an eligible run with no model and AI on reads as not run", () => {
    expect(text(render({ run: rules(modelRun("DONE", [pair()])), aiOff: AI_OFF_MESSAGES.SWITCHED_OFF }))).not.toContain(AI_OFF_MESSAGES.SWITCHED_OFF);
    const notRun = text(render({ run: rules(null), aiOff: null }));
    expect(notRun).toContain(copy.MODEL_NOT_RUN);
    expect(text(render({ run: rules(undefined), aiOff: null }))).toContain(copy.MODEL_NOT_RUN);
  });
  it("a claim without a confirmed receipt review shows the applicability line and no model rows, and a caller that passes no model flag renders the rule section as before", () => {
    const notEligible = text(render({ run: rules(null), modelEligible: false, aiOff: AI_OFF_MESSAGES.SWITCHED_OFF }));
    expect(notEligible).toContain(copy.MODEL_NOT_APPLICABLE);
    expect(notEligible).not.toContain(AI_OFF_MESSAGES.SWITCHED_OFF);
    const legacy = render({ run: rules(undefined), modelEligible: undefined });
    expect(text(legacy)).not.toMatch(/Model status|model check|Checked by/i);
  });
  it("with no rule run yet the section shows the fixed AI-off line when AI is off and no model rows, and the Run button shows only for an approver who can run", () => {
    const none = text(render({ run: null, aiOff: AI_OFF_MESSAGES.NO_KEY }));
    expect(none).toContain(copy.POLICY_NOT_RUN);
    expect(none).toContain(AI_OFF_MESSAGES.NO_KEY);
    expect(none).not.toMatch(/Model status|Checked by|Line L\d/);
    expect(text(render({ run: null, aiOff: null }))).not.toMatch(/AI suggestions|Model status|model check/i);
    expect(render({ run: null, canRun: false })).not.toContain("<button");
    expect(render({ run: null, canRun: true })).toContain(copy.POLICY_RUN_BUTTON);
  });
});

// FO-06 and FO-07 (IAC-415 PR 4, docs/GATE_REPORT.md section 51). The OK lines of a fund collapse into one sentence. A CONFLICT or UNSURE line keeps its
// own row first, a CONFLICT keeps its quoted clause, and "This is not an approval." stays once in the model status line.
describe("FO-06 modelOkSentence names every OK line in one sentence", () => {
  const ok = (lineId: string, description: string) => ({ lineId, description });
  it("names one, two and three or more lines with the exact join", () => {
    expect(copy.modelOkSentence([ok("L1", "Robot kit")])).toBe("No conflict found by the model on Line L1 (Robot kit).");
    expect(copy.modelOkSentence([ok("L1", "Robot kit"), ok("L3", "Sandwiches")])).toBe("No conflict found by the model on Line L1 (Robot kit) and Line L3 (Sandwiches).");
    expect(copy.modelOkSentence([ok("L1", "Robot kit"), ok("L2", "Markers"), ok("L3", "Sandwiches")])).toBe("No conflict found by the model on Line L1 (Robot kit), Line L2 (Markers) and Line L3 (Sandwiches).");
  });
  it("is empty for no lines, keeps the stored order and never says cleared, approved, passed or This is not an approval", () => {
    expect(copy.modelOkSentence([])).toBe("");
    const sentence = copy.modelOkSentence([ok("L9", "Zebra"), ok("L1", "Apple"), ok("L5", "Mango"), ok("L2", "Pear")]);
    expect(sentence.indexOf("Line L9")).toBeLessThan(sentence.indexOf("Line L1")); expect(sentence.indexOf("Line L5")).toBeLessThan(sentence.indexOf("Line L2"));
    expect(sentence).not.toMatch(/\b(cleared|approved|passed)\b/i); expect(sentence).not.toContain("This is not an approval");
  });
});

describe("FO-07 the model rows collapse OK lines and keep every CONFLICT and UNSURE row", () => {
  const mixed = [line({ lineId: "L1", description: "Robot kit" }), line({ lineId: "L2", description: "Gift cards for volunteers", verdict: "CONFLICT", clauseId: "1.4", clauseText: "Gift cards are not an allowed expense." }),
    line({ lineId: "L3", description: "Sandwiches" }), line({ lineId: "L4", description: "Poster board", verdict: "UNSURE", clauseId: "1.2" })];
  it("puts the CONFLICT and UNSURE rows first, in stored order, with the quoted clause, then one OK sentence", () => {
    const markup = render({ run: rules(modelRun("DONE", [pair({ lines: mixed })]), [hold()]) }); const body = text(markup);
    const conflict = 'Line L2 (Gift cards for volunteers): conflict with clause 1.4: "Gift cards are not an allowed expense."';
    const unsure = "Line L4 (Poster board): the model could not tell whether clause 1.2 permits this line.";
    const okLine = "No conflict found by the model on Line L1 (Robot kit) and Line L3 (Sandwiches).";
    for (const part of [conflict, unsure, okLine]) { expect(body).toContain(part); expect(body.split(part).length - 1, part).toBe(1); }
    expect(body.indexOf(conflict)).toBeLessThan(body.indexOf(unsure)); expect(body.indexOf(unsure)).toBeLessThan(body.indexOf(okLine));
    expect(markup.match(/<li>/g)).toHaveLength(4); // the rule Hold row, then the CONFLICT row, the UNSURE row and the one OK sentence
    expect(body).toContain(copy.MODEL_STATUS_TEXT.HOLD); expect(body).not.toContain("This is not an approval"); // a Hold rule row, so the rule part has no "No rule flags. This is not an approval." either
    expect(body).not.toMatch(/Line L1 \(Robot kit\): no conflict|Line L3 \(Sandwiches\): no conflict/);
  });
  it("prints no OK sentence when no line is OK, and one row only when every line is OK", () => {
    const none = render({ run: rules(modelRun("DONE", [pair({ lines: [mixed[1]!, mixed[3]!] })]), [hold()]) });
    expect(text(none)).not.toMatch(/No conflict found by the model on/); expect(none.match(/<li>/g)).toHaveLength(3);
    const all = render({ run: rules(modelRun("DONE", [pair({ lines: [mixed[0]!, mixed[2]!] })]), [hold()]) });
    expect(all.match(/<li>/g)).toHaveLength(2); expect(text(all).match(/This is not an approval\./g)).toHaveLength(1);
  });
  it("writes one sentence per fund, and a skipped or unchecked fund adds none", () => {
    const body = text(render({ run: rules(modelRun("DONE", [
      pair({ fundId: "fund_a", fundName: "Fund A", lines: [mixed[0]!, mixed[2]!] }), pair({ fundId: "fund_b", fundName: "Fund B", lines: [line({ lineId: "L1", description: "Robot kit" })] }),
      pair({ fundId: "fund_c", fundName: "Fund C", state: "NOT_CHECKED", reasonCode: "TIMEOUT", lines: [] }),
    ])) }));
    expect(body.match(/No conflict found by the model on/g)).toHaveLength(2);
    expect(body).toContain("No conflict found by the model on Line L1 (Robot kit).");
    expect(body.indexOf("Fund A")).toBeLessThan(body.indexOf("No conflict found by the model on Line L1 (Robot kit) and")); expect(body).toContain(copy.modelNotChecked("TIMEOUT"));
  });
  it("renders a stored description in the OK sentence as escaped text", () => {
    const evil = "<img src=x onerror=alert(3)>";
    const markup = render({ run: rules(modelRun("DONE", [pair({ lines: [line({ description: evil })] })])) });
    expect(markup).not.toContain("<img"); expect(markup).toContain("&lt;img");
  });
});

// IAC-415 PR 6 (checks read once): the Checks panel summary and the heading level. Pure strings and static markup, no database, no clock, no network.
describe("CO-04 ruleChecksSummary counts only HOLD flags and never calls a Hold clear", () => {
  const holdFlag = { severity: "HOLD" as const };
  const noteFlag = { severity: "NOTE" as const };
  it("says only the count when there is no stored run, no flags or only Notes", () => {
    for (const flags of [null, undefined, [], [noteFlag], [noteFlag, noteFlag]]) expect(copy.ruleChecksSummary(3, 3, flags)).toBe("Rule checks: 3 of 3 clear.");
    expect(copy.ruleChecksSummary(1, 4, null)).toBe("Rule checks: 1 of 4 clear.");
  });
  it("names one Hold in the singular and two or more in the plural, in the same line as the count", () => {
    expect(copy.ruleChecksSummary(3, 3, [holdFlag])).toBe("Rule checks: 3 of 3 clear. 1 Hold below goes to the approvers.");
    expect(copy.ruleChecksSummary(3, 3, [holdFlag, holdFlag])).toBe("Rule checks: 3 of 3 clear. 2 Holds below go to the approvers.");
    expect(copy.ruleChecksSummary(3, 3, [holdFlag, holdFlag, holdFlag, holdFlag])).toBe("Rule checks: 3 of 3 clear. 4 Holds below go to the approvers.");
  });
  it("counts HOLD only: a Note beside Holds adds nothing to the Hold count", () => {
    expect(copy.ruleChecksSummary(3, 3, [holdFlag, noteFlag, holdFlag, noteFlag, noteFlag])).toBe("Rule checks: 3 of 3 clear. 2 Holds below go to the approvers.");
    expect(copy.ruleChecksSummary(3, 3, [noteFlag, holdFlag])).toBe("Rule checks: 3 of 3 clear. 1 Hold below goes to the approvers.");
  });
  it("the Hold clause never says approved, passed or cleared, and the clear count is the passed-in count", () => {
    const withHolds = copy.ruleChecksSummary(2, 5, [holdFlag, holdFlag]);
    const clause = withHolds.replace("Rule checks: 2 of 5 clear. ", "");
    expect(clause).not.toMatch(/\b(cleared|approved|passed|clear)\b/i);
    expect(withHolds.match(/\bclear\b/g)).toHaveLength(1);
    expect(withHolds).toBe("Rule checks: 2 of 5 clear. 2 Holds below go to the approvers.");
  });
});

describe("CO-05 the Policy checks block is an h2 by default, an h3 on request, and its footer says Holds", () => {
  const body = { run: rules(null, [hold()]) };
  it("renders the h2 with no headingLevel and the h3 with headingLevel 3, with the same id and the same title", () => {
    const h2 = render(body); const h3 = render({ ...body, headingLevel: 3 });
    expect(h2).toContain('<h2 id="policy-checks-title">Policy checks</h2>'); expect(h2).not.toContain("<h3");
    expect(render({ ...body, headingLevel: 2 })).toBe(h2);
    expect(h3).toContain('<h3 id="policy-checks-title">Policy checks</h3>'); expect(h3).not.toContain("<h2");
    expect(h3.replace("<h3", "<h2").replace("</h3>", "</h2>")).toBe(h2);
  });
  it("the footer is the Holds sentence in every state, and the old Flags sentence is gone", () => {
    expect(copy.POLICY_FOOTER).toBe("Holds do not block approval. Two approvers are still required.");
    for (const props of [{ run: rules(null, [hold()]) }, { run: rules(null) }, { run: null }, { run: rules(modelRun("DONE", [pair()])), headingLevel: 3 as const }]) {
      const rendered = text(render(props));
      expect(rendered).toContain("Holds do not block approval. Two approvers are still required.");
      expect(rendered).not.toContain("Flags do not block");
    }
  });
});
