import { describe, expect, it } from "vitest";
import { BUDGET_LINE, SELECTABLE } from "../src/ai/categories";
import {
  CLAUSE_ID, CLAUSE_MAX_CHARS, CLAUSE_MAX_COUNT, DRAFT_REFUSALS, analyze, applyEdit, probePrepare, requiredBudgetLines, toPolicy, validInputText, validateDraft, type GrantInput,
} from "../src/rules-draft/draft-validate";
import { AGREEMENT, CLAUSE_SCOPE, GRANT, drafted, goodAnswer, storedUnsure, unsure, unsureList, unsureText } from "./support/rules-draft";

// IAC-440 Package A, DR-01 to DR-14 (docs/GATE_REPORT.md section 58): the pure validator. Every rule has a planted failing case beside a passing case.
// No database, no model, no network. A refusal names a reason code and the path of the field that broke the rule.
const run = (raw: unknown, input: GrantInput = GRANT) => validateDraft(raw, input, "MODEL");
const refusal = (raw: unknown, input: GrantInput = GRANT) => { const result = run(raw, input); return result.ok ? null : `${result.reason} ${result.path}`; };
const mutate = (change: (answer: Record<string, any>) => void) => { const answer = goodAnswer(); change(answer); return answer; };
// A grant text with one more clause (id 1.9), for a value the base agreement does not state. The answer and the input are built together so the
// clause stays an exact substring of the pasted text.
const withClause = (text: string, change: (answer: Record<string, any>) => void) => {
  const answer = goodAnswer(); answer.clauses.push({ id: "1.9", text }); change(answer);
  return { answer, input: { ...GRANT, text: `${GRANT.text}\n${text}` } as GrantInput };
};

describe("DR-01 a valid draft passes", () => {
  it("returns a complete draft with no missing field, six carried thresholds and the breadth equal to the category count", () => {
    const result = run(goodAnswer());
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.analysis).toEqual({ complete: true, missing: [], carried: ["suppliesLimitCents", "equipmentLimitCents", "claimLimitCents", "staleReceiptDays", "duplicateWindowDays", "splitWindowDays"], quoteUnsupported: [] });
    expect(result.draft.breadth).toBe(2);
    expect(result.draft.clauses.map(clause => clause.id)).toEqual(["1.1", "1.2", "1.3"]);
    expect(toPolicy(result.draft)).toMatchObject({ programs: ["robotics"], periodStart: "2026-09-01", periodEnd: "2027-06-30", breadth: 2, budgetLines: [{ budgetLine: "supplies", capCents: 30000n }] });
  });
  it("lists every refusal code it can return, each once", () => { expect(new Set(DRAFT_REFUSALS).size).toBe(DRAFT_REFUSALS.length); });
});

describe("DR-02 every clause is an exact substring of the pasted text", () => {
  it("refuses a clause that differs from the text by one character, a paraphrase and a clause joined across a gap", () => {
    for (const text of [CLAUSE_SCOPE.replace("only", "solely"), CLAUSE_SCOPE.replace("robot kits,", "robot kits"), `${CLAUSE_SCOPE} Extra words.`, "Section 1. Funds may be used only ... classroom supplies."]) {
      expect(refusal(mutate(answer => { answer.clauses[0].text = text; }))).toBe("CLAUSE_NOT_SUBSTRING clauses.0");
    }
  });
  it("accepts a clause with surrounding whitespace and stores it trimmed, still a substring", () => {
    const result = run(mutate(answer => { answer.clauses[0].text = `\n${CLAUSE_SCOPE}\n`; }));
    expect(result.ok).toBe(true); if (result.ok) { expect(result.draft.clauses[0]!.text).toBe(CLAUSE_SCOPE); expect(AGREEMENT.includes(result.draft.clauses[0]!.text)).toBe(true); }
  });
  it("refuses a case change, because the match is exact", () => {
    expect(refusal(mutate(answer => { answer.clauses[0].text = CLAUSE_SCOPE.toUpperCase(); }))).toBe("CLAUSE_NOT_SUBSTRING clauses.0");
  });
});

describe("DR-03 a clause is 1 to 600 characters after trim", () => {
  const long = (length: number) => `${"x".repeat(length)}`;
  const withText = (text: string): GrantInput => ({ ...GRANT, text: `${AGREEMENT}\n${text}` });
  it("refuses a blank clause and a 601 character clause", () => {
    expect(refusal(mutate(answer => { answer.clauses[0].text = "   "; }), { ...GRANT, text: `${AGREEMENT}   ` })).toBe("CLAUSE_LENGTH clauses.0");
    const input = withText(long(CLAUSE_MAX_CHARS + 1));
    expect(refusal(mutate(answer => { answer.clauses[0].text = long(CLAUSE_MAX_CHARS + 1); }), input)).toBe("CLAUSE_LENGTH clauses.0");
  });
  it("accepts a 600 character clause and counts code points, not UTF-16 units", () => {
    const input = withText(long(CLAUSE_MAX_CHARS));
    expect(run(mutate(answer => { answer.clauses[0].text = long(CLAUSE_MAX_CHARS); answer.programs = unsureList(); answer.allowedCategories = unsureList(); answer.breadth = 0; answer.periodStart = unsureText(); answer.periodEnd = unsureText(); answer.caps.supplies = unsure(); }), input).ok).toBe(true);
    const emoji = "\u{1F9E9}".repeat(CLAUSE_MAX_CHARS);
    expect(emoji.length).toBe(CLAUSE_MAX_CHARS * 2);
    expect(run(mutate(answer => { answer.clauses[0].text = emoji; answer.programs = unsureList(); answer.allowedCategories = unsureList(); answer.breadth = 0; answer.periodStart = unsureText(); answer.periodEnd = unsureText(); answer.caps.supplies = unsure(); }), withText(emoji)).ok).toBe(true);
  });
});

describe("DR-04 clause ids are two numbers joined by a dot, unique, and between 1 and 40 clauses", () => {
  it("accepts 1.1, 12.34 and 0.0, and refuses every other shape", () => {
    for (const id of ["1.1", "12.34", "0.0", "9.10"]) expect(CLAUSE_ID.test(id), id).toBe(true);
    for (const id of ["1", "123.1", "1.234", "a.b", "1.1 ", " 1.1", "1,1", "1.1.1", "", "1.-1", "1.1\n"]) {
      expect(refusal(mutate(answer => { answer.clauses[0].id = id; })), JSON.stringify(id)).toBe("CLAUSE_ID clauses.0");
    }
  });
  it("refuses a duplicate id and a non-string id", () => {
    expect(refusal(mutate(answer => { answer.clauses[1].id = "1.1"; }))).toBe("CLAUSE_DUPLICATE clauses.1");
    expect(refusal(mutate(answer => { answer.clauses[0].id = 1.1; }))).toBe("CLAUSE_ID clauses.0");
  });
  it("refuses no clauses and more than the clause maximum", () => {
    expect(refusal(mutate(answer => { answer.clauses = []; }))).toBe("NO_CLAUSES clauses");
    expect(refusal(mutate(answer => { answer.clauses = Array.from({ length: CLAUSE_MAX_COUNT + 1 }, (_, index) => ({ id: `${Math.floor(index / 10)}.${index % 10}`, text: CLAUSE_SCOPE })); }))).toBe("CLAUSE_COUNT clauses");
  });
});

