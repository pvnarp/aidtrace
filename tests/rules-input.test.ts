import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUDGET_LINES, THRESHOLD_KEYS } from "../src/rules-draft/draft-validate";
import { EDIT_CAP_FIELDS, EDIT_CATEGORY_PREFIX, EDIT_PROGRAM_PREFIX, EDIT_THRESHOLD_FIELDS, centsToInput, keepOrder, parseDate, parseDays, parseDollars, parseEditForm } from "../src/server/rules-input";
import { createRefusalCode, createUnavailableCode, actionRefusalCode, noticeQuery, refusedDraftReason, rulesNotice } from "../src/server/rules-notices";

// IAC-440 Package B, DR-89 to DR-91 (docs/GATE_REPORT.md section 60). Pure parsers and the fixed notice table. No database, no network, no model.

describe("DR-89 dollar text becomes integer cents by string arithmetic, and planted bad input is refused", () => {
  it.each([
    ["300", 30000], ["300.5", 30050], ["300.50", 30050], ["$1,234.56", 123456], [".5", 50], ["0.01", 1], ["  25 ", 2500], ["1,000", 100000], ["$0.99", 99],
    ["90071992547409.91", 9007199254740991],
  ])("%j parses to %i cents", (typed, cents) => {
    expect(parseDollars(typed)).toEqual({ ok: true, value: cents });
  });
  it("treats blank input as not settled (null), which the validator stores as UNSURE", () => {
    for (const typed of ["", "   ", "\t"]) expect(parseDollars(typed)).toEqual({ ok: true, value: null });
  });
  it.each([
    ["negative", "-5"], ["negative with decimals", "-0.50"], ["three decimals", "300.123"], ["exponent", "1e3"], ["capital exponent", "1E3"], ["letters", "abc"], ["digits then letters", "300abc"],
    ["zero", "0"], ["zero cents", "0.00"], ["a lone sign", "$"], ["a lone point", "."], ["trailing point", "300."], ["plus sign", "+300"], ["bad grouping", "1,23"], ["bad grouping two", "12,34,567"],
    ["spaces inside", "3 00"], ["symbol after", "300$"], ["hex", "0x10"], ["NaN", "NaN"], ["Infinity", "Infinity"], ["comma decimal", "300,50"],
    ["one cent over the safe integer", "90071992547409.92"], ["overflow", "99999999999999999999"], ["forty-one characters", `1${"0".repeat(40)}`], ["unicode digits", "١٢٣"],
    ["a newline inside", "30\n0"], ["percent", "5%"],
  ])("refuses %s (%j)", (_label, typed) => {
    expect(parseDollars(typed)).toEqual({ ok: false });
  });
  it("refuses a value that is not text", () => {
    for (const typed of [null, undefined, 300, {}, []] as unknown as string[]) expect(parseDollars(typed)).toEqual({ ok: false });
  });
  it("round trips every cents value it produces, so an untouched input never reads as a change", () => {
    for (const cents of [1, 99, 100, 101, 30000, 30050, 123456, 9007199254740991]) {
      const shown = centsToInput(cents);
      expect(parseDollars(shown)).toEqual({ ok: true, value: cents });
    }
    expect(centsToInput(30000)).toBe("300.00");
    expect(centsToInput(null)).toBe("");
    expect(centsToInput(-5)).toBe("");
    expect(centsToInput("not a number")).toBe("");
    expect(centsToInput(123456n)).toBe("1234.56");
  });
  it("uses no floating point anywhere in the money path of the parser or the edit form", () => {
    for (const file of ["src/server/rules-input.ts", "src/app/rules-ui/edit-form.tsx", "src/app/rules-ui/labels.ts"]) {
      const text = readFileSync(file, "utf8").split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
      expect(text, file).not.toMatch(/parseFloat|toFixed|Math\.round|Math\.floor|Math\.ceil|\*\s*100\b|\/\s*100\b(?!n)|Number\.parseFloat/);
    }
  });
});

