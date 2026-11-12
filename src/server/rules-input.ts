// IAC-440 Package B. Pure parsers for the edit form of an AI-drafted rule set.
// A person types dollars, days and dates. This module turns each into the exact value the Package A validator reads (integer cents, whole days, an ISO date,
// or null), and refuses anything else. No floating point is used anywhere: cents come from string arithmetic and BigInt, and a value is converted to a
// JavaScript number only after it is checked to be a safe integer. Empty input means "the grant does not say" (null, which the validator stores as UNSURE).
// The validator stays the authority on every rule. These parsers only decide what text becomes which value, so a malformed form never reaches it.
import { parseCentsInput } from "../app/grid/money";
import { BUDGET_LINES, THRESHOLD_KEYS, type DraftEdit, type ThresholdKey } from "../rules-draft/draft-validate";
import type { BudgetLine } from "../ai/categories";

// The most characters any one typed number or date may have, so a very long string never reaches BigInt.
const TYPED_MAX = 40;
const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

export type Typed<T> = { ok: true; value: T | null } | { ok: false };

// "300", "300.5", "$1,234.56" to cents. Blank is null. Zero, negatives, exponents, three decimals, letters and anything past the largest safe integer of cents are refused.
export function parseDollars(text: string): Typed<number> {
  if (typeof text !== "string" || text.length > TYPED_MAX) return { ok: false };
  const typed = text.trim();
  if (typed === "") return { ok: true, value: null };
  const cents = parseCentsInput(typed);
  if (cents === null || cents < 1n || cents > MAX_CENTS) return { ok: false };
  return { ok: true, value: Number(cents) };
}

// Whole days, one to 3650 (the bound of fund_check_settings). No sign, no decimal, no leading zero.
export function parseDays(text: string): Typed<number> {
  if (typeof text !== "string" || text.length > TYPED_MAX) return { ok: false };
  const typed = text.trim();
  if (typed === "") return { ok: true, value: null };
  if (!/^[1-9][0-9]{0,3}$/.test(typed)) return { ok: false };
  const days = Number(typed);
  return days >= 1 && days <= 3650 ? { ok: true, value: days } : { ok: false };
}

// A date as the date input sends it: year-month-day. Whether it is a real day is the validator's check.
export function parseDate(text: string): Typed<string> {
  if (typeof text !== "string" || text.length > TYPED_MAX) return { ok: false };
  const typed = text.trim();
  if (typed === "") return { ok: true, value: null };
  return /^\d{4}-\d{2}-\d{2}$/.test(typed) ? { ok: true, value: typed } : { ok: false };
}

// Cents to the text an input shows: 30000 is "300.00". It has no grouping so it parses back to the same cents. Anything that is not a whole number of cents is blank.
export function centsToInput(cents: number | string | bigint | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  let value: bigint;
  try { value = BigInt(cents); } catch { return ""; }
  if (value < 0n) return "";
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

export const EDIT_CAP_FIELDS: Record<BudgetLine, string> = Object.fromEntries(BUDGET_LINES.map(line => [line, `cap.${line}`])) as Record<BudgetLine, string>;
export const EDIT_THRESHOLD_FIELDS: Record<ThresholdKey, string> = Object.fromEntries(THRESHOLD_KEYS.map(key => [key, `threshold.${key}`])) as Record<ThresholdKey, string>;
export const EDIT_PROGRAM_PREFIX = "program.";
export const EDIT_CATEGORY_PREFIX = "category.";
const FIXED_FIELDS = ["action", "periodStart", "periodEnd", "summary", ...Object.values(EDIT_CAP_FIELDS), ...Object.values(EDIT_THRESHOLD_FIELDS)];
// The same shape the validator requires of a program id. A category name has the same shape.
const OPTION_ID = /^[a-z][a-z0-9_]{0,63}$/;

export type EditFormError = "FIELDS" | "MONEY" | "DAYS" | "DATE" | "SUMMARY";
export type EditForm = { ok: true; edit: DraftEdit } | { ok: false; error: EditFormError };

const isDays = (key: ThresholdKey) => key.endsWith("Days");

// The edit form. Every fixed field must be present exactly once, a program or category checkbox may appear once each with the value "on", and nothing else
// may appear. A partial post therefore cannot clear a field by leaving it out. Unchecked boxes are simply absent, so no checkboxes means no choice (null).
export function parseEditForm(form: URLSearchParams): EditForm {
  const seen = new Map<string, number>();
  for (const key of form.keys()) seen.set(key, (seen.get(key) ?? 0) + 1);
  for (const key of FIXED_FIELDS) if (seen.get(key) !== 1) return { ok: false, error: "FIELDS" };
  const programs: string[] = [], categories: string[] = [];
  for (const [key, count] of seen) {
    if (FIXED_FIELDS.includes(key)) continue;
    const program = key.startsWith(EDIT_PROGRAM_PREFIX), category = key.startsWith(EDIT_CATEGORY_PREFIX);
    const id = program ? key.slice(EDIT_PROGRAM_PREFIX.length) : category ? key.slice(EDIT_CATEGORY_PREFIX.length) : "";
    if (count !== 1 || (!program && !category) || !OPTION_ID.test(id) || form.get(key) !== "on") return { ok: false, error: "FIELDS" };
    (program ? programs : categories).push(id);
  }

  const summary = form.get("summary")!;
  if (summary.trim() === "") return { ok: false, error: "SUMMARY" };
  const periodStart = parseDate(form.get("periodStart")!), periodEnd = parseDate(form.get("periodEnd")!);
  if (!periodStart.ok || !periodEnd.ok) return { ok: false, error: "DATE" };
  const caps: Partial<Record<BudgetLine, number | null>> = {};
  for (const line of BUDGET_LINES) {
    const typed = parseDollars(form.get(EDIT_CAP_FIELDS[line])!);
    if (!typed.ok) return { ok: false, error: "MONEY" };
    caps[line] = typed.value;
  }
  const thresholds: Partial<Record<ThresholdKey, number | null>> = {};
  for (const key of THRESHOLD_KEYS) {
    const typed = isDays(key) ? parseDays(form.get(EDIT_THRESHOLD_FIELDS[key])!) : parseDollars(form.get(EDIT_THRESHOLD_FIELDS[key])!);
    if (!typed.ok) return { ok: false, error: isDays(key) ? "DAYS" : "MONEY" };
    thresholds[key] = typed.value;
  }
  return {
    ok: true,
    edit: {
      programs: programs.length ? programs.sort() : null, allowedCategories: categories.length ? categories.sort() : null,
      periodStart: periodStart.value, periodEnd: periodEnd.value, caps, thresholds, summary,
    },
  };
}

// A selection that holds the same items as the drafted list is returned in the drafted order, so an untouched checkbox group is never read as a change.
export function keepOrder(selected: string[] | null | undefined, drafted: readonly string[] | null): string[] | null {
  if (!selected) return null;
  if (!drafted || drafted.length !== selected.length) return selected;
  const set = new Set(selected);
  return drafted.every(item => set.has(item)) ? [...drafted] : selected;
}