describe("DR-05 every category and program is in the catalog", () => {
  it("refuses a category that is not in the catalog, an empty list, a non-string and a repeat", () => {
    expect(refusal(mutate(answer => { answer.allowedCategories.value = ["robot_kits_parts", "spaceships"]; }))).toBe("CATEGORY_UNKNOWN allowedCategories");
    expect(refusal(mutate(answer => { answer.allowedCategories.value = ["UNKNOWN"]; answer.breadth = 1; }))).toBe("CATEGORY_UNKNOWN allowedCategories");
    expect(refusal(mutate(answer => { answer.allowedCategories.value = []; answer.breadth = 0; }))).toBe("SHAPE allowedCategories");
    expect(refusal(mutate(answer => { answer.allowedCategories.value = [7]; answer.breadth = 1; }))).toBe("SHAPE allowedCategories");
    expect(refusal(mutate(answer => { answer.allowedCategories.value = ["robot_kits_parts", "robot_kits_parts"]; }))).toBe("DUPLICATE_VALUE allowedCategories");
  });
  it("refuses a category the request never offered, even when it is a real category", () => {
    expect(refusal(goodAnswer(), { ...GRANT, categories: ["robot_kits_parts"] })).toBe("CATEGORY_UNKNOWN allowedCategories");
  });
  it("refuses a program that is not in the catalog and one with a malformed id", () => {
    expect(refusal(mutate(answer => { answer.programs.value = ["robotics", "chess_club"]; }))).toBe("PROGRAM_UNKNOWN programs");
    expect(refusal(mutate(answer => { answer.programs.value = ["Robotics"]; }), { ...GRANT, programs: ["Robotics"] })).toBe("PROGRAM_UNKNOWN programs");
    expect(refusal(mutate(answer => { answer.programs.value = ["robotics"]; }), { ...GRANT, programs: [] })).toBe("PROGRAM_UNKNOWN programs");
  });
  it("accepts every selectable category that has a budget line, one at a time", () => {
    const choosable = SELECTABLE.filter(category => BUDGET_LINE[category] !== "prohibited");
    expect(choosable.length).toBe(17);
    for (const category of choosable) {
      const line = BUDGET_LINE[category] as string;
      const result = run(mutate(answer => { answer.allowedCategories.value = [category]; answer.breadth = 1; answer.caps = { ...answer.caps, supplies: unsure(), [line]: drafted(30000, "1.3", "$300.00") }; }));
      expect(result.ok, category).toBe(true); if (result.ok) expect(result.analysis.complete, category).toBe(true);
    }
  });
});

describe("DR-06 no prohibited category is ever allowed", () => {
  it("refuses a category the organization prohibits", () => {
    expect(refusal(goodAnswer(), { ...GRANT, prohibited: ["alcohol", "gift_cards", "classroom_supplies"] })).toBe("PROHIBITED_CATEGORY allowedCategories");
  });
  it("refuses alcohol and gift cards even when the organization list is empty, because the app maps both to the prohibited sentinel", () => {
    for (const category of ["alcohol", "gift_cards"]) {
      expect(refusal(mutate(answer => { answer.allowedCategories.value = ["robot_kits_parts", category]; }), { ...GRANT, prohibited: [] })).toBe("PROHIBITED_CATEGORY allowedCategories");
    }
  });
  it("refuses a prohibited category that sits at the end or the start of the list, and an inherited property name", () => {
    expect(refusal(mutate(answer => { answer.allowedCategories.value = ["alcohol", "robot_kits_parts"]; }))).toBe("PROHIBITED_CATEGORY allowedCategories");
    expect(refusal(mutate(answer => { answer.allowedCategories.value = ["constructor"]; answer.breadth = 1; }))).toBe("CATEGORY_UNKNOWN allowedCategories");
    expect(refusal(mutate(answer => { answer.allowedCategories.value = ["__proto__"]; answer.breadth = 1; }))).toBe("CATEGORY_UNKNOWN allowedCategories");
  });
});

describe("DR-07 dates are valid ISO dates and the start is not after the end", () => {
  it("refuses a malformed date, an impossible calendar date, a year outside the grant window and a non-string", () => {
    for (const value of ["tomorrow", "2026-02-30", "2026-13-01", "26-09-01", "2026-9-1", "2026-09-01T00:00:00Z", "0001-01-01", "2200-01-01", 20260901, ""]) {
      expect(refusal(mutate(answer => { answer.periodStart.value = value; })), JSON.stringify(value)).toBe("DATE_INVALID periodStart");
    }
  });
  it("refuses a start after the end and accepts a one day period and a leap day", () => {
    // Each value keeps a quote that holds its year, so the support check (DR-48) leaves it alone and the order rule is what decides.
    const start = (value: string) => mutate(answer => { answer.periodStart = drafted(value, "1.2", "ends on 2027-06-30"); });
    expect(refusal(start("2027-07-01"))).toBe("DATE_ORDER periodEnd");
    const oneDay = run(start("2027-06-30"));
    expect(oneDay.ok && oneDay.draft.periodStart.value).toBe("2027-06-30");
    const { answer, input } = withClause("Section 7. The leap day 2028-02-29 is one allowed day.", draft => {
      draft.periodStart = drafted("2028-02-29", "1.9", "2028-02-29"); draft.periodEnd = drafted("2028-02-29", "1.9", "2028-02-29");
    });
    const leap = run(answer, input);
    expect(leap.ok && [leap.draft.periodStart.value, leap.draft.periodEnd.value]).toEqual(["2028-02-29", "2028-02-29"]);
    expect(refusal(mutate(answer => { answer.periodStart.value = "2027-02-29"; answer.periodEnd.value = "2027-03-01"; }))).toBe("DATE_INVALID periodStart");
  });
});