describe("DR-90 days, dates and the edit form parse strictly, and a partial form cannot clear a field", () => {
  it("accepts whole days from 1 to 3650 and blank, and refuses everything else", () => {
    expect(parseDays("1")).toEqual({ ok: true, value: 1 });
    expect(parseDays("60")).toEqual({ ok: true, value: 60 });
    expect(parseDays("3650")).toEqual({ ok: true, value: 3650 });
    expect(parseDays("")).toEqual({ ok: true, value: null });
    for (const typed of ["0", "3651", "-1", "1.5", "06", "1e2", "ten", "99999", "1 0", "+5"]) expect(parseDays(typed), typed).toEqual({ ok: false });
  });
  it("accepts a date input value and blank, and leaves whether it is a real day to the validator", () => {
    expect(parseDate("2026-09-01")).toEqual({ ok: true, value: "2026-09-01" });
    expect(parseDate("")).toEqual({ ok: true, value: null });
    expect(parseDate("2026-02-31")).toEqual({ ok: true, value: "2026-02-31" });
    for (const typed of ["09/01/2026", "2026-9-1", "20260901", "2026-09-01T00:00", "tomorrow", "2026-09-011"]) expect(parseDate(typed), typed).toEqual({ ok: false });
  });

  const fields = (over: Record<string, string> = {}): URLSearchParams => {
    const form = new URLSearchParams({ action: "edit", periodStart: "2026-09-01", periodEnd: "2027-06-30", summary: "Pays robot kits." });
    for (const line of BUDGET_LINES) form.set(EDIT_CAP_FIELDS[line], "");
    for (const key of THRESHOLD_KEYS) form.set(EDIT_THRESHOLD_FIELDS[key], "");
    form.set(EDIT_CAP_FIELDS.supplies, "300.00");
    for (const [key, value] of Object.entries(over)) form.set(key, value);
    return form;
  };

  it("turns a complete form into the edit the validator reads: cents, null for blank, sorted checkboxes", () => {
    const form = fields({ [EDIT_THRESHOLD_FIELDS.claimLimitCents]: "1,200.00", [EDIT_THRESHOLD_FIELDS.staleReceiptDays]: "60" });
    form.append(`${EDIT_PROGRAM_PREFIX}robotics`, "on");
    form.append(`${EDIT_CATEGORY_PREFIX}robot_kits_parts`, "on");
    form.append(`${EDIT_CATEGORY_PREFIX}classroom_supplies`, "on");
    const parsed = parseEditForm(form);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.edit.programs).toEqual(["robotics"]);
    expect(parsed.edit.allowedCategories).toEqual(["classroom_supplies", "robot_kits_parts"]);
    expect(parsed.edit.periodStart).toBe("2026-09-01");
    expect(parsed.edit.caps?.supplies).toBe(30000);
    expect(parsed.edit.caps?.travel).toBeNull();
    expect(parsed.edit.thresholds?.claimLimitCents).toBe(120000);
    expect(parsed.edit.thresholds?.staleReceiptDays).toBe(60);
    expect(parsed.edit.thresholds?.suppliesLimitCents).toBeNull();
    expect(parsed.edit.summary).toBe("Pays robot kits.");
  });
  it("reads no checkbox as no choice (null), not as an empty list", () => {
    const parsed = parseEditForm(fields());
    expect(parsed.ok && parsed.edit.programs).toBeNull();
    expect(parsed.ok && parsed.edit.allowedCategories).toBeNull();
  });
  it("refuses a form with a field missing, duplicated or unknown, so a partial post cannot clear anything", () => {
    for (const key of ["action", "periodStart", "periodEnd", "summary", EDIT_CAP_FIELDS.supplies, EDIT_THRESHOLD_FIELDS.claimLimitCents]) {
      const form = fields(); form.delete(key);
      expect(parseEditForm(form), `missing ${key}`).toEqual({ ok: false, error: "FIELDS" });
      const twice = fields(); twice.append(key, "x");
      expect(parseEditForm(twice), `duplicate ${key}`).toEqual({ ok: false, error: "FIELDS" });
    }
    for (const [key, value] of [["extra", "1"], ["program.", "on"], ["program.Robotics", "on"], ["program.robotics", "yes"], ["category.1bad", "on"], ["fundId", "fund_b"], [`program.${"a".repeat(65)}`, "on"]]) {
      const form = fields(); form.append(key!, value!);
      expect(parseEditForm(form), key).toEqual({ ok: false, error: "FIELDS" });
    }
    const duplicateBox = fields(); duplicateBox.append(`${EDIT_PROGRAM_PREFIX}robotics`, "on"); duplicateBox.append(`${EDIT_PROGRAM_PREFIX}robotics`, "on");
    expect(parseEditForm(duplicateBox)).toEqual({ ok: false, error: "FIELDS" });
  });
  it("names the kind of mistake: money, days, date, summary", () => {
    expect(parseEditForm(fields({ [EDIT_CAP_FIELDS.travel]: "-5" }))).toEqual({ ok: false, error: "MONEY" });
    expect(parseEditForm(fields({ [EDIT_CAP_FIELDS.travel]: "1e3" }))).toEqual({ ok: false, error: "MONEY" });
    expect(parseEditForm(fields({ [EDIT_THRESHOLD_FIELDS.suppliesLimitCents]: "250.999" }))).toEqual({ ok: false, error: "MONEY" });
    expect(parseEditForm(fields({ [EDIT_THRESHOLD_FIELDS.staleReceiptDays]: "0" }))).toEqual({ ok: false, error: "DAYS" });
    expect(parseEditForm(fields({ [EDIT_THRESHOLD_FIELDS.splitWindowDays]: "1.5" }))).toEqual({ ok: false, error: "DAYS" });
    expect(parseEditForm(fields({ periodStart: "09/01/2026" }))).toEqual({ ok: false, error: "DATE" });
    expect(parseEditForm(fields({ summary: "   " }))).toEqual({ ok: false, error: "SUMMARY" });
  });
  it("keeps the drafted order for an untouched checkbox group and the chosen order otherwise", () => {
    expect(keepOrder(["a", "b"], ["b", "a"])).toEqual(["b", "a"]);
    expect(keepOrder(["a", "c"], ["b", "a"])).toEqual(["a", "c"]);
    expect(keepOrder(["a"], ["b", "a"])).toEqual(["a"]);
    expect(keepOrder(["a"], null)).toEqual(["a"]);
    expect(keepOrder(null, ["a"])).toBeNull();
  });
});