describe("DR-08 money is a positive integer of cents and days are 1 to 3650", () => {
  it("refuses zero, a negative, a fraction, a string, a non-finite number and an unsafe integer as a cap", () => {
    for (const value of [0, -5, 12.5, "30000", Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, null]) {
      const result = refusal(mutate(answer => { answer.caps.supplies.value = value; }));
      expect(result, String(value)).toMatch(value === null ? /^DRAFTED_NO_VALUE caps\.supplies$/ : /^MONEY_INVALID caps\.supplies$/);
    }
    // The smallest and the largest safe amount, each stated in its quote, so the values are kept and not downgraded by the support check.
    for (const [value, quote] of [[1, "$0.01"], [2 ** 53 - 1, "$90,071,992,547,409.91"]] as const) {
      const { answer, input } = withClause(`Section 7. The cap is ${quote} in total.`, draft => { draft.caps.supplies = drafted(value, "1.9", quote); });
      const result = run(answer, input);
      expect(result.ok && result.draft.caps.supplies.value, quote).toBe(value);
    }
  });
  it("applies the same rule to the cents thresholds and the day bounds to the day thresholds", () => {
    const threshold = (key: string, value: unknown) => mutate(answer => { answer.thresholds[key] = drafted(value, "1.3", "$300.00"); });
    expect(refusal(threshold("claimLimitCents", 0))).toBe("MONEY_INVALID thresholds.claimLimitCents");
    expect(refusal(threshold("suppliesLimitCents", 1.5))).toBe("MONEY_INVALID thresholds.suppliesLimitCents");
    for (const value of [0, 3651, 1.5, -1]) expect(refusal(threshold("staleReceiptDays", value)), String(value)).toBe("DAYS_INVALID thresholds.staleReceiptDays");
    for (const value of [1, 3650]) {
      const { answer, input } = withClause(`Section 7. The window is ${value} days.`, draft => { draft.thresholds.splitWindowDays = drafted(value, "1.9", `${value} days`); });
      const result = run(answer, input);
      expect(result.ok && result.draft.thresholds.splitWindowDays.value, String(value)).toBe(value);
    }
  });
});

describe("DR-09 breadth equals the category count", () => {
  it("refuses a breadth that is larger, smaller, missing or fractional, and a breadth with no categories", () => {
    for (const breadth of [3, 1, 0, null, 2.5, "2"]) expect(refusal(mutate(answer => { answer.breadth = breadth; })), String(breadth)).toBe("BREADTH_MISMATCH breadth");
    expect(refusal(mutate(answer => { answer.allowedCategories = unsureList(); answer.breadth = 2; }))).toBe("BREADTH_MISMATCH breadth");
  });
  it("accepts a breadth of 0 exactly when the categories are UNSURE, and stores it as null", () => {
    // The model schema has no null, so 0 is the empty breadth (IAC-440 schema fix, DR-61 to DR-65). The stored draft keeps today's null.
    const result = run(mutate(answer => { answer.allowedCategories = unsureList(); answer.breadth = 0; }));
    expect(result.ok).toBe(true); if (result.ok) { expect(result.draft.breadth).toBeNull(); expect(result.analysis.complete).toBe(false); expect(result.analysis.missing).toEqual(["allowedCategories"]); }
    // A null breadth beside UNSURE categories was accepted before the fix and still is; the schema can no longer produce it.
    const legacy = run(mutate(answer => { answer.allowedCategories = unsureList(); answer.breadth = null; }));
    expect(legacy.ok && legacy.draft.breadth).toBeNull();
  });
});

describe("DR-10 every drafted value cites a clause and quotes it", () => {
  it("refuses a citation of a clause that does not exist, a missing citation and a non-string citation", () => {
    expect(refusal(mutate(answer => { answer.programs.clauseId = "9.9"; }))).toBe("CITATION_MISSING programs");
    expect(refusal(mutate(answer => { answer.programs.clauseId = null; }))).toBe("CITATION_MISSING programs");
    expect(refusal(mutate(answer => { answer.programs.clauseId = 11; }))).toBe("CITATION_MISSING programs");
  });
  it("refuses a quote that is not in the cited clause, including a quote that is in another clause", () => {
    expect(refusal(mutate(answer => { answer.programs.quote = "chess afterschool program"; }))).toBe("QUOTE_NOT_IN_CLAUSE programs");
    expect(refusal(mutate(answer => { answer.periodStart.quote = "begins on 2027-06-30"; }))).toBe("QUOTE_NOT_IN_CLAUSE periodStart");
    expect(refusal(mutate(answer => { answer.caps.supplies.clauseId = "1.2"; }))).toBe("QUOTE_NOT_IN_CLAUSE caps.supplies");
    expect(refusal(mutate(answer => { answer.caps.supplies.quote = "USD 300.00"; }))).toBe("QUOTE_NOT_IN_CLAUSE caps.supplies");
  });
  it("refuses a missing, blank, non-string or over-long quote", () => {
    for (const quote of [null, "", "   ", 7]) expect(refusal(mutate(answer => { answer.programs.quote = quote; })), JSON.stringify(quote)).toBe("QUOTE_INVALID programs");
  });
  it("refuses a drafted field with no value, and the EDITED status in a model answer", () => {
    expect(refusal(mutate(answer => { answer.periodEnd.value = null; }))).toBe("DRAFTED_NO_VALUE periodEnd");
    expect(refusal(mutate(answer => { answer.periodEnd.status = "EDITED"; }))).toBe("STATUS_INVALID periodEnd");
    expect(refusal(mutate(answer => { answer.periodEnd.status = "APPROVED"; }))).toBe("STATUS_INVALID periodEnd");
  });
  it("accepts a quote that is the whole clause", () => {
    expect(run(mutate(answer => { answer.programs.quote = CLAUSE_SCOPE; })).ok).toBe(true);
  });
});

describe("DR-11 a field the text does not settle is UNSURE and carries no value", () => {
  it("a stored draft (EDIT mode) refuses an UNSURE field that has a value, a clause or a quote", () => {
    // Deliberately changed by the IAC-440 schema fix: this was a MODEL mode refusal. A model answer now discards what an UNSURE field carries (DR-63),
    // because the schema cannot say null; a stored draft always holds null parts, so a value on a stored UNSURE field is still corruption.
    const parent = run(goodAnswer()); expect(parent.ok).toBe(true); if (!parent.ok) return;
    const stored = (travel: unknown) => { const draft = structuredClone(parent.draft) as any; draft.caps.travel = travel; return validateDraft(draft, GRANT, "EDIT"); };
    expect(stored({ status: "UNSURE", value: 500, clauseId: null, quote: null })).toMatchObject({ ok: false, reason: "UNSURE_HAS_VALUE", path: "caps.travel" });
    expect(stored({ status: "UNSURE", value: null, clauseId: "1.3", quote: null })).toMatchObject({ ok: false, reason: "UNSURE_HAS_VALUE", path: "caps.travel" });
    expect(stored({ status: "UNSURE", value: null, clauseId: null, quote: "x" })).toMatchObject({ ok: false, reason: "UNSURE_HAS_VALUE", path: "caps.travel" });
    expect(stored(storedUnsure())).toMatchObject({ ok: true });
  });
  it("stores a draft with UNSURE required fields, marks it incomplete and names each missing field", () => {
    const result = run(mutate(answer => { answer.periodEnd = unsureText(); answer.programs = unsureList(); answer.caps.supplies = unsure(); }));
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.analysis.complete).toBe(false);
    expect(result.analysis.missing).toEqual(["programs", "periodEnd", "caps.supplies"]);
    expect(toPolicy(result.draft)).toBeNull();
  });
  it("requires a cap only for the budget lines the allowed categories use", () => {
    expect(requiredBudgetLines(["robot_kits_parts", "classroom_supplies"])).toEqual(["supplies"]);
    expect(requiredBudgetLines(["participant_meals", "mileage", "refrigeration_equipment", "program_fees"])).toEqual(["other", "travel", "equipment", "contractual"]);
    expect(requiredBudgetLines(["alcohol", "gift_cards"])).toEqual([]);
    const result = run(mutate(answer => { answer.allowedCategories.value = ["robot_kits_parts", "participant_meals"]; }));
    expect(result.ok && result.analysis.missing).toEqual(["caps.other"]);
  });
});

describe("DR-12 the answer has exactly the fields of the schema", () => {
  it("refuses extra keys, missing keys and wrong types at every level", () => {
    expect(refusal(mutate(answer => { answer.extra = 1; }))).toBe("SHAPE draft");
    expect(refusal(mutate(answer => { delete answer.summary; }))).toBe("SHAPE draft");
    expect(refusal("not an object")).toBe("SHAPE draft");
    expect(refusal(null)).toBe("SHAPE draft");
    expect(refusal([])).toBe("SHAPE draft");
    expect(refusal(mutate(answer => { answer.clauses = "none"; }))).toBe("SHAPE clauses");
    expect(refusal(mutate(answer => { answer.clauses[0].extra = true; }))).toBe("SHAPE clauses.0");
    expect(refusal(mutate(answer => { answer.programs.extra = true; }))).toBe("SHAPE programs");
    expect(refusal(mutate(answer => { delete answer.caps.travel; }))).toBe("SHAPE caps");
    expect(refusal(mutate(answer => { answer.thresholds.bonus = unsure(); }))).toBe("SHAPE thresholds");
    expect(refusal(mutate(answer => { answer.clauses[0].text = 5; }))).toBe("SHAPE clauses.0");
  });
  it("refuses a summary that is blank, longer than 300 characters or holds a control character, and trims a good one", () => {
    for (const summary of ["", "   ", "x".repeat(301), "two\nlines", "tab\there", 5]) expect(refusal(mutate(answer => { answer.summary = summary; })), JSON.stringify(summary)).toMatch(/^(SUMMARY_INVALID|SHAPE) summary$/);
    const result = run(mutate(answer => { answer.summary = `  ${"x".repeat(300)}  `; }));
    expect(result.ok && result.draft.summary.length).toBe(300);
  });
});

describe("DR-13 a complete draft is always a policy prepare() accepts", () => {
  it("runs prepare() on the policy of every complete draft: the probe throws exactly when prepare() would reject the structure", () => {
    const result = run(goodAnswer());
    expect(result.ok).toBe(true); if (!result.ok) return;
    const policy = toPolicy(result.draft)!;
    expect(() => probePrepare(policy, GRANT.prohibited)).not.toThrow();
    // The planted failures: a reversed period, a breadth that is not the category count, a category with no budget line, and no program.
    expect(() => probePrepare({ ...policy, periodStart: "2027-07-01" }, GRANT.prohibited)).toThrow(/reversed|no longer|period/i);
    expect(() => probePrepare({ ...policy, breadth: 5 }, GRANT.prohibited)).toThrow(/complete approved policy/);
    expect(() => probePrepare({ ...policy, budgetLines: [] }, GRANT.prohibited)).toThrow(/Missing .* budget line/);
    expect(() => probePrepare({ ...policy, programs: [] }, GRANT.prohibited)).toThrow();
  });
  it("accepts a one-line, one-day, one-category policy and the widest policy of all choosable categories with every cap", () => {
    expect(run(mutate(answer => { answer.periodStart.value = "2026-09-01"; answer.periodEnd.value = "2026-09-01"; })).ok).toBe(true);
    const all = SELECTABLE.filter(category => BUDGET_LINE[category] !== "prohibited");
    const wide = run(mutate(answer => {
      answer.allowedCategories.value = [...all]; answer.breadth = all.length;
      answer.caps = Object.fromEntries(["supplies", "other", "travel", "equipment", "contractual"].map(line => [line, drafted(30000, "1.3", "$300.00")]));
    }));
    expect(wide.ok).toBe(true); if (wide.ok) expect(wide.analysis.complete).toBe(true);
  });
});

describe("DR-14 the pasted text is bounded, and an edit is revalidated whole", () => {
  it("accepts 1 to 20000 code points of text with a visible character, and refuses blank, NUL, lone surrogates and oversize text", () => {
    expect(validInputText("a")).toBe(true); expect(validInputText("x".repeat(20_000))).toBe(true); expect(validInputText("\u{1F9E9}".repeat(20_000))).toBe(true);
    for (const text of ["", "   \n\t", "has\u0000nul", "x".repeat(20_001), "\ud800 lone", 5, null]) expect(validInputText(text), JSON.stringify(text)).toBe(false);
  });
  it("applyEdit marks only changed fields EDITED, drops their citation, keeps the rest, and refuses an edit that changes nothing", () => {
    const parent = run(goodAnswer()); expect(parent.ok).toBe(true); if (!parent.ok) return;
    const same = applyEdit(parent.draft, { programs: ["robotics"], caps: { supplies: 30000 } }, GRANT);
    expect(same).toMatchObject({ ok: false, reason: "NO_CHANGE" });
    const edited = applyEdit(parent.draft, { caps: { supplies: 25000 }, summary: "Pays robot kits and classroom supplies." }, GRANT);
    expect(edited.ok).toBe(true); if (!edited.ok) return;
    expect(edited.changed).toEqual(["caps.supplies", "summary"]);
    expect(edited.draft.caps.supplies).toEqual({ status: "EDITED", value: 25000, clauseId: null, quote: null });
    expect(edited.draft.programs).toEqual(parent.draft.programs);
    expect(edited.draft.clauses).toEqual(parent.draft.clauses);
  });
  it("applyEdit reruns every rule: a prohibited category, a reversed period, a bad cap and an unknown key are all refused", () => {
    const parent = run(goodAnswer()); expect(parent.ok).toBe(true); if (!parent.ok) return;
    expect(applyEdit(parent.draft, { allowedCategories: ["robot_kits_parts", "alcohol"] }, GRANT)).toMatchObject({ ok: false, reason: "PROHIBITED_CATEGORY" });
    expect(applyEdit(parent.draft, { periodEnd: "2026-01-01" }, GRANT)).toMatchObject({ ok: false, reason: "DATE_ORDER" });
    expect(applyEdit(parent.draft, { caps: { supplies: -1 } }, GRANT)).toMatchObject({ ok: false, reason: "MONEY_INVALID" });
    expect(applyEdit(parent.draft, { clauses: [] }, GRANT)).toMatchObject({ ok: false, reason: "SHAPE" });
    expect(applyEdit(parent.draft, {}, GRANT)).toMatchObject({ ok: false, reason: "SHAPE" });
    expect(applyEdit(parent.draft, "x", GRANT)).toMatchObject({ ok: false, reason: "SHAPE" });
  });
  it("applyEdit null clears a field to UNSURE and the draft becomes incomplete", () => {
    const parent = run(goodAnswer()); expect(parent.ok).toBe(true); if (!parent.ok) return;
    const cleared = applyEdit(parent.draft, { periodEnd: null }, GRANT);
    expect(cleared.ok).toBe(true); if (!cleared.ok) return;
    expect(cleared.draft.periodEnd).toEqual({ status: "UNSURE", value: null, clauseId: null, quote: null });
    expect(analyze(cleared.draft).missing).toEqual(["periodEnd"]);
  });
});