describe("DR-91 a redirect carries only a table code, and a page shows only text from the table", () => {
  it("shows one plain sentence per create refusal and per unavailable reason, with no error text", () => {
    expect(rulesNotice({ notice: createUnavailableCode("SWITCHED_OFF") })?.text).toBe("AI drafting is off on this instance. Nothing was sent.");
    expect(rulesNotice({ notice: createUnavailableCode("TIMEOUT") })?.text).toBe("The AI request did not finish. Nothing was stored. Try again.");
    expect(rulesNotice({ notice: createUnavailableCode("NO_KEY") })?.text).toContain("no key");
    expect(rulesNotice({ notice: createUnavailableCode("LIMIT") })?.text).toContain("limit");
    expect(rulesNotice({ notice: createUnavailableCode("ERROR") })?.text).toContain("failed");
    for (const reason of ["INVALID_REQUEST", "FUND_NOT_RESTRICTED", "STALE_BASE", "GUARD_REFUSED", "MALFORMED_TEXT", "WITHDRAWN"] as const) {
      const notice = rulesNotice({ notice: createRefusalCode(reason) });
      expect(notice, reason).not.toBeNull();
      expect(notice!.text, reason).toMatch(/^[A-Z][^<>{}]*[.]$/);
    }
  });
  it("maps SAME_APPROVER to its own plain sentence and every other action refusal to a fixed one", () => {
    expect(rulesNotice({ notice: actionRefusalCode("SAME_APPROVER") })?.text).toBe("You already approved this draft. A different approver must give the second approval.");
    for (const reason of ["INCOMPLETE", "THRESHOLDS_INCOMPLETE", "STALE_BASE", "WITHDRAWN", "BOUND", "NOT_DRAFTED", "DRAFT_INVALID", "GUARD_REFUSED", "DB_BROKEN"] as const) {
      expect(rulesNotice({ notice: actionRefusalCode(reason as never) }), reason).not.toBeNull();
    }
  });
  it("shows nothing for a code that is not in the table, for a prototype key, and for an array", () => {
    for (const notice of ["nope", "constructor", "__proto__", "toString", "hasOwnProperty", "https://evil.example", "//evil.example", "<script>alert(1)</script>", ""]) expect(rulesNotice({ notice }), notice).toBeNull();
    expect(rulesNotice({ notice: ["draft-off", "draft-off"] })).toBeNull();
    expect(rulesNotice({})).toBeNull();
  });
  it("builds a query from the code and at most two small integers and one validator name, and nothing else", () => {
    expect(noticeQuery("draft-off")).toBe("?notice=draft-off");
    expect(noticeQuery("bound", { v: 3, back: 2 })).toBe("?notice=bound&v=3&back=2");
    expect(noticeQuery("bound", { v: 3, back: -1 })).toBe("?notice=bound&v=3");
    expect(noticeQuery("bound", { v: 1.5 })).toBe("?notice=bound");
    expect(noticeQuery("bound", { v: 10_000_000 })).toBe("?notice=bound");
    expect(noticeQuery("edit-invalid", { why: "DATE_ORDER" })).toBe("?notice=edit-invalid&why=DATE_ORDER");
    expect(noticeQuery("edit-invalid", { why: "<script>" })).toBe("?notice=edit-invalid");
  });
  it("says how many frozen receipts went back to draft when binding changed the pay order, and nothing when it did not", () => {
    expect(rulesNotice({ notice: "bound", v: "3" })?.text).toBe("Version 3 is now the fund's approved rules. New claims use it.");
    expect(rulesNotice({ notice: "bound", v: "3", back: "2" })?.text).toContain("2 receipts that were frozen but not yet approved twice went back to draft and need both approvals again. Paid claims are untouched.");
    expect(rulesNotice({ notice: "bound", v: "3", back: "1" })?.text).toContain("1 receipt that was frozen");
    expect(rulesNotice({ notice: "bound", v: "3", back: "0" })?.text).toContain("no receipt was waiting");
    expect(rulesNotice({ notice: "bound" })).toBeNull();
    expect(rulesNotice({ notice: "bound", v: "3; drop", back: "1" })).toBeNull();
    expect(rulesNotice({ notice: "bound", v: "3", back: "x" })?.text).toBe("Version 3 is now the fund's approved rules. New claims use it.");
  });
  it("renders a validator refusal as text from the table and never a drafted value", () => {
    expect(rulesNotice({ notice: "edit-invalid", why: "DATE_ORDER" })?.text).toBe("The period must start on or before the day it ends. Nothing was saved.");
    expect(rulesNotice({ notice: "edit-invalid", why: "NOT_A_CODE" })?.text).toBe("That edit breaks a rule, so nothing was saved.");
    expect(refusedDraftReason("CLAUSE_NOT_SUBSTRING")).toContain("not in the grant text");
    expect(refusedDraftReason("SOMETHING_NEW")).toContain("broke a rule of the draft check");
    expect(refusedDraftReason(null)).toContain("No values are shown");
    expect(refusedDraftReason(undefined)).toContain("No values are shown");
  });
  it("puts no model name, key or brand word in any fixed sentence", () => {
    const text = readFileSync("src/server/rules-notices.ts", "utf8");
    expect(text).not.toMatch(/claude|anthropic|sk-ant/i);
  });
});