// IAC-440 Package A, November 1 fixes (docs/GATE_REPORT.md section 58, DR-46 to DR-50): the mechanical support check of quoted values and the
// well-formed text rule. A value the quote does not state is downgraded to UNSURE, never refused and never repaired.
const outcome = (path: string, quote: string, value: unknown, clauseText = `Section 7. The text reads: ${quote}.`) => {
  const { answer, input } = withClause(clauseText, draft => {
    const field = drafted(value, "1.9", quote);
    if (path.startsWith("caps.")) draft.caps[path.slice(5)] = field;
    else if (path.startsWith("thresholds.")) draft.thresholds[path.slice(11)] = field;
    else draft[path] = field;
  });
  const result = run(answer, input);
  if (!result.ok) return { refused: `${result.reason} ${result.path}` } as const;
  const read = (): any => (path.startsWith("caps.") ? result.draft.caps[path.slice(5) as "supplies"] : path.startsWith("thresholds.") ? result.draft.thresholds[path.slice(11) as "staleReceiptDays"] : (result.draft as any)[path]);
  return { kept: read().value !== null, field: read(), unsupported: result.draft.quoteUnsupported ?? [], analysis: result.analysis } as const;
};

describe("DR-46 a money value must equal a dollar amount the quote states", () => {
  it("keeps a cap whose quote states the same amount in each recognized form, and downgrades one that states another amount", () => {
    for (const quote of ["$1,500", "$1,500.00", "$1500", "1,500 dollars", "USD 1,500", "USD 1500.00", "$ 1,500", "1500 USD"]) {
      expect(outcome("caps.supplies", quote, 150000), quote).toMatchObject({ kept: true, unsupported: [] });
    }
    for (const quote of ["$1,500.50", "$15", "$150", "$15,000", "$1,500,000", "$1,5000"]) {
      const result = outcome("caps.supplies", quote, 150000);
      expect(result, quote).toMatchObject({ kept: false, unsupported: ["caps.supplies"], field: { status: "UNSURE", value: null, clauseId: null, quote: null } });
    }
  });
  it("reads cents exactly: $0.05 is 5, $10.5 is 1050, and a planted wrong cap of $300.00 against 50000 is downgraded", () => {
    expect(outcome("caps.supplies", "$0.05", 5)).toMatchObject({ kept: true });
    expect(outcome("caps.supplies", "$10.5", 1050)).toMatchObject({ kept: true });
    expect(outcome("caps.supplies", "$10.5", 105)).toMatchObject({ kept: false });
    expect(outcome("caps.supplies", "$300.00", 50000)).toMatchObject({ kept: false, unsupported: ["caps.supplies"] });
    expect(outcome("caps.supplies", "$300.00", 30000)).toMatchObject({ kept: true, unsupported: [] });
  });
  it("a quote with several amounts supports a value equal to any one of them, and a bare number or a day count is not an amount", () => {
    expect(outcome("caps.supplies", "$250 per receipt and $500 in total", 50000)).toMatchObject({ kept: true });
    expect(outcome("caps.supplies", "$250 per receipt and $500 in total", 25000)).toMatchObject({ kept: true });
    expect(outcome("caps.supplies", "$250 per receipt and $500 in total", 30000)).toMatchObject({ kept: false });
    expect(outcome("caps.supplies", "within 300 days of purchase", 30000)).toMatchObject({ kept: false });
    expect(outcome("caps.supplies", "three hundred dollars", 30000)).toMatchObject({ kept: false });
  });
  it("covers every money field: the caps and the three money thresholds, each with a failing and a passing case", () => {
    for (const path of ["caps.supplies", "caps.other", "caps.travel", "caps.equipment", "caps.contractual", "thresholds.suppliesLimitCents", "thresholds.equipmentLimitCents", "thresholds.claimLimitCents"]) {
      expect(outcome(path, "$700.00", 70000), path).toMatchObject({ kept: true });
      expect(outcome(path, "$700.00", 7000), path).toMatchObject({ kept: false, unsupported: [path] });
    }
  });
  it("a downgraded required cap leaves the draft incomplete, and a downgraded threshold only carries the previous version", () => {
    const cap = outcome("caps.supplies", "$300.00", 99900);
    expect(cap).toMatchObject({ kept: false, analysis: { complete: false, missing: ["caps.supplies"], quoteUnsupported: ["caps.supplies"] } });
    const threshold = outcome("thresholds.claimLimitCents", "$300.00", 99900);
    expect(threshold).toMatchObject({ kept: false, analysis: { complete: true, missing: [], quoteUnsupported: ["thresholds.claimLimitCents"] } });
    expect((threshold as any).analysis.carried).toContain("claimLimitCents");
  });
});

describe("DR-47 a day count must appear in the quote as digits or as an English number word", () => {
  it("keeps a count stated in digits, and downgrades one the quote does not state", () => {
    for (const quote of ["60 days", "60-day", "within 60 calendar days"]) expect(outcome("thresholds.staleReceiptDays", quote, 60), quote).toMatchObject({ kept: true, unsupported: [] });
    for (const quote of ["90 days", "6 days", "600 days", "60.5 days"]) {
      expect(outcome("thresholds.staleReceiptDays", quote, 60), quote).toMatchObject({ kept: false, unsupported: ["thresholds.staleReceiptDays"] });
    }
  });
  it("keeps a count stated as words, including hyphenated and hundred forms, and downgrades a different word", () => {
    for (const [quote, value] of [["thirty days", 30], ["Thirty days", 30], ["forty-five days", 45], ["ninety days", 90], ["three days", 3], ["one hundred and twenty days", 120], ["one hundred twenty days", 120], ["sixty (60) days", 60], ["twelve days", 12]] as const) {
      expect(outcome("thresholds.duplicateWindowDays", quote, value), quote).toMatchObject({ kept: true });
    }
    expect(outcome("thresholds.duplicateWindowDays", "thirty days", 90)).toMatchObject({ kept: false });
    expect(outcome("thresholds.duplicateWindowDays", "forty-five days", 40)).toMatchObject({ kept: false });
    expect(outcome("thresholds.duplicateWindowDays", "ten and twenty days", 30)).toMatchObject({ kept: false });
    expect(outcome("thresholds.duplicateWindowDays", "one hundred and twenty days", 100)).toMatchObject({ kept: false });
  });
  it("a dollar amount does not pass as a day count", () => {
    expect(outcome("thresholds.splitWindowDays", "$3.00 per receipt", 3)).toMatchObject({ kept: false });
    expect(outcome("thresholds.splitWindowDays", "$3 per receipt", 3)).toMatchObject({ kept: false });
    expect(outcome("thresholds.splitWindowDays", "$1,000 over 3 days", 3)).toMatchObject({ kept: true });
  });
  it("covers every day field with one failing and one passing case", () => {
    for (const path of ["thresholds.staleReceiptDays", "thresholds.duplicateWindowDays", "thresholds.splitWindowDays"]) {
      expect(outcome(path, "14 days", 14), path).toMatchObject({ kept: true });
      expect(outcome(path, "14 days", 15), path).toMatchObject({ kept: false, unsupported: [path] });
    }
  });
});

describe("DR-48 a period date must carry its four-digit year in the quote", () => {
  it("keeps a date whose year the quote states, and downgrades one whose year differs or is missing", () => {
    for (const path of ["periodStart", "periodEnd"]) {
      expect(outcome(path, "begins on 2026-09-01", "2026-09-01"), path).toMatchObject({ kept: true, unsupported: [] });
      expect(outcome(path, "September 1, 2026", "2026-09-01"), path).toMatchObject({ kept: true });
      expect(outcome(path, "begins on 2025-09-01", "2026-09-01"), path).toMatchObject({ kept: false, unsupported: [path] });
      expect(outcome(path, "begins on September first", "2026-09-01"), path).toMatchObject({ kept: false, unsupported: [path] });
      expect(outcome(path, "begins in 12026", "2026-09-01"), path).toMatchObject({ kept: false });
      expect(outcome(path, "begins in 20261", "2026-09-01"), path).toMatchObject({ kept: false });
    }
  });
  it("a downgraded period date leaves the draft incomplete and the order rule only applies to values that remain", () => {
    const start = outcome("periodStart", "begins on 2025-09-01", "2026-09-01");
    expect(start).toMatchObject({ kept: false, analysis: { complete: false, missing: ["periodStart"], quoteUnsupported: ["periodStart"] } });
    // A start after the end is still refused when both values are supported.
    const { answer, input } = withClause("Section 7. It begins on 2028-01-01.", draft => { draft.periodStart = drafted("2028-01-01", "1.9", "begins on 2028-01-01"); });
    expect(refusal(answer, input)).toBe("DATE_ORDER periodEnd");
  });
});

describe("DR-49 every model string is well formed", () => {
  const astral = "\u{1F9E9}";
  const withAstral = { ...GRANT, text: `${GRANT.text}\nSection 8. Puzzle ${astral} kits.` } as GrantInput;
  it("refuses a lone surrogate in a clause even when it is a UTF-16 substring of text that holds an astral character", () => {
    expect(withAstral.text.includes("\ud83e")).toBe(true);
    const answer = goodAnswer(); answer.clauses.push({ id: "1.9", text: "\ud83e" });
    expect(refusal(answer, withAstral)).toBe("MALFORMED_TEXT draft.clauses.3.text");
    // A whole astral character is well formed and passes.
    const good = goodAnswer(); good.clauses.push({ id: "1.9", text: `Puzzle ${astral} kits.` });
    expect(run(good, withAstral).ok).toBe(true);
  });
  it("refuses a lone high or low surrogate in a quote, the summary, a program, a category, a clause id and an object key", () => {
    const cases: [string, (answer: Record<string, any>) => void][] = [
      ["quote", answer => { answer.periodStart.quote = "begins on 2026-09-01\udc00"; }],
      ["summary", answer => { answer.summary = "Pays robot kits \ud800"; }],
      ["program", answer => { answer.programs.value = ["robo\ud800tics"]; }],
      ["category", answer => { answer.allowedCategories.value = ["robot_kits_parts", "\udfff"]; }],
      ["clause id", answer => { answer.clauses[0].id = "1.\ud800"; }],
      ["key", answer => { answer["bad\ud800key"] = 1; }],
      ["nested value", answer => { answer.caps.supplies.clauseId = "1.\udc00"; }],
    ];
    for (const [name, change] of cases) expect(refusal(mutate(change)), name).toMatch(/^MALFORMED_TEXT draft/);
  });
  it("refuses NUL, accepts well formed non-ASCII text, and walks before any other rule so the reason is MALFORMED_TEXT", () => {
    expect(refusal(mutate(answer => { answer.summary = "Pays robot kits\u0000"; }))).toBe("MALFORMED_TEXT draft.summary");
    expect(run(mutate(answer => { answer.summary = `Pays robot kits ${astral} and café supplies.`; })).ok).toBe(true);
    // A wrong breadth would be BREADTH_MISMATCH, but the malformed string is found first.
    expect(refusal(mutate(answer => { answer.breadth = 7; answer.summary = "\ud800"; }))).toBe("MALFORMED_TEXT draft.summary");
  });
  it("the edit path refuses a lone surrogate too, in the document and in the person's patch", () => {
    const parent = run(goodAnswer()); expect(parent.ok).toBe(true); if (!parent.ok) return;
    expect(applyEdit(parent.draft, { summary: "Pays robot kits \ud800" }, GRANT)).toMatchObject({ ok: false, reason: "MALFORMED_TEXT" });
    expect(applyEdit(parent.draft, { programs: ["\udc00"] }, GRANT)).toMatchObject({ ok: false, reason: "MALFORMED_TEXT" });
  });
});

describe("DR-50 a downgrade is recorded in quoteUnsupported, and an edit keeps or clears it", () => {
  const downgraded = () => {
    const { answer, input } = withClause("Section 7. The cap is $300.00 and receipts are stale after 60 days.", draft => {
      draft.caps.supplies = drafted(99900, "1.9", "$300.00");
      draft.thresholds.staleReceiptDays = drafted(61, "1.9", "60 days");
    });
    const result = run(answer, input); expect(result.ok).toBe(true);
    return { draft: result.ok ? result.draft : (null as never), input };
  };
  it("records exactly the downgraded paths in the order the fields are read, and nothing when every value is supported", () => {
    const { draft } = downgraded();
    expect(draft.quoteUnsupported).toEqual(["caps.supplies", "thresholds.staleReceiptDays"]);
    expect(draft.caps.supplies).toEqual({ status: "UNSURE", value: null, clauseId: null, quote: null });
    const clean = run(goodAnswer()); expect(clean.ok && clean.draft.quoteUnsupported).toBeUndefined();
    expect(Object.keys(clean.ok ? clean.draft : {})).not.toContain("quoteUnsupported");
  });
  it("a model answer may not carry quoteUnsupported itself: the validator is the only writer", () => {
    expect(refusal(mutate(answer => { answer.quoteUnsupported = ["caps.supplies"]; }))).toBe("SHAPE draft");
  });
  it("an edit keeps the list while the field is empty, drops a path a person fills, and refuses a malformed stored list", () => {
    const { draft, input } = downgraded();
    const unrelated = applyEdit(draft, { summary: "Pays robot kits and classroom supplies only." }, input);
    expect(unrelated.ok && unrelated.draft.quoteUnsupported).toEqual(["caps.supplies", "thresholds.staleReceiptDays"]);
    const filled = applyEdit(draft, { caps: { supplies: 30000 } }, input);
    expect(filled.ok && filled.draft.quoteUnsupported).toEqual(["thresholds.staleReceiptDays"]);
    expect(filled.ok && filled.draft.caps.supplies).toEqual({ status: "EDITED", value: 30000, clauseId: null, quote: null });
    const all = applyEdit(draft, { caps: { supplies: 30000 }, thresholds: { staleReceiptDays: 60 } }, input);
    expect(all.ok && Object.keys(all.draft)).not.toContain("quoteUnsupported");
    for (const bad of [[], ["caps.supplies", "caps.supplies"], ["summary"], ["caps.nowhere"], [7], "caps.supplies"]) {
      const stored = { ...structuredClone(draft), quoteUnsupported: bad };
      expect(validateDraft(stored, input, "EDIT"), JSON.stringify(bad)).toMatchObject({ ok: false, reason: "SHAPE", path: "quoteUnsupported" });
    }
  });
  it("a stored draft whose cited quote no longer supports its value is refused as QUOTE_UNSUPPORTED, not silently downgraded", () => {
    const parent = run(goodAnswer()); expect(parent.ok).toBe(true); if (!parent.ok) return;
    const stored = structuredClone(parent.draft); stored.caps.supplies = { ...stored.caps.supplies, value: 40000 };
    expect(validateDraft(stored, GRANT, "EDIT")).toMatchObject({ ok: false, reason: "QUOTE_UNSUPPORTED", path: "caps.supplies" });
  });
  it("lists the new refusal codes", () => {
    expect(DRAFT_REFUSALS).toEqual(expect.arrayContaining(["MALFORMED_TEXT", "QUOTE_UNSUPPORTED"]));
  });
});

// IAC-440 Package A schema fix (docs/GATE_REPORT.md section 58, DR-63 to DR-65): the model output schema has no null, so an UNSURE part of a model
// answer is the empty value ("" for text, [] for a list, 0 for an integer, "" for clauseId and quote, 0 for breadth beside UNSURE categories). The
// validator maps those back to null in MODEL mode only, so the draft, the database rows and every reader keep today's meaning.
const FIELD_PATHS = ["programs", "allowedCategories", "periodStart", "periodEnd", "caps.supplies", "caps.other", "caps.travel", "caps.equipment", "caps.contractual",
  "thresholds.suppliesLimitCents", "thresholds.equipmentLimitCents", "thresholds.claimLimitCents", "thresholds.staleReceiptDays", "thresholds.duplicateWindowDays", "thresholds.splitWindowDays"];
const emptyFor = (path: string) => (path === "programs" || path === "allowedCategories" ? unsureList() : path.startsWith("period") ? unsureText() : unsure());
const setPath = (answer: Record<string, any>, path: string, field: unknown) => { const [head, tail] = path.split("."); if (tail) answer[head!][tail] = field; else answer[head!] = field; };
const getPath = (draft: any, path: string) => path.split(".").reduce((node, key) => node[key], draft);
// A valid value for each field, so a refusal is about the citation or the quote and not about the value.
const VALID: Record<string, unknown> = { programs: ["robotics"], allowedCategories: ["robot_kits_parts", "classroom_supplies"], periodStart: "2026-09-01", periodEnd: "2027-06-30",
  "caps.supplies": 30000, "caps.other": 30000, "caps.travel": 30000, "caps.equipment": 30000, "caps.contractual": 30000,
  "thresholds.suppliesLimitCents": 30000, "thresholds.equipmentLimitCents": 30000, "thresholds.claimLimitCents": 30000, "thresholds.staleReceiptDays": 60, "thresholds.duplicateWindowDays": 60, "thresholds.splitWindowDays": 60 };

describe("DR-63 a model answer's empty UNSURE values become null in the validated draft", () => {
  it("maps each of the 15 fields on its own, with the empty value of its type, to the stored UNSURE with null parts", () => {
    expect(FIELD_PATHS).toHaveLength(15);
    for (const path of FIELD_PATHS) {
      const answer = goodAnswer(); setPath(answer, path, emptyFor(path));
      if (path === "allowedCategories") answer.breadth = 0;
      const result = run(answer);
      expect(result.ok, path).toBe(true); if (!result.ok) continue;
      expect(getPath(result.draft, path), path).toEqual({ status: "UNSURE", value: null, clauseId: null, quote: null });
    }
  });
  it("maps every field at once, breadth 0 to null, and stores an incomplete draft that cannot become a policy", () => {
    const answer = goodAnswer();
    for (const path of FIELD_PATHS) setPath(answer, path, emptyFor(path));
    answer.breadth = 0;
    const result = run(answer);
    expect(result.ok).toBe(true); if (!result.ok) return;
    for (const path of FIELD_PATHS) expect(getPath(result.draft, path), path).toEqual({ status: "UNSURE", value: null, clauseId: null, quote: null });
    expect(result.draft.breadth).toBeNull();
    expect(result.analysis.complete).toBe(false); expect(toPolicy(result.draft)).toBeNull();
    // Nothing of the empty values survives into what is stored.
    expect(JSON.stringify(result.draft)).not.toMatch(/"(value|clauseId|quote)":(""|\[\]|0)[,}]/);
  });
  it("discards what an UNSURE field carries instead of binding it: a guessed value, clause or quote is dropped and nothing is recorded for it", () => {
    const guess = (path: string) => ({ status: "UNSURE", value: VALID[path], clauseId: "1.3", quote: "$300.00" });
    for (const path of FIELD_PATHS.filter(path => path !== "allowedCategories")) {
      const answer = goodAnswer(); setPath(answer, path, guess(path));
      const result = run(answer);
      expect(result.ok, path).toBe(true); if (!result.ok) continue;
      expect(getPath(result.draft, path), path).toEqual({ status: "UNSURE", value: null, clauseId: null, quote: null });
      expect(result.draft.quoteUnsupported, path).toBeUndefined();
    }
    // UNSURE categories that carry a guess leave the breadth the model gave (0) as the only consistent value: the guess is never counted.
    const categories = goodAnswer(); categories.allowedCategories = guess("allowedCategories"); categories.breadth = 0;
    const kept = run(categories); expect(kept.ok && kept.draft.allowedCategories).toEqual({ status: "UNSURE", value: null, clauseId: null, quote: null });
    const counted = goodAnswer(); counted.allowedCategories = guess("allowedCategories"); counted.breadth = 2;
    expect(refusal(counted)).toBe("BREADTH_MISMATCH breadth");
  });
  it("breadth: 0 beside UNSURE categories is null, and any other breadth keeps the old rule", () => {
    const open = (breadth: unknown) => mutate(answer => { answer.allowedCategories = unsureList(); answer.breadth = breadth; });
    expect(run(open(0)).ok).toBe(true);
    for (const breadth of [1, 2, 17, -1, 2.5, "0", false]) expect(refusal(open(breadth)), String(breadth)).toBe("BREADTH_MISMATCH breadth");
    // Zero is not a free pass: beside drafted categories it is still a mismatch.
    expect(refusal(mutate(answer => { answer.breadth = 0; }))).toBe("BREADTH_MISMATCH breadth");
  });
  it("an unchanged DRAFTED field keeps its value, clause and quote", () => {
    const result = run(goodAnswer());
    expect(result.ok && result.draft.caps.supplies).toEqual({ status: "DRAFTED", value: 30000, clauseId: "1.3", quote: "$300.00" });
    expect(result.ok && result.draft.programs).toEqual({ status: "DRAFTED", value: ["robotics"], clauseId: "1.1", quote: "robotics afterschool program" });
  });
});

describe("DR-64 a DRAFTED field with an empty clause, quote or value is refused exactly as a null one", () => {
  it("refuses an empty clauseId with the reason a null clauseId gets, on all 15 fields", () => {
    for (const path of FIELD_PATHS) {
      const make = (clauseId: unknown) => mutate(answer => { setPath(answer, path, { status: "DRAFTED", value: VALID[path], clauseId, quote: "$300.00" }); });
      expect(refusal(make("")), path).toBe(`CITATION_MISSING ${path}`);
      expect(refusal(make(null)), path).toBe(`CITATION_MISSING ${path}`);
    }
  });
  it("refuses an empty or blank quote with the reason a null quote gets, on all 15 fields", () => {
    for (const path of FIELD_PATHS) {
      const make = (quote: unknown) => mutate(answer => { setPath(answer, path, { status: "DRAFTED", value: VALID[path], clauseId: "1.3", quote }); });
      expect(refusal(make("")), path).toBe(`QUOTE_INVALID ${path}`);
      expect(refusal(make("   ")), path).toBe(`QUOTE_INVALID ${path}`);
      expect(refusal(make(null)), path).toBe(`QUOTE_INVALID ${path}`);
    }
  });
  it("refuses DRAFTED with the empty value of its type: nothing is bound from an empty value", () => {
    const empties: [string, unknown, string][] = [["programs", [], "SHAPE"], ["allowedCategories", [], "SHAPE"], ["periodStart", "", "DATE_INVALID"], ["periodEnd", "", "DATE_INVALID"],
      ["caps.supplies", 0, "MONEY_INVALID"], ["thresholds.claimLimitCents", 0, "MONEY_INVALID"], ["thresholds.staleReceiptDays", 0, "DAYS_INVALID"]];
    for (const [path, value, reason] of empties) {
      const answer = goodAnswer(); setPath(answer, path, { status: "DRAFTED", value, clauseId: "1.3", quote: "$300.00" });
      if (path === "allowedCategories") answer.breadth = 0;
      expect(refusal(answer), path).toBe(`${reason} ${path}`);
    }
  });
});

describe("DR-65 EDIT mode is unchanged: stored drafts hold null and are never read as model output", () => {
  const parentDraft = () => { const parent = run(goodAnswer()); if (!parent.ok) throw new Error("parent"); return structuredClone(parent.draft) as any; };
  it("round trips a validated draft with UNSURE fields through EDIT mode, and does not accept the empty values there", () => {
    const answer = goodAnswer(); answer.periodEnd = unsureText();
    const first = run(answer); expect(first.ok).toBe(true); if (!first.ok) return;
    expect(validateDraft(structuredClone(first.draft), GRANT, "EDIT")).toMatchObject({ ok: true });
    const stored = structuredClone(first.draft) as any;
    stored.periodEnd = { status: "UNSURE", value: "", clauseId: "", quote: "" };
    expect(validateDraft(stored, GRANT, "EDIT")).toMatchObject({ ok: false, reason: "UNSURE_HAS_VALUE", path: "periodEnd" });
    const quoteOnly = structuredClone(first.draft) as any; quoteOnly.periodEnd = { status: "UNSURE", value: null, clauseId: null, quote: "" };
    expect(validateDraft(quoteOnly, GRANT, "EDIT")).toMatchObject({ ok: false, reason: "UNSURE_HAS_VALUE", path: "periodEnd" });
  });
  it("a stored breadth of 0 is not null: with UNSURE categories it is a mismatch, and null stays the only breadth of an open category list", () => {
    const answer = goodAnswer(); answer.allowedCategories = unsureList(); answer.breadth = 0;
    const first = run(answer); expect(first.ok).toBe(true); if (!first.ok) return;
    expect(first.draft.breadth).toBeNull();
    expect(validateDraft(structuredClone(first.draft), GRANT, "EDIT")).toMatchObject({ ok: true });
    expect(validateDraft({ ...structuredClone(first.draft), breadth: 0 }, GRANT, "EDIT")).toMatchObject({ ok: false, reason: "BREADTH_MISMATCH", path: "breadth" });
  });
  it("a stored DRAFTED field with an empty clauseId or quote is refused as before, and a stored EDITED field still carries no citation", () => {
    const draft = parentDraft(); draft.caps.supplies.clauseId = "";
    expect(validateDraft(draft, GRANT, "EDIT")).toMatchObject({ ok: false, reason: "CITATION_MISSING", path: "caps.supplies" });
    const blank = parentDraft(); blank.caps.supplies.quote = "";
    expect(validateDraft(blank, GRANT, "EDIT")).toMatchObject({ ok: false, reason: "QUOTE_INVALID", path: "caps.supplies" });
    const edited = applyEdit(parentDraft(), { caps: { supplies: 25000 } }, GRANT);
    expect(edited.ok && edited.draft.caps.supplies).toEqual({ status: "EDITED", value: 25000, clauseId: null, quote: null });
  });
});
